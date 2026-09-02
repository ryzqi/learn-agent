import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { isRuntimeEvent, runtimeEventMessage } from "./events.js";
import type { RuntimeEvent } from "./events.js";
import { HookContractError, HookRegistry } from "./hooks.js";
import type { HookResult } from "./hooks.js";
import {
  isChatMessage,
  systemMessage,
  toolMessage,
  userMessage,
  validateToolPairing,
} from "./messages.js";
import type { ChatMessage, ToolCall } from "./messages.js";
import type { ModelClient, ModelReply, ModelRequest } from "./model.js";
import { PermissionDecision, PermissionPolicy, PermissionRequest } from "./permissions.js";
import type { PreparedToolCall, ToolContext, ToolRegistry, ToolResult } from "./tools.js";
import { copyToolResult, isToolResult, toolError } from "./tools.js";

// AgentRunner 是 Agent Loop：协调模型、工具、权限、Hook、后台事件与资源关闭，并保证每个工具调用都有协议回填。
export class AgentRunError extends Error {
  override readonly name: string = "AgentRunError";
}

export class AgentLimitError extends AgentRunError {
  override readonly name: string = "AgentLimitError";
}

export class IncompleteModelReplyError extends AgentRunError {
  override readonly name: string = "IncompleteModelReplyError";
}

export interface RunResult {
  readonly finalText: string;
  readonly history: readonly ChatMessage[];
  readonly turns: number;
}

// RunOptions 是显式回合选项：idempotencyKey 让队友消息重试时保持工具副作用可去重，claimToken 供 Worktree 认领，signal 用于取消当前回合。
export interface RunOptions {
  readonly idempotencyKey?: string;
  readonly claimToken?: string;
  readonly signal?: AbortSignal;
}

export interface AgentRunnerOptions {
  readonly model: ModelClient;
  readonly tools: ToolRegistry;
  readonly systemPrompt: string;
  readonly systemPromptProvider?: SystemPromptProvider;
  readonly workspace: string;
  readonly maxTurns?: number;
  readonly identity?: string;
  readonly permissionPolicy?: PermissionPolicy;
  readonly hooks?: HookRegistry;
  readonly toolRoundObserver?: ToolRoundObserver;
  readonly historyProcessor?: RequestHistoryProcessor;
  readonly toolResultProcessor?: ToolResultProcessor;
  readonly turnLifecycle?: TurnLifecycle;
  readonly modelRequestExecutor?: ModelRequestExecutor;
  // 可选分派器接管工具执行；后台任务等场景可以先返回占位结果，再异步补交终态。
  readonly toolDispatcher?: ToolDispatcher;
  // P18 可选上下文提供器把 claim 映射到受限工作区；不注入时保持 P1-P17 行为。
  readonly toolContextProvider?: ToolContextProvider;
  // 可选事件泵把后台终态异步注入 Agent Loop；注入后每轮模型请求前都会先接收事件。
  readonly eventPump?: RuntimeEventPump;
  // 可选外部资源按逆序统一关闭，AgentRunner 在 close() 时负责收束其生命周期。
  readonly resources?: readonly AsyncResource[];
}

// 处理器产出必须仍满足消息配对，确保压缩不破坏模型协议。
export interface RequestHistoryProcessor {
  prepare(history: readonly ChatMessage[]): Promise<readonly ChatMessage[]>;
}

// 动态提示 Provider 对 AgentRunner 保持零参数契约，内部数据源由组合根在构建时绑定。
export interface SystemPromptProvider {
  // 每轮模型调用临时读取动态系统提示，不把渲染结果写入对话历史。
  render(): string;
}

// Executor 接管模型调用时必须显式 beginTurn，确保恢复状态与 Agent 回合对齐。
export interface ModelRequestExecutor {
  beginTurn(): void;
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelReply>;
}

// TurnLifecycle 是记忆等跨请求能力的边界：beginTurn 在首轮前执行，
// beforeModel 只给下一次模型请求附加上下文，complete 在最终结果返回前收尾。
export interface TurnLifecycle {
  beginTurn(query: string): Promise<void>;
  beforeModel(): readonly ChatMessage[];
  complete(history: readonly ChatMessage[]): Promise<void>;
}

