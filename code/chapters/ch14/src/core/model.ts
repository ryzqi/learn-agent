import type { AssistantMessage, ChatMessage } from "./messages.js";

// 供应商 adapter 必须归一为这些结束状态，循环据此处理不可完成或被过滤的回复。
// content_filter 在这里是合法 wire 值，但能否进入最终结果由 loop 层决定。
export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "function_call";

// typed API error 只携带适配器稳定提取的状态、错误码和请求 ID，供恢复层按类型分派。
// 基类字段全部在构造时校验，statusCode 必须是正整数；错误对象本身也必须满足可靠契约。
export class ModelAPIError extends Error {
  readonly statusCode: number;
  readonly errorCode: string | undefined;
  readonly requestId: string | undefined;

  constructor(
    message: string,
    options: {
      readonly statusCode: number;
      readonly errorCode?: string;
      readonly requestId?: string;
      readonly cause?: unknown;
    },
  ) {
    if (typeof message !== "string" || message.trim().length === 0) {
      throw new TypeError("message must be a non-empty string");
    }
    if (!Number.isInteger(options.statusCode) || options.statusCode <= 0) {
      throw new RangeError("statusCode must be a positive integer");
    }
    if (
      options.errorCode !== undefined &&
      (typeof options.errorCode !== "string" || options.errorCode.trim().length === 0)
    ) {
      throw new TypeError("errorCode must be a non-empty string or undefined");
    }
    if (
      options.requestId !== undefined &&
      (typeof options.requestId !== "string" || options.requestId.trim().length === 0)
    ) {
      throw new TypeError("requestId must be a non-empty string or undefined");
    }
    super(message, { cause: options.cause });
    this.name = "ModelAPIError";
    this.statusCode = options.statusCode;
    this.errorCode = options.errorCode;
    this.requestId = options.requestId;
  }
}

// 限流错误固定对应 HTTP 429，Retry-After 原样透传，不在这里解析时间格式。
export class ModelRateLimitError extends ModelAPIError {
  readonly retryAfter: string | undefined;

  constructor(
    message: string,
    options: {
      readonly retryAfter?: string;
      readonly statusCode?: number;
      readonly errorCode?: string;
      readonly requestId?: string;
      readonly cause?: unknown;
    } = {},
  ) {
    const statusCode = options.statusCode === undefined ? 429 : options.statusCode;
    if (statusCode !== 429) {
      throw new RangeError("ModelRateLimitError statusCode must be 429");
    }
    if (options.retryAfter !== undefined && typeof options.retryAfter !== "string") {
      throw new TypeError("retryAfter must be a string or undefined");
    }
    super(message, { ...options, statusCode });
    this.name = "ModelRateLimitError";
    this.retryAfter = options.retryAfter;
  }
}

// 过载错误固定对应 HTTP 529，连续次数由 RecoveryManager 根据回合状态维护。
export class ModelOverloadedError extends ModelAPIError {
  constructor(
    message: string,
    options: {
      readonly statusCode?: number;
      readonly errorCode?: string;
      readonly requestId?: string;
      readonly cause?: unknown;
    } = {},
  ) {
    const statusCode = options.statusCode === undefined ? 529 : options.statusCode;
    if (statusCode !== 529) {
      throw new RangeError("ModelOverloadedError statusCode must be 529");
    }
    super(message, { ...options, statusCode });
    this.name = "ModelOverloadedError";
  }
}

// 输入过长只映射 400 加明确的 error code，不能根据异常 message 文本猜测。
export class ModelPromptTooLongError extends ModelAPIError {
  constructor(
    message: string,
    options: {
      readonly statusCode?: number;
      readonly errorCode?: string;
      readonly requestId?: string;
      readonly cause?: unknown;
    } = {},
  ) {
    const statusCode = options.statusCode === undefined ? 400 : options.statusCode;
    if (statusCode !== 400) {
      throw new RangeError("ModelPromptTooLongError statusCode must be 400");
    }
    super(message, { ...options, statusCode });
    this.name = "ModelPromptTooLongError";
  }
}

export interface OpenAIToolSchema {
  // 工具 schema 只接受 OpenAI 兼容 function 结构；parameters 保留原始 JSON Schema，
  // 由请求映射层原样透传，不在 core 中解析具体参数类型。
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

// model 和 maxTokens 可由恢复层覆写；messages/tools 是每次请求的完整快照。
// 一次完整模型请求的快照。messages/tools 是完整上下文；model/maxTokens 可选，
// 以便 RecoveryManager 在不改动消息内容的前提下切换模型或提升输出预算。
export interface ModelRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly OpenAIToolSchema[];
  readonly model?: string;
  readonly maxTokens?: number;
}

export interface TokenUsage {
  // usage 只接受三个非负整数；adapter 必须完成校验后才填充，避免恢复层或日志拿到残缺计数。
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

// reply 必须是一次完整模型输出；finishReason 为 length 时由上层决定是否续写。
// reply 必须是一次完整模型输出；finishReason 为 length 时由上层决定是否续写，
// content_filter 表示内容被过滤，不能当作正常最终回复。
export interface ModelReply {
  readonly message: AssistantMessage;
  readonly finishReason: FinishReason;
  readonly usage?: TokenUsage;
}

// core 只依赖一次完整调用，不感知 OpenAI SDK 或 HTTP 细节；signal 传播取消与超时。
// 调用方负责总时限和重试策略，ModelClient 本身不自动重试。
export interface ModelClient {
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelReply>;
}
