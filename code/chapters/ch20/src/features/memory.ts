// 持久记忆：用带文件锁的 manifest 与 markdown 记录管理跨会话记忆，并通过模型选择、提取、合并完成生命周期。
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { lock as acquireFileLock } from "proper-lockfile";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { isWindowsReservedComponent } from "../core/filesystem.js";
import {
  assistantMessage,
  systemMessage,
  toolCall,
  toolMessage,
  userMessage,
  validateToolPairing,
} from "../core/messages.js";
import type { ChatMessage, ToolCall } from "../core/messages.js";
import type { ModelClient } from "../core/model.js";

// memory.ts 负责第 9 章的文件级记忆：安全记录、manifest 权威集合、模型 side-query 与回合生命周期。
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MEMORY_FILENAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const CJK_RUN_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff]+/gu;
// 单条记忆和派生目录都设预算，避免“记忆文件”反向把上下文撑爆。
const MAX_MEMORY_LINES = 200;
const MAX_MEMORY_BYTES = 4_096;
// 锁参数：短重试避免忙等，stale/update 交给 proper-lockfile 处理崩溃遗留锁。
const LOCK_RETRY_MS = 10;
const LOCK_STALE_MS = 30_000;
const LOCK_UPDATE_MS = 10_000;
const MAX_WINDOWS_LOCK_RACE_RETRIES = 100;
// 进程内互斥尾链：同进程并发回合先排队，再尝试跨进程文件锁。
const PROCESS_LOCK_TAILS = new Map<string, Promise<void>>();

// 三个 side-query 输出都直接进入 JSON.parse()，不做围栏剥离或子串截取；
// 因此系统提示必须明确禁止 Markdown 代码块和解释文字，降低真实模型附加围栏的概率。
const NO_FENCE_INSTRUCTION =
  "直接输出纯 JSON 文本，禁止使用 Markdown 代码块或反引号包裹，禁止输出任何解释文字。";
const SELECTOR_SYSTEM_PROMPT = `从目录中选择与查询直接相关的记忆名称。
只能返回 JSON 字符串数组，不得调用工具；没有相关项时返回 []。
${NO_FENCE_INSTRUCTION}`;
const EXTRACTOR_SYSTEM_PROMPT = `从会话中提取值得跨会话保留的新记忆。
只能返回 JSON 数组，不得调用工具。每项必须且只能包含 name、type、description、body；
type 只能是 user、feedback、project、reference，没有新记忆时返回 []。
name 必须是安全的小写 slug：只能包含小写字母、数字，多个词之间用单个连字符 - 分隔，禁止下划线、空格、大写字母或中文字符。
${NO_FENCE_INSTRUCTION}`;
const CONSOLIDATOR_SYSTEM_PROMPT = `整理给定记忆，合并重复或冲突内容，不得调用工具。
只能返回 JSON object，必须且只能包含 source_names 和 records；
source_names 是被替换的原记忆名称，records 是非空的新记忆数组。
${NO_FENCE_INSTRUCTION}`;

export class MemoryStoreError extends Error {
  // 文件记忆的名称、索引和正文必须作为一个受锁保护的持久化集合维护。
  override readonly name: string = "MemoryStoreError";
}

export const MemoryType = Object.freeze({
  USER: "user",
  FEEDBACK: "feedback",
  PROJECT: "project",
  REFERENCE: "reference",
} as const);

// 记忆类别用于选择和整理阶段的稳定路由，不允许模型写入其他类型。
export type MemoryType = (typeof MemoryType)[keyof typeof MemoryType];

// MemoryRecord 是不可变值对象；名称直接决定文件名，因此先做安全 slug 校验再落盘。
export interface MemoryRecordOptions {
  // slug 同时作为逻辑名称和文件名的一部分，必须保持稳定且安全。
  readonly name: string;
  // 目录索引展示的一行摘要。
  readonly description: string;
  // 便于按用户偏好、反馈、项目或参考资料分类。
  readonly kind: MemoryType;
  // 记忆正文，序列化前会统一换行并执行大小预算。
  readonly body: string;
}

export class MemoryRecord {
  readonly name: string;
  readonly description: string;
  readonly kind: MemoryType;
  readonly body: string;

  constructor(options: MemoryRecordOptions) {
    if (
      typeof options.name !== "string" ||
      !SLUG_PATTERN.test(options.name) ||
      isWindowsReservedComponent(options.name)
    ) {
      throw new MemoryStoreError("memory name must be a safe lowercase slug");
    }
    if (typeof options.description !== "string" || options.description.trim().length === 0) {
      throw new MemoryStoreError("memory description must be a non-empty string");
    }
    if (options.description.includes("\n") || options.description.includes("\r")) {
      throw new MemoryStoreError("memory description must fit on one line");
    }
    if (!isMemoryType(options.kind)) {
      throw new MemoryStoreError("memory kind must be MemoryType");
    }
    if (typeof options.body !== "string" || options.body.trim().length === 0) {
      throw new MemoryStoreError("memory body must be a non-empty string");
    }

    this.name = options.name;
    this.description = options.description;
    this.kind = options.kind;
    this.body = stripOuterNewlines(options.body.replace(/\r\n|\r/gu, "\n"));
    const serialized = serializeMemory(this);
    enforceMemoryBudget(serialized);
    Object.freeze(this);
  }
}

