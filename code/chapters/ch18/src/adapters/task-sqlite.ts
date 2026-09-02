import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import { lock as acquireFileLock } from "proper-lockfile";

import {
  canonicalTaskId,
  normalizeOwner,
  Task,
  TaskBlockedError,
  TaskError,
  TaskGraphError,
  TaskNotFoundError,
  TaskStateError,
  TaskStatus,
  TaskStorageError,
} from "../features/tasks.js";
import type { CreateTaskInput, TaskCompletion } from "../features/tasks.js";
import type { LeasedTaskStore, TaskClaim } from "../features/work-stealing.js";
import { TaskClaimError, TaskLeaseExpiredError } from "../features/work-stealing.js";

const require = createRequire(import.meta.url);
import {
  canonicalGitObjectId,
  WorktreeAction,
  WorktreeBinding,
  WorktreeEvent,
  WorktreeStateError,
  WorktreeStatus,
} from "../features/worktrees.js";
import type { WorktreeStore } from "../features/worktrees.js";

const LOCK_STALE_MS = 30_000;
const LOCK_UPDATE_MS = 10_000;
const LOCK_RETRY_MS = 10;
const MAX_WINDOWS_LOCK_RACE_RETRIES = 100;
const DATABASE_FILE = "tasks.sqlite3";
// 同一进程内按数据库路径串行化操作，跨进程由 proper-lockfile 文件锁协作。
const PROCESS_LOCK_TAILS = new Map<string, Promise<void>>();
let sqlPromise: Promise<SqlJsStatic> | undefined;

// SqliteTaskStore 依赖可注入时钟，便于测试租约过期等时间边界。
export interface SqliteClock {
  now(): Date;
}

// 选项允许测试替换 id、claim token、时钟和租约时长，生产环境使用随机 UUID 与默认 60 秒租约。
export interface SqliteTaskStoreOptions {
  readonly idGenerator?: () => string;
  readonly claimTokenGenerator?: () => string;
  readonly clock?: SqliteClock;
  readonly leaseDurationMs?: number;
}

// 所有路径都限制在真实 workspace 内，避免符号链接或相对路径逃逸。
interface SqlitePaths {
  readonly workspace: string;
  readonly root: string;
  readonly database: string;
  readonly lock: string;
}

// 每次事务从 SQLite 重新构建任务图，保证依赖顺序和约束判断使用同一份快照。
interface TaskGraph {
  readonly tasks: ReadonlyMap<string, Task>;
  readonly order: readonly string[];
}

// SQLite 在同一原子存储中保留任务租约、worktree 绑定及不可变事件审计记录。
export class SqliteTaskStore implements LeasedTaskStore, WorktreeStore {
  readonly #workspaceInput: string;
  readonly #idGenerator: () => string;
  readonly #claimTokenGenerator: () => string;
  readonly #clock: SqliteClock;
  readonly #leaseDurationMs: number;

