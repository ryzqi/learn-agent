import type { ChatMessage } from "./messages.js";
import { isChatMessage, systemMessage, userMessage } from "./messages.js";
import type { PermissionBehavior } from "./permissions.js";
import { isPermissionBehavior } from "./permissions.js";
import type { PreparedToolCall, ToolResult } from "./tools.js";
import { copyToolResult, freezePreparedToolCall, isToolResult } from "./tools.js";

// 支持的生命周期事件集合；注册表和运行期校验共用它避免事件名漂移。
export const HOOK_EVENTS = Object.freeze([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
] as const);
// Hook 是受限扩展点：事件上下文和返回值均按事件类型严格校验。
export type HookEvent = (typeof HOOK_EVENTS)[number];

export class HookContractError extends Error {
  // 稳定错误名，表明 Hook 输入、输出或事件字段违反受限扩展契约。
  override readonly name: string = "HookContractError";
}

// 收窄未知事件值，构造 HookContext 和注册回调前均需经过此边界。
function isHookEvent(value: unknown): value is HookEvent {
  return HOOK_EVENTS.some((event) => event === value);
}

// 确认 Hook 接收到的是已通过工具名称和 schema 校验的调用，拒绝不完整 prepare 结果。
function isValidPrepared(prepared: unknown): prepared is PreparedToolCall {
  if (typeof prepared !== "object" || prepared === null) {
    return false;
  }
  const value = prepared as PreparedToolCall;
  const call = value.call;
  const definition = value.definition;
  return (
    typeof call === "object" &&
    call !== null &&
    typeof call.id === "string" &&
    call.id.length > 0 &&
    typeof call.name === "string" &&
    call.name.length > 0 &&
    typeof call.arguments === "string" &&
    value.error === undefined &&
    typeof definition === "object" &&
    definition !== null &&
    typeof definition.name === "string" &&
    typeof definition.inputSchema?.safeParse === "function" &&
    typeof definition.invoke === "function" &&
    value.arguments !== undefined
  );
}

export interface HookContextOptions {
  // 决定允许哪些字段的生命周期事件。
  readonly event: HookEvent;
  // UserPromptSubmit 专属的用户消息。
  readonly message?: ChatMessage;
  // PreToolUse/PostToolUse 专属的已准备调用。
  readonly prepared?: PreparedToolCall;
  // PostToolUse 专属的工具结果。
  readonly result?: ToolResult;
  // Stop 专属的当前会话历史快照。
  readonly history?: readonly ChatMessage[];
  // Stop 是否已经请求过继续，用于阻止 Hook 自我延续。
  readonly stopHookActive?: boolean;
}

// 某次 Hook 回调看到的冻结生命周期数据；不同事件严格隔离字段所有权。
export class HookContext {
  // 每个事件只携带其拥有的数据，避免 Hook 误用其他生命周期阶段的状态。
  readonly event: HookEvent;
  readonly message: ChatMessage | undefined;
  readonly prepared: PreparedToolCall | undefined;
  readonly result: ToolResult | undefined;
  readonly history: readonly ChatMessage[];
  readonly stopHookActive: boolean;

  // 校验事件字段组合、复制 history 并冻结上下文，防止回调修改 Agent 内部状态。
  constructor(options: HookContextOptions) {
    if (!isHookEvent(options.event)) {
      throw new HookContractError("event must be a HookEvent");
    }
    const history = options.history === undefined ? [] : options.history;
    const stopHookActive = options.stopHookActive === undefined ? false : options.stopHookActive;
    if (!Array.isArray(history) || !history.every((message: unknown) => isChatMessage(message))) {
      throw new HookContractError(`${options.event} history must contain ChatMessage values`);
    }
    if (typeof stopHookActive !== "boolean") {
      throw new HookContractError("stopHookActive must be boolean");
    }

    this.event = options.event;
    this.message = options.message;
    this.prepared = options.prepared;
    this.result = options.result;
    this.history = Object.freeze([...history]);
    this.stopHookActive = stopHookActive;
    this.#validateEventFields();
    Object.freeze(this);
  }