export interface MemorySelector {
  select(query: string, catalog: string): Promise<string>;
}

export interface MemoryExtractor {
  extract(history: readonly ChatMessage[], catalog: string): Promise<string>;
}

export interface MemoryConsolidator {
  consolidate(records: readonly MemoryRecord[]): Promise<string>;
}

// 选择、提取、整理都通过同一个无工具模型边界调用，输出必须是完整 JSON/文本。
export class ModelMemoryQueries implements MemorySelector, MemoryExtractor, MemoryConsolidator {
  readonly #model: ModelClient;

  constructor(model: ModelClient) {
    if (typeof model?.complete !== "function") {
      throw new TypeError("model must implement ModelClient");
    }
    this.#model = model;
  }

  async select(query: string, catalog: string): Promise<string> {
    return await this.#complete([
      systemMessage(SELECTOR_SYSTEM_PROMPT),
      userMessage(stableJson({ catalog, query })),
    ]);
  }

  async extract(history: readonly ChatMessage[], catalog: string): Promise<string> {
    const snapshot = copyHistory(history);
    validateToolPairing(snapshot);
    return await this.#complete([
      systemMessage(EXTRACTOR_SYSTEM_PROMPT),
      ...snapshot,
      userMessage(stableJson({ existing_catalog: catalog })),
    ]);
  }

  async consolidate(records: readonly MemoryRecord[]): Promise<string> {
    const snapshot = validateRecordCollection(records, false);
    return await this.#complete([
      systemMessage(CONSOLIDATOR_SYSTEM_PROMPT),
      userMessage(stableJson(snapshot.map(memoryRecordPayload))),
    ]);
  }

  async #complete(messages: readonly ChatMessage[]): Promise<string> {
    // 三个 memory side-query 都强制无工具、stop 和非空完整文本；JSON 解析交给调用方。
    const reply = await this.#model.complete(
      Object.freeze({ messages: Object.freeze([...messages]), tools: Object.freeze([]) }),
    );
    if (reply.message.toolCalls.length > 0) {
      throw new MemoryStoreError("memory model must not call tools");
    }
    if (reply.finishReason !== "stop") {
      throw new MemoryStoreError(
        `memory model finishReason must be stop, got ${reply.finishReason}`,
      );
    }
    const content = reply.message.content;
    if (content === null || content.trim().length === 0) {
      throw new MemoryStoreError("memory model must return non-empty text");
    }
    return content;
  }
}

interface StoredMemory {
  readonly filename: string;
  readonly record: MemoryRecord;
}

interface ConsolidationPlan {
  readonly sourceNames: readonly string[];
  readonly records: readonly MemoryRecord[];
}

// 持久文件三份：manifest 是权威指针，MEMORY.md 是可重建目录，*.md 存正文；.lock 仅用于跨进程互斥。
interface MemoryStorePaths {
  readonly workspace: string;
  readonly root: string;
  readonly manifest: string;
  readonly index: string;
  readonly lock: string;
}

export interface MemoryStoreOptions {
  // 所有 .memory 文件都归属于此工作区，不能跨工作区读取。
  readonly workspace: string;
  // 生成记录文件后缀的 slug 工厂，可在测试中固定。
  readonly idGenerator?: () => string;
  // 派生 MEMORY.md 索引的行数上限。
  readonly maxIndexLines?: number;
  // 派生 MEMORY.md 索引的 UTF-8 字节上限。
  readonly maxIndexBytes?: number;
}

export interface ApplyConsolidationOptions {
  readonly baseRecords: readonly MemoryRecord[];
  readonly additions: readonly MemoryRecord[];
  readonly sourceNames: readonly string[];
  readonly replacements: readonly MemoryRecord[];
}

// MemoryStore 是记忆集合的唯一事务入口，所有读改写都通过进程内队列与文件锁串行。
export class MemoryStore {
  // 存取均经进程内互斥和跨进程文件锁，避免并发回合破坏索引与记录一致性。
  readonly #workspaceInput: string;
  readonly #idGenerator: () => string;
  readonly #maxIndexLines: number;
  readonly #maxIndexBytes: number;

  constructor(options: MemoryStoreOptions) {
    if (typeof options.workspace !== "string" || options.workspace.trim().length === 0) {
      throw new TypeError("workspace must be a non-empty string");
    }
    const maxIndexLines = options.maxIndexLines === undefined ? 200 : options.maxIndexLines;
    const maxIndexBytes = options.maxIndexBytes === undefined ? 4_096 : options.maxIndexBytes;
    requirePositiveInteger("maxIndexLines", maxIndexLines);
    requirePositiveInteger("maxIndexBytes", maxIndexBytes);
    if (options.idGenerator !== undefined && typeof options.idGenerator !== "function") {
      throw new TypeError("idGenerator must be a function");
    }

    this.#workspaceInput = options.workspace;
    this.#idGenerator = options.idGenerator === undefined ? randomMemoryId : options.idGenerator;
    this.#maxIndexLines = maxIndexLines;
    this.#maxIndexBytes = maxIndexBytes;
  }

