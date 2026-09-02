import { userMessage, validateToolPairing } from "../core/messages.js";
import type { ChatMessage } from "../core/messages.js";
import {
  ModelOverloadedError,
  ModelPromptTooLongError,
  ModelRateLimitError,
} from "../core/model.js";
import type { ModelClient, ModelReply, ModelRequest } from "../core/model.js";
import { CompactionManager } from "./compaction.js";

// 文件职责：提供供应商无关的模型恢复层。RecoveryManager 以一次 logical ModelRequest 为边界，
// 内部处理 length 续写、prompt-too-long 压缩、429/529 退避与 fallback；
// 取消和总 deadline 贯穿所有异步操作，每个 typed failure 都是可验证的终止条件。

// 默认恢复参数集中定义，测试可注入小预算；生产默认把重试和等待控制在一个 turn 内。
export const DEFAULT_INITIAL_MAX_TOKENS = 8_000;
export const DEFAULT_ESCALATED_MAX_TOKENS = 64_000;
export const DEFAULT_MAX_CONTINUATIONS = 3;
export const DEFAULT_MAX_TRANSIENT_ATTEMPTS = 10;
export const DEFAULT_BASE_DELAY_SECONDS = 0.5;
export const DEFAULT_MAX_DELAY_SECONDS = 32;
export const DEFAULT_JITTER_RATIO = 0.25;
export const DEFAULT_OVERLOAD_FALLBACK_THRESHOLD = 3;
export const DEFAULT_TOTAL_TIMEOUT_SECONDS = 300;
// 续写提示要求模型无寒暄地接续，避免重复正文或重新规划。
export const CONTINUATION_PROMPT =
  "Continue exactly where you left off. Do not repeat any text, no apology, no recap. Pick up mid-thought.";

// typed failure 让调用方和测试能按类型判断取消、超时、耗尽和非法 Retry-After。
export class RecoveryError extends Error {
  override readonly name: string = "RecoveryError";
}

export class InvalidRetryAfterError extends RecoveryError {
  override readonly name: string = "InvalidRetryAfterError";
}

export class RecoveryCancelledError extends RecoveryError {
  override readonly name: string = "RecoveryCancelledError";
}

export class RecoveryDeadlineExceeded extends RecoveryError {
  override readonly name: string = "RecoveryDeadlineExceeded";
}

export class RecoveryRetriesExhausted extends RecoveryError {
  override readonly name: string = "RecoveryRetriesExhausted";
}

// 轻量取消令牌允许测试手动触发，并与 AbortSignal 一起约束所有异步操作。
// 契约：cancel() 幂等且只触发一次；取消后新增订阅会立即执行，并返回 no-op 退订函数。
export class CancellationToken {
  #cancelled = false;
  readonly #listeners = new Set<() => void>();

  get isCancelled(): boolean {
    return this.#cancelled;
  }

  cancel(): void {
    // 已取消时直接返回；否则一次性触发全部监听器并清空，保证不重复通知。
    if (this.#cancelled) {
      return;
    }
    this.#cancelled = true;
    for (const listener of this.#listeners) {
      listener();
    }
    this.#listeners.clear();
  }

  subscribe(listener: () => void): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("listener must be a function");
    }
    // 取消后订阅立即唤醒调用方，避免错过已经发生的取消事件。
    if (this.#cancelled) {
      listener();
      return () => {};
    }
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

// 构造时校验预算关系，避免运行期把供应商不接受的 maxTokens 发出去。
export interface RecoveryConfigOptions {
  // 主模型连续过载时切换到的备用模型名称。
  readonly primaryModel: string;
  readonly fallbackModel: string;
  // 首次请求的输出预算；length 后提升到 escalatedMaxTokens。
  readonly initialMaxTokens?: number;
  // 长度恢复阶段使用的第二档预算，不能超过模型上限。
  readonly escalatedMaxTokens?: number;
  // 供应商允许的最大输出预算，保护配置不会发出非法值。
  readonly modelMaxTokens?: number;
  // 同一逻辑请求最多追加的纯文本续写次数。
  readonly maxContinuations?: number;
  // 429/529 等瞬态失败的总尝试上限。
  readonly maxTransientAttempts?: number;
  readonly baseDelaySeconds?: number;
  readonly maxDelaySeconds?: number;
  readonly jitterRatio?: number;
  readonly overloadFallbackThreshold?: number;
  readonly totalTimeoutSeconds?: number;
}

