// JsonProtocolStore 适配器：将协议请求持久化为单文件 state.json，用进程内互斥和文件锁保证原子读改写。
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { lock as acquireLock } from "proper-lockfile";

import {
  ProtocolExpiredError,
  ProtocolError,
  ProtocolMismatchError,
  ProtocolNotFoundError,
  ProtocolRequestKind,
  ProtocolRequestStatus,
  ProtocolStateError,
  ProtocolStorageError,
  type ProtocolRequest,
  type ProtocolResolution,
  type ProtocolStore,
} from "../features/protocol.js";
import {
  canonicalAgentName,
  canonicalMailboxMessageId,
  type ProtocolMailboxMessage,
  ProtocolMessageKind,
} from "../features/mailbox.js";

const STATE_VERSION = 1;
// 进程内 Promise 尾队列，对同一 workspace 串行化同时进入 #withLock 的多个调用，与 proper-lockfile 构成双重锁。
const tails = new Map<string, Promise<void>>();

export interface JsonProtocolStoreOptions {
  // 测试可注入确定 UUID；生产默认 randomUUID，结果仍需规范化校验。
  readonly idGenerator?: () => string;
  // 创建、过期与 resolution 时间都来自同一时钟边界。
  readonly clock?: () => Date;
  // pending 请求有效窗口；过期请求保留在快照中但不可再消费。
  readonly requestTtlMs?: number;
  // 测试可替换原子写；生产实现保证旧文件或新文件二选一可见。
  readonly atomicReplace?: (path: string, content: Buffer) => Promise<void>;
}
// 路径固定位于 workspace/.agent_tutorial/protocol/，锁文件 .protocol.lock 在 stateRoot 下。
interface Paths {
  // realpath 后的工作区根，用作互斥键和路径逃逸校验基准。
  readonly workspace: string;
  // 协议状态目录 `.agent_tutorial/protocol`。
  readonly root: string;
  // 单一 JSON 快照路径，包含全部请求历史和终态。
  readonly state: string;
  // proper-lockfile 使用的跨进程锁路径。
  readonly lock: string;
}
// StoredState 是磁盘 JSON 的未信任外壳，具体请求随后逐项严格解析。
interface StoredState {
  // 版本不匹配时整份快照拒绝加载，避免静默误读旧 schema。
  readonly version: number;
  // 保持 unknown，必须经 parseRequest 才能进入领域层。
  readonly requests: readonly unknown[];
}

// RequestData 统一承接新建请求和磁盘反序列化两条未信任输入路径。
interface RequestData {
  readonly id: unknown;
  readonly kind: unknown;
  readonly sender: unknown;
  readonly target: unknown;
  readonly status?: unknown;
  readonly content: unknown;
  readonly createdAtUtc: unknown;
  readonly expiresAtUtc: unknown;
  readonly resolution?: unknown;
}