  // 读取记录：根目录不存在视为空集合，存在时先校验边界，再在锁内按 manifest 加载。
  async records(): Promise<readonly MemoryRecord[]> {
    // 读取入口：目录不存在时视为空集合；存在时必须先校验根目录，再在锁内按 manifest 重读集合。
    const paths = await this.#resolvePaths();
    if (!(await pathExists(paths.root))) {
      return Object.freeze([]);
    }
    await this.#validateRoot(paths);
    return await this.#withLock(paths, async () =>
      Object.freeze((await this.#loadStored(paths)).map((item) => item.record)),
    );
  }

  // 渲染目录：只读取轻量索引，不把正文拼进模型上下文。
  async renderCatalog(): Promise<string> {
    // 目录入口只返回 name、文件名和单行描述，selector 不直接读取全部正文。
    const paths = await this.#resolvePaths();
    if (!(await pathExists(paths.root))) {
      return "";
    }
    await this.#validateRoot(paths);
    return await this.#withLock(paths, async () =>
      this.#renderIndex(await this.#loadStored(paths)),
    );
  }

  async add(record: MemoryRecord): Promise<void> {
    await this.extend([record]);
  }

  // 新增记忆：先拒绝重名，再独占写正文文件，最后原子提交 manifest 和 MEMORY.md。
  async extend(records: readonly MemoryRecord[]): Promise<void> {
    // extend() 只追加新名称；同一名称重复写入会在锁内失败，避免静默覆盖已有记忆。
    const validated = validateRecordCollection(records, true);
    if (validated.length === 0) {
      return;
    }
    const paths = await this.#resolvePaths();
    await this.#prepareRoot(paths);
    await this.#withLock(paths, async () => {
      const current = await this.#loadStored(paths);
      const currentNames = new Set(current.map((item) => item.record.name));
      const duplicates = validated
        .map((record) => record.name)
        .filter((name) => currentNames.has(name));
      if (duplicates.length > 0) {
        throw new MemoryStoreError(
          `memory names already exist: ${[...duplicates].sort().join(", ")}`,
        );
      }

      const filenames = validated.map((record) => this.#newFilename(record.name));
      const candidate = [
        ...current,
        ...validated.map((record, index): StoredMemory => {
          const filename = filenames[index];
          if (filename === undefined) {
            throw new MemoryStoreError("memory filename generation failed");
          }
          return Object.freeze({ filename, record });
        }),
      ];
      const index = this.#renderIndex(candidate);
      const written = await this.#writeRecordFiles(
        paths,
        validated.map((record, recordIndex) => {
          const filename = filenames[recordIndex];
          if (filename === undefined) {
            throw new MemoryStoreError("memory filename generation failed");
          }
          return Object.freeze({ filename, record });
        }),
      );
      try {
        await this.#commit(paths, candidate, index);
      } catch (error) {
        await removePaths(written);
        throw error;
      }
    });
  }

  // 合并记忆：先校验 base 未漂移，再写新文件并提交，成功后才删除被替换的旧文件。
  async applyConsolidation(options: ApplyConsolidationOptions): Promise<void> {
    // 整理事务：先在锁内重读 manifest，发现 baseRecords 已变化立即失败；提交后才清理被替换的旧文件。
    const base = validateRecordCollection(options.baseRecords, true);
    const additions = validateRecordCollection(options.additions, true);
    const replacements = validateRecordCollection(options.replacements, false);
    const candidates = validateRecordCollection([...base, ...additions], true);
    validateConsolidationSources(options.sourceNames, candidates);

    const paths = await this.#resolvePaths();
    await this.#prepareRoot(paths);
    await this.#withLock(paths, async () => {
      const current = await this.#loadStored(paths);
      const currentByName = new Map(current.map((item) => [item.record.name, item]));
      if (
        base.some((record) => {
          const stored = currentByName.get(record.name);
          return stored === undefined || !recordsEqual(stored.record, record);
        })
      ) {
        throw new MemoryStoreError("memory collection changed during consolidation");
      }

      const sourceSet = new Set(options.sourceNames);
      const retained = current.filter((item) => !sourceSet.has(item.record.name));
      const pending = [
        ...additions.filter((record) => !sourceSet.has(record.name)),
        ...replacements,
      ];
      validateRecordCollection([...retained.map((item) => item.record), ...pending], false);
      const additionsToStore = pending.map(
        (record): StoredMemory =>
          Object.freeze({ filename: this.#newFilename(record.name), record }),
      );
      const candidate = [...retained, ...additionsToStore];
      const index = this.#renderIndex(candidate);
      const written = await this.#writeRecordFiles(paths, additionsToStore);
      try {
        await this.#commit(paths, candidate, index);
      } catch (error) {
        await removePaths(written);
        throw error;
      }

      await Promise.all(
        current
          .filter((item) => sourceSet.has(item.record.name))
          .map((item) => rm(join(paths.root, item.filename), { force: true })),
      );
    });
  }

  // 每次操作先通过 realpath 固定 workspace，再在 .memory 下构造路径，避免相对路径漂移。
  async #resolvePaths(): Promise<MemoryStorePaths> {
    const workspace = await realpath(this.#workspaceInput);
    if (!(await stat(workspace)).isDirectory()) {
      throw new TypeError(`workspace is not a directory: ${this.#workspaceInput}`);
    }
    const root = join(workspace, ".memory");
    return Object.freeze({
      workspace,
      root,
      manifest: join(root, "manifest.json"),
      index: join(root, "MEMORY.md"),
      lock: join(root, ".lock"),
    });
  }

  async #prepareRoot(paths: MemoryStorePaths): Promise<void> {
    await mkdir(paths.root, { recursive: true });
    await this.#validateRoot(paths);
  }

  async #validateRoot(paths: MemoryStorePaths): Promise<void> {
    let resolvedRoot: string;
    try {
      resolvedRoot = await realpath(paths.root);
    } catch (error) {
      throw new MemoryStoreError("memory root could not be resolved", { cause: error });
    }
    if (resolvedRoot !== paths.root || !pathIsInside(paths.workspace, resolvedRoot)) {
      throw new MemoryStoreError("memory root escapes workspace");
    }
    if (!(await stat(resolvedRoot)).isDirectory()) {
      throw new MemoryStoreError("memory root is not a directory");
    }
  }

  // 两层锁：进程内 mutex 排队同进程任务，proper-lockfile 在跨进程间串行文件事务。
  async #withLock<T>(paths: MemoryStorePaths, operation: () => Promise<T>): Promise<T> {
    return await withProcessMutex(paths.root, async () =>
      this.#withCrossProcessLock(paths, operation),
    );
  }

  // .lock 由 proper-lockfile 管理；stale/update 参数负责崩溃后的锁恢复。
  async #withCrossProcessLock<T>(paths: MemoryStorePaths, operation: () => Promise<T>): Promise<T> {
    let release: () => Promise<void>;
    let windowsRaceRetries = 0;
    while (true) {
      try {
        release = await acquireFileLock(paths.root, {
          lockfilePath: paths.lock,
          realpath: true,
          stale: LOCK_STALE_MS,
          update: LOCK_UPDATE_MS,
          retries: 0,
        });
        break;
      } catch (error) {
        if (isWindowsLockRace(error) && windowsRaceRetries < MAX_WINDOWS_LOCK_RACE_RETRIES) {
          windowsRaceRetries += 1;
          await delay(LOCK_RETRY_MS);
          continue;
        }
        if (!hasErrorCode(error, "EEXIST")) {
          if (!hasErrorCode(error, "ELOCKED")) {
            throw error;
          }
        }
        await delay(LOCK_RETRY_MS);
      }
    }
    try {
      await this.#validateRoot(paths);
      return await operation();
    } finally {
      await release();
    }
  }

  // 文件名追加唯一 ID，使提交新集合时不会覆盖同一名称的旧记录文件。
  #newFilename(name: string): string {
    const identifier = this.#idGenerator();
    if (typeof identifier !== "string" || !SLUG_PATTERN.test(identifier)) {
      throw new MemoryStoreError("generated memory id must be a safe lowercase slug");
    }
    return `${name}-${identifier}.md`;
  }

  async #writeRecordFiles(
    paths: MemoryStorePaths,
    records: readonly StoredMemory[],
  ): Promise<readonly string[]> {
    // 用 "wx" 独占创建记录文件，写入并 fsync 后回读校验，失败时清理本轮文件。
    const written: string[] = [];
    try {
      for (const item of records) {
        const path = join(paths.root, item.filename);
        let handle: FileHandle;
        try {
          handle = await open(path, "wx");
        } catch (error) {
          if (hasErrorCode(error, "EEXIST")) {
            throw new MemoryStoreError(`memory file already exists: ${item.filename}`, {
              cause: error,
            });
          }
          throw error;
        }
        written.push(path);
        try {
          await handle.writeFile(serializeMemory(item.record));
          await handle.sync();
        } finally {
          await handle.close();
        }
        const verified = parseMemory(await readFile(path));
        if (!recordsEqual(verified, item.record)) {
          throw new MemoryStoreError(`memory file verification failed: ${item.filename}`);
        }
      }
    } catch (error) {
      await removePaths(written);
      throw error;
    }
    return Object.freeze(written);
  }

  async #commit(
    paths: MemoryStorePaths,
    records: readonly StoredMemory[],
    index: string,
  ): Promise<void> {
    // 先原子替换可重建的 MEMORY.md，再原子替换权威 manifest；失败时回滚索引。
    const manifest = Buffer.from(
      JSON.stringify({ version: 1, files: records.map((item) => item.filename) }),
      "utf8",
    );
    const previousIndex = (await pathExists(paths.index)) ? await readFile(paths.index) : undefined;
    await atomicReplace(paths.index, Buffer.from(index, "utf8"));
    try {
      await atomicReplace(paths.manifest, manifest);
    } catch (error) {
      if (previousIndex === undefined) {
        await rm(paths.index, { force: true });
      } else {
        await atomicReplace(paths.index, previousIndex);
      }
      throw error;
    }
  }

  async #loadStored(paths: MemoryStorePaths): Promise<readonly StoredMemory[]> {
    // 读取端不信任目录扫描，而是重新校验 manifest、文件名、realpath 与每条记录。
    if (!(await pathExists(paths.manifest))) {
      return Object.freeze([]);
    }
    let manifest: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(paths.manifest));
      manifest = JSON.parse(text);
    } catch (error) {
      throw new MemoryStoreError("memory manifest is not valid UTF-8 JSON", { cause: error });
    }
    if (!isStrictManifest(manifest)) {
      throw new MemoryStoreError("memory manifest has an invalid schema");
    }
    if (new Set(manifest.files).size !== manifest.files.length) {
      throw new MemoryStoreError("memory manifest filenames must be unique");
    }
    if (manifest.files.length > this.#maxIndexLines) {
      throw new MemoryStoreError("memory manifest exceeds the index line limit");
    }

    const stored: StoredMemory[] = [];
    for (const filename of manifest.files) {
      if (!MEMORY_FILENAME_PATTERN.test(filename) || isWindowsReservedComponent(filename)) {
        throw new MemoryStoreError(`memory manifest contains an unsafe filename: ${filename}`);
      }
      const path = join(paths.root, filename);
      let resolvedPath: string;
      try {
        resolvedPath = await realpath(path);
      } catch (error) {
        throw new MemoryStoreError(`memory file could not be read: ${filename}`, { cause: error });
      }
      if (!pathIsInside(paths.root, resolvedPath)) {
        throw new MemoryStoreError(`memory file escapes the store: ${filename}`);
      }
      let record: MemoryRecord;
      try {
        record = parseMemory(await readFile(resolvedPath));
      } catch (error) {
        if (error instanceof MemoryStoreError) {
          throw error;
        }
        throw new MemoryStoreError(`memory file could not be read: ${filename}`, { cause: error });
      }
      stored.push(Object.freeze({ filename, record }));
    }
    return Object.freeze(stored);
  }

  #renderIndex(records: readonly StoredMemory[]): string {
    // MEMORY.md 只保留名称、文件名和单行描述，作为 selector 的轻量目录。
    if (records.length > this.#maxIndexLines) {
      throw new MemoryStoreError("memory index exceeds the index line limit");
    }
    const index = records
      .map((item) => `- [${item.record.name}](${item.filename}) - ${item.record.description}`)
      .join("\n");
    const rendered = index.length === 0 ? "" : `${index}\n`;
    if (Buffer.byteLength(rendered, "utf8") > this.#maxIndexBytes) {
      throw new MemoryStoreError("memory index exceeds the index byte limit");
    }
    return rendered;
  }
}

