// MCP 工具领域与运行时：校验本地 allowlist，动态发布远程工具，并在连接失效时原子撤销注册项。
import { z } from "zod";

import type { ToolCall } from "../core/messages.js";
import type {
  StoredToolDefinition,
  ToolDefinition,
  ToolRegistry,
  ToolResult,
} from "../core/tools.js";
import { toolError, toolSuccess } from "../core/tools.js";

const ALIAS_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const REMOTE_NAME_PATTERN = /[^a-z0-9_]+/g;
const REPEATED_UNDERSCORE_PATTERN = /_+/g;
const MAX_TOOL_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

export class McpContractError extends Error {
  // 本地配置、远程声明或 JSON 负载违反 MCP 集成契约。
  override readonly name: string = "McpContractError";
}

export class McpTransportError extends Error {
  // stdio 连接、初始化或请求传输失败；不包含远程工具主动返回的业务错误。
  override readonly name: string = "McpTransportError";
}

export class McpTimeoutError extends McpTransportError {
  // 单独标记超时，使运行时可以返回稳定错误码并撤销失效连接。
  override readonly name: string = "McpTimeoutError";
}

export interface McpSchemaValidator {
  // 发布工具前把远程 JSON Schema 编译成同步谓词，调用阶段不再重复编译。
  compile(
    exposedName: string,
    inputSchema: Readonly<Record<string, unknown>>,
  ): (value: unknown) => boolean;
}

export interface McpToolPolicyOptions {
  // remoteName 必须与 tools/list 的原始名称精确匹配，effect 只由本地决定。
  readonly remoteName: string;
  readonly effect: "read" | "write" | "execute" | "external";
}

// 本地策略是远程工具 effect 的唯一事实源；远程只负责实现能力，不决定权限。
export class McpToolPolicy {
  readonly remoteName: string;
  readonly effect: McpToolPolicyOptions["effect"];

  constructor(options: McpToolPolicyOptions) {
    // 策略对象冻结后可安全复用于多个 server spec，不允许远程覆盖 effect。
    if (typeof options.remoteName !== "string" || options.remoteName.trim().length === 0) {
      throw new McpContractError("MCP tool policy remoteName must not be empty");
    }
    if (options.remoteName !== options.remoteName.trim()) {
      throw new McpContractError("MCP tool policy remoteName must not have surrounding whitespace");
    }
    if (!isEffect(options.effect)) {
      throw new McpContractError("MCP tool policy effect is invalid");
    }
    this.remoteName = options.remoteName;
    this.effect = options.effect;
    Object.freeze(this);
  }
}

export interface McpServerSpecOptions {
  // alias 进入模型可见工具名；command/args/cwd 只交给 stdio 适配器启动子进程。
  readonly alias: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly toolPolicies: readonly McpToolPolicy[];
  readonly startupTimeoutSeconds: number;
  readonly toolTimeoutSeconds: number;
  readonly cwd?: string;
}

// 一份本地 allowlist：只有明确声明了 alias 和 policy 的远程工具才允许进入注册表。
export class McpServerSpec {
  readonly alias: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly toolPolicies: readonly McpToolPolicy[];
  readonly startupTimeoutSeconds: number;
  readonly toolTimeoutSeconds: number;
  readonly cwd: string | undefined;

  constructor(options: McpServerSpecOptions) {
    // 构造阶段完成别名、启动参数、policy 唯一性和超时校验，连接阶段只消费可信快照。
    if (typeof options.alias !== "string" || !ALIAS_PATTERN.test(options.alias)) {
      throw new McpContractError("MCP server alias must match ^[a-z][a-z0-9_]{0,31}$");
    }
    if (typeof options.command !== "string" || options.command.trim().length === 0) {
      throw new McpContractError("MCP server command must not be empty");
    }
    if (
      !Array.isArray(options.args) ||
      !options.args.every((argument) => typeof argument === "string")
    ) {
      throw new McpContractError("MCP server args must contain strings");
    }
    if (
      !Array.isArray(options.toolPolicies) ||
      !options.toolPolicies.every((policy) => policy instanceof McpToolPolicy)
    ) {
      throw new McpContractError("MCP toolPolicies must contain McpToolPolicy values");
    }
    const policyNames = options.toolPolicies.map((policy) => policy.remoteName);
    if (new Set(policyNames).size !== policyNames.length) {
      throw new McpContractError("MCP tool policies must not contain duplicate remote names");
    }
    for (const [name, value] of [
      ["startupTimeoutSeconds", options.startupTimeoutSeconds],
      ["toolTimeoutSeconds", options.toolTimeoutSeconds],
    ] as const) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new McpContractError(`${name} must be a finite positive number`);
      }
    }
    if (
      options.cwd !== undefined &&
      (typeof options.cwd !== "string" || options.cwd.length === 0)
    ) {
      throw new McpContractError("MCP server cwd must be a non-empty string or undefined");
    }
    this.alias = options.alias;
    this.command = options.command;
    this.args = Object.freeze([...options.args]);
    this.toolPolicies = Object.freeze([...options.toolPolicies]);
    this.startupTimeoutSeconds = options.startupTimeoutSeconds;
    this.toolTimeoutSeconds = options.toolTimeoutSeconds;
    this.cwd = options.cwd;
    Object.freeze(this);
  }
}

