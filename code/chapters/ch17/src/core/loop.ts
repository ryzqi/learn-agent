// AgentRunner 主循环：串联模型、工具注册表、权限、Hook、后台事件与资源关闭，保证每个工具调用都按协议回填。
import { resolve } from "node:path";

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

// RunOptions 是显式回合选项：idempotencyKey 让队友消息重试时保持工具副作用可去重，signal 用于取消当前回合。
export interface RunOptions {
  readonly idempotencyKey?: string;
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
  // 接收已通过 schema 校验的工具调用，并返回统一 ToolResult。
  dispatch(prepared: PreparedToolCall, context: ToolContext): Promise<ToolResult>;
}

// 事件泵是外部运行时到 Agent Loop 的单向通道：drain 取已就绪事件，waitForEvents 等待 pending 工作，acknowledgeEvents 标记已消费。
export interface RuntimeEventPump {
  // 外部运行时是否仍可能产生事件，供 Loop 决定是否等待。
  readonly hasPendingWork: boolean;
  // 非阻塞取走当前事件批次。
  drainEvents(limit?: number): readonly RuntimeEvent[];
  // 等待并取走下一批事件。
  waitForEvents(limit?: number): Promise<readonly RuntimeEvent[]>;
  // ack 允许异步完成，调用方必须等待确认后才能安全丢弃事件。
  acknowledgeEvents(events: readonly RuntimeEvent[]): void | Promise<void>;
  // 可选恢复屏障，首次 drain 前必须完成。
  ready?(): Promise<void>;
}

// AsyncResource 是 Runner 可管理的关闭边界；由组合根注入，避免核心直接依赖具体后台实现。
export interface AsyncResource {
  // Runner 关闭时按资源注入顺序逆序调用。
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
  readonly #maxTurns: number;
  readonly #identity: string;
  readonly #permissionPolicy: PermissionPolicy | undefined;
  readonly #hooks: HookRegistry;
  readonly #toolRoundObserver: ToolRoundObserver | undefined;
  readonly #historyProcessor: RequestHistoryProcessor | undefined;
  readonly #toolResultProcessor: ToolResultProcessor | undefined;
  readonly #turnLifecycle: TurnLifecycle | undefined;
  readonly #modelRequestExecutor: ModelRequestExecutor | undefined;
  // ToolDispatcher 可选接管实际调用；未注入时仍走 ToolRegistry.invoke 的同步路径。
  readonly #toolDispatcher: ToolDispatcher | undefined;
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
    this.#eventPump = options.eventPump;
    this.#resources = Object.freeze([...resources]);
  }

  get history(): readonly ChatMessage[] {
    return Object.freeze([...this.#history]);
  }

  // 普通用户回合入口；显式 idempotencyKey 与 signal 先于任何模型/工具副作用校验。
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
      if (options.signal?.aborted) throw options.signal.reason;
      return await this.#runUserTurn(prompt, undefined, options.idempotencyKey, options.signal);
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
    const context: ToolContext = Object.freeze({
      workspace: this.#workspace,
      identity: runtimeEvent?.contextIdentity ?? this.#identity,
      ...(turnIdempotencyKey === undefined ? {} : { idempotencyKey: turnIdempotencyKey }),
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
      const tools = this.#tools.snapshot();
      const request: ModelRequest = Object.freeze({
        messages: requestMessages,
        tools: tools.openAITools(),
        // 模型边界一次只发送当前轮请求；signal 透传到底层调用和 RecoveryManager，取消时立即收束。
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
        // 当前轮已无工具调用；先等待可能有结果的后台事件，事件到达时继续下一轮。
        const event = await this.#acceptNextRuntimeEvent(true, false);
        if (event !== undefined) {
          continue;
        }
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
    // 没有处理器时也深拷贝结果，避免工具内部可变对象污染 canonical history。
    if (this.#toolResultProcessor === undefined) {
      return Object.freeze(results.map((result) => copyToolResult(result)));
    }
    // 处理器收到只读快照；返回批次必须与工具调用数一致，否则整批按错误回填。
    try {
      const input = Object.freeze(results.map((result) => copyToolResult(result)));
      const processed: unknown = await this.#toolResultProcessor(input);
      if (!Array.isArray(processed) || processed.length !== calls.length) {
        throw new Error("tool result processor returned an invalid batch");
      }
      return Object.freeze(processed.map((result) => copyToolResult(result)));
      // 处理器失败时整批返回受控错误，仍与原工具调用数量一一对应。
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
    // Pre Hook 可阻断或建议权限，实际拒绝仍由统一权限策略裁决。
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

    // 分派器可选接管工具执行，但必须返回同一 ToolResult 契约；错误统一转为受控错误。
    let result: ToolResult;
    try {
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

  async #complete(finalText: string, turns: number): Promise<RunResult> {
    // complete 使用完整 canonical history，让 extractor 看到请求级压缩前的原始会话。
    validateToolPairing(this.#history);
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
      // 资源按注入顺序的逆序释放，并收集单个失败，确保一个资源异常不会中断其余清理。
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

  // 事件消费先做去重：普通新事件先写入历史并 ack，重复事件跳过；ack 失败时按事件类型回滚或保留重试状态。
  async #acceptNextRuntimeEvent(
    waitForPendingWork: boolean,
    allowContextEvents: boolean,
  ): Promise<RuntimeEvent | undefined> {
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
      // Cron 上下文事件在普通用户回合中只暂存，不在模型请求之间抢占。
      if (event.contextIdentity !== undefined && !allowContextEvents) {
        this.#deferredRuntimeEvents.push(event);
        events = this.#eventPump.drainEvents(1);
        continue;
      }
      // mailbox 与 Cron 一样属于上下文事件，普通 user turn 只暂存，由显式 runEvents() 消费。
      if (event.toPayload().kind === "mailbox" && !allowContextEvents) {
        this.#deferredRuntimeEvents.push(event);
        events = this.#eventPump.drainEvents(1);
        continue;
      }
      // mailbox ack 失败后会重新发布；此时只补 ack，不重复写 history，也不重复进入模型请求。
      const isNewEvent = !this.#seenEventIds.has(event.eventId);
      const retryingAcknowledgement = this.#pendingEventAcks.has(event.eventId);
      if (!isNewEvent && !retryingAcknowledgement) {
        events = this.#eventPump.drainEvents(1);
        continue;
      }
      // 新事件在 ack 前先写入 history 并登记 id；ack 失败后按事件类型决定回滚或保留重试。
      // mailbox 是唯一保留半状态的事件类型：已入历史但不重复进模型，重发后仅补 ack，保证至少一次且不重复消费。
      if (isNewEvent) {
        this.#history.push(runtimeEventMessage(event));
        this.#seenEventIds.add(event.eventId);
      }
      try {
        await this.#eventPump.acknowledgeEvents(events);
        // 普通事件回滚 history 与去重登记；mailbox 保留已入历史的半状态，等待重新发布后仅 ack。
      } catch (error) {
        if (event.toPayload().kind !== "mailbox" && isNewEvent) {
          this.#history.pop();
          this.#seenEventIds.delete(event.eventId);
          // 登记 pending ack，使重试事件跳过 history/model，直接确认 mailbox。
        }
        if (event.toPayload().kind === "mailbox") this.#pendingEventAcks.add(event.eventId);
        throw error;
        // ack 成功后移除重试登记；对 mailbox 而言，此刻历史、模型调用与持久确认才同时成立。
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
