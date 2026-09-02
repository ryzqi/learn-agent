// JSON 后台任务适配器：把 running/终态持久化到 workspace 内的安全目录，并通过文件锁和原子替换保证状态迁移一致。
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

import type { ToolResult } from "../core/tools.js";
import { isToolResult, toolError, toolSuccess } from "../core/tools.js";
import {
  BackgroundError,
  BackgroundJob,
  BackgroundJobNotFoundError,
  BackgroundJobStatus,
  BackgroundStorageError,
  canonicalBackgroundId,
  type BackgroundJobStore,
  type BackgroundJobStatus as BackgroundJobStatusValue,
} from "../features/background.js";

// 文件锁超过 30 秒未续期视为陈旧；10 秒续期并每 10ms 重试，兼顾低延迟与断线恢复。
const LOCK_STALE_MS = 30_000;
const LOCK_UPDATE_MS = 10_000;
const LOCK_RETRY_MS = 10;
// Windows 上 proper-lockfile 的临时目录竞争会表现为 EBUSY/ENOTEMPTY/EPERM，这里给有限重试。
const MAX_WINDOWS_LOCK_RACE_RETRIES = 100;
// 严格 UTF-8 解码器让损坏字节在解析阶段显式失败，而不是被替换成不可见乱码。
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
// 进程内锁队列：同一 key 的操作按链式 Promise 串行化，避免进程内并发越过跨进程文件锁。
const PROCESS_LOCK_TAILS = new Map<string, Promise<void>>();

export interface JsonBackgroundJobStoreOptions {
  // 测试可注入原子替换函数，用于模拟写盘故障；缺省使用同目录临时文件 + rename。
  readonly atomicReplace?: (path: string, content: Buffer) => Promise<void>;
}

// 适配器把后台 job 的 running/终态写入 workspace 内 JSON，核心只依赖 BackgroundJobStore 接口。
interface BackgroundPaths {
  // realpath 后的 workspace 根目录，用于验证所有状态路径都未逃逸。
  readonly workspace: string;
  // 运行时状态根目录，位于 workspace/.agent_tutorial。
  readonly stateRoot: string;
  // 后台作业 JSON 文件目录。
  readonly root: string;
  // 跨进程文件锁路径。
  readonly lock: string;
}

export class JsonBackgroundJobStore implements BackgroundJobStore {
  // 外部输入的 workspace 路径；每次操作时再解析真实路径。
  readonly #workspaceInput: string;
  // 原子替换写入函数；默认实现保证读者不会看到半写文件。
  readonly #atomicReplace: (path: string, content: Buffer) => Promise<void>;

  // 校验外部 workspace 与可选注入点；构造器不访问文件系统。
  constructor(workspace: string, options: JsonBackgroundJobStoreOptions = {}) {
    if (typeof workspace !== "string" || workspace.trim().length === 0) {
      throw new TypeError("workspace must be a non-empty string");
    }
    if (options.atomicReplace !== undefined && typeof options.atomicReplace !== "function") {
      throw new TypeError("atomicReplace must be a function");
    }
    this.#workspaceInput = workspace;
    this.#atomicReplace =
      options.atomicReplace === undefined ? atomicReplace : options.atomicReplace;
  }