export interface McpPublishedToolOptions {
  // 这是远程 tools/list 的边界对象，尚未附加本地 effect 或暴露名称。
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

// 远程 tools/list 返回的声明；发布前先克隆并冻结，防止外部对象被后续修改。
export class McpPublishedTool {
  readonly name: string;
  readonly description: string | undefined;
  readonly inputSchema: Readonly<Record<string, unknown>>;

  constructor(options: McpPublishedToolOptions) {
    // schema 深克隆并冻结，避免 MCP SDK 或测试 double 在发布后改写定义。
    if (typeof options.name !== "string" || options.name.trim().length === 0) {
      throw new McpContractError("Published MCP tool name must not be empty");
    }
    if (options.name !== options.name.trim()) {
      throw new McpContractError("Published MCP tool name must not have surrounding whitespace");
    }
    if (options.description !== undefined && typeof options.description !== "string") {
      throw new McpContractError("Published MCP tool description must be a string or undefined");
    }
    if (!isRecord(options.inputSchema)) {
      throw new McpContractError("Published MCP tool input schema must be an object");
    }
    this.name = options.name;
    this.description = options.description;
    this.inputSchema = freezeJsonObject(cloneJson(options.inputSchema));
    Object.freeze(this);
  }
}

export interface McpCallResultOptions {
  // content 保留协议块，structuredContent 可缺省为 null，isError 表示远程业务失败。
  readonly content: readonly Readonly<Record<string, unknown>>[];
  readonly structuredContent: Readonly<Record<string, unknown>> | null;
  readonly isError: boolean;
}

export class McpCallResult {
  readonly content: readonly Readonly<Record<string, unknown>>[];
  readonly structuredContent: Readonly<Record<string, unknown>> | null;
  readonly isError: boolean;

  constructor(options: McpCallResultOptions) {
    // 远程结果在进入 Agent 工具边界前完成形状校验和深冻结。
    if (!Array.isArray(options.content) || !options.content.every((block) => isRecord(block))) {
      throw new McpContractError("MCP call content must contain objects");
    }
    if (options.structuredContent !== null && !isRecord(options.structuredContent)) {
      throw new McpContractError("MCP structured content must be an object or null");
    }
    if (typeof options.isError !== "boolean") {
      throw new McpContractError("MCP call isError must be boolean");
    }
    this.content = Object.freeze(
      options.content.map((block) => freezeJsonObject(cloneJson(block))),
    );
    this.structuredContent =
      options.structuredContent === null
        ? null
        : freezeJsonObject(cloneJson(options.structuredContent));
    this.isError = options.isError;
    Object.freeze(this);
  }
}

export interface McpConnection {
  // 连接抽象只暴露 tools/list、tools/call、终态通知与关闭，不泄露具体 SDK client。
  listTools(options?: { readonly signal?: AbortSignal }): Promise<readonly McpPublishedTool[]>;
  callTool(
    name: string,
    argumentsValue: Readonly<Record<string, unknown>>,
    options: { readonly timeoutSeconds: number; readonly signal?: AbortSignal },
  ): Promise<McpCallResult>;
  waitForFailure(): Promise<void>;
  close(): Promise<void>;
}

export interface McpConnectionFactory {
  // 工厂只有在 initialize 成功后返回连接；失败连接的清理由适配器负责。
  open(spec: McpServerSpec, signal?: AbortSignal): Promise<McpConnection>;
}

interface ConnectionState {
  // spec、connection 与其已注册 definitions 必须作为一个 alias 级状态单元迁移。
  readonly spec: McpServerSpec;
  readonly connection: McpConnection;
  readonly definitions: readonly StoredToolDefinition[];
}

class PublishFailure extends Error {
  // 只携带允许暴露给模型的稳定 code/message，不包含远程 schema 或进程细节。
  readonly code: string;
  readonly publicMessage: string;