// MemorySession 把 MemoryStore 包装成 AgentRunner 可调用的回合生命周期。
export interface MemorySessionOptions {
  readonly store: MemoryStore;
  readonly selector?: MemorySelector;
  readonly extractor?: MemoryExtractor;
  readonly consolidator?: MemoryConsolidator;
  readonly maxSelected?: number;
  readonly consolidateThreshold?: number;
  readonly emitContextMessages?: boolean;
}

export class MemorySession {
  // 生命周期在回合前选择相关记忆、回合后提取并合并，模型不会直接写文件。
  readonly #store: MemoryStore;
  readonly #selector: MemorySelector | undefined;
  readonly #extractor: MemoryExtractor | undefined;
  readonly #consolidator: MemoryConsolidator | undefined;
  readonly #maxSelected: number;
  readonly #consolidateThreshold: number;
  readonly #emitContextMessages: boolean;
  // 当前回合选中的只读快照；下一回合 beginTurn 会完全替换。
  #selected: readonly MemoryRecord[] = Object.freeze([]);
  // 记忆 side-query 或持久化失败只记录在此，不阻断主 Agent 回答。
  #lastError: string | undefined;

  constructor(options: MemorySessionOptions) {
    const maxSelected = options.maxSelected === undefined ? 5 : options.maxSelected;
    const consolidateThreshold =
      options.consolidateThreshold === undefined ? 10 : options.consolidateThreshold;
    requirePositiveInteger("maxSelected", maxSelected);
    requirePositiveInteger("consolidateThreshold", consolidateThreshold);
    this.#store = options.store;
    this.#selector = options.selector;
    this.#extractor = options.extractor;
    this.#consolidator = options.consolidator;
    this.#maxSelected = maxSelected;
    this.#consolidateThreshold = consolidateThreshold;
    this.#emitContextMessages =
      options.emitContextMessages === undefined ? true : options.emitContextMessages;
  }