  constructor(workspace: string, options: SqliteTaskStoreOptions = {}) {
    if (typeof workspace !== "string" || workspace.trim().length === 0) {
      throw new TypeError("workspace must be a non-empty string");
    }
    if (options.idGenerator !== undefined && typeof options.idGenerator !== "function") {
      throw new TypeError("idGenerator must be a function");
    }
    if (
      options.claimTokenGenerator !== undefined &&
      typeof options.claimTokenGenerator !== "function"
    ) {
      throw new TypeError("claimTokenGenerator must be a function");
    }
    if (options.clock !== undefined && typeof options.clock.now !== "function") {
      throw new TypeError("clock must implement now()");
    }
    const leaseDurationMs =
      options.leaseDurationMs === undefined ? 60_000 : options.leaseDurationMs;
    if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new RangeError("leaseDurationMs must be positive");
    }
    this.#workspaceInput = workspace;
    this.#idGenerator = options.idGenerator === undefined ? randomUUID : options.idGenerator;
    this.#claimTokenGenerator =
      options.claimTokenGenerator === undefined ? randomUUID : options.claimTokenGenerator;
    this.#clock = options.clock === undefined ? { now: () => new Date() } : options.clock;
    this.#leaseDurationMs = leaseDurationMs;
  }

  // SQLite 数据文件固定在 workspace/.agent_tutorial 下，锁文件与数据库同目录。
  get databasePath(): string {
    return resolve(this.#workspaceInput, ".agent_tutorial", DATABASE_FILE);
  }

  // 创建任务时同时写入依赖边；重复 id 或缺失依赖在事务中直接失败。
  async createTask(input: CreateTaskInput): Promise<Task> {
    const id = this.#nextId();
    const dependencies = normalizeDependencies(
      input.blockedBy === undefined ? [] : input.blockedBy,
    );
    if (dependencies.includes(id)) {
      throw new TaskGraphError(`Task ${id} cannot depend on itself`);
    }
    const task = new Task({
      id,
      subject: input.subject,
      description: input.description === undefined ? "" : input.description,
      status: TaskStatus.PENDING,
      owner: null,
      blockedBy: dependencies,
    });
    return await this.#transaction(true, (database) => {
      if (
        queryRows(database, "SELECT 1 AS present FROM tasks WHERE id = ?", [task.id]).length > 0
      ) {
        throw new TaskGraphError(`Task id already exists: ${task.id}`);
      }
      const missing = dependencies.filter(
        (dependency) =>
          queryRows(database, "SELECT 1 AS present FROM tasks WHERE id = ?", [dependency])
            .length === 0,
      );
      if (missing.length > 0) {
        throw new TaskGraphError(`Task dependency does not exist: ${missing.join(", ")}`);
      }
      database.run(
        "INSERT INTO tasks(id, subject, description, status, owner, claim_token, lease_expires_at_utc) VALUES (?, ?, ?, 'pending', NULL, NULL, NULL)",
        [task.id, task.subject, task.description],
      );
      dependencies.forEach((dependency, position) => {
        database.run(
          "INSERT INTO task_dependencies(task_id, dependency_id, position) VALUES (?, ?, ?)",
          [task.id, dependency, position],
        );
      });
      return task;
    });
  }

  // 读取前先释放过期租约，保证调用方看到的是有效任务状态。
  async getTask(taskId: string): Promise<Task> {
    const id = normalizeLookupId(taskId);
    return await this.#transaction(true, (database) => {
      const now = this.#now();
      releaseExpired(database, now);
      return getExisting(loadGraph(database), id);
    });
  }

  // 按创建顺序返回冻结任务列表，与 work stealing 的扫描顺序一致。
  async listTasks(): Promise<readonly Task[]> {
    return await this.#transaction(true, (database) => {
      releaseExpired(database, this.#now());
      const graph = loadGraph(database);
      return Object.freeze(
        graph.order.map((id) => {
          const task = graph.tasks.get(id);
          if (task === undefined) throw new TaskStorageError(`Task graph is missing: ${id}`);
          return task;
        }),
      );
    });
  }

  async reserveWorktree(binding: WorktreeBinding): Promise<WorktreeBinding> {
    // binding 写入和 reserve 审计事件放在同一个 BEGIN IMMEDIATE 事务中；
    // 若事件写入失败，绑定状态一起回滚，不会出现“已预留但无审计”的中间态。
    if (!(binding instanceof WorktreeBinding)) {
      throw new TypeError("binding must be a WorktreeBinding");
    }
    if (binding.status !== WorktreeStatus.RESERVED) {
      throw new WorktreeStateError("New worktree binding must be reserved");
    }
    return await this.#transaction(true, (database) => {
      const task = getExisting(loadGraph(database), binding.taskId);
      if (task.status !== TaskStatus.PENDING) {
        throw new WorktreeStateError(
          `Task ${task.id} is ${task.status}; reserving a worktree requires pending`,
        );
      }
      try {
        database.run(
          "INSERT INTO worktree_bindings(task_id, name, branch, relative_path, integration_ref, baseline_commit, branch_tip, status, review_reason, created_at_utc, updated_at_utc) VALUES (?, ?, ?, ?, ?, ?, NULL, 'reserved', NULL, ?, ?)",
          [
            binding.taskId,
            binding.name,
            binding.branch,
            binding.relativePath,
            binding.integrationRef,
            binding.baselineCommit,
            encodeDate(binding.createdAtUtc),
            encodeDate(binding.updatedAtUtc),
          ],
        );
      } catch (error) {
        throw new WorktreeStateError("Worktree task, name, branch, or path is already reserved", {
          cause: error,
        });
      }
      appendWorktreeEvent(database, WorktreeAction.RESERVE, binding);
      return binding;
    });
  }

  // 从 reserved 到 active 表示工作树实际创建完成，后续自动认领才能使用该绑定。
  async activateWorktree(
    taskId: string,
    options: { readonly branchTip: string; readonly occurredAtUtc: Date },
  ): Promise<WorktreeBinding> {
    return await this.#transitionWorktree(taskId, {
      expected: [WorktreeStatus.RESERVED],
      target: WorktreeStatus.ACTIVE,
      action: WorktreeAction.CREATE,
      branchTip: options.branchTip,
      reason: null,
      occurredAtUtc: options.occurredAtUtc,
      requiredTaskStatus: TaskStatus.PENDING,
    });
  }

  // 任务完成后保留工作树，用于继续集成或后续审计。
  async keepWorktree(
    taskId: string,
    options: { readonly branchTip: string; readonly occurredAtUtc: Date },
  ): Promise<WorktreeBinding> {
    return await this.#transitionWorktree(taskId, {
      expected: [WorktreeStatus.ACTIVE],
      target: WorktreeStatus.KEPT,
      action: WorktreeAction.KEEP,
      branchTip: options.branchTip,
      reason: null,
      occurredAtUtc: options.occurredAtUtc,
      requiredTaskStatus: TaskStatus.COMPLETED,
    });
  }

  // 结果需要人工复核时保留 review_reason，并只允许从 active 进入。
  async markWorktreeNeedsReview(
    taskId: string,
    options: {
      readonly branchTip: string | null;
      readonly reason: string;
      readonly occurredAtUtc: Date;
    },
  ): Promise<WorktreeBinding> {
    return await this.#transitionWorktree(taskId, {
      expected: [WorktreeStatus.ACTIVE],
      target: WorktreeStatus.NEEDS_REVIEW,
      action: WorktreeAction.NEEDS_REVIEW,
      branchTip: options.branchTip,
      reason: options.reason,
      occurredAtUtc: options.occurredAtUtc,
      requiredTaskStatus: TaskStatus.COMPLETED,
    });
  }

  // 已保留或需复核的工作树可最终移除；binding 仍留在数据库作为审计记录。
  async markWorktreeRemoved(
    taskId: string,
    options: { readonly branchTip: string; readonly occurredAtUtc: Date },
  ): Promise<WorktreeBinding> {
    return await this.#transitionWorktree(taskId, {
      expected: [WorktreeStatus.ACTIVE, WorktreeStatus.KEPT, WorktreeStatus.NEEDS_REVIEW],
      target: WorktreeStatus.REMOVED,
      action: WorktreeAction.REMOVE,
      branchTip: options.branchTip,
      reason: null,
      occurredAtUtc: options.occurredAtUtc,
      requiredTaskStatus: TaskStatus.COMPLETED,
    });
  }

  // 读取 binding 使用与任务相同的规范化 id，避免大小写/格式差异绕过约束。
  async getWorktreeBinding(taskId: string): Promise<WorktreeBinding> {
    const id = normalizeLookupId(taskId);
    return await this.#transaction(true, (database) => loadWorktreeBinding(database, id));
  }

  // 事件表为 append-only，按 sequence 升序返回完整审计链。
  async listWorktreeEvents(): Promise<readonly WorktreeEvent[]> {
    return await this.#transaction(true, (database) =>
      Object.freeze(
        queryRows(
          database,
          "SELECT sequence, action, status, task_id, name, branch, relative_path, integration_ref, baseline_commit, branch_tip, reason, created_at_utc FROM worktree_events ORDER BY sequence ASC",
        ).map((row) => worktreeEventFromRow(row)),
      ),
    );
  }

  // 手动 claim 与自动 claim 共用 #claim，确保租约和 token 生成规则一致。
  async claimTask(taskId: string, owner: string): Promise<TaskClaim> {
    const id = normalizeLookupId(taskId);
    const normalizedOwner = normalizeOwner(owner);
    return await this.#transaction(true, (database) => {
      const now = this.#now();
      releaseExpired(database, now);
      const graph = loadGraph(database);
      const task = getExisting(graph, id);
      return this.#claim(database, graph, task, normalizedOwner, now);
    });
  }

  // 按任务创建顺序取第一个 ready 任务；依赖未完成的任务跳过。
  async claimNext(owner: string): Promise<TaskClaim | undefined> {
    const normalizedOwner = normalizeOwner(owner);
    return await this.#transaction(true, (database) => {
      const now = this.#now();
      releaseExpired(database, now);
      const graph = loadGraph(database);
      for (const id of graph.order) {
        const task = graph.tasks.get(id);
        if (task === undefined || task.status !== TaskStatus.PENDING) continue;
        if (
          task.blockedBy.some(
            (dependency) => graph.tasks.get(dependency)?.status !== TaskStatus.COMPLETED,
          )
        ) {
          continue;
        }
        return this.#claim(database, graph, task, normalizedOwner, now);
      }
      return undefined;
    });
  }

  async claimNextBound(owner: string): Promise<TaskClaim | undefined> {
    // 只从已 active 的 worktree_bindings 中选择 ready task，
    // 确保自动认领与手动 claim 遵守相同的 Worktree 隔离前提。
    const normalizedOwner = normalizeOwner(owner);
    return await this.#transaction(true, (database) => {
      const now = this.#now();
      releaseExpired(database, now);
      const graph = loadGraph(database);
      const active = new Set(
        queryRows(database, "SELECT task_id FROM worktree_bindings WHERE status = 'active'").map(
          (row) => requiredString(row.task_id, "worktree task id"),
        ),
      );
      for (const id of graph.order) {
        const task = graph.tasks.get(id);
        if (task === undefined || !active.has(id) || task.status !== TaskStatus.PENDING) continue;
        if (
          task.blockedBy.some(
            (dependency) => graph.tasks.get(dependency)?.status !== TaskStatus.COMPLETED,
          )
        ) {
          continue;
        }
        return this.#claim(database, graph, task, normalizedOwner, now);
      }
      return undefined;
    });
  }

  async lookupClaim(claimToken: string): Promise<TaskClaim | undefined> {
    // 先查 task_claim_tokens 判断 token 是否曾经生成过；再查 tasks 是否仍持有 in_progress 租约。
    // 已知 token 但租约已消失是契约错误，必须显式失败，不能静默返回 undefined。
    const normalizedToken = canonicalClaimToken(claimToken);
    return await this.#transaction(true, (database) => {
      const known = queryRows(database, "SELECT task_id FROM task_claim_tokens WHERE token = ?", [
        normalizedToken,
      ])[0];
      if (known === undefined) return undefined;
      const now = this.#now();
      releaseExpired(database, now);
      const row = queryRows(
        database,
        "SELECT id, lease_expires_at_utc FROM tasks WHERE claim_token = ? AND status = 'in_progress'",
        [normalizedToken],
      )[0];
      if (row === undefined) {
        throw new TaskClaimError("claim token is known but no longer active");
      }
      const graph = loadGraph(database);
      const task = getExisting(graph, requiredString(row.id, "task id"));
      const lease = parseOptionalDate(row.lease_expires_at_utc);
      if (lease === null)
        throw new TaskStorageError("Active SQLite task claim has no lease expiry");
      return Object.freeze({ task, claimToken: normalizedToken, leaseExpiresAtUtc: lease });
    });
  }

  // 完成时必须同时匹配 owner 与 claim token，并在更新后解锁依赖完成的待办任务。
  async completeTask(taskId: string, owner: string, claimToken: string): Promise<TaskCompletion> {
    const id = normalizeLookupId(taskId);
    const normalizedOwner = normalizeOwner(owner);
    const normalizedToken = canonicalClaimToken(claimToken);
    let expired = false;
    const outcome = await this.#transaction(true, (database) => {
      const now = this.#now();
      const current = queryRows(
        database,
        "SELECT status, owner, claim_token, lease_expires_at_utc FROM tasks WHERE id = ?",
        [id],
      )[0];
      if (current === undefined) throw new TaskNotFoundError(`Task does not exist: ${id}`);
      const lease = parseOptionalDate(current.lease_expires_at_utc);
      if (current.status === TaskStatus.IN_PROGRESS && lease !== null && now >= lease) {
        releaseExpired(database, now);
        expired = true;
        return undefined;
      }
      releaseExpired(database, now);
      const graph = loadGraph(database);
      const task = getExisting(graph, id);
      if (task.status !== TaskStatus.IN_PROGRESS) {
        throw new TaskStateError(`Task ${id} is ${task.status}; expected in_progress`);
      }
      if (task.owner !== normalizedOwner || current.claim_token !== normalizedToken) {
        throw new TaskClaimError(`Task ${id} owner or claim token does not match the active claim`);
      }
      const changed = database.run(
        "UPDATE tasks SET status = 'completed', claim_token = NULL, lease_expires_at_utc = NULL WHERE id = ? AND status = 'in_progress' AND owner = ? AND claim_token = ?",
        [id, normalizedOwner, normalizedToken],
      );
      if (changed.getRowsModified() !== 1) {
        throw new TaskClaimError(`Task ${id} owner or claim token does not match the active claim`);
      }
      const completed = new Task({ ...task, status: TaskStatus.COMPLETED });
      const unblocked = graph.order
        .map((candidateId) => graph.tasks.get(candidateId))
        .filter((candidate): candidate is Task => candidate !== undefined)
        .filter(
          (candidate) =>
            candidate.status === TaskStatus.PENDING &&
            candidate.blockedBy.includes(id) &&
            candidate.blockedBy.every(
              (dependency) =>
                dependency === id || graph.tasks.get(dependency)?.status === TaskStatus.COMPLETED,
            ),
        );
      return Object.freeze({ task: completed, unblocked: Object.freeze(unblocked) });
    });
    if (expired) throw new TaskLeaseExpiredError(`Task ${id} claim lease expired`);
    if (outcome === undefined) throw new TaskStorageError("Task completion produced no result");
    return outcome;
  }

  // 生成 token 与更新任务状态都在当前事务内完成；UPDATE 影响行数校验保证只有一个 owner 成功。
  #claim(database: Database, graph: TaskGraph, task: Task, owner: string, now: Date): TaskClaim {
    if (task.status !== TaskStatus.PENDING) {
      throw new TaskStateError(`Task ${task.id} is ${task.status}; expected pending`);
    }
    const blockedBy = task.blockedBy.filter(
      (dependency) => graph.tasks.get(dependency)?.status !== TaskStatus.COMPLETED,
    );
    if (blockedBy.length > 0) throw new TaskBlockedError(task.id, blockedBy);
    const token = this.#nextClaimToken();
    const expiresAt = new Date(now.getTime() + this.#leaseDurationMs);
    try {
      database.run("INSERT INTO task_claim_tokens(token, task_id) VALUES (?, ?)", [token, task.id]);
    } catch (error) {
      throw new TaskStorageError("Generated claim token already exists", { cause: error });
    }
    const changed = database.run(
      "UPDATE tasks SET status = 'in_progress', owner = ?, claim_token = ?, lease_expires_at_utc = ? WHERE id = ? AND status = 'pending' AND owner IS NULL",
      [owner, token, encodeDate(expiresAt), task.id],
    );
    if (changed.getRowsModified() !== 1) {
      throw new TaskStateError(`Task ${task.id} could not be atomically claimed`);
    }
    return Object.freeze({
      task: new Task({ ...task, status: TaskStatus.IN_PROGRESS, owner }),
      claimToken: token,
      leaseExpiresAtUtc: expiresAt,
    });
  }

  // 所有 worktree 状态迁移共用此事务路径，统一校验任务状态、当前状态和目标约束。
  async #transitionWorktree(
    taskId: string,
    options: {
      readonly expected: readonly WorktreeStatus[];
      readonly target: WorktreeStatus;
      readonly action: WorktreeAction;
      readonly branchTip: string | null;
      readonly reason: string | null;
      readonly occurredAtUtc: Date;
      readonly requiredTaskStatus: TaskStatus;
    },
  ): Promise<WorktreeBinding> {
    // binding 的写入和 event 插入在同一个 SQLite 事务内完成，
    // 任一失败都整体回滚，确保审计事实与当前状态始终对应。
    const normalized = normalizeLookupId(taskId);
    const occurredAt = validDate(options.occurredAtUtc);
    const branchTip = options.branchTip === null ? null : canonicalGitObjectId(options.branchTip);
    return await this.#transaction(true, (database) => {
      const graph = loadGraph(database);
      const task = getExisting(graph, normalized);
      if (task.status !== options.requiredTaskStatus) {
        throw new WorktreeStateError(
          `Task ${task.id} is ${task.status}; expected ${options.requiredTaskStatus}`,
        );
      }
      const current = loadWorktreeBinding(database, normalized);
      if (!options.expected.includes(current.status)) {
        throw new WorktreeStateError(
          `Worktree binding ${current.taskId} is ${current.status}; transition is not allowed`,
        );
      }
      const updated = new WorktreeBinding({
        taskId: current.taskId,
        name: current.name,
        branch: current.branch,
        relativePath: current.relativePath,
        integrationRef: current.integrationRef,
        baselineCommit: current.baselineCommit,
        branchTip: branchTip === null ? current.branchTip : branchTip,
        status: options.target,
        reviewReason: options.reason,
        createdAtUtc: current.createdAtUtc,
        updatedAtUtc: occurredAt,
      });
      const changed = database.run(
        "UPDATE worktree_bindings SET branch_tip = ?, status = ?, review_reason = ?, updated_at_utc = ? WHERE task_id = ? AND status = ?",
        [
          updated.branchTip,
          updated.status,
          updated.reviewReason,
          encodeDate(updated.updatedAtUtc),
          updated.taskId,
          current.status,
        ],
      );
      if (changed.getRowsModified() !== 1) {
        throw new WorktreeStateError("Worktree binding could not be atomically transitioned");
      }
      appendWorktreeEvent(database, options.action, updated);
      return updated;
    });
  }

  // 事务先取跨进程文件锁，再以 BEGIN IMMEDIATE 打开 SQLite 事务，避免并发写入互相覆盖。
  async #transaction<T>(create: boolean, operation: (database: Database) => T): Promise<T> {
    const paths = await this.#preparePaths(create);
    if (paths === undefined) {
      throw new TaskStorageError("SQLite Task storage root is unavailable");
    }
    return await withProcessMutex(paths.database, async () => {
      let release: (() => Promise<void>) | undefined;
      let raceRetries = 0;
      try {
        while (release === undefined) {
          try {
            release = await acquireFileLock(paths.root, {
              lockfilePath: paths.lock,
              realpath: true,
              stale: LOCK_STALE_MS,
              update: LOCK_UPDATE_MS,
              retries: 0,
            });
          } catch (error) {
            if (isWindowsLockRace(error) && raceRetries < MAX_WINDOWS_LOCK_RACE_RETRIES) {
              raceRetries += 1;
              await delay(LOCK_RETRY_MS);
              continue;
            }
            if (hasErrorCode(error, "EEXIST") || hasErrorCode(error, "ELOCKED")) {
              await delay(LOCK_RETRY_MS);
              continue;
            }
            throw error;
          }
        }
        await this.#validatePaths(paths);
        const database = await openDatabase(paths);
        try {
          database.run("BEGIN IMMEDIATE");
          try {
            const result = operation(database);
            database.run("COMMIT");
            await persistDatabase(paths.database, database.export());
            return result;
          } catch (error) {
            try {
              database.run("ROLLBACK");
            } catch {
              // 事务已经失败时，原始错误更有诊断价值。
            }
            if (error instanceof TaskError) throw error;
            throw new TaskStorageError("SQLite Task transaction failed", { cause: error });
          }
        } finally {
          database.close();
        }
      } catch (error) {
        if (error instanceof TaskError) throw error;
        throw new TaskStorageError("SQLite Task operation failed", { cause: error });
      } finally {
        if (release !== undefined) await release();
      }
    });
  }

  // 解析真实 workspace 并确保 .agent_tutorial 目录存在；只读路径缺失时返回 undefined。
  async #preparePaths(create: boolean): Promise<SqlitePaths | undefined> {
    let workspace: string;
    try {
      workspace = await realpath(this.#workspaceInput);
      if (!(await stat(workspace)).isDirectory()) throw new Error("workspace is not a directory");
      const root = join(workspace, ".agent_tutorial");
      if (create) {
        await mkdir(root, { recursive: true });
      } else {
        try {
          await lstat(root);
        } catch (error) {
          if (hasErrorCode(error, "ENOENT")) return undefined;
          throw error;
        }
      }
      const paths = Object.freeze({
        workspace,
        root,
        database: join(root, DATABASE_FILE),
        lock: join(root, `${DATABASE_FILE}.lock`),
      });
      await this.#validatePaths(paths);
      return paths;
    } catch (error) {
      if (error instanceof TaskError) throw error;
      throw new TaskStorageError("SQLite Task storage root is invalid", { cause: error });
    }
  }

  // 打开数据库和锁文件前校验路径未被符号链接替换，防止从工作区外读写。
  async #validatePaths(paths: SqlitePaths): Promise<void> {
    const rootInfo = await lstat(paths.root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new TaskStorageError("SQLite Task storage root escapes workspace");
    }
    const resolvedRoot = await realpath(paths.root);
    if (!pathIsInside(paths.workspace, resolvedRoot)) {
      throw new TaskStorageError("SQLite Task storage root escapes workspace");
    }
    if (await pathExists(paths.database)) await validateDatabaseFile(paths);
    const lockInfo = await lstatIfExists(paths.lock);
    if (lockInfo?.isSymbolicLink()) {
      throw new TaskStorageError("SQLite Task lock path must not be a symbolic link");
    }
  }

  // 所有外部生成的 id 统一经过 canonicalTaskId，让存储层只接受规范 UUID。
  #nextId(): string {
    try {
      return canonicalTaskId(this.#idGenerator());
    } catch (error) {
      throw new TaskGraphError("Generated task id must be a canonical UUID", { cause: error });
    }
  }

  // claim token 同样强制规范 UUID，保证 lookupClaim 的键稳定。
  #nextClaimToken(): string {
    try {
      return canonicalClaimToken(this.#claimTokenGenerator());
    } catch (error) {
      if (error instanceof TaskStorageError) throw error;
      throw new TaskStorageError("Claim token generator returned an invalid UUID", {
        cause: error,
      });
    }
  }

  // 每次事务从注入时钟取当前时间，避免测试依赖真实 Date.now()。
  #now(): Date {
    const value = this.#clock.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new TaskStorageError("Work stealing clock returned an invalid time");
    }
    return new Date(value.getTime());
  }
}

