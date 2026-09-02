// SQLite 任务存储：独立持久化 P17 的 DAG、租约与 claim token；每个事务都在进程队列、文件锁和 BEGIN IMMEDIATE 下原子完成。
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

const LOCK_STALE_MS = 30_000;
const LOCK_UPDATE_MS = 10_000;
const LOCK_RETRY_MS = 10;
const MAX_WINDOWS_LOCK_RACE_RETRIES = 100;
const DATABASE_FILE = "tasks.sqlite3";
const PROCESS_LOCK_TAILS = new Map<string, Promise<void>>();
let sqlPromise: Promise<SqlJsStatic> | undefined;

// SQLite 任务库独立于早期 JSON 图；每次操作在锁与事务中维护依赖、lease 和 claim token。
export interface SqliteClock {
  // 每次事务只读取一次当前时间，保证租约释放、认领和完成使用同一时间基准。
  now(): Date;
}

export interface SqliteTaskStoreOptions {
  // 任务 ID、claim token 与时钟可注入，以稳定覆盖冲突、过期和排序测试。
  readonly idGenerator?: () => string;
  readonly claimTokenGenerator?: () => string;
  readonly clock?: SqliteClock;
  // 租约时长只在认领时固化为绝对截止时间，不会随运行时配置变化追溯修改。
  readonly leaseDurationMs?: number;
}

interface SqlitePaths {
  // realpath 后的工作区根，用于拒绝数据库或锁路径逃逸。
  readonly workspace: string;
  // `.agent_tutorial` 状态根，同时作为 proper-lockfile 的加锁对象。
  readonly root: string;
  // sql.js 导出后的单一数据库文件。
  readonly database: string;
  // 跨进程写事务锁；不得是符号链接。
  readonly lock: string;
}

interface TaskGraph {
  // 当前事务从数据库重建的不可变任务快照。
  readonly tasks: ReadonlyMap<string, Task>;
  // SQLite sequence 对应的稳定创建顺序，claimNext 与列表都依赖该顺序。
  readonly order: readonly string[];
}

export class SqliteTaskStore implements LeasedTaskStore {
  // 认领使用半开租约：过期租约可释放，但完成必须匹配当前 claim token。
  // 构造器只保存路径与注入边界，数据库目录到首次操作时才创建并验证。
  readonly #workspaceInput: string;
  readonly #idGenerator: () => string;
  readonly #claimTokenGenerator: () => string;
  readonly #clock: SqliteClock;
  readonly #leaseDurationMs: number;