// JsonProtocolStore 将所有协议请求保存为单一 state.json 快照。
// 两层锁保障原子性：
//   1. 进程内 mutex（Promise 尾队列）串行化同一进程内多实例并发。
//   2. proper-lockfile 目录锁串行化跨进程/跨 Runtime 访问。
export class JsonProtocolStore implements ProtocolStore {
  // 保留调用方路径，首次操作时才 realpath 并确认真实目录。
  readonly #workspaceInput: string;
  // 仅在锁内创建请求时调用，生成值必须是 canonical UUID。
  readonly #idGenerator: () => string;
  // 每次读取后复制 Date，防止注入方继续修改原对象。
  readonly #clock: () => Date;
  // 所有请求共享构造时确定的有效期策略。
  readonly #ttlMs: number;
  // 所有快照写入都经同一个可替换原子边界。
  readonly #atomicReplace: (path: string, content: Buffer) => Promise<void>;
  // 构建时校验 workspace 非空和 ttlMs 为正整数；idGenerator/clock/atomicReplace 测试可注入。
  constructor(workspace: string, options: JsonProtocolStoreOptions = {}) {
    if (typeof workspace !== "string" || workspace.trim().length === 0)
      throw new TypeError("workspace must be a non-empty string");
    this.#workspaceInput = workspace;
    // 默认使用 randomUUID；测试可注入确定 UUID。
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#clock = options.clock ?? (() => new Date());
    this.#ttlMs = options.requestTtlMs ?? 300_000;
    this.#atomicReplace = options.atomicReplace ?? atomicReplace;
    // TTL 为正整数，过期后 #requireCurrent 会拒绝操作。
    if (!Number.isInteger(this.#ttlMs) || this.#ttlMs <= 0)
      throw new TypeError("requestTtlMs must be positive");
  }
  async createRequest(input: {
    readonly kind: ProtocolRequestKind;
    readonly sender: string;
    readonly target: string;
    readonly content: string;
  }): Promise<ProtocolRequest> {
    // 校验、追加与持久化都位于同一锁内，避免并发请求覆盖彼此。
    return await this.#withLock(true, async (paths) => {
      // 锁内重新读取快照，避免基于过期内存状态追加请求。
      const state = await this.#load(paths);
      let id: string;
      try {
        id = canonicalMailboxMessageId(this.#idGenerator());
      } catch (error) {
        throw new ProtocolStorageError("Protocol id generator returned an invalid UUID", {
          cause: error,
        });
      }
      if (state.some((item) => item.id === id))
        throw new ProtocolStorageError(`Protocol request id already exists: ${id}`);
      const now = this.#now();
      const last = state.at(-1);
      // 状态数组按创建顺序追加；时钟倒退时显式失败，避免“最新计划”被错误重排。
      if (last !== undefined && now.valueOf() < last.createdAtUtc.valueOf())
        throw new ProtocolStorageError("Protocol clock moved backwards");
      let request: ProtocolRequest;
      try {
        request = makeRequest({
          id,
          ...input,
          createdAtUtc: now,
          expiresAtUtc: new Date(now.valueOf() + this.#ttlMs),
        });
      } catch (error) {
        if (error instanceof ProtocolStorageError) throw error;
        throw new ProtocolStorageError("Protocol request fields failed validation", {
          cause: error,
        });
      }
      await this.#persist(paths, [...state, request]);
      return request;
    });
  }
  async getPendingRequest(id: string): Promise<ProtocolRequest> {
    // 只读查询也要经过同一套锁与解析，避免读到另一个并发写入的中间快照。
    return await this.#withLock(
      false,
      async (paths) => {
        const request = find(await this.#load(paths), id);
        this.#requireCurrent(request);
        return request;
      },
      async () => find([], id),
    );
  }
  async getRequest(id: string): Promise<ProtocolRequest> {
    // 任意状态查询统一返回当前持久快照；state 不存在时由 find 给出确定错误。
    return await this.#withLock(
      false,
      async (paths) => find(await this.#load(paths), id),
      async () => find([], id),
    );
  }
  async listRequests(): Promise<readonly ProtocolRequest[]> {
    // 列表只用于诊断或测试，不在锁外缓存状态，保证每次返回都是最新快照。
    return await this.#withLock(
      false,
      async (paths) => await this.#load(paths),
      async () => [],
    );
  }
  async latestPlanRequest(sender: string): Promise<ProtocolRequest | undefined> {
    // “最新计划”由锁内数组顺序决定，不以 UUID 文本或请求 ID 排序。
    return await this.#withLock(
      false,
      async (paths) => {
        let name: string;
        try {
          name = canonicalAgentName(sender);
        } catch {
          throw new ProtocolMismatchError("Plan sender must be a canonical Agent name");
        }
        const requests = (await this.#load(paths)).filter(
          (item) => item.kind === ProtocolRequestKind.PlanApproval && item.sender === name,
        );
        return requests.at(-1);
      },
      async () => undefined,
    );
  }
  async validateRequest(message: ProtocolMailboxMessage): Promise<ProtocolRequest> {
    // 请求方向只读校验：确认 typed message 与持久化 request 完全配对，不迁移状态。
    return await this.#withLock(
      false,
      async (paths) => {
        const request = find(await this.#load(paths), message.requestId);
        this.#validateMessage(request, message, false);
        return request;
      },
      async () => find([], message.requestId),
    );
  }
  async validateResponse(message: ProtocolMailboxMessage): Promise<ProtocolRequest> {
    // 响应方向只读校验：Lead drain 阶段只验证，等到 ack 阶段才真正消费。
    return await this.#withLock(
      false,
      async (paths) => {
        const request = find(await this.#load(paths), message.requestId);
        this.#validateMessage(request, message, true);
        return request;
      },
      async () => find([], message.requestId),
    );
  }
  async consumeResponse(message: ProtocolMailboxMessage): Promise<ProtocolRequest> {
    // 这是唯一把 pending 原子迁移到 approved/rejected 的存储操作。
    return await this.#withLock(
      false,
      async (paths) => {
        const state = await this.#load(paths);
        const request = find(state, message.requestId);
        // 已 resolved 且是同一条响应时幂等返回；另一个 message 重试同一请求则明确拒绝。
        if (request.status !== ProtocolRequestStatus.Pending) {
          if (sameResponse(request, message)) return request;
          throw new ProtocolStateError(`Protocol request is already resolved: ${request.id}`);
        }
        const now = this.#now();
        this.#validateMessage(request, message, true, now);
        const approved = requireResponseDecision(message);
        const resolution: ProtocolResolution = Object.freeze({
          messageId: message.id,
          approved,
          content: message.content,
          resolvedAtUtc: now,
        });
        const updated = makeRequest({
          ...request,
          status: approved ? ProtocolRequestStatus.Approved : ProtocolRequestStatus.Rejected,
          resolution,
        });
        await this.#persist(
          paths,
          state.map((item) => (item.id === request.id ? updated : item)),
        );
        return updated;
      },
      async () => find([], message.requestId),
    );
  }
  // 先取进程内 mutex，再取 proper-lockfile 目录锁，保证锁内操作是跨实例的原子读改写。
  async #withLock<T>(
    create: boolean,
    operation: (paths: Paths) => Promise<T>,
    missing: () => Promise<T> = async () => {
      throw new ProtocolStorageError("Protocol state root is unavailable");
    },
  ): Promise<T> {
    // create=false 且目录不存在时执行 missing，避免只读查询创建运行时文件。
    const paths = await this.#paths(create);
    if (paths === undefined) return await missing();
    return await mutex(paths.workspace, async () => {
      let release: (() => Promise<void>) | undefined;
      let outcome: { readonly value: T } | undefined;
      let operationFailed = false;
      let operationError: unknown;
      let releaseError: unknown;
      try {
        release = await acquireLock(paths.root, {
          lockfilePath: paths.lock,
          stale: 30_000,
          update: 10_000,
          retries: { retries: 100, minTimeout: 10, maxTimeout: 10 },
        });
        outcome = { value: await operation(paths) };
      } catch (error) {
        operationFailed = true;
        operationError = error;
      } finally {
        if (release !== undefined) {
          try {
            await release();
          } catch (error) {
            releaseError = error;
          }
        }
      }
      if (operationFailed) {
        if (operationError instanceof ProtocolError) throw operationError;
        throw new ProtocolStorageError("Protocol lock operation failed", { cause: operationError });
      }
      if (releaseError !== undefined) {
        throw new ProtocolStorageError("Protocol lock could not be released", {
          cause: releaseError,
        });
      }
      if (outcome === undefined)
        throw new ProtocolStorageError("Protocol lock operation did not complete");
      return outcome.value;
    });
  }
  async #paths(create: boolean): Promise<Paths | undefined> {
    // 解析真实 workspace，并创建或校验 .agent_tutorial/protocol 状态目录；非创建模式目录缺失时返回 undefined。
    let workspace: string;
    try {
      workspace = await realpath(this.#workspaceInput);
      if (!(await stat(workspace)).isDirectory()) throw new Error("not a directory");
    } catch (error) {
      throw new ProtocolStorageError("workspace is not a directory", { cause: error });
    }
    const stateRoot = join(workspace, ".agent_tutorial");
    const root = join(stateRoot, "protocol");
    if (create) {
      try {
        await ensureDirectory(stateRoot, workspace, "runtime state root");
        await ensureDirectory(root, workspace, "Protocol state root");
      } catch (error) {
        if (error instanceof ProtocolStorageError) throw error;
        throw new ProtocolStorageError("Protocol state root could not be created", {
          cause: error,
        });
      }
    } else {
      try {
        await lstat(root);
        await ensureDirectory(root, workspace, "Protocol state root");
      } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined;
        throw error;
      }
    }
    const lock = join(stateRoot, ".protocol.lock");
    try {
      if ((await lstat(lock)).isSymbolicLink()) {
        throw new ProtocolStorageError("Protocol lock path must not be a symbolic link");
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    return Object.freeze({
      workspace,
      root,
      state: join(root, "state.json"),
      lock,
    });
  }
  async #load(paths: Paths): Promise<readonly ProtocolRequest[]> {
    // 读取 state.json 并校验版本、字段、id 唯一性与创建顺序；文件不存在时视为空状态。
    try {
      const stateInfo = await lstat(paths.state);
      if (!stateInfo.isFile())
        throw new ProtocolStorageError("Protocol state file is not a regular file");
      const raw = await readFile(paths.state, "utf8");
      const value: unknown = JSON.parse(raw);
      if (!isStoredState(value)) throw new Error("invalid state");
      const requests = value.requests.map(parseRequest);
      const ids = new Set<string>();
      for (let index = 0; index < requests.length; index += 1) {
        const request = requests[index];
        if (request === undefined) throw new Error("invalid request");
        if (ids.has(request.id)) throw new Error("duplicate request id");
        ids.add(request.id);
        const previous = index === 0 ? undefined : requests[index - 1];
        if (
          previous !== undefined &&
          request.createdAtUtc.valueOf() < previous.createdAtUtc.valueOf()
        ) {
          throw new Error("requests are not in creation order");
        }
      }
      return requests;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      if (error instanceof ProtocolStorageError) throw error;
      throw new ProtocolStorageError("Protocol state is invalid", { cause: error });
    }
  }
  async #persist(paths: Paths, requests: readonly ProtocolRequest[]): Promise<void> {
    // 统一经 atomicReplace 持久化快照；写入失败时旧 state.json 保持不变。
    const content = Buffer.from(
      `${JSON.stringify({ version: STATE_VERSION, requests: requests.map(serializeRequest) }, null, 2)}\n`,
      "utf8",
    );
    try {
      await this.#atomicReplace(paths.state, content);
    } catch (error) {
      throw new ProtocolStorageError("Could not persist protocol state", { cause: error });
    }
  }
  #now(): Date {
    // 时钟注入可返回确定时间；无效 Date 在进入状态机前统一转成存储错误。
    try {
      const now = this.#clock();
      if (!(now instanceof Date) || !Number.isFinite(now.valueOf()))
        throw new Error("invalid clock value");
      return new Date(now.valueOf());
    } catch (error) {
      throw new ProtocolStorageError("Protocol clock must return a valid Date", { cause: error });
    }
  }
  #requireCurrent(request: ProtocolRequest, now = this.#now()): void {
    // pending 且未过期才可参与状态迁移；已 resolved 或过期分别映射为状态错误和过期错误。
    if (request.status !== ProtocolRequestStatus.Pending)
      throw new ProtocolStateError(`Protocol request is already resolved: ${request.id}`);
    if (now.valueOf() >= request.expiresAtUtc.valueOf())
      throw new ProtocolExpiredError(`Protocol request has expired: ${request.id}`);
  }
  #validateMessage(
    request: ProtocolRequest,
    message: ProtocolMailboxMessage,
    response: boolean,
    now = this.#now(),
  ): void {
    // 校验 message 与 request 的 kind、sender、recipient 和内容完全对应，防止错投递或伪造响应。
    const expected = response
      ? request.kind === ProtocolRequestKind.Shutdown
        ? ProtocolMessageKind.ShutdownResponse
        : ProtocolMessageKind.PlanApprovalResponse
      : request.kind === ProtocolRequestKind.Shutdown
        ? ProtocolMessageKind.ShutdownRequest
        : ProtocolMessageKind.PlanApprovalRequest;
    if (
      message.kind !== expected ||
      message.sender !== (response ? request.target : request.sender) ||
      message.recipient !== (response ? request.sender : request.target)
    )
      throw new ProtocolMismatchError("Protocol message does not match request");
    if (response && message.approved === null)
      throw new ProtocolMismatchError("Protocol response is missing its decision");
    if (!response && message.content !== request.content)
      throw new ProtocolMismatchError("Protocol request content does not match registered request");
    if (response && request.status !== ProtocolRequestStatus.Pending) {
      if (sameResponse(request, message)) return;
      throw new ProtocolStateError(`Protocol request is already resolved: ${request.id}`);
    }
    this.#requireCurrent(request, now);
  }
}