  // 按事件验证字段归属，避免例如 Stop Hook 读取或伪造工具执行状态。
  #validateEventFields(): void {
    if (this.event === "UserPromptSubmit") {
      if (!isChatMessage(this.message) || this.message.role !== "user") {
        throw new HookContractError("UserPromptSubmit requires a user message");
      }
      if (
        this.prepared !== undefined ||
        this.result !== undefined ||
        this.history.length > 0 ||
        this.stopHookActive
      ) {
        throw new HookContractError("UserPromptSubmit received fields owned by another event");
      }
      return;
    }
    if (this.event === "PreToolUse") {
      if (!isValidPrepared(this.prepared)) {
        throw new HookContractError("PreToolUse requires a valid prepared tool call");
      }
      if (
        this.message !== undefined ||
        this.result !== undefined ||
        this.history.length > 0 ||
        this.stopHookActive
      ) {
        throw new HookContractError("PreToolUse received fields owned by another event");
      }
      return;
    }
    if (this.event === "PostToolUse") {
      if (!isValidPrepared(this.prepared)) {
        throw new HookContractError("PostToolUse requires a valid prepared tool call");
      }
      if (!isToolResult(this.result)) {
        throw new HookContractError("PostToolUse requires a tool result");
      }
      if (this.message !== undefined || this.history.length > 0 || this.stopHookActive) {
        throw new HookContractError("PostToolUse received fields owned by another event");
      }
      return;
    }
    if (this.message !== undefined || this.prepared !== undefined || this.result !== undefined) {
      throw new HookContractError("Stop received fields owned by another event");
    }
  }
}

export interface HookResultOptions {
  // PreToolUse 对权限合并提出的候选行为。
  readonly permissionBehavior?: PermissionBehavior;
  // PreToolUse 唯一允许的参数更新，必须保留原调用身份与定义。
  readonly updatedInput?: PreparedToolCall;
  // PostToolUse 唯一允许的结果更新。
  readonly updatedOutput?: ToolResult;
  // 任意事件可追加的只读系统上下文，下一轮模型请求前置。
  readonly additionalContext?: readonly ChatMessage[];
  // PreToolUse 可阻断执行并直接回填的错误结果。
  readonly blockingError?: ToolResult;
  // PostToolUse 请求停止剩余同轮调用与后续继续。
  readonly preventContinuation?: boolean;
  // Stop 请求额外一次模型轮次的用户消息，只允许生效一次。
  readonly forceContinue?: ChatMessage;
}

// Hook 的结构化影响；回调不能直接改写 Loop，只能返回受事件约束的声明式结果。
export class HookResult {
  // 构造器内校验类型并冻结副本，防止回调引用扩散污染。
  // Hook 的副作用被建模为结构化结果，不能直接修改 Agent 内部状态。
  readonly permissionBehavior: PermissionBehavior;
  readonly updatedInput: PreparedToolCall | undefined;
  readonly updatedOutput: ToolResult | undefined;
  readonly additionalContext: readonly ChatMessage[];
  readonly blockingError: ToolResult | undefined;
  readonly preventContinuation: boolean;
  readonly forceContinue: ChatMessage | undefined;

  // 验证结果形状、深复制可变引用并冻结，防止回调返回值在合并后被改写。
  constructor(options: HookResultOptions = {}) {
    const permissionBehavior = options.permissionBehavior ?? "passthrough";
    const additionalContext = options.additionalContext ?? [];
    const preventContinuation = options.preventContinuation ?? false;
    if (!isPermissionBehavior(permissionBehavior)) {
      throw new HookContractError("permissionBehavior must be a PermissionBehavior");
    }
    if (options.updatedInput !== undefined && !isValidPrepared(options.updatedInput)) {
      throw new HookContractError("updatedInput must be a valid prepared tool call");
    }
    if (options.updatedOutput !== undefined && !isToolResult(options.updatedOutput)) {
      throw new HookContractError("updatedOutput must be a ToolResult");
    }
    if (
      options.blockingError !== undefined &&
      (!isToolResult(options.blockingError) || !options.blockingError.isError)
    ) {
      throw new HookContractError("blockingError must be an error ToolResult");
    }
    if (
      !Array.isArray(additionalContext) ||
      !additionalContext.every(
        (message: unknown) => isChatMessage(message) && message.role === "system",
      )
    ) {
      throw new HookContractError("additionalContext must contain system ChatMessage values");
    }
    if (typeof preventContinuation !== "boolean") {
      throw new HookContractError("preventContinuation must be boolean");
    }
    if (
      options.forceContinue !== undefined &&
      (!isChatMessage(options.forceContinue) || options.forceContinue.role !== "user")
    ) {
      throw new HookContractError("forceContinue must be a user message");
    }

    this.permissionBehavior = permissionBehavior;
    this.updatedInput = options.updatedInput;
    this.updatedOutput =
      options.updatedOutput === undefined ? undefined : copyToolResult(options.updatedOutput);
    this.additionalContext = Object.freeze(
      additionalContext.map((message) => systemMessage(message.content)),
    );
    this.blockingError =
      options.blockingError === undefined ? undefined : copyToolResult(options.blockingError);
    this.preventContinuation = preventContinuation;
    this.forceContinue =
      options.forceContinue === undefined ? undefined : userMessage(options.forceContinue.content);
    Object.freeze(this);
  }

