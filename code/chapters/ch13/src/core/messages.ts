// 消息类型是 core 与模型 adapter 之间唯一的会话结构，构造函数负责冻结和字段校验。
// 与 Chat Completions 对齐的最小会话消息模型。
// validateToolPairing 强制保证每个 tool_call 有对应 tool 消息。
// 会话消息模型：匹配 OpenAI Chat Completions 的最小角色与字段集。
// validateToolPairing 强制保证每个 tool_call 有对应 tool 消息，维护供应商配对契约。
export type Role = "system" | "user" | "assistant" | "tool";

export class MessageContractError extends Error {
  override readonly name = "MessageContractError";
}

// 参数保留 JSON 字符串，具体解析和 schema 校验属于工具注册表。
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface SystemMessage {
  readonly role: "system";
  readonly content: string;
}

export interface UserMessage {
  readonly role: "user";
  readonly content: string;
}

// 同一 assistant 消息中的调用 ID 是后续工具结果配对的唯一键。
export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: string | null;
  readonly toolCalls: readonly ToolCall[];
}

export interface ToolMessage {
  readonly role: "tool";
  readonly content: string;
  readonly toolCallId: string;
}

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const role = Reflect.get(value, "role");
  const content = Reflect.get(value, "content");
  if (role === "system" || role === "user") {
    return typeof content === "string";
  }
  if (role === "tool") {
    return typeof content === "string" && typeof Reflect.get(value, "toolCallId") === "string";
  }
  if (role !== "assistant" || (content !== null && typeof content !== "string")) {
    return false;
  }
  const calls = Reflect.get(value, "toolCalls");
  return (
    Array.isArray(calls) &&
    calls.every(
      (call) =>
        typeof call === "object" &&
        call !== null &&
        typeof Reflect.get(call, "id") === "string" &&
        typeof Reflect.get(call, "name") === "string" &&
        typeof Reflect.get(call, "arguments") === "string",
    )
  );
}

function requireString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string") {
    throw new MessageContractError(`${field} must be a string`);
  }
  if (!allowEmpty && value.length === 0) {
    throw new MessageContractError(`${field} must not be empty`);
  }
  return value;
}

export function toolCall(id: unknown, name: unknown, argumentsJson: unknown): ToolCall {
  // 参数保留 JSON 字符串，具体解析和 schema 校验属于工具注册表。
  return Object.freeze({
    id: requireString(id, "tool call id"),
    name: requireString(name, "tool call name"),
    arguments: requireString(argumentsJson, "tool call arguments", true),
  });
}

export function systemMessage(content: string): SystemMessage {
  return Object.freeze({ role: "system", content: requireString(content, "system content", true) });
}

export function userMessage(content: string): UserMessage {
  return Object.freeze({ role: "user", content: requireString(content, "user content", true) });
}

export function assistantMessage(
  content: string | null,
  toolCalls: readonly ToolCall[] = [],
): AssistantMessage {
  if (content !== null) {
    requireString(content, "assistant content", true);
  }
  // 同一 assistant 消息中的调用 ID 是后续工具结果配对的唯一键。
  const ids = toolCalls.map((call) => call.id);
  if (new Set(ids).size !== ids.length) {
    throw new MessageContractError("assistant tool call ids must be unique");
  }
  return Object.freeze({ role: "assistant", content, toolCalls: Object.freeze([...toolCalls]) });
}

export function toolMessage(content: string, toolCallId: string): ToolMessage {
  return Object.freeze({
    role: "tool",
    content: requireString(content, "tool content", true),
    toolCallId: requireString(toolCallId, "tool_call_id"),
  });
}

// assistant 工具调用后必须紧随对应数量的 tool 消息，保证供应商协议历史有效。
export function validateToolPairing(messages: readonly ChatMessage[]): void {
  // 每个 assistant 工具调用之后必须紧跟对应 tool result，否则协议在供应商侧会直接失败。
  // assistant 工具调用后必须紧随对应数量的 tool 消息，保证供应商协议历史有效。
  const pending = new Set<string>();

  // pending 集合表达“当前 assistant 工具调用块尚未回填完成”：
  // 下一批消息必须是 tool，且只能消费 pending 中的 ID；不能出现孤儿或缺失。
  for (const message of messages) {
    if (pending.size > 0) {
      if (message.role !== "tool") {
        throw new MessageContractError(
          `missing tool results for ids: ${JSON.stringify([...pending].sort())}`,
        );
      }
      if (!pending.delete(message.toolCallId)) {
        throw new MessageContractError(`unexpected tool result id: ${message.toolCallId}`);
      }
      continue;
    }

    if (message.role === "tool") {
      throw new MessageContractError(`orphan tool result id: ${message.toolCallId}`);
    }
    if (message.role === "assistant" && message.toolCalls.length > 0) {
      for (const call of message.toolCalls) {
        pending.add(call.id);
      }
    }
  }

  if (pending.size > 0) {
    throw new MessageContractError(
      `missing tool results for ids: ${JSON.stringify([...pending].sort())}`,
    );
  }
}