  // 在锁内创建唯一的 running 记录，成功落盘后才允许 Supervisor 启动实际工作。
  async createRunning(input: {
    readonly jobId: string;
    readonly sourceToolCallId: string;
    readonly toolName: string;
  }): Promise<BackgroundJob> {
    // 先持久化 running，再允许 Supervisor 启动 worker；启动前的失败不会遗留可恢复的 job。
    const job = new BackgroundJob({
      id: input.jobId,
      sourceToolCallId: input.sourceToolCallId,
      toolName: input.toolName,
      status: BackgroundJobStatus.RUNNING,
      result: null,
    });
    const paths = await this.#preparePaths(true);
    if (paths === undefined) {
      throw new BackgroundStorageError("Background job root could not be created");
    }
    return await this.#withLock(paths, async () => {
      const jobs = await this.#loadJobs(paths);
      if (jobs.has(job.id)) {
        throw new BackgroundStorageError(`Background job id already exists: ${job.id}`);
      }
      await this.#persistJob(paths, job);
      return job;
    });
  }

  // 对指定作业执行 running -> 终态的条件写入，竞争失败时返回 undefined。
  async finishRunning(
    jobId: string,
    status: Exclude<BackgroundJobStatusValue, "running">,
    result: ToolResult,
  ): Promise<BackgroundJob | undefined> {
    // 条件迁移：只有磁盘中的状态仍是 running 才返回终态 job；后到竞争者返回 undefined。
    const id = normalizeLookupId(jobId);
    if (!isBackgroundJobStatus(status) || !isToolResult(result)) {
      throw new BackgroundStorageError("invalid terminal background job update");
    }
    const paths = await this.#preparePaths(false);
    if (paths === undefined) {
      throw new BackgroundJobNotFoundError(`Background job does not exist: ${id}`);
    }
    return await this.#withLock(paths, async () => {
      const job = (await this.#loadJobs(paths)).get(id);
      if (job === undefined) {
        throw new BackgroundJobNotFoundError(`Background job does not exist: ${id}`);
      }
      if (job.status !== BackgroundJobStatus.RUNNING) {
        return undefined;
      }
      const terminal = new BackgroundJob({ ...job, status, result });
      await this.#persistJob(paths, terminal);
      return terminal;
    });
  }

  // 恢复时批量中断遗留 running 作业，并返回本次真正发生迁移的有序快照。
  async interruptRunning(): Promise<readonly BackgroundJob[]> {
    // 进程重启时把遗留 running 统一迁移为 interrupted，并只发布一次中断事件。
    const paths = await this.#preparePaths(false);
    if (paths === undefined) {
      return [];
    }
    return await this.#withLock(paths, async () => {
      const interrupted: BackgroundJob[] = [];
      for (const job of [...(await this.#loadJobs(paths)).values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      )) {
        if (job.status !== BackgroundJobStatus.RUNNING) {
          continue;
        }
        const terminal = new BackgroundJob({
          ...job,
          status: BackgroundJobStatus.INTERRUPTED,
          result: toolError(
            "background_interrupted",
            "Background job was interrupted by a previous process exit",
          ),
        });
        await this.#persistJob(paths, terminal);
        interrupted.push(terminal);
      }
      return Object.freeze(interrupted);
    });
  }

  // 在共享锁保护下读取单个作业，格式错误和不存在统一映射为 not found。
  async getJob(jobId: string): Promise<BackgroundJob> {
    const id = normalizeLookupId(jobId);
    const paths = await this.#preparePaths(false);
    if (paths === undefined) {
      throw new BackgroundJobNotFoundError(`Background job does not exist: ${id}`);
    }
    return await this.#withLock(paths, async () => {
      const job = (await this.#loadJobs(paths)).get(id);
      if (job === undefined) {
        throw new BackgroundJobNotFoundError(`Background job does not exist: ${id}`);
      }
      return job;
    });
  }

  // 返回按规范 UUID 排序的不可变作业快照；存储目录尚未创建时视为空集合。
  async listJobs(): Promise<readonly BackgroundJob[]> {
    const paths = await this.#preparePaths(false);
    if (paths === undefined) {
      return [];
    }
    return await this.#withLock(paths, async () =>
      Object.freeze(
        [...(await this.#loadJobs(paths)).values()].sort((left, right) =>
          left.id.localeCompare(right.id),
        ),
      ),
    );
  }

  // 解析并校验状态目录；create=false 时缺失目录表示尚无作业，而不是存储故障。
  async #preparePaths(create: boolean): Promise<BackgroundPaths | undefined> {
    // 每次操作都解析真实路径并确认状态目录仍在 workspace 内，拒绝 symlink/junction 逃逸。
    try {
      const workspace = await realpath(this.#workspaceInput);
      if (!(await stat(workspace)).isDirectory()) {
        throw new Error("workspace is not a directory");
      }
      const stateRoot = join(workspace, ".agent_tutorial");
      const root = join(stateRoot, "background");
      if (create) {
        await mkdir(stateRoot, { recursive: true });
        await validateDirectory(workspace, stateRoot, "runtime state root");
        await mkdir(root, { recursive: true });
      } else {
        if (!(await pathExists(stateRoot))) {
          return undefined;
        }
        await validateDirectory(workspace, stateRoot, "runtime state root");
        if (!(await pathExists(root))) {
          return undefined;
        }
      }
      const paths = Object.freeze({
        workspace,
        stateRoot,
        root,
        lock: join(stateRoot, ".background.lock"),
      });
      await validateDirectory(workspace, root, "Background job root");
      if ((await pathExists(paths.lock)) && (await lstat(paths.lock)).isSymbolicLink()) {
        throw new BackgroundStorageError("Background job lock path must not be a symbolic link");
      }
      return paths;
    } catch (error) {
      if (error instanceof BackgroundError) {
        throw error;
      }
      throw new BackgroundStorageError("Background job root is invalid", { cause: error });
    }
  }

  // 把一次读改写操作包进进程内互斥与跨进程文件锁，并统一包装基础设施异常。
  async #withLock<T>(paths: BackgroundPaths, operation: () => Promise<T>): Promise<T> {
    // 进程内队列 + 跨进程文件锁，让读取、条件判断、写入成为同一个临界区。
    return await withProcessMutex(paths.root, async () => {
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
        await validateDirectory(paths.workspace, paths.root, "Background job root");
        return await operation();
      } catch (error) {
        if (error instanceof BackgroundError) {
          throw error;
        }
        throw new BackgroundStorageError("Background job storage operation failed", {
          cause: error,
        });
      } finally {
        if (release !== undefined) {
          await release();
        }
      }
    });
  }

  // 加载并验证完整目录快照；任一文件损坏时拒绝返回部分可信结果。
  async #loadJobs(paths: BackgroundPaths): Promise<Map<string, BackgroundJob>> {
    // 加载时校验文件名、payload id、UTF-8、JSON schema 与状态不变量；任一文件损坏都让整批失败。
    let entries: readonly Dirent[];
    try {
      entries = (await readdir(paths.root, { withFileTypes: true }))
        .filter((entry) => entry.name.endsWith(".json"))
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      throw new BackgroundStorageError("Background job directory could not be listed", {
        cause: error,
      });
    }
    const jobs = new Map<string, BackgroundJob>();
    for (const entry of entries) {
      const path = join(paths.root, entry.name);
      const details = await lstat(path);
      if (!details.isFile() || details.isSymbolicLink()) {
        throw new BackgroundStorageError(`Background job file is not regular: ${entry.name}`);
      }
      let job: BackgroundJob;
      try {
        const expectedId = canonicalBackgroundId(entry.name.slice(0, -5));
        job = parseStoredJob(JSON.parse(UTF8_DECODER.decode(await readFile(path))) as unknown);
        if (job.id !== expectedId) {
          throw new BackgroundStorageError(
            `Background job filename does not match payload id: ${entry.name}`,
          );
        }
      } catch (error) {
        if (error instanceof BackgroundError) {
          throw error;
        }
        throw new BackgroundStorageError(`Background job file is invalid: ${entry.name}`, {
          cause: error,
        });
      }
      if (jobs.has(job.id)) {
        throw new BackgroundStorageError(`Duplicate persisted background job id: ${job.id}`);
      }
      jobs.set(job.id, job);
    }
    return jobs;
  }

  // 以稳定 JSON 结构原子替换单个作业文件，保留旧文件直到新内容完整写入。
  async #persistJob(paths: BackgroundPaths, job: BackgroundJob): Promise<void> {
    // 使用稳定字段顺序的 JSON 通过原子替换落盘，失败时旧文件保持不变。
    const payload = {
      id: job.id,
      result:
        job.result === null
          ? null
          : {
              content: job.result.content,
              error_code: job.result.errorCode ?? null,
              is_error: job.result.isError,
            },
      source_tool_call_id: job.sourceToolCallId,
      status: job.status,
      tool_name: job.toolName,
    };
    try {
      await this.#atomicReplace(
        join(paths.root, `${job.id}.json`),
        Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8"),
      );
    } catch (error) {
      if (error instanceof BackgroundError) {
        throw error;
      }
      throw new BackgroundStorageError(`Could not persist background job ${job.id}`, {
        cause: error,
      });
    }
  }
}

