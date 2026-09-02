// JsonTaskStore 把 P12 任务 DAG 持久化到 workspace 的 .agent_tutorial/.tasks，并以文件锁串行化状态迁移。
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { TextDecoder } from "node:util";
import { lock as acquireFileLock } from "proper-lockfile";

import {
  canonicalTaskId,
  normalizeOwner,
  Task,
  TaskBlockedError,
  TaskError,
  TaskGraphError,
  TaskNotFoundError,
  TaskOwnershipError,
  TaskStateError,
  TaskStatus,
  TaskStorageError,
} from "../features/tasks.js";
import type { CreateTaskInput, TaskCompletion, TaskStore } from "../features/tasks.js";

const LOCK_STALE_MS = 30_000;
const LOCK_UPDATE_MS = 10_000;
const LOCK_RETRY_MS = 10;
const MAX_WINDOWS_LOCK_RACE_RETRIES = 100;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const PROCESS_LOCK_TAILS = new Map<string, Promise<void>>();

// JSON 适配器用进程内队列加跨进程锁串行化读改写，并以原子替换发布图快照。
interface JsonTaskPaths {
  readonly workspace: string;
  readonly root: string;
  readonly tasks: string;
  readonly lock: string;
}

export interface JsonTaskStoreOptions {
  readonly idGenerator?: () => string;
  readonly atomicReplace?: (path: string, content: Buffer) => Promise<void>;
}

export class JsonTaskStore implements TaskStore {
  // 每次状态迁移都在同一锁内重载、校验并持久化完整任务图。
  readonly #workspaceInput: string;
  readonly #idGenerator: () => string;
  readonly #atomicReplace: (path: string, content: Buffer) => Promise<void>;