  get selected(): readonly MemoryRecord[] {
    return this.#selected;
  }

  get lastError(): string | undefined {
    return this.#lastError;
  }

  // 回合开始先读当前集合；模型选择失败时使用确定性关键词回退，不让记忆问题中断主任务。
  // 回合前选择相关记忆；模型选择失败时退回确定性关键词匹配。
  async beginTurn(query: string): Promise<void> {
    const records = await this.#store.records();
    this.#selected = Object.freeze([]);
    this.#lastError = undefined;
    if (records.length === 0) {
      return;
    }

    if (this.#selector !== undefined) {
      try {
        const output = await this.#selector.select(query, await this.#store.renderCatalog());
        const names = parseSelectedNames(output);
        const byName = new Map(records.map((record) => [record.name, record]));
        if (names.some((name) => !byName.has(name))) {
          throw new MemoryStoreError("selector returned an unknown memory name");
        }
        this.#selected = Object.freeze(
          names.slice(0, this.#maxSelected).map((name) => {
            const selected = byName.get(name);
            if (selected === undefined) {
              throw new MemoryStoreError("selector returned an unknown memory name");
            }
            return selected;
          }),
        );
        return;
      } catch {
        this.#lastError = "Memory selection failed; deterministic fallback used";
      }
    }
    this.#selected = keywordSelect(query, records, this.#maxSelected);
  }

  // 只把选中记忆作为 system context 附加到下一次模型请求，不写入 canonical history。
  beforeModel(): readonly ChatMessage[] {
    if (!this.#emitContextMessages || this.#selected.length === 0) {
      return Object.freeze([]);
    }
    return Object.freeze([systemMessage(this.renderSelected())]);
  }

  renderSelected(): string {
    if (this.#selected.length === 0) {
      return "";
    }
    const sections = ["<relevant_memories>"];
    for (const record of this.#selected) {
      sections.push(`## ${record.name} (${record.kind})`, record.description, record.body);
    }
    sections.push("</relevant_memories>");
    return sections.join("\n\n");
  }

  // 回合结束用完整 canonical history 提取；提取、整理或写入失败只记录 lastError，不改变旧集合。
  // 回合结束从完整 canonical history 提取并追加或整理记忆。
  async complete(history: readonly ChatMessage[]): Promise<void> {
    const current = await this.#store.records();
    let candidate = current;
    let extracted: readonly MemoryRecord[] = Object.freeze([]);
    if (this.#extractor !== undefined) {
      try {
        const snapshot = copyHistory(history);
        const output = await this.#extractor.extract(snapshot, await this.#store.renderCatalog());
        extracted = parseRecordList(output, true);
        candidate = validateRecordCollection([...current, ...extracted], true);
      } catch {
        this.#lastError = "Memory extraction failed";
        return;
      }
    }

    if (this.#consolidator === undefined || candidate.length < this.#consolidateThreshold) {
      if (extracted.length > 0) {
        try {
          await this.#store.extend(extracted);
        } catch {
          this.#lastError = "Memory extraction failed";
        }
      }
      return;
    }

    try {
      const output = await this.#consolidator.consolidate(candidate);
      const plan = parseConsolidationPlan(output, candidate);
      await this.#store.applyConsolidation({
        baseRecords: current,
        additions: extracted,
        sourceNames: plan.sourceNames,
        replacements: plan.records,
      });
    } catch {
      this.#lastError = "Memory consolidation failed";
    }
  }
}

