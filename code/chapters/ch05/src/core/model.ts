// 供应商 adapter 必须归一为这些结束状态，循环据此处理不可完成或被过滤的回复。
// 模型接口边界：core 只依赖 complete() 返回规范化 ModelReply，不绑定供应商 SDK。
import type { AssistantMessage, ChatMessage } from "./messages.js";

// 供应商 adapter 必须归一为这些结束状态，循环据此处理截断、内容过滤或正常结束。
export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "function_call";

export interface OpenAIToolSchema {
  // 模型看到的工具定义只包含名称、描述和 JSON Schema，不暴露 handler 或 effect。
  readonly type: "function";
  // SDK 协议要求的函数工具元数据容器。
  readonly function: {
    // 注册表中的稳定工具调用名称。
    readonly name: string;
    // 供模型选择工具时使用的能力说明。
    readonly description: string;
    // 供应商无关的 JSON Schema 参数契约。
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

// model 和 maxTokens 可由更高章节的恢复或预算层覆写。
export interface ModelRequest {
  // model 和 maxTokens 可由更高章节的恢复或预算层覆写。
  // 已验证、不可由调用中途改变的会话历史。
  readonly messages: readonly ChatMessage[];
  // 与历史同时冻结的可调用工具描述。
  readonly tools: readonly OpenAIToolSchema[];
  // 可选单次模型覆盖。
  readonly model?: string;
  // 可选单次输出预算，而非 Agent 总回合预算。
  readonly maxTokens?: number;
}

export interface TokenUsage {
  // 用量用于观测和分析，Adapters 必须按严格整数契约提供。
  // 输入消息消耗量。
  readonly promptTokens: number;
  // 输出回复消耗量。
  readonly completionTokens: number;
  // 供应商报告的总量。
  readonly totalTokens: number;
}

export interface ModelReply {
  // normalized finishReason 是唯一权威的结束信号，adapter 不得保留原始供应商枚举。
  // 已转换为核心消息契约的模型回复。
  readonly message: AssistantMessage;
  // 决定循环继续、结束或失败的结束状态。
  readonly finishReason: FinishReason;
  // 可选用量数据。
  readonly usage?: TokenUsage;
}

// core 只依赖一次完整调用，不感知 OpenAI SDK 或 HTTP 细节。
export interface ModelClient {
  // core 只依赖一次完整调用，不感知 OpenAI SDK 或 HTTP 细节。
  // core 只依赖一次完整调用；重试、降级和恢复由上层组合根在 adapter 外实现。
  complete(request: ModelRequest): Promise<ModelReply>;
}