  constructor(code: string, publicMessage: string) {
    // 内部异常与工具错误使用同一公开消息，避免边界转换时意外泄密。
    super(publicMessage);
    this.name = "PublishFailure";
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

// 连接状态变更串行化：connect、disconnect、close 不会在并发调用中互相覆盖。
class AsyncMutex {
  // Promise 尾链串行化状态操作；网络关闭在锁外执行，避免长 I/O 占用临界区。
  #tail: Promise<void> = Promise.resolve();

  async run<Result>(operation: () => Promise<Result> | Result): Promise<Result> {
    // 每个调用等待前一 gate，finally 必须释放本 gate，失败也不能阻塞后续操作。
    const previous = this.#tail;
    const gate = createReleaseGate();
    this.#tail = gate.promise;
    await previous;
    try {
      return await operation();
    } finally {
      gate.release();
    }
  }
}

function createReleaseGate(): { readonly promise: Promise<void>; readonly release: () => void } {
  // 把 Promise 的 resolve 保存为显式 release，供互斥尾链在 finally 中推进。
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (release === undefined) throw new Error("MCP mutex release was not initialized");
  return { promise, release };
}

const aliasInputSchema = z.strictObject({
  alias: z.string().min(1).max(32).regex(ALIAS_PATTERN),
});

// MCP 运行时把远程能力发布为受策略约束的本地工具，并集中管理连接生命周期。
export class McpRuntime {
  // servers 是启动 allowlist；connections 只保存已完成“发现 + 注册”的活动连接。
  readonly #servers: ReadonlyMap<string, McpServerSpec>;
  readonly #connectionFactory: McpConnectionFactory;
  readonly #schemaValidator: McpSchemaValidator;
  readonly #connections = new Map<string, ConnectionState>();
  // 已从 registry 撤销、但 connection.close() 尚未成功的对象；Runner 逆序关闭时兜底重试。
  readonly #pendingCloses: McpConnection[] = [];
  readonly #lock = new AsyncMutex();
  readonly #leadToolDefinitions: readonly [
    ToolDefinition<z.infer<typeof aliasInputSchema>>,
    ToolDefinition<z.infer<typeof aliasInputSchema>>,
  ];
  #registry: ToolRegistry | undefined;
  #closeRequested = false;
  #closed = false;

  constructor(options: {
    readonly servers: readonly McpServerSpec[];
    readonly connectionFactory: McpConnectionFactory;
    readonly schemaValidator: McpSchemaValidator;
  }) {
    // 构造时只建立静态 server/spec 与管理工具；动态远程工具必须等待 install + connect。
    if (!Array.isArray(options.servers) || options.servers.length === 0) {
      throw new McpContractError("MCP runtime requires at least one server spec");
    }
    if (!options.servers.every((server) => server instanceof McpServerSpec)) {
      throw new McpContractError("MCP runtime servers must contain McpServerSpec values");
    }
    const aliases = options.servers.map((server) => server.alias);
    if (new Set(aliases).size !== aliases.length) {
      throw new McpContractError("MCP runtime server aliases must be unique");
    }
    if (typeof options.connectionFactory?.open !== "function") {
      throw new TypeError("connectionFactory must implement McpConnectionFactory");
    }
    if (typeof options.schemaValidator?.compile !== "function") {
      throw new TypeError("schemaValidator must implement McpSchemaValidator");
    }
    this.#servers = new Map(options.servers.map((server) => [server.alias, server]));
    this.#connectionFactory = options.connectionFactory;
    this.#schemaValidator = options.schemaValidator;
    const connect = async (input: z.infer<typeof aliasInputSchema>): Promise<ToolResult> =>
      await this.#connect(input.alias);
    const disconnect = async (input: z.infer<typeof aliasInputSchema>): Promise<ToolResult> =>
      await this.#disconnect(input.alias);
    this.#leadToolDefinitions = Object.freeze([
      {
        name: "connect_mcp",
        description: "Connect one locally allowlisted MCP server alias.",
        inputSchema: aliasInputSchema,
        effect: "external",
        source: "mcp:management",
        handler: connect,
      },
      {
        name: "disconnect_mcp",
        description: "Disconnect one MCP server alias and withdraw its tools.",
        inputSchema: aliasInputSchema,
        effect: "external",
        source: "mcp:management",
        handler: disconnect,
      },
    ]);
  }