function isMemoryType(value: unknown): value is MemoryType {
  return Object.values(MemoryType).some((kind) => kind === value);
}

// 每份记忆是独立 Markdown 文件：frontmatter 提供可检索元数据，正文保存完整细节。
function serializeMemory(record: MemoryRecord): Buffer {
  const metadata = stringifyYaml({
    name: record.name,
    description: record.description,
    type: record.kind,
  }).trimEnd();
  return Buffer.from(`---\n${metadata}\n---\n\n${record.body}\n`, "utf8");
}

function parseMemory(raw: Buffer): MemoryRecord {
  enforceMemoryBudget(raw);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch (error) {
    throw new MemoryStoreError("memory file is not valid UTF-8", { cause: error });
  }
  const lines = text.split(/\r\n|\r|\n/gu);
  if (lines[0] !== "---") {
    throw new MemoryStoreError("memory file is missing YAML frontmatter");
  }
  const end = lines.indexOf("---", 1);
  if (end < 0) {
    throw new MemoryStoreError("memory file has unclosed YAML frontmatter");
  }
  let metadata: unknown;
  try {
    metadata = parseYaml(lines.slice(1, end).join("\n"));
  } catch (error) {
    throw new MemoryStoreError("memory frontmatter is invalid YAML", { cause: error });
  }
  if (!hasExactKeys(metadata, ["name", "description", "type"])) {
    throw new MemoryStoreError("memory frontmatter has an invalid schema");
  }
  try {
    return new MemoryRecord({
      name: requireStringField(metadata.name, "name"),
      description: requireStringField(metadata.description, "description"),
      kind: requireMemoryTypeField(metadata.type),
      body: stripOuterNewlines(lines.slice(end + 1).join("\n")),
    });
  } catch (error) {
    if (error instanceof MemoryStoreError) {
      throw error;
    }
    throw new MemoryStoreError("memory frontmatter fields have invalid types", { cause: error });
  }
}