function makeRequest(input: RequestData): ProtocolRequest {
  // 构造不可变 ProtocolRequest，校验必需字段、sender!=target、有效时间区间及状态与 resolution 的一致性。
  if (!(input.createdAtUtc instanceof Date) || !Number.isFinite(input.createdAtUtc.valueOf()))
    throw new ProtocolStorageError("Protocol request fields failed validation");
  if (!(input.expiresAtUtc instanceof Date) || !Number.isFinite(input.expiresAtUtc.valueOf()))
    throw new ProtocolStorageError("Protocol request fields failed validation");
  const sender = canonicalAgentName(requireString(input.sender, "sender"));
  const target = canonicalAgentName(requireString(input.target, "target"));
  const content = requireString(input.content, "content");
  const kind = requireEnum(input.kind, Object.values(ProtocolRequestKind));
  const status =
    input.status === undefined
      ? ProtocolRequestStatus.Pending
      : requireEnum(input.status, Object.values(ProtocolRequestStatus));
  const resolution =
    input.resolution === undefined || input.resolution === null
      ? null
      : normalizeResolution(input.resolution);
  if (
    sender === target ||
    content.trim().length === 0 ||
    input.expiresAtUtc.valueOf() <= input.createdAtUtc.valueOf()
  )
    throw new ProtocolStorageError("Protocol request fields failed validation");
  if (status === ProtocolRequestStatus.Pending && resolution !== null)
    throw new ProtocolStorageError("Pending protocol request cannot have a resolution");
  if (status !== ProtocolRequestStatus.Pending) {
    if (resolution === null)
      throw new ProtocolStorageError("Resolved protocol request requires a resolution");
    const expected = resolution.approved
      ? ProtocolRequestStatus.Approved
      : ProtocolRequestStatus.Rejected;
    if (
      status !== expected ||
      resolution.resolvedAtUtc.valueOf() < input.createdAtUtc.valueOf() ||
      resolution.resolvedAtUtc.valueOf() >= input.expiresAtUtc.valueOf()
    )
      throw new ProtocolStorageError("Protocol request resolution is invalid");
  }
  return Object.freeze({
    id: canonicalMailboxMessageId(requireString(input.id, "id")),
    kind,
    sender,
    target,
    status,
    content,
    createdAtUtc: new Date(input.createdAtUtc.valueOf()),
    expiresAtUtc: new Date(input.expiresAtUtc.valueOf()),
    resolution,
  });
}
function serializeRequest(request: ProtocolRequest): Record<string, unknown> {
  // 持久化字段使用 snake_case，与内存 camelCase 的转换只在序列化边界发生。
  return {
    id: request.id,
    kind: request.kind,
    sender: request.sender,
    target: request.target,
    status: request.status,
    content: request.content,
    created_at_utc: request.createdAtUtc.toISOString(),
    expires_at_utc: request.expiresAtUtc.toISOString(),
    resolution:
      request.resolution === null
        ? null
        : {
            message_id: request.resolution.messageId,
            approved: request.resolution.approved,
            content: request.resolution.content,
            resolved_at_utc: request.resolution.resolvedAtUtc.toISOString(),
          },
  };
}
function parseRequest(value: unknown): ProtocolRequest {
  // 反序列化时拒绝未知字段或缺失字段，磁盘输入不能绕过领域校验。
  if (!isRecord(value)) throw new Error("invalid request");
  const expected = [
    "content",
    "created_at_utc",
    "expires_at_utc",
    "id",
    "kind",
    "resolution",
    "sender",
    "status",
    "target",
  ];
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("invalid request fields");
  }
  const resolution = value.resolution;
  return makeRequest({
    id: value.id,
    kind: value.kind,
    sender: value.sender,
    target: value.target,
    status: value.status,
    content: value.content,
    createdAtUtc: parseDate(value.created_at_utc),
    expiresAtUtc: parseDate(value.expires_at_utc),
    resolution: resolution === null ? null : parseResolution(resolution),
  });
}
function find(requests: readonly ProtocolRequest[], id: string): ProtocolRequest {
  // 按规范化 UUID 查找请求，不存在时抛 ProtocolNotFoundError。
  let normalized: string;
  try {
    normalized = canonicalMailboxMessageId(id);
  } catch {
    throw new ProtocolNotFoundError("Protocol request id must be a canonical UUID");
  }
  const request = requests.find((item) => item.id === normalized);
  if (request === undefined)
    throw new ProtocolNotFoundError(`Protocol request does not exist: ${normalized}`);
  return request;
}
function sameResponse(request: ProtocolRequest, message: ProtocolMailboxMessage): boolean {
  // message id、decision 与 content 全同才算同一次响应的幂等重放。
  // 比较完整响应内容，判断是否是对同一请求、同一条已消费响应的幂等重试。
  const r = request.resolution;
  return (
    r !== null &&
    message.kind ===
      (request.kind === ProtocolRequestKind.Shutdown
        ? ProtocolMessageKind.ShutdownResponse
        : ProtocolMessageKind.PlanApprovalResponse) &&
    message.sender === request.target &&
    message.recipient === request.sender &&
    r.messageId === message.id &&
    r.approved === message.approved &&
    r.content === message.content
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  // JSON 对象守卫排除 null 与数组，供后续精确字段检查复用。
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireString(value: unknown, label: string): string {
  // 持久化文本必须是非空字符串，调用方字段名只用于稳定错误定位。
  if (typeof value !== "string" || value.trim().length === 0)
    throw new ProtocolStorageError(`Protocol ${label} must not be empty`);
  return value;
}
function requireEnum<T extends string>(value: unknown, values: readonly T[]): T {
  // 磁盘枚举必须属于当前封闭集合，不接受未知未来值静默降级。
  if (typeof value !== "string" || !values.includes(value as T))
    throw new ProtocolStorageError("Protocol request fields failed validation");
  return value as T;
}
function parseDate(value: unknown): Date {
  // 仅接受可解析且规范化为同一 ISO 字符串的 UTC 时间。
  if (typeof value !== "string" || !value.endsWith("Z")) throw new Error("invalid date");
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value)
    throw new Error("invalid date");
  return date;
}
function parseResolution(value: unknown): ProtocolResolution {
  // resolution 只允许四个持久字段，额外字段视为 schema 漂移。
  if (!isRecord(value)) throw new Error("invalid resolution");
  const expected = ["approved", "content", "message_id", "resolved_at_utc"];
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("invalid resolution fields");
  }
  return normalizeResolution({
    messageId: canonicalMailboxMessageId(requireString(value.message_id, "resolution message_id")),
    approved: requireBoolean(value.approved),
    content: requireString(value.content, "resolution content"),
    resolvedAtUtc: parseDate(value.resolved_at_utc),
  });
}
function normalizeResolution(value: unknown): ProtocolResolution {
  // 内存创建路径同样复制并冻结 resolution，防止外部对象后续变更。
  if (
    !isRecord(value) ||
    typeof value.messageId !== "string" ||
    typeof value.approved !== "boolean" ||
    typeof value.content !== "string" ||
    !(value.resolvedAtUtc instanceof Date)
  ) {
    throw new Error("invalid resolution");
  }
  if (!Number.isFinite(value.resolvedAtUtc.valueOf()) || value.content.trim().length === 0)
    throw new Error("invalid resolution");
  return Object.freeze({
    messageId: canonicalMailboxMessageId(value.messageId),
    approved: value.approved,
    content: value.content,
    resolvedAtUtc: new Date(value.resolvedAtUtc.valueOf()),
  });
}
function requireBoolean(value: unknown): boolean {
  // 审批结论必须显式为 boolean，不能把字符串或数值做宽松转换。
  if (typeof value !== "boolean") throw new Error("invalid boolean");
  return value;
}
function requireResponseDecision(message: ProtocolMailboxMessage): boolean {
  // 响应缺少 decision 时拒绝状态迁移，不从正文猜测审批结果。
  if (message.approved === null)
    throw new ProtocolMismatchError("Protocol response is missing its decision");
  return message.approved;
}
function isStoredState(value: unknown): value is StoredState {
  // 最外层仅允许 version/requests 两个字段，额外字段不可忽略。
  if (!isRecord(value) || value.version !== STATE_VERSION || !Array.isArray(value.requests)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  return keys.length === 2 && keys[0] === "requests" && keys[1] === "version";
}
function errorCode(error: unknown): string | undefined {
  // 安全提取 Node 系统错误 code；非 Error 或缺少 code 时返回 undefined。
  if (!(error instanceof Error)) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}
async function ensureDirectory(path: string, workspace: string, label: string): Promise<void> {
  // 创建并验证目录不是符号链接且不逃逸 workspace，防止路径遍历把状态写到外部。
  try {
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new ProtocolStorageError(`${label} is not a directory`);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      await mkdir(path);
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new ProtocolStorageError(`${label} is not a directory`);
    }
    const resolved = await realpath(path);
    if (
      resolved !== path ||
      !resolved.startsWith(`${workspace}${process.platform === "win32" ? "\\" : "/"}`)
    )
      throw new ProtocolStorageError(`${label} escapes workspace`);
  } catch (error) {
    if (error instanceof ProtocolStorageError) throw error;
    throw new ProtocolStorageError(`${label} could not be resolved`, { cause: error });
  }
}
async function mutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  // 用 Promise 尾队列把同一 key 上的并发操作串行化，进程内多个 store 实例共享这份队列。
  const previous = tails.get(key) ?? Promise.resolve();
  let unlock!: () => void;
  const current = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const tail = previous.then(() => current);
  tails.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    unlock();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
async function atomicReplace(path: string, content: Buffer): Promise<void> {
  // 先写入同目录临时文件、fsync、rename，读方只能看到完整旧文件或完整新文件。
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx");
  try {
    await handle.write(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