async function openDatabase(paths: SqlitePaths): Promise<Database> {
  await validateDatabaseTargetBeforeOpen(paths);
  const SQL = await getSql();
  const database = await readDatabase(paths.database, SQL);
  try {
    database.run("PRAGMA foreign_keys = ON");
    // tasks CHECK 固化租约状态组合；worktree_bindings 保证 name/branch/path 唯一；
    // worktree_events 用触发器拒绝 UPDATE/DELETE，形成不可变审计链。
    // 同一数据库文件同时保存任务、claim、worktree binding 和 append-only 审计事件；
    // 约束在 SQLite 层把非法状态组合和事件改写直接拒绝。
    database.run(`
      CREATE TABLE IF NOT EXISTS task_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO task_metadata(key, value) VALUES ('schema_version', '1');
      CREATE TABLE IF NOT EXISTS tasks(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        subject TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'in_progress', 'completed')),
        owner TEXT,
        claim_token TEXT UNIQUE,
        lease_expires_at_utc TEXT,
        CHECK(
          (status = 'pending' AND owner IS NULL AND claim_token IS NULL AND lease_expires_at_utc IS NULL)
          OR (status = 'in_progress' AND owner IS NOT NULL AND claim_token IS NOT NULL AND lease_expires_at_utc IS NOT NULL)
          OR (status = 'completed' AND owner IS NOT NULL AND claim_token IS NULL AND lease_expires_at_utc IS NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS task_dependencies(
        task_id TEXT NOT NULL,
        dependency_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK(position >= 0),
        PRIMARY KEY(task_id, dependency_id),
        UNIQUE(task_id, position),
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY(dependency_id) REFERENCES tasks(id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS task_claim_tokens(
        token TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS worktree_bindings(
        task_id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        branch TEXT NOT NULL UNIQUE,
        relative_path TEXT NOT NULL UNIQUE,
        integration_ref TEXT NOT NULL,
        baseline_commit TEXT NOT NULL,
        branch_tip TEXT,
        status TEXT NOT NULL CHECK(status IN ('reserved', 'active', 'kept', 'needs_review', 'removed')),
        review_reason TEXT,
        created_at_utc TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL,
        CHECK(
          (status = 'needs_review' AND review_reason IS NOT NULL)
          OR (status != 'needs_review' AND review_reason IS NULL)
        ),
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS worktree_events(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL CHECK(action IN ('reserve', 'create', 'keep', 'needs_review', 'remove')),
        status TEXT NOT NULL CHECK(status IN ('reserved', 'active', 'kept', 'needs_review', 'removed')),
        task_id TEXT NOT NULL,
        name TEXT NOT NULL,
        branch TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        integration_ref TEXT NOT NULL,
        baseline_commit TEXT NOT NULL,
        branch_tip TEXT,
        reason TEXT,
        created_at_utc TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE RESTRICT
      );
      CREATE TRIGGER IF NOT EXISTS worktree_events_reject_update
      BEFORE UPDATE ON worktree_events
      BEGIN
        SELECT RAISE(ABORT, 'worktree_events is append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS worktree_events_reject_delete
      BEFORE DELETE ON worktree_events
      BEGIN
        SELECT RAISE(ABORT, 'worktree_events is append-only');
      END;
    `);
    const version = queryRows(
      database,
      "SELECT value FROM task_metadata WHERE key = 'schema_version'",
    )[0]?.value;
    if (version !== "1") throw new TaskStorageError("Unsupported SQLite Task schema version");
    return database;
  } catch (error) {
    database.close();
    if (error instanceof TaskError) throw error;
    throw new TaskStorageError("SQLite Task database could not be opened", { cause: error });
  }
}