// 预算同时约束序列化和读取后的原文件，手工改大的记忆也会被拒绝。
function enforceMemoryBudget(raw: Buffer): void {
  if (countLines(raw) > MAX_MEMORY_LINES) {
    throw new MemoryStoreError(`memory file must not exceed ${MAX_MEMORY_LINES} lines`);
  }
  if (raw.byteLength > MAX_MEMORY_BYTES) {
    throw new MemoryStoreError(`memory file must not exceed ${MAX_MEMORY_BYTES} UTF-8 bytes`);
  }
}

function countLines(raw: Buffer): number {
  if (raw.byteLength === 0) {
    return 0;
  }
  const text = raw.toString("latin1");
  const pieces = text.split(/\r\n|\r|\n/gu);
  return pieces.at(-1) === "" ? pieces.length - 1 : pieces.length;
}

function stripOuterNewlines(value: string): string {
  return value.replace(/^\n+|\n+$/gu, "");
}

// 集合级契约：只接受 MemoryRecord 且名称唯一；空集合是否合法由调用场景决定。
function validateRecordCollection(
  records: readonly MemoryRecord[],
  allowEmpty: boolean,
): readonly MemoryRecord[] {
  if (!Array.isArray(records) || !records.every((record) => record instanceof MemoryRecord)) {
    throw new MemoryStoreError("memory collection must contain MemoryRecord values");
  }
  if (!allowEmpty && records.length === 0) {
    throw new MemoryStoreError("memory collection must not be empty");
  }
  const names = records.map((record) => record.name);
  if (new Set(names).size !== names.length) {
    throw new MemoryStoreError("memory names must be unique");
  }
  return Object.freeze([...records]);
}

// 模型输出必须整体可解析为 JSON，不从代码围栏或解释文本中截取子串。
function parseRecordList(output: string, allowEmpty: boolean): readonly MemoryRecord[] {
  if (typeof output !== "string") {
    throw new MemoryStoreError("memory model output must be a JSON string");
  }
  let values: unknown;
  try {
    values = JSON.parse(output);
  } catch (error) {
    throw new MemoryStoreError("memory model output is not valid JSON", { cause: error });
  }
  return parseRecordValues(values, allowEmpty);
}

function parseRecordValues(values: unknown, allowEmpty: boolean): readonly MemoryRecord[] {
  if (!Array.isArray(values)) {
    throw new MemoryStoreError("memory model output must be a JSON array");
  }
  const records = values.map((value) => {
    if (!hasExactKeys(value, ["name", "type", "description", "body"])) {
      throw new MemoryStoreError("memory model item has an invalid schema");
    }
    try {
      return new MemoryRecord({
        name: requireStringField(value.name, "name"),
        description: requireStringField(value.description, "description"),
        kind: requireMemoryTypeField(value.type),
        body: requireStringField(value.body, "body"),
      });
    } catch (error) {
      throw new MemoryStoreError("memory model item has invalid fields", { cause: error });
    }
  });
  return validateRecordCollection(records, allowEmpty);
}

function parseConsolidationPlan(
  output: string,
  candidates: readonly MemoryRecord[],
): ConsolidationPlan {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (error) {
    throw new MemoryStoreError("consolidation output is not valid JSON", { cause: error });
  }
  if (!hasExactKeys(value, ["source_names", "records"])) {
    throw new MemoryStoreError("consolidation output has an invalid schema");
  }
  if (
    !Array.isArray(value.source_names) ||
    value.source_names.length === 0 ||
    !value.source_names.every((name): name is string => typeof name === "string")
  ) {
    throw new MemoryStoreError("consolidation source_names must be a non-empty string array");
  }
  validateConsolidationSources(value.source_names, candidates);
  return Object.freeze({
    sourceNames: Object.freeze([...value.source_names]),
    records: parseRecordValues(value.records, false),
  });
}

function validateConsolidationSources(
  sourceNames: readonly string[],
  candidates: readonly MemoryRecord[],
): void {
  if (
    !Array.isArray(sourceNames) ||
    sourceNames.length === 0 ||
    !sourceNames.every((name) => typeof name === "string")
  ) {
    throw new MemoryStoreError("consolidation sourceNames must be a non-empty string array");
  }
  if (new Set(sourceNames).size !== sourceNames.length) {
    throw new MemoryStoreError("consolidation sourceNames must be unique");
  }
  const candidateNames = new Set(candidates.map((record) => record.name));
  const unknown = sourceNames.filter((name) => !candidateNames.has(name));
  if (unknown.length > 0) {
    throw new MemoryStoreError(
      `consolidation contains unknown source names: ${[...unknown].sort().join(", ")}`,
    );
  }
}