// 工具结果处理器只允许整批返回，输出必须与工具调用数量一致，否则由 Runner 按受控错误回填。
export type ToolResultProcessor = (
  results: readonly ToolResult[],
) => Promise<readonly ToolResult[]> | readonly ToolResult[];

// 工具分派器保留原同步执行路径的返回值契约；后台作业先返回占位结果，再通过事件泵补交终态。
export interface ToolDispatcher {
  dispatch(prepared: PreparedToolCall, context: ToolContext): Promise<ToolResult>;
}

// 在工具调度前解析受限执行上下文，MCP 工具与本地工具共享同一身份边界。
export interface ToolContextProvider {
  readonly workspaceRoot: string;
  resolve(context: ToolContext): ToolContext | Promise<ToolContext>;
}

export interface RuntimeEventPump {
  readonly hasPendingWork: boolean;
  drainEvents(limit?: number): readonly RuntimeEvent[];
  waitForEvents(limit?: number): Promise<readonly RuntimeEvent[]>;
  // ack 允许异步完成，调用方必须等待确认后才能安全丢弃事件。
  acknowledgeEvents(events: readonly RuntimeEvent[]): void | Promise<void>;
  ready?(): Promise<void>;
}

// AsyncResource 是 Runner 可管理的关闭边界；由组合根注入，避免核心直接依赖具体后台实现。
export interface AsyncResource {
  close(): Promise<void>;
}

// 观察器可在模型请求前提供指导，并在工具轮完成后更新内部状态。
export interface ToolRoundObserver {
  beforeModel(): readonly ChatMessage[];
  recordToolRound(toolNames: readonly string[]): void;
}

interface ToolExecution {
  readonly result: ToolResult;
  readonly additionalContext: readonly ChatMessage[];
  readonly preventContinuation: boolean;
}

export class AgentRunner {
  readonly #model: ModelClient;
  readonly #tools: ToolRegistry;
  readonly #systemPrompt: string;
  readonly #systemPromptProvider: SystemPromptProvider | undefined;
  readonly #workspace: string;
  readonly #workspaceRoot: string;
  readonly #maxTurns: number;
  readonly #identity: string;
  readonly #permissionPolicy: PermissionPolicy | undefined;
  readonly #hooks: HookRegistry;
  readonly #toolRoundObserver: ToolRoundObserver | undefined;
  readonly #historyProcessor: RequestHistoryProcessor | undefined;
  readonly #toolResultProcessor: ToolResultProcessor | undefined;
  readonly #turnLifecycle: TurnLifecycle | undefined;
  readonly #modelRequestExecutor: ModelRequestExecutor | undefined;
  // 可选分派器接管实际调用；未注入时仍走 ToolRegistry.invoke 的同步路径。
  readonly #toolDispatcher: ToolDispatcher | undefined;
  // P18 可选提供器负责把 claim 解析为受限工作区；未注入时工具上下文保持原工作区。
  readonly #toolContextProvider: ToolContextProvider | undefined;
  // EventPump 可选接收后台终态；未注入时保持 P01-P12 的同步 Agent Loop。
  readonly #eventPump: RuntimeEventPump | undefined;
  // 外部资源以冻结数组保存，关闭时按逆序执行，保证依赖方先于被依赖方释放。
  readonly #resources: readonly AsyncResource[];
  readonly #history: ChatMessage[] = [];
  // 事件 id 去重表：同一后台事件只能作为一条 user message 注入一次 canonical history。
  readonly #seenEventIds = new Set<string>();
  // mailbox ack 重试登记：事件已入 canonical history，但 ack 未确认前不允许再次写历史或调用模型。
  readonly #pendingEventAcks = new Set<string>();
  // 延迟事件队列：用户回合内不允许 Cron/mailbox 等上下文事件抢占，先暂存到 runEvents() 再消费。
  readonly #deferredRuntimeEvents: RuntimeEvent[] = [];
  // 运行/关闭状态组成 Runner 生命周期：并发 run、重复 close 和关闭后继续执行都会显式失败。
  #running = false;
  #closed = false;
  #closing = false;