// 文件不存在时创建空库，否则读取现有字节；解析失败由上层包装为 TaskStorageError。
async function readDatabase(path: string, SQL: SqlJsStatic): Promise<Database> {
  try {
    const bytes = await readFile(path);
    return new SQL.Database(bytes);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return new SQL.Database();
    throw new TaskStorageError("SQLite Task database could not be read", { cause: error });
  }
}

// 惰性加载 sql.js WASM，只初始化一次。
async function getSql(): Promise<SqlJsStatic> {
  if (sqlPromise === undefined) {
    sqlPromise = initSqlJs({
      locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm"),
    });
  }
  return await sqlPromise;
}

// 先写临时文件再 rename，避免进程中断留下半写数据库。
async function persistDatabase(path: string, content: Uint8Array): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx");
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    if (handle !== undefined) await handle.close();
    await rm(temporary, { force: true });
  }
}

// 打开前只允许普通文件数据库，拒绝符号链接或目录目标。
async function validateDatabaseTargetBeforeOpen(paths: SqlitePaths): Promise<void> {
  const information = await lstatIfExists(paths.database);
  if (information === undefined) return;
  if (information.isSymbolicLink()) {
    throw new TaskStorageError("SQLite Task database escapes workspace or is not a regular file");
  }
  await validateDatabaseFile(paths);
}