function parseSelectedNames(output: string): readonly string[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (error) {
    throw new MemoryStoreError("selector output is not valid JSON", { cause: error });
  }
  if (!Array.isArray(value) || !value.every((name): name is string => typeof name === "string")) {
    throw new MemoryStoreError("selector output must be a JSON string array");
  }
  if (new Set(value).size !== value.length) {
    throw new MemoryStoreError("selector output names must be unique");
  }
  return Object.freeze([...value]);
}

// 关键词回退只扫描 name/description，不读正文，与 selector 看到的目录预算一致。
function keywordSelect(
  query: string,
  records: readonly MemoryRecord[],
  limit: number,
): readonly MemoryRecord[] {
  const keywords = keywordTokens(query);
  const ranked = records
    .map((record) => {
      const searchable = `${record.name} ${record.description}`.toLowerCase();
      const score = [...keywords].filter((keyword) => searchable.includes(keyword)).length;
      return Object.freeze({ record, score });
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => {
      const scoreDifference = right.score - left.score;
      return scoreDifference === 0
        ? compareText(left.record.name, right.record.name)
        : scoreDifference;
    });
  return Object.freeze(ranked.slice(0, limit).map((item) => item.record));
}

// 英文按至少 3 个字符的 token，中文按相邻 bigram，让中英文查询都能形成可比较特征。
function keywordTokens(value: string): ReadonlySet<string> {
  const folded = value.toLowerCase();
  const tokens = new Set((folded.match(/[a-z0-9]+/gu) ?? []).filter((token) => token.length >= 3));
  for (const run of folded.match(CJK_RUN_PATTERN) ?? []) {
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.add(run.slice(index, index + 2));
    }
  }
  return tokens;
}

// extractor 收到深拷贝后的不可变消息快照，避免调用方后续修改影响提取输入。
function copyHistory(history: readonly ChatMessage[]): readonly ChatMessage[] {
  if (!Array.isArray(history)) {
    throw new MemoryStoreError("memory extraction history must be an array");
  }
  const copied = history.map((message) => {
    if (message.role === "system") {
      return systemMessage(message.content);
    }
    if (message.role === "user") {
      return userMessage(message.content);
    }
    if (message.role === "tool") {
      return toolMessage(message.content, message.toolCallId);
    }
    return assistantMessage(
      message.content,
      message.toolCalls.map((call: ToolCall) => toolCall(call.id, call.name, call.arguments)),
    );
  });
  validateToolPairing(copied);
  return Object.freeze(copied);
}

function memoryRecordPayload(record: MemoryRecord): Readonly<Record<string, string>> {
  return Object.freeze({
    name: record.name,
    type: record.kind,
    description: record.description,
    body: record.body,
  });
}

// 递归按键排序生成稳定 JSON，保证相同对象在不同运行和测试中保持确定输入。
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new MemoryStoreError("memory JSON payload contains an unsupported value");
  }
  return serialized;
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

function isStrictManifest(value: unknown): value is { version: 1; files: string[] } {
  return (
    hasExactKeys(value, ["version", "files"]) &&
    typeof value.version === "number" &&
    value.version === 1 &&
    Array.isArray(value.files) &&
    value.files.every((filename): filename is string => typeof filename === "string")
  );
}

function requireStringField(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new MemoryStoreError(`memory field ${field} must be a string`);
  }
  return value;
}

function requireMemoryTypeField(value: unknown): MemoryType {
  if (!isMemoryType(value)) {
    throw new MemoryStoreError("memory type is invalid");
  }
  return value;
}

function recordsEqual(left: MemoryRecord, right: MemoryRecord): boolean {
  return (
    left.name === right.name &&
    left.description === right.description &&
    left.kind === right.kind &&
    left.body === right.body
  );
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

// 先写同目录临时文件并 fsync，再 rename 覆盖；读方要么看到旧文件，要么看到完整新文件。
async function atomicReplace(path: string, content: Buffer): Promise<void> {
  const temporary = join(resolve(path, ".."), `.${randomUUID()}.tmp`);
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

async function removePaths(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { force: true })));
}

// 用 Promise 尾链实现同进程串行；失败也先记录尾链，让后续操作等待事务结束。
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
    if (PROCESS_LOCK_TAILS.get(key) === tail) {
      PROCESS_LOCK_TAILS.delete(key);
    }
  }
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

// 用相对路径判断 child 是否仍在 parent 内，供 manifest 文件与 .memory 根目录边界校验。
function pathIsInside(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}

// Windows 上 proper-lockfile 的锁文件重命名/删除可能短暂返回这些错误，按固定次数重试。
function isWindowsLockRace(error: unknown): boolean {
  return (
    hasErrorCode(error, "EBUSY") || hasErrorCode(error, "ENOTEMPTY") || hasErrorCode(error, "EPERM")
  );
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function randomMemoryId(): string {
  return randomUUID().replaceAll("-", "");
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