export class RecoveryConfig {
  readonly primaryModel: string;
  readonly fallbackModel: string;
  readonly initialMaxTokens: number;
  readonly escalatedMaxTokens: number;
  readonly modelMaxTokens: number;
  readonly maxContinuations: number;
  readonly maxTransientAttempts: number;
  readonly baseDelaySeconds: number;
  readonly maxDelaySeconds: number;
  readonly jitterRatio: number;
  readonly overloadFallbackThreshold: number;
  readonly totalTimeoutSeconds: number;

  constructor(options: RecoveryConfigOptions) {
    this.primaryModel = nonEmptyText("primaryModel", options.primaryModel);
    this.fallbackModel = nonEmptyText("fallbackModel", options.fallbackModel);
    this.initialMaxTokens = positiveInteger(
      "initialMaxTokens",
      option(options.initialMaxTokens, DEFAULT_INITIAL_MAX_TOKENS),
    );
    this.escalatedMaxTokens = positiveInteger(
      "escalatedMaxTokens",
      option(options.escalatedMaxTokens, DEFAULT_ESCALATED_MAX_TOKENS),
    );
    this.modelMaxTokens = positiveInteger(
      "modelMaxTokens",
      option(options.modelMaxTokens, DEFAULT_ESCALATED_MAX_TOKENS),
    );
    this.maxContinuations = nonNegativeInteger(
      "maxContinuations",
      option(options.maxContinuations, DEFAULT_MAX_CONTINUATIONS),
    );
    this.maxTransientAttempts = positiveInteger(
      "maxTransientAttempts",
      option(options.maxTransientAttempts, DEFAULT_MAX_TRANSIENT_ATTEMPTS),
    );
    this.baseDelaySeconds = positiveFinite(
      "baseDelaySeconds",
      option(options.baseDelaySeconds, DEFAULT_BASE_DELAY_SECONDS),
    );
    this.maxDelaySeconds = positiveFinite(
      "maxDelaySeconds",
      option(options.maxDelaySeconds, DEFAULT_MAX_DELAY_SECONDS),
    );
    this.jitterRatio = nonNegativeFinite(
      "jitterRatio",
      option(options.jitterRatio, DEFAULT_JITTER_RATIO),
    );
    this.overloadFallbackThreshold = positiveInteger(
      "overloadFallbackThreshold",
      option(options.overloadFallbackThreshold, DEFAULT_OVERLOAD_FALLBACK_THRESHOLD),
    );
    this.totalTimeoutSeconds = positiveFinite(
      "totalTimeoutSeconds",
      option(options.totalTimeoutSeconds, DEFAULT_TOTAL_TIMEOUT_SECONDS),
    );
    if (this.initialMaxTokens >= this.escalatedMaxTokens) {
      throw new RangeError("escalatedMaxTokens must exceed initialMaxTokens");
    }
    if (this.escalatedMaxTokens > this.modelMaxTokens) {
      throw new RangeError("escalatedMaxTokens must not exceed modelMaxTokens");
    }
    if (this.baseDelaySeconds > this.maxDelaySeconds) {
      throw new RangeError("baseDelaySeconds must not exceed maxDelaySeconds");
    }
    Object.freeze(this);
  }
}

// 回合内可变恢复状态只由 RecoveryManager 持有，外部通过只读快照观察。
export interface RecoveryState {
  // 当前实际发送请求所用模型和输出预算。
  currentModel: string;
  currentMaxTokens: number;
  // 是否已经从初始预算升级，避免重复升级分支。
  hasEscalated: boolean;
  // 已追加的续写片段数量。
  recoveryCount: number;
  // 连续 529 次数，达到阈值后切换 fallback。
  consecutive529: number;
  // 当前窗口是否已执行 prompt-too-long 响应式压缩。
  hasAttemptedReactiveCompact: boolean;
}

export interface RecoveryManagerOptions {
  // 原始模型调用边界，所有重试仍归属于同一逻辑请求。
  readonly model: ModelClient;
  // prompt-too-long 时复用的上下文压缩器。
  readonly compaction: CompactionManager;
  // 固定的预算、退避、fallback 和 deadline 约束。
  readonly config: RecoveryConfig;
  readonly monotonic?: () => number;
  readonly utcNow?: () => Date;
  readonly sleeper?: (seconds: number, signal: AbortSignal) => Promise<void>;
  readonly jitter?: (upperBound: number) => number;
  readonly cancellation?: CancellationToken;
}