// 数据库必须位于 workspace 内且 nlink 为 1，避免硬链接被其他位置改写。
async function validateDatabaseFile(paths: SqlitePaths): Promise<void> {
  const resolved = await realpath(paths.database);
  const information = await stat(paths.database);
  if (
    !pathIsInside(paths.workspace, resolved) ||
    resolved !== paths.database ||
    !information.isFile() ||
    information.nlink !== 1
  ) {
    throw new TaskStorageError("SQLite Task database escapes workspace or is not a regular file");
  }
}

// 从 tasks 与 task_dependencies 重建完整任务图，并校验循环依赖。
function loadGraph(database: Database): TaskGraph {
  const rows = queryRows(
    database,
    "SELECT id, subject, description, status, owner FROM tasks ORDER BY sequence ASC",
  );
  const dependencies = new Map<string, string[]>();
  for (const row of rows) dependencies.set(requiredString(row.id, "task id"), []);
  for (const row of queryRows(
    database,
    "SELECT task_id, dependency_id FROM task_dependencies ORDER BY task_id ASC, position ASC",
  )) {
    const taskId = requiredString(row.task_id, "dependency task id");
    const dependencyId = requiredString(row.dependency_id, "dependency id");
    const values = dependencies.get(taskId);
    if (values === undefined)
      throw new TaskGraphError(`Dependency references unknown task: ${taskId}`);
    values.push(dependencyId);
  }
  const tasks = new Map<string, Task>();
  const order: string[] = [];
  for (const row of rows) {
    const id = requiredString(row.id, "task id");
    const blockedBy = dependencies.get(id);
    if (blockedBy === undefined) {
      throw new TaskGraphError(`Task dependencies are missing: ${id}`);
    }
    try {
      const task = new Task({
        id,
        subject: requiredString(row.subject, "task subject"),
        description: requiredString(row.description, "task description"),
        status: row.status as TaskStatus,
        owner: row.owner === null ? null : requiredString(row.owner, "task owner"),
        blockedBy: Object.freeze([...blockedBy]),
      });
      tasks.set(task.id, task);
      order.push(task.id);
    } catch (error) {
      if (error instanceof TaskError) throw error;
      throw new TaskStorageError(`Persisted SQLite task is invalid: ${id}`, { cause: error });
    }
  }
  validateGraph(tasks);
  return Object.freeze({ tasks, order: Object.freeze(order) });
}