  constructor(workspace: string, options: JsonTaskStoreOptions = {}) {
    // 构造器只校验外部边界；idGenerator/atomicReplace 是测试可注入的确定性和故障点。
    if (typeof workspace !== "string" || workspace.trim().length === 0) {
      throw new TypeError("workspace must be a non-empty string");
    }
    if (options.idGenerator !== undefined && typeof options.idGenerator !== "function") {
      throw new TypeError("idGenerator must be a function");
    }
    if (options.atomicReplace !== undefined && typeof options.atomicReplace !== "function") {
      throw new TypeError("atomicReplace must be a function");
    }
    this.#workspaceInput = workspace;
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#atomicReplace = options.atomicReplace ?? atomicReplace;
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    // createTask 在锁内重载图、校验无环和唯一 ID，然后原子写入任务。
    const paths = await this.#preparePaths(true);
    if (paths === undefined) {
      throw new TaskStorageError("Task storage root could not be created");
    }
    return await this.#withLock(paths, async () => {
      // 锁内重建整张图，按“无碰撞 -> 依赖存在 -> 无自依赖 -> 全图无环”的顺序决定是否写入。
      const graph = await this.#loadGraph(paths);
      const id = this.#generatedId();
      if (graph.has(id)) {
        throw new TaskGraphError(`task id already exists: ${id}`);
      }
      const task = new Task({
        id,
        subject: input.subject,
        description: input.description === undefined ? "" : input.description,
        status: TaskStatus.PENDING,
        owner: null,
        blockedBy: input.blockedBy === undefined ? [] : input.blockedBy,
      });
      const candidate = new Map(graph);
      candidate.set(task.id, task);
      validateGraph(candidate);
      await this.#writeTask(paths, task);
      return task;
    });
  }

  async getTask(taskId: string): Promise<Task> {
    const id = canonicalTaskId(taskId);
    const paths = await this.#preparePaths(false);
    if (paths === undefined) {
      throw new TaskNotFoundError(`Task not found: ${id}`);
    }
    return await this.#withLock(paths, async () => {
      // 锁内重读全图后重新计算阻塞：即使锁外任务刚变 ready，临界区内也只能看到最新图。
      const task = (await this.#loadGraph(paths)).get(id);
      if (task === undefined) {
        throw new TaskNotFoundError(`Task not found: ${id}`);
      }
      return task;
    });
  }

  async listTasks(): Promise<readonly Task[]> {
    const paths = await this.#preparePaths(false);
    if (paths === undefined) {
      return Object.freeze([]);
    }
    return await this.#withLock(paths, async () =>
      Object.freeze(
        [...(await this.#loadGraph(paths)).values()].sort((left, right) =>
          compareText(left.id, right.id),
        ),
      ),
    );
  }

  async claimTask(taskId: string, owner: string): Promise<Task> {
    const id = canonicalTaskId(taskId);
    const normalizedOwner = normalizeOwner(owner);
    const paths = await this.#preparePaths(false);
    if (paths === undefined) {
      throw new TaskNotFoundError(`Task not found: ${id}`);
    }
    return await this.#withLock(paths, async () => {
      const graph = await this.#loadGraph(paths);
      const task = graph.get(id);
      if (task === undefined) {
        throw new TaskNotFoundError(`Task not found: ${id}`);
      }
      if (task.status !== TaskStatus.PENDING) {
        throw new TaskStateError(`Task ${id} must be pending to claim`);
      }
      const blockedBy = task.blockedBy.filter((dependency) => {
        const dependencyTask = graph.get(dependency);
        return dependencyTask === undefined || dependencyTask.status !== TaskStatus.COMPLETED;
      });
      if (blockedBy.length > 0) {
        throw new TaskBlockedError(id, blockedBy);
      }
      const claimed = new Task({ ...task, status: TaskStatus.IN_PROGRESS, owner: normalizedOwner });
      await this.#writeTask(paths, claimed);
      return claimed;
    });
  }

  async completeTask(taskId: string, owner: string): Promise<TaskCompletion> {
    const id = canonicalTaskId(taskId);
    const normalizedOwner = normalizeOwner(owner);
    const paths = await this.#preparePaths(false);
    if (paths === undefined) {
      throw new TaskNotFoundError(`Task not found: ${id}`);
    }
    return await this.#withLock(paths, async () => {
      const graph = await this.#loadGraph(paths);
      const task = graph.get(id);
      if (task === undefined) {
        throw new TaskNotFoundError(`Task not found: ${id}`);
      }
      if (task.status !== TaskStatus.IN_PROGRESS) {
        throw new TaskStateError(`Task ${id} must be in_progress to complete`);
      }
      if (task.owner !== normalizedOwner) {
        throw new TaskOwnershipError(`Task ${id} is owned by ${task.owner}`);
      }
      const completed = new Task({ ...task, status: TaskStatus.COMPLETED });
      const candidate = new Map(graph);
      candidate.set(id, completed);
      // 只报告直接依赖完成且全部依赖都已 completed 的 pending Task，不改写下游文件。
      const unblocked = [...candidate.values()]
        .filter(
          (dependent) =>
            dependent.status === TaskStatus.PENDING &&
            dependent.blockedBy.includes(id) &&
            dependent.blockedBy.every(
              (dependency) => candidate.get(dependency)?.status === TaskStatus.COMPLETED,
            ),
        )
        .sort((left, right) => compareText(left.id, right.id));
      await this.#writeTask(paths, completed);
      return Object.freeze({ task: completed, unblocked: Object.freeze(unblocked) });
    });
  }

  async #preparePaths(create: boolean): Promise<JsonTaskPaths | undefined> {
    // 每次操作都重新 realpath workspace，再校验 .agent_tutorial/.tasks 未逃逸。
    let workspace: string;
    try {
      workspace = await realpath(this.#workspaceInput);
      if (!(await stat(workspace)).isDirectory()) {
        throw new Error("workspace is not a directory");
      }
      const root = join(workspace, ".agent_tutorial");
      const tasks = join(root, ".tasks");
      if (create) {
        await mkdir(root, { recursive: true });
        await this.#validateRoot(workspace, root);
        await mkdir(tasks, { recursive: true });
      } else {
        if (!(await pathExists(root))) {
          return undefined;
        }
        await this.#validateRoot(workspace, root);
        if (!(await pathExists(tasks))) {
          return undefined;
        }
      }
      const paths = Object.freeze({
        workspace,
        root,
        tasks,
        lock: join(workspace, ".agent_tutorial", ".tasks.lock"),
      });
      await this.#validatePaths(paths);
      return paths;
    } catch (error) {
      if (error instanceof TaskError) {
        throw error;
      }
      throw new TaskStorageError("Task storage root is invalid", { cause: error });
    }
  }

  async #validatePaths(paths: JsonTaskPaths): Promise<void> {
    // 每次操作前再次校验 root/tasks/lock 的物理路径，防止符号链接逃逸。
    await this.#validateRoot(paths.workspace, paths.root);
    let resolvedRoot: string;
    let resolvedTasks: string;
    try {
      resolvedRoot = await realpath(paths.root);
      resolvedTasks = await realpath(paths.tasks);
    } catch (error) {
      throw new TaskStorageError("Task storage root could not be resolved", { cause: error });
    }
    if (
      !pathIsInside(paths.workspace, resolvedRoot) ||
      !pathIsInside(resolvedRoot, resolvedTasks)
    ) {
      throw new TaskStorageError("Task storage root escapes workspace");
    }
    const rootInformation = await stat(resolvedRoot);
    const taskInformation = await stat(resolvedTasks);
    if (!rootInformation.isDirectory() || !taskInformation.isDirectory()) {
      throw new TaskStorageError("Task storage root is not a directory");
    }
    if (await pathExists(paths.lock)) {
      const lockInformation = await lstat(paths.lock);
      if (lockInformation.isSymbolicLink()) {
        throw new TaskStorageError("Task lock path must not be a symbolic link");
      }
    }
  }

  async #validateRoot(workspace: string, root: string): Promise<void> {
    // root 必须是 workspace 内的真实目录；创建后与每次读取前都复查。
    let resolvedRoot: string;
    try {
      resolvedRoot = await realpath(root);
    } catch (error) {
      throw new TaskStorageError("Task storage root could not be resolved", { cause: error });
    }
    if (!pathIsInside(workspace, resolvedRoot)) {
      throw new TaskStorageError("Task storage root escapes workspace");
    }
    if (!(await stat(resolvedRoot)).isDirectory()) {
      throw new TaskStorageError("Task storage root is not a directory");
    }
  }

  async #withLock<T>(paths: JsonTaskPaths, operation: () => Promise<T>): Promise<T> {
    // 进程内队列 + 跨进程文件锁保证同一图上的读改写是一个临界区。
    return await withProcessMutex(paths.tasks, async () => {
      let release: (() => Promise<void>) | undefined;
      let windowsRaceRetries = 0;
      try {
        while (release === undefined) {
          try {
            release = await acquireFileLock(paths.tasks, {
              lockfilePath: paths.lock,
              realpath: true,
              stale: LOCK_STALE_MS,
              update: LOCK_UPDATE_MS,
              retries: 0,
            });
          } catch (error) {
            if (isWindowsLockRace(error) && windowsRaceRetries < MAX_WINDOWS_LOCK_RACE_RETRIES) {
              windowsRaceRetries += 1;
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
        return await operation();
      } catch (error) {
        if (error instanceof TaskError) {
          throw error;
        }
        throw new TaskStorageError("Task storage operation failed", { cause: error });
      } finally {
        if (release !== undefined) {
          await release();
        }
      }
    });
  }

  async #loadGraph(paths: JsonTaskPaths): Promise<Map<string, Task>> {
    // 重建必须加载并校验整张图；任一文件损坏都让整个 store 明确失败。
    let entries: readonly Dirent[];
    try {
      entries = (await readdir(paths.tasks, { withFileTypes: true }))
        .filter((entry) => entry.name.endsWith(".json"))
        .sort((left, right) => compareText(left.name, right.name));
    } catch (error) {
      throw new TaskStorageError("Task files could not be listed", { cause: error });
    }
    const graph = new Map<string, Task>();
    for (const entry of entries) {
      const path = join(paths.tasks, entry.name);
      let task: Task;
      try {
        const information = await lstat(path);
        if (!information.isFile() || information.isSymbolicLink()) {
          throw new Error("Task file is not a regular file");
        }
        const payload = JSON.parse(UTF8_DECODER.decode(await readFile(path))) as unknown;
        task = parseStoredTask(payload);
      } catch (error) {
        if (error instanceof TaskStorageError) {
          throw new TaskStorageError(`Task file is invalid: ${entry.name}`, { cause: error });
        }
        if (error instanceof TaskError) {
          throw error;
        }
        throw new TaskStorageError(`Task file is invalid: ${entry.name}`, { cause: error });
      }
      if (entry.name !== `${task.id}.json`) {
        throw new TaskStorageError(`Task filename does not match payload id: ${entry.name}`);
      }
      if (graph.has(task.id)) {
        throw new TaskStorageError(`Duplicate task id: ${task.id}`);
      }
      graph.set(task.id, task);
    }
    validateGraph(graph);
    return graph;
  }

  async #writeTask(paths: JsonTaskPaths, task: Task): Promise<void> {
    // 保存始终走原子替换，失败时旧文件保持不变。
    try {
      await this.#atomicReplace(join(paths.tasks, `${task.id}.json`), serializeTask(task));
    } catch (error) {
      if (error instanceof TaskError) {
        throw error;
      }
      throw new TaskStorageError(`Task file persist failed: ${task.id}`, { cause: error });
    }
  }

  #generatedId(): string {
    let value: string;
    try {
      value = this.#idGenerator();
    } catch (error) {
      throw new TaskGraphError("task id generator failed", { cause: error });
    }
    try {
      return canonicalTaskId(value);
    } catch (error) {
      throw new TaskGraphError("generated task id must be a canonical UUID", { cause: error });
    }
  }
}