// 每个用户回合共享一个总 deadline，重试、压缩和 continuation 不能各自延长时限。
export class RecoveryManager {
  readonly #model: ModelClient;
  readonly #compaction: CompactionManager;
  readonly #config: RecoveryConfig;
  readonly #monotonic: () => number;
  readonly #utcNow: () => Date;
  readonly #sleeper: (seconds: number, signal: AbortSignal) => Promise<void>;
  readonly #jitter: (upperBound: number) => number;
  readonly #cancellation: CancellationToken;
  #state: RecoveryState | undefined;
  // 单回合总 deadline；重试、sleep 和压缩共享此截止时间。
  #deadline: number | undefined;

  constructor(options: RecoveryManagerOptions) {
    if (typeof options.model?.complete !== "function") {
      throw new TypeError("model must implement ModelClient");
    }
    if (!(options.compaction instanceof CompactionManager)) {
      throw new TypeError("compaction must be a CompactionManager");
    }
    if (!(options.config instanceof RecoveryConfig)) {
      throw new TypeError("config must be a RecoveryConfig");
    }
    if (options.monotonic !== undefined && typeof options.monotonic !== "function") {
      throw new TypeError("monotonic must be a function");
    }
    if (options.utcNow !== undefined && typeof options.utcNow !== "function") {
      throw new TypeError("utcNow must be a function");
    }
    if (options.sleeper !== undefined && typeof options.sleeper !== "function") {
      throw new TypeError("sleeper must be a function");
    }
    if (options.jitter !== undefined && typeof options.jitter !== "function") {
      throw new TypeError("jitter must be a function");
    }
    if (
      options.cancellation !== undefined &&
      !(options.cancellation instanceof CancellationToken)
    ) {
      throw new TypeError("cancellation must be a CancellationToken");
    }
    this.#model = options.model;
    this.#compaction = options.compaction;
    this.#config = options.config;
    this.#monotonic =
      options.monotonic === undefined ? () => performance.now() / 1_000 : options.monotonic;
    this.#utcNow = options.utcNow === undefined ? () => new Date() : options.utcNow;
    this.#sleeper = options.sleeper === undefined ? sleep : options.sleeper;
    this.#jitter =
      options.jitter === undefined ? (upperBound) => Math.random() * upperBound : options.jitter;
    this.#cancellation =
      options.cancellation === undefined ? new CancellationToken() : options.cancellation;
  }