  get connectedAliases(): readonly string[] {
    // 返回当前活动连接快照，调用方不能修改内部 Map。
    return Object.freeze([...this.#connections.keys()]);
  }

  get serverAliases(): readonly string[] {
    // 返回本地允许连接的全部 alias，不代表这些 server 已连接。
    return Object.freeze([...this.#servers.keys()]);
  }

  get isClosed(): boolean {
    // 仅当所有连接关闭成功后才为 true；closeRequested 可更早阻止新连接。
    return this.#closed;
  }

  get leadToolDefinitions(): readonly [
    ToolDefinition<z.infer<typeof aliasInputSchema>>,
    ToolDefinition<z.infer<typeof aliasInputSchema>>,
  ] {
    // connect/disconnect 只交给 Lead；远程工具由连接成功后动态加入同一 registry。
    return this.#leadToolDefinitions;
  }

  install(registry: ToolRegistry): void {
    // 运行时与一个可变注册表一一绑定，重复安装会破坏 definitions 的对象身份撤销语义。
    if (this.#registry !== undefined) {
      throw new McpContractError("MCP runtime is already installed");
    }
    if (this.#closeRequested || this.#closed) {
      throw new McpContractError("MCP runtime cannot be installed after close");
    }
    // 只给 Lead registry 安装连接管理工具；远程工具要等 connect 成功后才动态发布。
    registry.registerMany(this.#leadToolDefinitions);
    this.#registry = registry;
  }

  async close(): Promise<void> {
    // 关闭先在锁内撤销全部模型可见工具，再逆连接顺序回收 stdio 资源；
    // 关闭失败的连接保留在 pendingCloses，允许上层再次调用 close 重试。
    const connections = await this.#lock.run(async () => {
      if (this.#closed) return [] as McpConnection[];
      this.#closeRequested = true;
      const states = [...this.#connections.values()].reverse();
      const definitions = states.flatMap((state) => [...state.definitions]);
      if (definitions.length > 0) this.#requireRegistry().unregisterMany(definitions);
      this.#connections.clear();
      const result = states.map((state) => state.connection);
      result.push(...this.#pendingCloses.splice(0));
      return result;
    });
    // 先撤销 definitions，再在锁外关闭连接，避免长 I/O 阻塞后续状态操作。
    const failures: unknown[] = [];
    for (const connection of connections) {
      try {
        await connection.close();
      } catch (error) {
        failures.push(error);
        this.#rememberPendingClose(connection);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "MCP runtime close failed");
    this.#closed = true;
  }

  async #connect(alias: string): Promise<ToolResult> {
    // alias 级连接是事务式发布：open、tools/list、policy/schema 校验和批量注册
    // 全部成功后才写入 #connections，任一步失败都尝试关闭临时连接。
    return await this.#lock.run(async () => {
      if (this.#closeRequested || this.#closed) {
        return toolError("mcp_runtime_closed", "MCP runtime is closing or closed");
      }
      const spec = this.#servers.get(alias);
      if (spec === undefined) {
        return toolError("unknown_mcp_server", `Unknown MCP server alias: ${alias}`);
      }
      if (this.#connections.has(alias)) {
        return toolError(
          "mcp_already_connected",
          `MCP server alias is already connected: ${alias}`,
        );
      }

      // 事务式发布：发现和注册全部成功后才记录连接状态，任一步失败都关闭 connection。
      let connection: McpConnection;
      try {
        connection = await this.#connectionFactory.open(spec);
      } catch (error) {
        return this.#connectionError(alias, error, "connect");
      }
      let published: readonly McpPublishedTool[];
      try {
        published = await connection.listTools();
      } catch (error) {
        await this.#closeFailedConnection(connection);
        return this.#connectionError(alias, error, "tool discovery");
      }

      let definitions: readonly StoredToolDefinition[];
      try {
        const candidates = this.#publishDefinitions(spec, published);
        definitions = this.#requireRegistry().registerMany(candidates);
      } catch (error) {
        const cleanupOk = await this.#closeFailedConnection(connection);
        if (!cleanupOk) {
          return toolError(
            "mcp_cleanup_failed",
            `MCP connection validation failed and cleanup is pending: ${alias}`,
          );
        }
        if (error instanceof PublishFailure) {
          return toolError(error.code, error.publicMessage);
        }
        return toolError(
          "mcp_name_collision",
          `MCP exposed tool name collides with the local registry: ${alias}`,
        );
      }
      const state = { spec, connection, definitions };
      this.#connections.set(alias, state);
      // 连接状态与 definitions 已同时可见；此后的 transport 故障统一由 Watchdog 撤销。
      void this.#watchConnection(alias, state);
      return toolSuccess(
        jsonText({
          server_alias: alias,
          status: "connected",
          tools: definitions.map((definition) => definition.name),
        }),
      );
    });
  }

  async #disconnect(alias: string): Promise<ToolResult> {
    // 断开先在锁内删除状态和 definitions，再在锁外关闭传输，保证模型立即失去该能力。
    const state = await this.#lock.run(async () => {
      if (this.#closeRequested || this.#closed) return undefined;
      if (!this.#servers.has(alias)) return null;
      const current = this.#connections.get(alias);
      if (current === undefined) return false;
      this.#connections.delete(alias);
      this.#requireRegistry().unregisterMany(current.definitions);
      return current;
    });
    if (state === undefined)
      return toolError("mcp_runtime_closed", "MCP runtime is closing or closed");
    if (state === null)
      return toolError("unknown_mcp_server", `Unknown MCP server alias: ${alias}`);
    if (state === false) {
      return toolError("mcp_not_connected", `MCP server alias is not connected: ${alias}`);
    }
    // 先撤销 definitions 再关连接；即使 close 失败，模型也看不到已断开的远程工具。
    try {
      await state.connection.close();
    } catch {
      this.#rememberPendingClose(state.connection);
      return toolError(
        "mcp_disconnect_failed",
        `MCP tools were withdrawn but connection cleanup is pending: ${alias}`,
      );
    }
    return toolSuccess(
      jsonText({
        server_alias: alias,
        status: "disconnected",
        tools: state.definitions.map((definition) => definition.name),
      }),
    );
  }

  #publishDefinitions(
    spec: McpServerSpec,
    published: readonly McpPublishedTool[],
  ): readonly ToolDefinition<Record<string, unknown>>[] {
    // 把远程声明与本地 policy 做精确集合匹配，再生成带 alias、effect、schema 和 source 的本地定义。
    // Published 集合必须与 policy 精确匹配，未声明和多余的工具都拒绝发布。
    if (!Array.isArray(published) || !published.every((tool) => tool instanceof McpPublishedTool)) {
      throw new PublishFailure(
        "mcp_invalid_tool_list",
        `MCP server returned an invalid tool list: ${spec.alias}`,
      );
    }
    const policies = new Map(spec.toolPolicies.map((policy) => [policy.remoteName, policy]));
    const publishedNames = published.map((tool) => tool.name);
    if (new Set(publishedNames).size !== publishedNames.length) {
      throw new PublishFailure(
        "mcp_name_collision",
        `MCP server published duplicate tool names: ${spec.alias}`,
      );
    }
    if (
      publishedNames.length !== policies.size ||
      publishedNames.some((name) => !policies.has(name))
    ) {
      throw new PublishFailure(
        "mcp_policy_mismatch",
        `MCP published tools do not exactly match local policy: ${spec.alias}`,
      );
    }
    const exposedNames = new Set<string>();
    const definitions: ToolDefinition<Record<string, unknown>>[] = [];
    for (const tool of published) {
      const exposedName = exposedToolName(spec.alias, tool.name);
      if (exposedNames.has(exposedName)) {
        throw new PublishFailure(
          "mcp_name_collision",
          `MCP tool names collide after normalization: ${spec.alias}`,
        );
      }
      exposedNames.add(exposedName);
      const policy = policies.get(tool.name);
      if (policy === undefined) throw new Error("MCP policy lookup lost a published tool");
      let validator: (value: unknown) => boolean;
      try {
        validator = this.#schemaValidator.compile(exposedName, tool.inputSchema);
      } catch {
        throw new PublishFailure(
          "mcp_invalid_schema",
          `MCP tool input schema is invalid: ${exposedName}`,
        );
      }
      const inputSchema = z.custom<Record<string, unknown>>((value) => validator(value), {
        message: "Arguments failed MCP JSON Schema validation",
      });
      const definition: ToolDefinition<Record<string, unknown>> = {
        name: exposedName,
        description: validatedDescription(spec.alias, tool),
        inputSchema,
        inputSchemaJson: tool.inputSchema,
        effect: policy.effect,
        source: `mcp:${spec.alias}:${tool.name}`,
        handler: async (_input, _context) =>
          await this.#invokeRemote(spec.alias, tool.name, _input),
      };
      definitions.push(definition);
    }
    return definitions;
  }

  async #watchConnection(alias: string, state: ConnectionState): Promise<void> {
    // 连接级 Watchdog：transport 终止后撤销该 alias 的动态工具，避免失效工具继续暴露。
    await state.connection.waitForFailure();
    await this.#dropFailedConnection(alias, state);
  }

  async #invokeRemote(
    alias: string,
    remoteName: string,
    argumentsValue: Readonly<Record<string, unknown>>,
  ): Promise<ToolResult> {
    // 每次调用先读取当前 alias 状态；超时/传输错误撤销整条连接，远程 isError 仅影响本次结果。
    const state = await this.#lock.run(() => this.#connections.get(alias));
    if (state === undefined) {
      return remoteError(
        alias,
        remoteName,
        "mcp_not_connected",
        "MCP server is no longer connected",
      );
    }
    // 超时或 transport 故障视为连接失效；业务 isError 只返回固定脱敏结果，不泄露服务端细节。
    let result: McpCallResult;
    try {
      result = await state.connection.callTool(remoteName, argumentsValue, {
        timeoutSeconds: state.spec.toolTimeoutSeconds,
      });
    } catch (error) {
      if (error instanceof McpTimeoutError) {
        await this.#dropFailedConnection(alias, state);
        return remoteError(alias, remoteName, "mcp_timeout", "MCP tool call exceeded its timeout");
      }
      if (error instanceof McpTransportError) {
        await this.#dropFailedConnection(alias, state);
        return remoteError(
          alias,
          remoteName,
          "mcp_connection_lost",
          "MCP connection was lost during the tool call",
        );
      }
      throw error;
    }
    if (result.isError) {
      return remoteError(alias, remoteName, "mcp_remote_error", "MCP server reported a tool error");
    }
    return toolSuccess(
      jsonText({
        content: result.content,
        server_alias: alias,
        status: "ok",
        structured_content: result.structuredContent,
        tool: remoteName,
      }),
    );
  }

  async #dropFailedConnection(alias: string, state: ConnectionState): Promise<void> {
    // 先核对对象身份，避免旧连接状态误删重连后的新 definitions。
    const current = await this.#lock.run(async () => {
      const existing = this.#connections.get(alias);
      if (existing !== state) return undefined;
      this.#requireRegistry().unregisterMany(state.definitions);
      this.#connections.delete(alias);
      return state;
    });
    if (current === undefined) return;
    try {
      await current.connection.close();
    } catch {
      this.#rememberPendingClose(current.connection);
    }
  }

  async #closeFailedConnection(connection: McpConnection): Promise<boolean> {
    // 连接尚未发布时的清理辅助；失败对象进入 pendingCloses，由统一 close 再次回收。
    try {
      await connection.close();
      return true;
    } catch {
      this.#rememberPendingClose(connection);
      return false;
    }
  }

  #rememberPendingClose(connection: McpConnection): void {
    // 按对象身份去重，避免同一个 connection 被多次加入关闭队列。
    if (!this.#pendingCloses.some((existing) => existing === connection)) {
      this.#pendingCloses.push(connection);
    }
  }

  #requireRegistry(): ToolRegistry {
    // 所有动态注册/撤销都要求先 install；缺失注册表属于组合根契约错误。
    if (this.#registry === undefined) {
      throw new McpContractError("MCP runtime is not installed in a registry");
    }
    return this.#registry;
  }

  #connectionError(alias: string, error: unknown, operation: string): ToolResult {
    // 只转换已知 MCP 边界错误，未知异常继续抛出，避免掩盖编程错误。
    if (error instanceof McpTimeoutError) {
      return toolError("mcp_connect_timeout", `MCP server ${operation} timed out: ${alias}`);
    }
    if (error instanceof McpTransportError || error instanceof McpContractError) {
      return toolError("mcp_connection_failed", `MCP server ${operation} failed: ${alias}`);
    }
    throw error;
  }
}