function parseStoredTask(value: unknown): Task {
  // 磁盘 schema 必须精确匹配六个字段；额外或缺失字段都会让整张图恢复失败。
  if (!hasExactKeys(value, ["id", "subject", "description", "status", "owner", "blocked_by"])) {
    throw new TaskStorageError("Task file has an invalid schema");
  }
  if (
    typeof value.id !== "string" ||
    typeof value.subject !== "string" ||
    typeof value.description !== "string"
  ) {
    throw new TaskStorageError("Task file has invalid string fields");
  }
  if (
    (value.owner !== null && typeof value.owner !== "string") ||
    !Array.isArray(value.blocked_by) ||
    !value.blocked_by.every((dependency): dependency is string => typeof dependency === "string")
  ) {
    throw new TaskStorageError("Task file has invalid owner or dependency fields");
  }
  try {
    return new Task({
      id: value.id,
      subject: value.subject,
      description: value.description,
      status: value.status as TaskStatus,
      owner: value.owner,
      blockedBy: value.blocked_by,
    });
  } catch (error) {
    if (error instanceof TaskStorageError) {
      throw error;
    }
    throw new TaskStorageError("Task file has invalid fields", { cause: error });
  }
}

function serializeTask(task: Task): Buffer {
  // 固定字段顺序和结尾换行，让任务文件可 diff、可审计，也避免写盘内容随机漂移。
  const payload = {
    blocked_by: [...task.blockedBy],
    description: task.description,
    id: task.id,
    owner: task.owner,
    status: task.status,
    subject: task.subject,
  };
  return Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
}