// 按 task_id 读取 worktree binding；不存在时抛出显式状态错误。
function loadWorktreeBinding(database: Database, taskId: string): WorktreeBinding {
  const row = queryRows(
    database,
    "SELECT task_id, name, branch, relative_path, integration_ref, baseline_commit, branch_tip, status, review_reason, created_at_utc, updated_at_utc FROM worktree_bindings WHERE task_id = ?",
    [taskId],
  )[0];
  if (row === undefined) {
    throw new WorktreeStateError(`Task does not have a worktree binding: ${taskId}`);
  }
  try {
    return new WorktreeBinding({
      taskId: requiredString(row.task_id, "worktree task id"),
      name: requiredString(row.name, "worktree name"),
      branch: requiredString(row.branch, "worktree branch"),
      relativePath: requiredString(row.relative_path, "worktree path"),
      integrationRef: requiredString(row.integration_ref, "worktree integration ref"),
      baselineCommit: requiredString(row.baseline_commit, "worktree baseline commit"),
      branchTip: nullableString(row.branch_tip, "worktree branch tip"),
      status: requiredString(row.status, "worktree status") as WorktreeStatus,
      reviewReason: nullableString(row.review_reason, "worktree review reason"),
      createdAtUtc: parseRequiredDate(row.created_at_utc, "worktree creation time"),
      updatedAtUtc: parseRequiredDate(row.updated_at_utc, "worktree update time"),
    });
  } catch (error) {
    if (error instanceof TaskError) throw error;
    throw new TaskStorageError(`Persisted SQLite worktree binding is invalid: ${taskId}`, {
      cause: error,
    });
  }
}