  constructor(workspace: string, options: SqliteTaskStoreOptions = {}) {
    // 构造阶段验证注入边界，但不创建目录或打开数据库，避免配置失败留下状态文件。
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

  get databasePath(): string {
    // 该 getter 只提供可预测展示路径；真正访问前仍会 realpath 并执行安全校验。
    return resolve(this.#workspaceInput, ".agent_tutorial", DATABASE_FILE);
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    // 依赖存在性、任务插入和依赖顺序写入位于同一事务，任一失败都不留下半张图。
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

  async getTask(taskId: string): Promise<Task> {
    // 读取前先释放已过期租约，因此调用方看到的是当前可认领状态而非陈旧 in_progress。
    const id = normalizeLookupId(taskId);
    return await this.#transaction(true, (database) => {
      const now = this.#now();
      releaseExpired(database, now);
      return getExisting(loadGraph(database), id);
    });
  }

  async listTasks(): Promise<readonly Task[]> {
    // 返回顺序由数据库 sequence 固定，不受 UUID 或并发读取顺序影响。
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

  async claimTask(taskId: string, owner: string): Promise<TaskClaim> {
    // 手动认领与自动认领共用 #claim，保持依赖检查、token 和租约语义一致。
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

  async claimNext(owner: string): Promise<TaskClaim | undefined> {
    // 自动认领按稳定创建顺序选择首个 ready task；没有候选时返回 undefined 进入空闲轮询。
    const normalizedOwner = normalizeOwner(owner);
    return await this.#transaction(true, (database) => {
      // 先释放过期租约，再加载完整 DAG，按创建顺序找第一个没有未完成依赖的 pending task。
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

  async completeTask(taskId: string, owner: string, claimToken: string): Promise<TaskCompletion> {
    // owner 与 token 必须同时匹配当前租约；旧 token 即使属于同一 owner 也不能完成重认领任务。
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

  #claim(database: Database, graph: TaskGraph, task: Task, owner: string, now: Date): TaskClaim {
    // 该方法只在 BEGIN IMMEDIATE 内调用，把依赖检查、token 登记和条件更新组成一个认领原子步。
    if (task.status !== TaskStatus.PENDING) {
      throw new TaskStateError(`Task ${task.id} is ${task.status}; expected pending`);
    }
    const blockedBy = task.blockedBy.filter(
      (dependency) => graph.tasks.get(dependency)?.status !== TaskStatus.COMPLETED,
    );
    if (blockedBy.length > 0) throw new TaskBlockedError(task.id, blockedBy);
    const token = this.#nextClaimToken();
    const expiresAt = new Date(now.getTime() + this.#leaseDurationMs);
    // 历史 token 表保证同一 token 全生命周期不可复用；冲突会让整个认领事务回滚。
    try {
      database.run("INSERT INTO task_claim_tokens(token, task_id) VALUES (?, ?)", [token, task.id]);
    } catch (error) {
      throw new TaskStorageError("Generated claim token already exists", { cause: error });
    }
    // 条件 UPDATE 是最终互斥点：并发扫描即使看到同一 pending task，也只有一个事务能改到 in_progress。
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

  async #transaction<T>(create: boolean, operation: (database: Database) => T): Promise<T> {
    // 所有公开操作都收敛到此处，统一执行路径校验、三层互斥、事务提交和数据库原子落盘。
    const paths = await this.#preparePaths(create);
    if (paths === undefined) {
      throw new TaskStorageError("SQLite Task storage root is unavailable");
    }
    // 三层互斥：进程内 tail-chain、文件锁、BEGIN IMMEDIATE，共同保证跨进程也不会重复认领。
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
          // BEGIN IMMEDIATE 在写事务开始时就持有保留锁，使“扫描 + 条件更新”作为一个原子步骤执行。
          database.run("BEGIN IMMEDIATE");
          try {
            const result = operation(database);
            database.run("COMMIT");
            // sql.js 是内存数据库，提交后必须 export 并通过临时文件原子替换落盘。
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

  async #preparePaths(create: boolean): Promise<SqlitePaths | undefined> {
    // 读操作不创建存储目录，缺目录时返回 undefined，让上层明确失败而不是凭空新建数据库。
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

  async #validatePaths(paths: SqlitePaths): Promise<void> {
    // 每次持锁操作前重新校验真实路径，防止运行期间目录被替换为链接。
    // 工作区、数据库和锁文件都限制在 realpath 后的 workspace 内，符号链接路径直接拒绝。
    const rootInfo = await lstat(paths.root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new TaskStorageError("SQLite Task storage root escapes workspace");
    }
    const resolvedRoot = await realpath(paths.root);
    if (!pathIsInside(paths.workspace, resolvedRoot)) {
      throw new TaskStorageError("SQLite Task storage root escapes workspace");
    }
    if (await pathExists(paths.database)) await validateDatabaseFile(paths);
    // 只做一次 lstat：锁文件若在"探测存在"与"读取元信息"之间被释放，两次 syscall 会误报错误。
    const lockInfo = await lstatIfExists(paths.lock);
    if (lockInfo?.isSymbolicLink()) {
      throw new TaskStorageError("SQLite Task lock path must not be a symbolic link");
    }
  }

  #nextId(): string {
    // 注入生成器的结果仍必须经过领域 UUID 规范化，测试替身不能绕过生产约束。
    try {
      return canonicalTaskId(this.#idGenerator());
    } catch (error) {
      throw new TaskGraphError("Generated task id must be a canonical UUID", { cause: error });
    }
  }

  #nextClaimToken(): string {
    // claim token 与任务 ID 采用同一 canonical UUID 形式，但通过独立生成器保持职责分离。
    try {
      return canonicalClaimToken(this.#claimTokenGenerator());
    } catch (error) {
      if (error instanceof TaskStorageError) throw error;
      throw new TaskStorageError("Claim token generator returned an invalid UUID", {
        cause: error,
      });
    }
  }

  #now(): Date {
    // 返回副本，避免可变 Date 从时钟边界泄漏进事务状态。
    const value = this.#clock.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new TaskStorageError("Work stealing clock returned an invalid time");
    }
    return new Date(value.getTime());
  }
}

async function openDatabase(paths: SqlitePaths): Promise<Database> {
  // sql.js 每次打开都执行建表与 schema 校验，不依赖外部 SQLite 进程或历史文件格式。
  await validateDatabaseTargetBeforeOpen(paths);
  const SQL = await getSql();
  const database = await readDatabase(paths.database, SQL);
  try {
    database.run("PRAGMA foreign_keys = ON");
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

async function readDatabase(path: string, SQL: SqlJsStatic): Promise<Database> {
  // 文件不存在表示首个事务，创建空内存库；其他读取错误必须显式失败。
  try {
    const bytes = await readFile(path);
    return new SQL.Database(bytes);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return new SQL.Database();
    throw new TaskStorageError("SQLite Task database could not be read", { cause: error });
  }
}

async function getSql(): Promise<SqlJsStatic> {
  // WASM 初始化进程内只执行一次，所有 store 实例共享同一加载 Promise。
  if (sqlPromise === undefined) {
    sqlPromise = initSqlJs({
      locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm"),
    });
  }
  return await sqlPromise;
}

async function persistDatabase(path: string, content: Uint8Array): Promise<void> {
  // 临时文件写完后原子 rename，避免进程中断时留下半写数据库。
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

async function validateDatabaseTargetBeforeOpen(paths: SqlitePaths): Promise<void> {
  // 打开前检查可防止 sql.js 跟随符号链接读取工作区外数据库。
  const information = await lstatIfExists(paths.database);
  if (information === undefined) return;
  if (information.isSymbolicLink()) {
    throw new TaskStorageError("SQLite Task database escapes workspace or is not a regular file");
  }
  await validateDatabaseFile(paths);
}

async function validateDatabaseFile(paths: SqlitePaths): Promise<void> {
  // 数据库必须是工作区内、非硬链接、真实路径不变的普通文件。
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

function loadGraph(database: Database): TaskGraph {
  // 每次操作都从两张表重建任务图，避免进程间缓存读到已被其他 worker 提交的认领结果。
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

function validateGraph(tasks: ReadonlyMap<string, Task>): void {
  // 深度优先校验缺失依赖和环；持久化图损坏时整次事务失败。
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
  // 领域层统一把不存在映射为 TaskNotFoundError，避免上层处理 undefined。
  const task = graph.tasks.get(id);
  if (task === undefined) throw new TaskNotFoundError(`Task does not exist: ${id}`);
  return task;
}

function releaseExpired(database: Database, now: Date): void {
  // lease 是半开区间：now 已等于或超过截止时刻时，原子把任务退回 pending，让其他 worker 可再次认领。
  database.run(
    "UPDATE tasks SET status = 'pending', owner = NULL, claim_token = NULL, lease_expires_at_utc = NULL WHERE status = 'in_progress' AND lease_expires_at_utc IS NOT NULL AND lease_expires_at_utc <= ?",
    [encodeDate(now)],
  );
}

function queryRows(
  database: Database,
  sql: string,
  params: readonly SqlParam[] = [],
): Record<string, unknown>[] {
  // sql.js 返回列名和值矩阵；这里转换为未信任对象，字段仍由调用方逐项校验。
  const result = database.exec(sql, [...params]);
  const first = result[0];
  if (first === undefined) return [];
  return first.values.map((values) =>
    Object.fromEntries(first.columns.map((column, index) => [column, values[index]])),
  );
}

type SqlParam = string | number | null;

function normalizeDependencies(values: readonly string[]): readonly string[] {
  // 保留调用方顺序用于教程展示，但拒绝重复依赖和非规范 UUID。
  if (!Array.isArray(values)) throw new TaskGraphError("Task dependencies must be an array");
  const normalized = values.map((value) => canonicalTaskId(value));
  if (new Set(normalized).size !== normalized.length) {
    throw new TaskGraphError("Task dependencies must be unique");
  }
  return Object.freeze(normalized);
}

function normalizeLookupId(value: string): string {
  try {
    return canonicalTaskId(value);
  } catch {
    throw new TaskNotFoundError("Task id must be a canonical UUID");
  }
}

function canonicalClaimToken(value: string): string {
  try {
    return canonicalTaskId(value);
  } catch {
    throw new TaskClaimError("Claim token must be a canonical UUID");
  }
}

function encodeDate(value: Date): string {
  return value.toISOString();
}

function parseOptionalDate(value: unknown): Date | null {
  // NULL 表示没有活跃租约；非空值必须是可解析时间。
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new TaskStorageError("Persisted lease expiry is invalid");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new TaskStorageError("Persisted lease expiry is invalid");
  return parsed;
}

function requiredString(value: unknown, label: string): string {
  // 数据库行字段不做宽松字符串转换，类型不符即视为存储损坏。
  if (typeof value !== "string") throw new TaskStorageError(`Persisted ${label} is invalid`);
  return value;
}

async function withProcessMutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  // 同一进程内的并发 SQLite 操作按数据库路径串行执行，避免重复进入文件锁竞争。
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

function pathIsInside(parent: string, child: string): boolean {
  // 使用 relative 判断包含关系，避免简单字符串前缀把相邻目录误判为子目录。
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

async function lstatIfExists(path: string): Promise<Stats | undefined> {
  // 一次 syscall 同时得到"是否存在"和元信息，调用方无需再补一次 lstat。
  // 仅把 ENOENT 视为不存在，权限或 I/O 错误继续上抛。
  try {
    return await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  return (await lstatIfExists(path)) !== undefined;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}

function isWindowsLockRace(error: unknown): boolean {
  // Windows 上 lock 文件可能在检查与打开之间消失，只重试这一类短暂竞态。
  // proper-lockfile 在 Windows 文件锁删除/重命名阶段可能短暂出现这些错误，短等待后重试即可。
  return (
    hasErrorCode(error, "EBUSY") || hasErrorCode(error, "ENOTEMPTY") || hasErrorCode(error, "EPERM")
  );
}

async function delay(milliseconds: number): Promise<void> {
  // 文件锁竞争使用固定短等待，避免同步忙循环占满事件循环。
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