  constructor(options: AgentRunnerOptions) {
    const maxTurns = options.maxTurns === undefined ? 20 : options.maxTurns;
    if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
      throw new Error("maxTurns must be a positive integer");
    }
    const identity = options.identity === undefined ? "user" : options.identity;
    if (identity.trim().length === 0) {
      throw new Error("identity must not be empty");
    }
    if (options.systemPrompt.trim().length === 0) {
      throw new Error("systemPrompt must not be empty");
    }
    if (
      options.systemPromptProvider !== undefined &&
      typeof options.systemPromptProvider.render !== "function"
    ) {
      throw new TypeError("systemPromptProvider must implement render()");
    }
    if (
      options.modelRequestExecutor !== undefined &&
      (typeof options.modelRequestExecutor.beginTurn !== "function" ||
        typeof options.modelRequestExecutor.complete !== "function")
    ) {
      // 可选扩展契约在构造时校验，避免运行到模型阶段才发现缺方法。
      throw new TypeError("modelRequestExecutor must implement beginTurn() and complete()");
    }
    if (
      options.toolDispatcher !== undefined &&
      typeof options.toolDispatcher.dispatch !== "function"
    ) {
      // 工具分派器在构造期校验，运行中一旦注入就不可缺失 dispatch()。
      throw new TypeError("toolDispatcher must implement dispatch()");
    }
    if (
      options.toolContextProvider !== undefined &&
      (typeof options.toolContextProvider.resolve !== "function" ||
        typeof options.toolContextProvider.workspaceRoot !== "string" ||
        options.toolContextProvider.workspaceRoot.trim().length === 0)
    ) {
      // P18 上下文提供器必须同时给出 workspaceRoot 与 resolve()，否则无法建立受限工作区边界。
      throw new TypeError("toolContextProvider must implement the ToolContextProvider contract");
    }
    if (
      options.eventPump !== undefined &&
      (typeof options.eventPump.drainEvents !== "function" ||
        typeof options.eventPump.waitForEvents !== "function" ||
        typeof options.eventPump.acknowledgeEvents !== "function" ||
        (options.eventPump.ready !== undefined && typeof options.eventPump.ready !== "function"))
    ) {
      // 事件泵契约完整校验后才注入，未注入时 Loop 保持原有同步行为。
      throw new TypeError("eventPump must implement the RuntimeEventPump contract");
    }
    const resources = options.resources === undefined ? [] : options.resources;
    if (
      !Array.isArray(resources) ||
      !resources.every((resource) => typeof resource.close === "function")
    ) {
      // 资源数组只接受实现了 close() 的对象；缺省为空，关闭时不产生副作用。
      throw new TypeError("resources must contain AsyncResource values");
    }