  get state(): Readonly<RecoveryState> {
    if (this.#state === undefined) {
      throw new RecoveryError("Recovery turn has not been started");
    }
    return Object.freeze({ ...this.#state });
  }

  beginTurn(): void {
    // 状态在回合边界重置，避免 fallback、长度升级或重试计数泄漏到下一次请求。
    const startedAt = this.#monotonicNow();
    this.#state = {
      currentModel: this.#config.primaryModel,
      currentMaxTokens: this.#config.initialMaxTokens,
      hasEscalated: false,
      recoveryCount: 0,
      consecutive529: 0,
      hasAttemptedReactiveCompact: false,
    };
    this.#deadline = startedAt + this.#config.totalTimeoutSeconds;
  }

  async complete(request: ModelRequest): Promise<ModelReply> {
    const state = this.#requireState();
    validateToolPairing(request.messages);
    // complete() 只接受外部 Loop 的原始请求：model 必须仍是 primary、maxTokens 必须是 initial。
    // RecoveryManager 内部的覆盖只通过局部 state/effectiveRequest 发生，防止调用方绕过恢复状态。
    if (request.model !== undefined && request.model !== this.#config.primaryModel) {
      throw new RangeError("request.model must match RecoveryConfig.primaryModel");
    }
    if (
      request.maxTokens !== undefined &&
      (!Number.isInteger(request.maxTokens) ||
        request.maxTokens <= 0 ||
        request.maxTokens !== this.#config.initialMaxTokens)
    ) {
      throw new RangeError("request.maxTokens must match RecoveryConfig.initialMaxTokens");
    }

    let requestMessages = Object.freeze([...request.messages]);
    const fragments: string[] = [];
    let promptTooLongRetries = 0;
    let transientFailures = 0;
    state.hasAttemptedReactiveCompact = false;

    // 循环只在一个逻辑请求内重试：长度升级、续写、压缩和瞬态退避都返回同一个 ModelReply。
    while (true) {
      // 每次尝试都重建完整请求快照；model/maxTokens 随恢复状态变化。
      const effectiveRequest: ModelRequest = Object.freeze({
        ...request,
        messages: requestMessages,
        model: state.currentModel,
        maxTokens: state.currentMaxTokens,
      });
      let reply: ModelReply;
      try {
        reply = await this.#runBounded((signal) => this.#model.complete(effectiveRequest, signal));
      } catch (error) {
        // 仅识别的模型边界错误进入恢复分支；其他错误按原样向上抛出。
        if (error instanceof ModelRateLimitError) {
          // 429 是限流信号，不累计到 529 fallback。
          state.consecutive529 = 0;
          transientFailures += 1;
          await this.#retryTransient(transientFailures, error.retryAfter, "rate limit");
          continue;
        }
        if (error instanceof ModelOverloadedError) {
          // 529 连续达到阈值后切 fallback，下一次请求才显式携带新模型。
          state.consecutive529 += 1;
          if (state.consecutive529 >= this.#config.overloadFallbackThreshold) {
            state.currentModel = this.#config.fallbackModel;
            state.consecutive529 = 0;
          }
          transientFailures += 1;
          await this.#retryTransient(transientFailures, undefined, "overload");
          continue;
        }
        if (error instanceof ModelPromptTooLongError) {
          // 输入过长保留首条 system，只对请求快照压缩一次。
          state.consecutive529 = 0;
          const [leadingSystem, compactableHistory] = splitLeadingSystem(requestMessages);
          const outcome = await this.#runBounded((signal) =>
            this.#compaction.compactOnPromptTooLong(
              compactableHistory,
              {
                retryCount: promptTooLongRetries,
              },
              signal,
            ),
          );
          promptTooLongRetries += 1;
          state.hasAttemptedReactiveCompact = true;
          requestMessages = Object.freeze([...leadingSystem, ...outcome.history]);
          validateToolPairing(requestMessages);
          continue;
        }
        throw error;
      }

      transientFailures = 0;
      state.consecutive529 = 0;
      if (reply.finishReason !== "length") {
        // 正常结束立即返回；fragments 只合并到最终回复。
        state.hasAttemptedReactiveCompact = false;
        return mergeFragments(reply, fragments);
      }
      if (!state.hasEscalated) {
        // 首次 length 提升输出预算并完全丢弃残缺回复，重试同一请求。
        state.currentMaxTokens = this.#config.escalatedMaxTokens;
        state.hasEscalated = true;
        continue;
      }
      // 已提升预算仍 length 时，把文本片段和续写提示放入局部 requestMessages。
      const fragment = reply.message.content;
      if (reply.message.toolCalls.length > 0 || fragment === null || fragment.length === 0) {
        throw new RecoveryRetriesExhausted(
          "length recovery requires a non-empty text-only assistant fragment",
        );
      }
      if (state.recoveryCount >= this.#config.maxContinuations) {
        throw new RecoveryRetriesExhausted("continuation recovery attempts exhausted");
      }
      fragments.push(fragment);
      requestMessages = Object.freeze([
        ...requestMessages,
        reply.message,
        userMessage(CONTINUATION_PROMPT),
      ]);
      validateToolPairing(requestMessages);
      state.recoveryCount += 1;
    }
  }