// 把审计事件行解析成 WorktreeEvent，任何字段损坏都会让事务失败。
function worktreeEventFromRow(row: Record<string, unknown>): WorktreeEvent {
  try {
    return new WorktreeEvent({
      sequence: requiredNumber(row.sequence, "worktree event sequence"),
      action: requiredString(row.action, "worktree event action") as WorktreeAction,
      status: requiredString(row.status, "worktree event status") as WorktreeStatus,
      taskId: requiredString(row.task_id, "worktree event task id"),
      name: requiredString(row.name, "worktree event name"),
      branch: requiredString(row.branch, "worktree event branch"),
      relativePath: requiredString(row.relative_path, "worktree event path"),
      integrationRef: requiredString(row.integration_ref, "worktree event integration ref"),
      baselineCommit: requiredString(row.baseline_commit, "worktree event baseline commit"),
      branchTip: nullableString(row.branch_tip, "worktree event branch tip"),
      reason: nullableString(row.reason, "worktree event reason"),
      createdAtUtc: parseRequiredDate(row.created_at_utc, "worktree event creation time"),
    });
  } catch (error) {
    if (error instanceof TaskError) throw error;
    throw new TaskStorageError("Persisted SQLite worktree event is invalid", { cause: error });
  }
}

// 插入事件后读取 last_insert_rowid 作为不可变 sequence，返回事件供调用方使用。
function appendWorktreeEvent(
  database: Database,
  action: WorktreeAction,
  binding: WorktreeBinding,
): WorktreeEvent {
  const result = database.run(
    "INSERT INTO worktree_events(action, status, task_id, name, branch, relative_path, integration_ref, baseline_commit, branch_tip, reason, created_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      action,
      binding.status,
      binding.taskId,
      binding.name,
      binding.branch,
      binding.relativePath,
      binding.integrationRef,
      binding.baselineCommit,
      binding.branchTip,
      binding.reviewReason,
      encodeDate(binding.updatedAtUtc),
    ],
  );
  const sequence = queryRows(database, "SELECT last_insert_rowid() AS sequence")[0]?.sequence;
  const normalizedSequence = requiredNumber(sequence, "worktree event sequence");
  if (result.getRowsModified() !== 1 || normalizedSequence <= 0) {
    throw new TaskStorageError("SQLite worktree event did not receive a sequence");
  }
  return new WorktreeEvent({
    sequence: normalizedSequence,
    action,
    status: binding.status,
    taskId: binding.taskId,
    name: binding.name,
    branch: binding.branch,
    relativePath: binding.relativePath,
    integrationRef: binding.integrationRef,
    baselineCommit: binding.baselineCommit,
    branchTip: binding.branchTip,
    reason: binding.reviewReason,
    createdAtUtc: binding.updatedAtUtc,
  });
}