    this.#model = options.model;
    this.#tools = options.tools;
    this.#systemPrompt = options.systemPrompt;
    this.#systemPromptProvider = options.systemPromptProvider;
    this.#workspace = resolve(options.workspace);
    this.#workspaceRoot = resolve(
      options.toolContextProvider === undefined
        ? this.#workspace
        : options.toolContextProvider.workspaceRoot,
    );
    this.#maxTurns = maxTurns;
    this.#identity = identity;
    this.#permissionPolicy =
      options.permissionPolicy === undefined && options.hooks !== undefined
        ? new PermissionPolicy()
        : options.permissionPolicy;
    this.#hooks = options.hooks === undefined ? new HookRegistry() : options.hooks;
    this.#toolRoundObserver = options.toolRoundObserver;
    this.#historyProcessor = options.historyProcessor;
    this.#toolResultProcessor = options.toolResultProcessor;
    this.#turnLifecycle = options.turnLifecycle;
    this.#modelRequestExecutor = options.modelRequestExecutor;
    this.#toolDispatcher = options.toolDispatcher;
    // P18 提供器在构造期解析工作区根，工具上下文只允许落在 workspaceRoot 内部。
    this.#toolContextProvider = options.toolContextProvider;
    this.#eventPump = options.eventPump;
    this.#resources = Object.freeze([...resources]);
  }

  get history(): readonly ChatMessage[] {
    return Object.freeze([...this.#history]);
  }

  // 普通用户回合入口；显式 idempotencyKey、claimToken 与 signal 先于任何模型/工具副作用校验。
  async run(prompt: string, options: RunOptions = {}): Promise<RunResult> {
    this.#ensureOpen();
    if (this.#closed) {
      throw new AgentRunError("AgentRunner is closed");
    }
    if (this.#running) {
      throw new AgentRunError("AgentRunner is already running");
    }
    // running 标记在 finally 中复位，保证异常退出后 Runner 仍可复用。
    this.#running = true;
    try {
      if (
        options.idempotencyKey !== undefined &&
        (typeof options.idempotencyKey !== "string" || options.idempotencyKey.trim().length === 0)
      ) {
        throw new Error("idempotencyKey must not be empty");
      }
      if (
        options.claimToken !== undefined &&
        (typeof options.claimToken !== "string" || options.claimToken.trim().length === 0)
      ) {
        // P18 认领令牌在进入模型调用前校验，空 token 不能形成幂等认领键。
        throw new Error("claimToken must not be empty");
      }
      if (options.signal?.aborted) throw options.signal.reason;
      return await this.#runUserTurn(
        prompt,
        undefined,
        options.idempotencyKey,
        options.claimToken,
        options.signal,
      );
    } finally {
      this.#running = false;
    }
  }

  // Cron/mailbox wakeup 调用的外部事件入口：无用户 prompt 时消费一个允许执行的上下文事件并启动独立回合。
  async runEvents(): Promise<RunResult | undefined> {
    this.#ensureOpen();
    // 与用户 turn 共用运行锁；正在运行时 wakeup 直接放弃，避免并发回合。
    if (this.#running) {
      return undefined;
    }
    this.#running = true;
    try {
      // 显式允许上下文事件，调度到的新事件由此开启一轮。
      const event = await this.#acceptNextRuntimeEvent(false, true);
      if (event === undefined) {
        return undefined;
      }
      const payload = event.toPayload();
      // 事件 payload 转为回合 prompt；事件消息已在历史中，不再经过 UserPromptSubmit hook。
      const prompt = typeof payload.prompt === "string" ? payload.prompt : JSON.stringify(payload);
      return await this.#runUserTurn(prompt, event);
    } finally {
      this.#running = false;
    }
  }

  // runtimeEvent 表示事件回合：跳过普通 user prompt hook，并使用事件携带的身份与幂等键；普通 run() 可显式传入同款选项。
  async #runUserTurn(
    prompt: string,
    runtimeEvent?: RuntimeEvent,
    idempotencyKey?: string,
    claimToken?: string,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    this.#ensureOpen();
    // 普通用户回合追加 userMessage 并运行 UserPromptSubmit；事件回合的事件消息已由事件泵写入。
    if (runtimeEvent === undefined) {
      const submitted = userMessage(prompt);
      const promptHook = await this.#hooks.runUserPrompt(submitted);
      this.#history.push(submitted, ...promptHook.additionalContext);
    }
    // 生命周期先于首轮模型请求执行；选择失败由实现方降级，不能阻塞主 Agent。
    if (this.#turnLifecycle !== undefined) {
      await this.#turnLifecycle.beginTurn(prompt);
    }
    // 执行器与 memory lifecycle 对齐回合边界；P01-P10 不注入时继续直接调用 ModelClient。
    this.#modelRequestExecutor?.beginTurn();
    // 事件回合使用事件携带的 identity 与幂等键，不借用 CLI 用户身份；普通 run() 沿用 Runner identity。
    const turnIdempotencyKey = runtimeEvent?.idempotencyKey ?? idempotencyKey;
    // 每个 turn 创建独立 executionScope；provider 可用时注入，
    // 使同一回复内连续 tool call 能共享 claim 关联，但不同 turn 不串用。
    const toolContextScope = Object.freeze({});
    const context: ToolContext = Object.freeze({
      workspace: this.#workspace,
      identity: runtimeEvent?.contextIdentity ?? this.#identity,
      ...(turnIdempotencyKey === undefined ? {} : { idempotencyKey: turnIdempotencyKey }),
      ...(claimToken === undefined ? {} : { claimToken }),
      ...(this.#toolContextProvider === undefined ? {} : { executionScope: toolContextScope }),
    });

    let stopHookActive = false;
    for (let turn = 1; turn <= this.#maxTurns; turn += 1) {
      // 用户回合内只接收普通后台事件；Cron/mailbox 上下文事件会被延迟，避免打断当前用户会话。
      // 每次模型请求前都先接收已完成的后台事件，避免事件只在首轮可见。
      await this.#acceptNextRuntimeEvent(false, false);
      validateToolPairing(this.#history);
      const preparedHistory: unknown =
        this.#historyProcessor === undefined
          ? this.#history
          : await this.#historyProcessor.prepare(Object.freeze([...this.#history]));
      if (
        !Array.isArray(preparedHistory) ||
        !preparedHistory.every((message: unknown) => isChatMessage(message))
      ) {
        throw new AgentRunError("Request history processor returned invalid messages");
      }
      // requestHistory 只决定模型本次能看到什么，canonical history 仍保持完整追加。
      const requestHistory = Object.freeze([...preparedHistory]);
      validateToolPairing(requestHistory);
      // beforeModel 注入只进入本次模型请求，不写入 canonical history。
      const turnGuidance =
        this.#turnLifecycle === undefined ? [] : this.#turnLifecycle.beforeModel();
      if (
        !Array.isArray(turnGuidance) ||
        !turnGuidance.every((message: unknown) => isChatMessage(message))
      ) {
        throw new AgentRunError("Turn lifecycle returned invalid model guidance");
      }
      const observerGuidance =
        // 观察器指导是请求级内容，只影响当次模型输入；TODO 提醒等不写入持久历史。
        // 系统提示在每轮组装请求前渲染，使工具列表和选中记忆等运行态变化下一轮生效。
        this.#toolRoundObserver === undefined ? [] : this.#toolRoundObserver.beforeModel();
      const systemPrompt = this.#renderSystemPrompt();
      const requestMessages = Object.freeze([
        systemMessage(systemPrompt),
        ...requestHistory,
        ...turnGuidance,
        ...observerGuidance,
      ]);
      validateToolPairing(requestMessages);
      // 一次模型请求与其回复内的所有 tool calls 共享同一个不可变 snapshot；
      // MCP 连接/断开只能在下一轮模型请求起点影响工具集。
      const tools = this.#tools.snapshot();
      const request: ModelRequest = Object.freeze({
        messages: requestMessages,
        tools: tools.openAITools(),
      });
      // 有执行器时，内部重试、压缩和 fallback 都在 complete() 内收束，不会重新进入外层循环。
      const reply = await (this.#modelRequestExecutor === undefined
        ? this.#model.complete(request, signal)
        : this.#modelRequestExecutor.complete(request, signal));

      if (reply.finishReason === "length") {
        throw new IncompleteModelReplyError("Model output reached the token limit");
      }
      if (reply.finishReason === "content_filter") {
        throw new AgentRunError("Model response was blocked by the content filter");
      }

      const assistant = reply.message;
      this.#history.push(assistant);
      if (assistant.toolCalls.length === 0) {
        if (assistant.content === null) {
          throw new AgentRunError("Model stopped without final text or tool calls");
        }
        const stopHook = await this.#hooks.runStop(this.#history, stopHookActive);
        if (stopHook.forceContinue !== undefined) {
          this.#history.push(...stopHook.additionalContext, stopHook.forceContinue);
          stopHookActive = true;
          continue;
        }
        const event = await this.#acceptNextRuntimeEvent(true, false);
        if (event !== undefined) {
          continue;
        }
        // 当前轮已无工具调用；先等待可能有结果的后台事件，事件到达时继续下一轮。
        return await this.#complete(assistant.content, turn);
      }

      // 一条 assistant 消息中的每个调用都必须回填一次，错误和拒绝也不例外。
      const results: ToolResult[] = [];
      const deferredContext: ChatMessage[] = [];
      let stoppedResultIndex: number | undefined;
      for (const call of assistant.toolCalls) {
        let result: ToolResult;
        if (stoppedResultIndex !== undefined) {
          result = toolError(
            "hook_stopped_continuation",
            "Skipped after PostToolUse requested a stop",
          );
        } else {
          const execution = await this.#executeTool(call, context, tools);
          result = execution.result;
          deferredContext.push(...execution.additionalContext);
          if (execution.preventContinuation) {
            stoppedResultIndex = results.length;
          }
        }
        results.push(result);
      }
      const processedResults = await this.#processToolResults(results, assistant.toolCalls);
      for (const [index, call] of assistant.toolCalls.entries()) {
        const result = processedResults[index];
        if (result === undefined) {
          throw new AgentRunError("Tool execution did not produce a paired result");
        }
        // 每个工具调用都必须回填一个 tool message，否则后续模型请求会破坏协议配对。
        this.#history.push(toolMessage(result.content, call.id));
      }
      if (this.#toolRoundObserver !== undefined) {
        this.#toolRoundObserver.recordToolRound(assistant.toolCalls.map((call) => call.name));
      }
      this.#history.push(...deferredContext);
      if (stoppedResultIndex !== undefined) {
        const stoppedResult = processedResults[stoppedResultIndex];
        if (stoppedResult === undefined) {
          throw new AgentRunError("PostToolUse stop did not preserve its result");
        }
        return await this.#complete(stoppedResult.content, turn);
      }
    }

    throw new AgentLimitError(`Agent exceeded maxTurns=${this.#maxTurns}`);
  }

  async #processToolResults(
    results: readonly ToolResult[],
    calls: readonly ToolCall[],
  ): Promise<readonly ToolResult[]> {
    // 处理器只能改变结果内容，不能改变调用数量；失败时为每个 call 生成配对错误，
    // 以保持模型协议的 tool_call/tool_result 一一对应关系。
    // 未配置处理器时仍复制结果，避免调用方通过同一对象意外修改历史。
    if (this.#toolResultProcessor === undefined) {
      return Object.freeze(results.map((result) => copyToolResult(result)));
    }
    try {
      const input = Object.freeze(results.map((result) => copyToolResult(result)));
      const processed: unknown = await this.#toolResultProcessor(input);
      if (!Array.isArray(processed) || processed.length !== calls.length) {
        throw new Error("tool result processor returned an invalid batch");
      }
      return Object.freeze(processed.map((result) => copyToolResult(result)));
    } catch {
      return Object.freeze(
        calls.map(() => toolError("tool_result_processing_error", "Tool result processing failed")),
      );
    }
  }

  // 每轮模型请求前渲染系统提示；provider 缺失时使用构建期固定字符串。
  #renderSystemPrompt(): string {
    // Provider 输出是模型边界输入，空值立即失败而不是回退到旧缓存。
    const rendered =
      this.#systemPromptProvider === undefined
        ? this.#systemPrompt
        : this.#systemPromptProvider.render();
    if (typeof rendered !== "string" || rendered.trim().length === 0) {
      throw new AgentRunError("System prompt provider returned an empty prompt");
    }
    return rendered;
  }

  // 工具执行边界统一产出 ToolResult，Hook、权限和 handler 异常都不可见原始堆栈。
  async #executeTool(
    call: ToolCall,
    context: ToolContext,
    tools: ToolRegistry,
  ): Promise<ToolExecution> {
    let prepared: PreparedToolCall;
    try {
      prepared = tools.prepare(call);
    } catch {
      return execution(toolError("tool_preparation_error", "Tool preparation failed"));
    }
    if (prepared.error !== undefined) {
      return execution(prepared.error);
    }

    // 在参数 schema 校验之后、PreToolUse/权限/handler 之前解析可信工作区；
    // 解析失败时工具 handler 保持零调用，直接返回配对错误。
    try {
      context = await this.#resolveToolContext(context);
    } catch {
      return execution(toolError("tool_context_error", "Tool context resolution failed"));
    }

    let preHook: HookResult;
    try {
      preHook = await this.#hooks.runPreTool(prepared);
    } catch (error) {
      return execution(
        error instanceof HookContractError
          ? toolError("hook_contract_error", "PreToolUse hook returned an invalid update")
          : toolError("hook_execution_error", "PreToolUse hook failed"),
      );
    }
    const effective = preHook.updatedInput === undefined ? prepared : preHook.updatedInput;
    if (preHook.blockingError !== undefined) {
      return execution(preHook.blockingError, preHook.additionalContext);
    }

    if (this.#permissionPolicy !== undefined) {
      // Hook 只提交结构化建议；系统 deny 仍在同一策略合并中拥有最高优先级。
      try {
        const decision = await this.#permissionPolicy.decide(
          new PermissionRequest({
            prepared: effective,
            context,
            recommendations: hookRecommendations(preHook),
          }),
        );
        if (!decision.isAllowed) {
          return execution(decision.toToolResult(), preHook.additionalContext);
        }
      } catch {
        return execution(
          toolError("permission_evaluation_error", "Permission evaluation failed"),
          preHook.additionalContext,
        );
      }
    }

    let result: ToolResult;
    try {
      // 未注入分派器时直接调用工具注册表；分派器路径必须返回同一个 ToolResult 契约。
      result =
        this.#toolDispatcher === undefined
          ? await tools.invoke(effective, context)
          : await this.#toolDispatcher.dispatch(effective, context);
      if (!isToolResult(result)) {
        throw new TypeError("tool dispatcher returned an invalid result");
      }
    } catch {
      return execution(
        toolError("tool_dispatch_error", "Tool dispatch failed"),
        preHook.additionalContext,
      );
    }
    let postHook: HookResult;
    try {
      postHook = await this.#hooks.runPostTool(effective, result);
    } catch {
      return execution(
        toolError("hook_execution_error", "PostToolUse hook failed"),
        preHook.additionalContext,
      );
    }
    if (postHook.updatedOutput !== undefined) {
      result = postHook.updatedOutput;
    }
    return execution(
      result,
      [...preHook.additionalContext, ...postHook.additionalContext],
      postHook.preventContinuation,
    );
  }

  async #resolveToolContext(context: ToolContext): Promise<ToolContext> {
    // 这是工具执行前的最后一道上下文边界：provider 可解析 claim，Loop 负责验证
    // 不可变身份与真实路径，避免任意 provider 把工具带出受控 workspace。
    const provider = this.#toolContextProvider;
    if (provider === undefined) return context;
    // provider 负责把 claim 映射到受限 workspace；核心只验证身份不可变和路径仍在仓库根内。
    const resolved = await provider.resolve(context);
    if (typeof resolved !== "object" || resolved === null) {
      throw new TypeError("tool context provider must return ToolContext");
    }
    if (
      resolved.identity !== context.identity ||
      resolved.idempotencyKey !== context.idempotencyKey ||
      resolved.executionScope !== context.executionScope
    ) {
      throw new Error("tool context provider changed immutable execution identity");
    }
    const workspace = await realpath(resolved.workspace);
    if (!(await stat(workspace)).isDirectory() || !isWithin(this.#workspaceRoot, workspace)) {
      throw new Error("resolved tool workspace is outside the controlled workspace root");
    }
    // 再次冻结并写入解析后的真实路径，工具不能在调用期间自行改写执行目录。
    return Object.freeze({ ...resolved, workspace });
  }

  async #complete(finalText: string, turns: number): Promise<RunResult> {
    // 仅在 canonical history 通过配对校验且回合生命周期完成后构造结果，
    // 返回值和历史都冻结，调用方不能事后篡改本次运行证据。
    validateToolPairing(this.#history);
    // complete 使用完整 canonical history，让 extractor 看到请求级压缩前的原始会话。
    if (this.#turnLifecycle !== undefined) {
      await this.#turnLifecycle.complete(Object.freeze([...this.#history]));
    }
    return Object.freeze({
      finalText,
      history: Object.freeze([...this.#history]),
      turns,
    });
  }

  // 重复关闭是幂等操作；正在关闭时拒绝并发调用，防止资源释放顺序错乱。
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    if (this.#closing) {
      throw new AgentRunError("AgentRunner close is already in progress");
    }
    this.#closing = true;
    const failures: unknown[] = [];
    try {
      for (const resource of [...this.#resources].reverse()) {
        try {
          await resource.close();
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      this.#closing = false;
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "AgentRunner close failed");
    }
    this.#closed = true;
  }

  async #acceptNextRuntimeEvent(
    waitForPendingWork: boolean,
    allowContextEvents: boolean,
  ): Promise<RuntimeEvent | undefined> {
    // 按当前回合类型筛选事件：用户回合延迟上下文事件，事件回合才消费它们；
    // 每次只取一个事件，借助 eventId 与 pending ack 集合实现可重试且不重复注入。
    // 事件消费先做去重：普通新事件先写入历史并 ack，重复事件跳过；ack 失败时按事件类型回滚或保留重试状态。
    if (this.#eventPump === undefined) {
      return undefined;
    }
    if (this.#eventPump.ready !== undefined) {
      await this.#eventPump.ready();
    }
    let events =
      this.#deferredRuntimeEvents.length > 0
        ? Object.freeze([this.#deferredRuntimeEvents.shift() as RuntimeEvent])
        : this.#eventPump.drainEvents(1);
    if (events.length === 0 && waitForPendingWork && this.#eventPump.hasPendingWork) {
      events = await this.#eventPump.waitForEvents(1);
    }
    while (events.length > 0) {
      const event = events[0];
      if (event === undefined || !isRuntimeEvent(event)) {
        throw new AgentRunError("Runtime event pump returned invalid events");
      }
      if (event.contextIdentity !== undefined && !allowContextEvents) {
        this.#deferredRuntimeEvents.push(event);
        events = this.#eventPump.drainEvents(1);
        continue;
      }
      if (event.toPayload().kind === "mailbox" && !allowContextEvents) {
        this.#deferredRuntimeEvents.push(event);
        events = this.#eventPump.drainEvents(1);
        continue;
      }
      // 只有首次看到的普通事件写历史；重复事件只补 ack，避免后台终态重复注入。
      const isNewEvent = !this.#seenEventIds.has(event.eventId);
      const retryingAcknowledgement = this.#pendingEventAcks.has(event.eventId);
      if (!isNewEvent && !retryingAcknowledgement) {
        events = this.#eventPump.drainEvents(1);
        continue;
      }
      if (isNewEvent) {
        this.#history.push(runtimeEventMessage(event));
        this.#seenEventIds.add(event.eventId);
      }
      try {
        await this.#eventPump.acknowledgeEvents(events);
      } catch (error) {
        if (event.toPayload().kind !== "mailbox" && isNewEvent) {
          this.#history.pop();
          this.#seenEventIds.delete(event.eventId);
        }
        if (event.toPayload().kind === "mailbox") this.#pendingEventAcks.add(event.eventId);
        throw error;
      }
      this.#pendingEventAcks.delete(event.eventId);
      return event;
    }
    return undefined;
  }

  // 关闭或正在关闭的 Runner 都不可继续执行回合；状态错误显式抛出而不是静默降级。
  #ensureOpen(): void {
    if (this.#closed || this.#closing) {
      throw new AgentRunError("AgentRunner is closed");
    }
  }
}

function execution(
  result: ToolResult,
  additionalContext: readonly ChatMessage[] = [],
  preventContinuation = false,
): ToolExecution {
  return Object.freeze({
    result,
    additionalContext: Object.freeze([...additionalContext]),
    preventContinuation,
  });
}

function hookRecommendations(hook: HookResult): readonly PermissionDecision[] {
  if (hook.permissionBehavior === "passthrough") {
    return [];
  }
  return [
    new PermissionDecision(
      hook.permissionBehavior,
      `PreToolUse hook requested ${hook.permissionBehavior}`,
      "pre-tool-hook",
    ),
  ];
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}