  async #retryTransient(
    transientFailures: number,
    retryAfter: string | undefined,
    label: string,
  ): Promise<void> {
    // 429/529 共用瞬态重试路径：先检查次数和 deadline，再 sleep。
    // 重试次数和等待时间都受总 deadline 约束，不能排队到回合超时之后。
    if (transientFailures >= this.#config.maxTransientAttempts) {
      throw new RecoveryRetriesExhausted(`${label} recovery attempts exhausted`);
    }
    const delay =
      retryAfter === undefined
        ? this.#backoffDelay(transientFailures - 1)
        : this.#parseRetryAfter(retryAfter);
    if (delay >= this.#remainingSeconds()) {
      throw new RecoveryDeadlineExceeded("retry delay would reach or cross the turn deadline");
    }
    await this.#runBounded((signal) => this.#sleeper(delay, signal));
  }

  #parseRetryAfter(value: string): number {
    // 秒数优先；HTTP-date 必须有明确时区，非法值不 sleep 不重试。
    const normalized = value.trim();
    if (/^\d+(?:\.\d+)?$/.test(normalized)) {
      const delay = Number(normalized);
      if (Number.isFinite(delay)) {
        return delay;
      }
      throw new InvalidRetryAfterError("Retry-After seconds must be finite");
    }
    const target = Date.parse(normalized);
    if (!Number.isFinite(target) || !/(?:\b(?:GMT|UTC)\b|[+-]\d{4})$/i.test(normalized)) {
      throw new InvalidRetryAfterError("Retry-After is not seconds or an HTTP date");
    }
    const now = this.#utcNow();
    if (Number.isNaN(now.getTime())) {
      throw new RecoveryError("UTC clock must return a valid Date");
    }
    return Math.max(0, (target - now.getTime()) / 1_000);
  }

  #backoffDelay(attempt: number): number {
    // 指数退避封顶 32 秒，再叠加可注入抖动，避免同批请求同时重试。
    const base = Math.min(
      this.#config.baseDelaySeconds * 2 ** attempt,
      this.#config.maxDelaySeconds,
    );
    const upperBound = base * this.#config.jitterRatio;
    const jitter = this.#jitter(upperBound);
    if (!Number.isFinite(jitter) || jitter < 0 || jitter > upperBound) {
      throw new RecoveryError("jitter must return a finite value within its upper bound");
    }
    return base + jitter;
  }

  async #runBounded<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    // 模型调用、sleep 和响应式压缩都在同一个取消/超时边界内运行。
    // 取消或超时先中止边界操作，再等待它收束，不能遗留后台请求或摘要写入。
    this.#raiseIfCancelled();
    const remaining = this.#remainingSeconds();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operationPromise = Promise.resolve().then(() => operation(controller.signal));
    const deadlinePromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new RecoveryDeadlineExceeded("turn deadline exceeded")),
        remaining * 1_000,
      );
    });
    let unsubscribeCancellation = () => {};
    const cancellationPromise = new Promise<never>((_resolve, reject) => {
      unsubscribeCancellation = this.#cancellation.subscribe(() => {
        controller.abort();
        reject(new RecoveryCancelledError("recovery turn was cancelled"));
      });
    });
    try {
      const result = await Promise.race([operationPromise, deadlinePromise, cancellationPromise]);
      this.#raiseIfCancelled();
      this.#remainingSeconds();
      return result;
    } catch (error) {
      if (error instanceof RecoveryCancelledError || error instanceof RecoveryDeadlineExceeded) {
        controller.abort();
        await operationPromise.catch(() => undefined);
      }
      throw error;
    } finally {
      unsubscribeCancellation();
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      controller.abort();
    }
  }

  #remainingSeconds(): number {
    // 剩余时间 <= 0 时立即失败，而不是先 sleep 再等超时。
    if (this.#deadline === undefined) {
      throw new RecoveryError("Recovery turn has not been started");
    }
    const remaining = this.#deadline - this.#monotonicNow();
    if (remaining <= 0) {
      throw new RecoveryDeadlineExceeded("turn deadline exceeded");
    }
    return remaining;
  }

  #raiseIfCancelled(): void {
    if (this.#cancellation.isCancelled) {
      throw new RecoveryCancelledError("recovery turn was cancelled");
    }
  }

  #monotonicNow(): number {
    const value = this.#monotonic();
    if (!Number.isFinite(value)) {
      throw new RecoveryError("monotonic clock must return a finite number");
    }
    return value;
  }

  #requireState(): RecoveryState {
    if (this.#state === undefined) {
      throw new RecoveryError("Recovery turn has not been started");
    }
    return this.#state;
  }
}

// 成功回复只拼接最终文本片段，不自动补空格或改写内容。
function mergeFragments(reply: ModelReply, fragments: readonly string[]): ModelReply {
  if (fragments.length === 0) {
    return reply;
  }
  return Object.freeze({
    ...reply,
    message: {
      ...reply.message,
      content: `${fragments.join("")}${reply.message.content ?? ""}`,
    },
  });
}

// system 必须保持请求首位；没有 system 时整个快照都可压缩。
function splitLeadingSystem(
  messages: readonly ChatMessage[],
): readonly [readonly ChatMessage[], readonly ChatMessage[]] {
  if (messages.length > 1 && messages[0]?.role === "system") {
    return Object.freeze([Object.freeze([messages[0]]), Object.freeze(messages.slice(1))]);
  }
  return Object.freeze([Object.freeze([]), Object.freeze([...messages])]);
}

// 默认 sleeper 响应 AbortSignal，取消时立即以 RecoveryCancelledError 收束。
function sleep(seconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, seconds * 1_000);
    const cancel = () => {
      clearTimeout(timeout);
      reject(new RecoveryCancelledError("recovery turn was cancelled"));
    };
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
  });
}

function option(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : value;
}

function nonEmptyText(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(name: string, value: unknown): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value as number;
}

function nonNegativeInteger(name: string, value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value as number;
}

function positiveFinite(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
}

function nonNegativeFinite(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return value;
}