  // 检查当前结果是否只使用目标事件允许的字段，避免跨生命周期越权。
  validateFor(event: HookEvent): void {
    if (!isHookEvent(event)) {
      throw new HookContractError("event must be a HookEvent");
    }
    const invalid: string[] = [];
    if (event !== "PreToolUse") {
      if (this.permissionBehavior !== "passthrough") {
        invalid.push("permissionBehavior");
      }
      if (this.updatedInput !== undefined) {
        invalid.push("updatedInput");
      }
      if (this.blockingError !== undefined) {
        invalid.push("blockingError");
      }
    }
    if (event !== "PostToolUse") {
      if (this.updatedOutput !== undefined) {
        invalid.push("updatedOutput");
      }
      if (this.preventContinuation) {
        invalid.push("preventContinuation");
      }
    }
    if (event !== "Stop" && this.forceContinue !== undefined) {
      invalid.push("forceContinue");
    }
    if (invalid.length > 0) {
      throw new HookContractError(
        `${event} HookResult does not allow fields: ${invalid.join(", ")}`,
      );
    }
  }
}

// 同步或异步 Hook 回调；必须返回受 HookResult 契约约束的对象。
export type HookCallback = (context: HookContext) => HookResult | Promise<HookResult>;

// 按事件保存有序回调队列，并负责串行运行、标准化和合并各回调结果。
export class HookRegistry {
  // 每个事件有独立回调队列，注册顺序即为执行顺序。
  // 回调按注册顺序合并；后续回调读取前一个回调规范化后的上下文。
  readonly #callbacks: Map<HookEvent, HookCallback[]> = new Map(
    HOOK_EVENTS.map((event) => [event, []]),
  );

  // 注册回调到事件队列尾部，注册顺序即该事件的执行顺序。
  register(event: HookEvent, callback: HookCallback): void {
    if (!isHookEvent(event)) {
      throw new HookContractError("event must be a HookEvent");
    }
    if (typeof callback !== "function") {
      throw new HookContractError("hook callback must be callable");
    }
    const callbacks = this.#callbacks.get(event);
    if (callbacks === undefined) {
      throw new HookContractError(`hook registry is missing event: ${event}`);
    }
    callbacks.push(callback);
  }

  // 串行执行该事件所有回调，传递规范化后的上下文并合并成单个最终结果。
  async run(context: HookContext): Promise<HookResult> {
    // 串行执行回调，合并结果；blockingError 或 forceContinue 短路。
    if (!(context instanceof HookContext)) {
      throw new HookContractError("context must be a HookContext");
    }
    let combined = new HookResult();
    let current = context;
    const callbacks = this.#callbacks.get(context.event);
    if (callbacks === undefined) {
      throw new HookContractError(`hook registry is missing event: ${context.event}`);
    }
    for (const callback of callbacks) {
      const outcome: unknown = await callback(current);
      if (!(outcome instanceof HookResult)) {
        throw new HookContractError(`${context.event} hook callback must return HookResult`);
      }
      outcome.validateFor(context.event);
      const normalizedInput = normalizeUpdatedInput(current, outcome);
      const normalizedOutcome =
        normalizedInput === undefined
          ? outcome
          : new HookResult({
              permissionBehavior: outcome.permissionBehavior,
              updatedInput: normalizedInput,
              additionalContext: outcome.additionalContext,
              ...(outcome.blockingError === undefined
                ? {}
                : { blockingError: outcome.blockingError }),
            });
      const effective =
        context.event === "Stop" &&
        context.stopHookActive &&
        normalizedOutcome.forceContinue !== undefined
          ? new HookResult({ additionalContext: normalizedOutcome.additionalContext })
          : normalizedOutcome;
      combined = mergeResults(combined, effective);

      if (effective.updatedInput !== undefined) {
        current = new HookContext({ event: "PreToolUse", prepared: effective.updatedInput });
      }
      if (effective.updatedOutput !== undefined && current.prepared !== undefined) {
        current = new HookContext({
          event: "PostToolUse",
          prepared: current.prepared,
          result: effective.updatedOutput,
        });
      }
      if (effective.blockingError !== undefined || effective.forceContinue !== undefined) {
        break;
      }
    }
    return combined;
  }

  // 以用户消息构造 UserPromptSubmit 上下文并运行对应队列。
  async runUserPrompt(message: ChatMessage): Promise<HookResult> {
    return this.run(new HookContext({ event: "UserPromptSubmit", message }));
  }

  // 以已验证调用构造 PreToolUse 上下文。
  async runPreTool(prepared: PreparedToolCall): Promise<HookResult> {
    return this.run(new HookContext({ event: "PreToolUse", prepared }));
  }

  // 以调用与结果构造 PostToolUse 上下文。
  async runPostTool(prepared: PreparedToolCall, result: ToolResult): Promise<HookResult> {
    return this.run(new HookContext({ event: "PostToolUse", prepared, result }));
  }

  // 以历史与续写状态构造 Stop 上下文，Stop 只能安全请求一次继续。
  async runStop(history: readonly ChatMessage[], stopHookActive: boolean): Promise<HookResult> {
    return this.run(new HookContext({ event: "Stop", history, stopHookActive }));
  }
}