function parseStoredJob(value: unknown): BackgroundJob {
  // 磁盘结果先做严格 schema 校验，再归一成 ToolResult；展示层剥离 Error 前缀。
  if (!hasExactKeys(value, ["id", "source_tool_call_id", "tool_name", "status", "result"])) {
    throw new BackgroundStorageError("Background job file has an invalid schema");
  }
  if (
    typeof value.id !== "string" ||
    typeof value.source_tool_call_id !== "string" ||
    typeof value.tool_name !== "string" ||
    !isBackgroundJobStatus(value.status)
  ) {
    throw new BackgroundStorageError("Background job file has invalid fields");
  }
  let result: ToolResult | null = null;
  if (value.result !== null) {
    if (
      !hasExactKeys(value.result, ["content", "error_code", "is_error"]) ||
      typeof value.result.content !== "string" ||
      typeof value.result.is_error !== "boolean" ||
      (value.result.error_code !== null && typeof value.result.error_code !== "string")
    ) {
      throw new BackgroundStorageError("Background job file has invalid result");
    }
    if (value.result.is_error && typeof value.result.error_code !== "string") {
      throw new BackgroundStorageError("Background job error result requires error_code");
    }
    if (!value.result.is_error && value.result.error_code !== null) {
      throw new BackgroundStorageError("Successful background job result cannot have error_code");
    }
    if (value.result.is_error) {
      const errorCode = value.result.error_code;
      if (typeof errorCode !== "string") {
        throw new BackgroundStorageError("Background job error result requires error_code");
      }
      result = toolError(errorCode, value.result.content.replace(/^Error \[[^\]]+\]: /u, ""));
    } else {
      result = toolSuccess(value.result.content);
    }
  }
  return new BackgroundJob({
    id: value.id,
    sourceToolCallId: value.source_tool_call_id,
    toolName: value.tool_name,
    status: value.status,
    result,
  });
}