function exposedToolName(alias: string, remoteName: string): string {
  // 本地名统一为 mcp__alias__normalized，从名称上隔离不同 server 的同名远程工具。
  const normalized = remoteName
    .trim()
    .toLowerCase()
    .replace(REMOTE_NAME_PATTERN, "_")
    .replace(REPEATED_UNDERSCORE_PATTERN, "_")
    .replace(/^_+|_+$/g, "");
  if (normalized.length === 0) {
    throw new PublishFailure(
      "mcp_invalid_tool_name",
      `MCP tool name cannot be normalized: ${alias}`,
    );
  }
  const exposed = `mcp__${alias}__${normalized}`;
  if (exposed.length > MAX_TOOL_NAME_LENGTH) {
    throw new PublishFailure(
      "mcp_invalid_tool_name",
      `MCP exposed tool name exceeds ${MAX_TOOL_NAME_LENGTH} characters: ${alias}`,
    );
  }
  return exposed;
}

function validatedDescription(alias: string, tool: McpPublishedTool): string {
  // 空描述使用本地可控文案，非空描述限制长度后原样保留。
  if (tool.description === undefined || tool.description.trim().length === 0) {
    return `MCP tool ${tool.name} published by server alias ${alias}.`;
  }
  if (tool.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new PublishFailure(
      "mcp_invalid_tool_description",
      `MCP tool description exceeds ${MAX_DESCRIPTION_LENGTH} characters: ${alias}`,
    );
  }
  return tool.description;
}