// 重解析 Hook 提供的参数更新，保留原调用 ID/工具定义并返回脱离 Hook 引用的冻结副本。
function normalizeUpdatedInput(
  // 重新解析 updatedInput 并冻结副本，防止“批准 A、执行 B”。
  context: HookContext,
  result: HookResult,
): PreparedToolCall | undefined {
  const updated = result.updatedInput;
  if (updated === undefined) {
    return undefined;
  }
  const original = context.prepared;
  if (original === undefined || original.definition === undefined) {
    throw new HookContractError("updatedInput requires an existing prepared tool call");
  }
  if (updated.call.id !== original.call.id) {
    throw new HookContractError("updatedInput must preserve the OpenAI tool call id");
  }
  if (updated.call.name !== original.call.name) {
    throw new HookContractError("updatedInput must preserve the tool name");
  }
  if (updated.definition !== original.definition) {
    throw new HookContractError("updatedInput must preserve the registered definition");
  }
  const parsed = original.definition.inputSchema.safeParse(updated.arguments);
  if (!parsed.success) {
    throw new HookContractError("updatedInput arguments must match the registered input schema");
  }
  // 审批和执行只读取这个脱离 Hook 原引用的冻结副本，避免批准 A、执行 B。
  return freezePreparedToolCall(updated.call, original.definition, parsed.data);
}

// 合并串行回调影响：更新以后者为准、上下文累积、权限取最严格、阻断/续写短路保留首项。
function mergeResults(current: HookResult, incoming: HookResult): HookResult {
  // 合并策略：updatedInput/Output 以后优先，additionalContext 串联，
  // preventContinuation OR，permissionBehavior 取最严格，
  // blockingError/forceContinue 短路并保留最先出现的。
  return new HookResult({
    permissionBehavior: strongerPermission(current.permissionBehavior, incoming.permissionBehavior),
    ...(incoming.updatedInput === undefined
      ? current.updatedInput === undefined
        ? {}
        : { updatedInput: current.updatedInput }
      : { updatedInput: incoming.updatedInput }),
    ...(incoming.updatedOutput === undefined
      ? current.updatedOutput === undefined
        ? {}
        : { updatedOutput: current.updatedOutput }
      : { updatedOutput: incoming.updatedOutput }),
    additionalContext: [...current.additionalContext, ...incoming.additionalContext],
    ...(incoming.blockingError === undefined
      ? current.blockingError === undefined
        ? {}
        : { blockingError: current.blockingError }
      : { blockingError: incoming.blockingError }),
    preventContinuation: current.preventContinuation || incoming.preventContinuation,
    ...(incoming.forceContinue === undefined
      ? current.forceContinue === undefined
        ? {}
        : { forceContinue: current.forceContinue }
      : { forceContinue: incoming.forceContinue }),
  });
}

// 按 deny > ask > allow > passthrough 的保守优先级合并权限建议。
function strongerPermission(
  // deny > ask > allow > passthrough
  current: PermissionBehavior,
  incoming: PermissionBehavior,
): PermissionBehavior {
  const priority: Readonly<Record<PermissionBehavior, number>> = {
    passthrough: 0,
    allow: 1,
    ask: 2,
    deny: 3,
  };
  return priority[incoming] > priority[current] ? incoming : current;
}