function validateGraph(graph: ReadonlyMap<string, Task>): void {
  // 写入前验证依赖引用和环，保证后续 claim/complete 只处理有效 DAG。
  for (const task of graph.values()) {
    for (const dependency of task.blockedBy) {
      if (dependency === task.id) {
        throw new TaskGraphError(`Task ${task.id} must not depend on itself`);
      }
      if (!graph.has(dependency)) {
        throw new TaskGraphError(`Task ${task.id} dependency does not exist: ${dependency}`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new TaskGraphError(`Task graph contains a cycle at ${id}`);
    }
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    const task = graph.get(id);
    if (task === undefined) {
      throw new TaskGraphError(`Task graph references missing task ${id}`);
    }
    for (const dependency of task.blockedBy) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of graph.values()) {
    visit(task.id);
  }
}

async function atomicReplace(path: string, content: Buffer): Promise<void> {
  // 同目录临时文件先 sync，再用 rename 发布；最终路径从不暴露半写内容。
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
    if (handle !== undefined) {
      await handle.close();
    }
    await rm(temporary, { force: true });
  }
}

async function withProcessMutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  // 同一进程内的并发操作也排队，跨进程部分由文件锁保证。
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
    if (PROCESS_LOCK_TAILS.get(key) === tail) {
      PROCESS_LOCK_TAILS.delete(key);
    }
  }
}

function hasExactKeys<T extends readonly string[]>(
  value: unknown,
  keys: T,
): value is Record<T[number], unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function pathIsInside(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}

function isWindowsLockRace(error: unknown): boolean {
  return (
    hasErrorCode(error, "EBUSY") || hasErrorCode(error, "ENOTEMPTY") || hasErrorCode(error, "EPERM")
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