// 深度优先检测循环和缺失依赖，保证图可安全执行。
function validateGraph(tasks: ReadonlyMap<string, Task>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new TaskGraphError(`Task graph contains a cycle at ${id}`);
    if (visited.has(id)) return;
    const task = tasks.get(id);
    if (task === undefined) throw new TaskGraphError(`Task graph references missing task ${id}`);
    visiting.add(id);
    for (const dependency of task.blockedBy) {
      if (!tasks.has(dependency))
        throw new TaskGraphError(`Task dependency does not exist: ${dependency}`);
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of tasks.keys()) visit(id);
}

function getExisting(graph: TaskGraph, id: string): Task {
  const task = graph.tasks.get(id);
  if (task === undefined) throw new TaskNotFoundError(`Task does not exist: ${id}`);
  return task;
}

// 到期租约在读取/认领前统一归还为 pending，不等调用方主动续租。
function releaseExpired(database: Database, now: Date): void {
  database.run(
    "UPDATE tasks SET status = 'pending', owner = NULL, claim_token = NULL, lease_expires_at_utc = NULL WHERE status = 'in_progress' AND lease_expires_at_utc IS NOT NULL AND lease_expires_at_utc <= ?",
    [encodeDate(now)],
  );
}

// 将 sql.js exec 结果转换为列名到值的对象数组，空结果返回 []。
function queryRows(
  database: Database,
  sql: string,
  params: readonly SqlParam[] = [],
): Record<string, unknown>[] {
  const result = database.exec(sql, [...params]);
  const first = result[0];
  if (first === undefined) return [];
  return first.values.map((values) =>
    Object.fromEntries(first.columns.map((column, index) => [column, values[index]])),
  );
}

type SqlParam = string | number | null;

// 依赖必须为规范 UUID 且不重复；重复或格式错误在写入前失败。
function normalizeDependencies(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values)) throw new TaskGraphError("Task dependencies must be an array");
  const normalized = values.map((value) => canonicalTaskId(value));
  if (new Set(normalized).size !== normalized.length) {
    throw new TaskGraphError("Task dependencies must be unique");
  }
  return Object.freeze(normalized);
}

// 查询用 id 采用规范格式，避免调用方输入直接进入 SQL 参数。
function normalizeLookupId(value: string): string {
  try {
    return canonicalTaskId(value);
  } catch {
    throw new TaskNotFoundError("Task id must be a canonical UUID");
  }
}

// claim token 与任务 id 使用同一 UUID 规范，便于幂等重放。
function canonicalClaimToken(value: string): string {
  try {
    return canonicalTaskId(value);
  } catch {
    throw new TaskClaimError("Claim token must be a canonical UUID");
  }
}

// 时间统一以 ISO-8601 UTC 文本持久化，租约比较可按字符串字典序进行。
function encodeDate(value: Date): string {
  return value.toISOString();
}

// 可空时间字段反序列化；非空但无效的时间直接判为存储损坏。
function parseOptionalDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new TaskStorageError("Persisted lease expiry is invalid");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new TaskStorageError("Persisted lease expiry is invalid");
  return parsed;
}

// 必填时间字段不允许缺失，缺失即存储损坏。
function parseRequiredDate(value: unknown, label: string): Date {
  const parsed = parseOptionalDate(value);
  if (parsed === null) throw new TaskStorageError(`Persisted ${label} is invalid`);
  return parsed;
}

// worktree 转换时间来自外部，这里先校验再进入持久化。
function validDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new WorktreeStateError("Worktree transition time must be a valid Date");
  }
  return new Date(value.getTime());
}

// 持久化行字段统一按类型校验，返回强类型值或抛出存储损坏错误。
function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TaskStorageError(`Persisted ${label} is invalid`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requiredString(value, label);
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TaskStorageError(`Persisted ${label} is invalid`);
  }
  return value;
}

// 进程内串行化同一数据库的 Promise 链，避免同进程并发绕过文件锁的时序。
async function withProcessMutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = PROCESS_LOCK_TAILS.get(key);
  const result = previous === undefined ? operation() : previous.then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  PROCESS_LOCK_TAILS.set(key, tail);
  try {
    return await result;
  } finally {
    if (PROCESS_LOCK_TAILS.get(key) === tail) PROCESS_LOCK_TAILS.delete(key);
  }
}

// 用 path.relative 判断目标是否位于 parent 内，比字符串前缀更可靠。
function pathIsInside(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

// 一次 lstat 同时得到"是否存在"和元信息：路径不存在返回 undefined，其他 IO 错误继续抛出。
// 调用方据此避免"先探测存在再取元信息"的两次 syscall——锁文件在两次之间被释放会误报错误。
async function lstatIfExists(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

// 将 ENOENT 转为 false，其他 IO 错误继续抛出。
async function pathExists(path: string): Promise<boolean> {
  return (await lstatIfExists(path)) !== undefined;
}

// 从任意 Error-like 对象读取 code，供 Windows 文件锁竞态判断使用。
function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}

// Windows 下重命名/删除锁文件可能短暂返回 EBUSY/ENOTEMPTY/EPERM，这些错误可重试。
function isWindowsLockRace(error: unknown): boolean {
  return (
    hasErrorCode(error, "EBUSY") || hasErrorCode(error, "ENOTEMPTY") || hasErrorCode(error, "EPERM")
  );
}

// 文件锁竞态重试前的短等待。
async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