function remoteError(alias: string, remoteName: string, code: string, message: string): ToolResult {
  // 远端错误只保留 code/message/alias 等可控字段，服务器私有内容不进入模型上下文。
  return {
    content: jsonText({
      error: { code, message },
      server_alias: alias,
      status: "error",
      tool: remoteName,
    }),
    isError: true,
    errorCode: code,
  };
}

function jsonText(value: unknown): string {
  // MCP 工具统一返回 JSON 文本，使 alias、状态和错误码保持结构化。
  return JSON.stringify(value);
}

function isEffect(value: unknown): value is McpToolPolicyOptions["effect"] {
  // effect 集合与核心权限系统保持一致，远程不能扩展任意权限类别。
  return value === "read" || value === "write" || value === "execute" || value === "external";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // MCP JSON 对象边界排除 null 与数组。
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  // JSON 往返既复制对象也拒绝函数、循环引用和 undefined 根值。
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("value is not JSON serializable");
    return JSON.parse(serialized) as T;
  } catch (error) {
    throw new McpContractError("MCP value must be JSON serializable", { cause: error });
  }
}

function freezeJsonObject<T extends Record<string, unknown>>(value: T): Readonly<T> {
  // 递归冻结协议对象，阻止发布或调用后被外部引用修改。
  for (const nested of Object.values(value)) {
    if (isRecord(nested)) freezeJsonObject(nested);
    if (Array.isArray(nested)) freezeJsonArray(nested);
  }
  return Object.freeze(value);
}

function freezeJsonArray(value: unknown[]): readonly unknown[] {
  // 数组与其中的对象/子数组使用同一深冻结规则。
  for (const nested of value) {
    if (isRecord(nested)) freezeJsonObject(nested);
    if (Array.isArray(nested)) freezeJsonArray(nested);
  }
  return Object.freeze(value);
}

export function isMcpToolDefinition(definition: unknown): definition is ToolDefinition<unknown> {
  // 测试和组合层只需识别工具定义的最小可调用形状。
  return (
    typeof definition === "object" &&
    definition !== null &&
    typeof Reflect.get(definition, "name") === "string" &&
    typeof Reflect.get(definition, "handler") === "function"
  );
}

export function isMcpManagementCall(call: ToolCall): boolean {
  // 管理调用用于区分连接生命周期命令与动态远程工具调用。
  return call.name === "connect_mcp" || call.name === "disconnect_mcp";
}