// 查询 id 规范化失败统一转 not found，避免把格式错误暴露成存储错误。
function normalizeLookupId(value: string): string {
  try {
    return canonicalBackgroundId(value);
  } catch (_error) {
    throw new BackgroundJobNotFoundError("Background job id must be a canonical UUID");
  }
}

// 磁盘 JSON 必须恰好包含预期字段；多余或缺失字段都按损坏处理。
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

// 对目录执行 realpath 后再验证工作区归属，阻止符号链接或 junction 绕过路径边界。
async function validateDirectory(workspace: string, path: string, label: string): Promise<void> {
  const resolved = await realpath(path);
  if (!pathIsInside(workspace, resolved) || !(await stat(resolved)).isDirectory()) {
    throw new BackgroundStorageError(`${label} escapes workspace or is not a directory`);
  }
}

// 只把 ENOENT 解释为不存在；权限和 I/O 错误继续交给上层存储边界处理。
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

// 相对路径为空或仍位于 parent 内才返回 true；绝对路径与 ../ 逃逸都拒绝。
function pathIsInside(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

// 同一状态目录的调用共享 Promise 尾队列，避免本进程内同时争用同一文件锁。
async function withProcessMutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  // 进程内锁串行化同一 store 的并发调用；跨进程部分由 proper-lockfile 的文件锁保证。
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

// 使用同目录临时文件、fsync 和 rename 实现单文件原子替换，并始终清理临时文件。
async function atomicReplace(path: string, content: Buffer): Promise<void> {
  // 同目录临时文件先 fsync 再 rename，最终路径从不暴露半写内容。
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

// 安全读取 Node 错误对象上的 code 字段，用于识别可重试文件系统错误。
function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}

// Windows 锁文件清理或改名瞬间的竞争错误集合。
function isWindowsLockRace(error: unknown): boolean {
  return (
    hasErrorCode(error, "EBUSY") || hasErrorCode(error, "ENOTEMPTY") || hasErrorCode(error, "EPERM")
  );
}

// 锁竞争和重试之间的短暂等待。
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

// 持久化状态必须是六个状态字面量之一，未知字符串不能进入领域对象。
function isBackgroundJobStatus(value: unknown): value is BackgroundJobStatusValue {
  return Object.values(BackgroundJobStatus).some((status) => status === value);
}
