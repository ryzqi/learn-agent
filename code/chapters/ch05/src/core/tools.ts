import { z } from "zod";

import type { ToolCall } from "./messages.js";
import { toolCall } from "./messages.js";
import type { OpenAIToolSchema } from "./model.js";

// effect 是权限策略判断副作用的语义标签，而不是执行方式。
export type EffectClass = "read" | "write" | "execute" | "external";

export interface ToolContext {
  readonly workspace: string;
  readonly identity: string;
  readonly idempotencyKey?: string;
}

export interface ToolResult {
  readonly content: string;
  readonly isError: boolean;
  readonly errorCode?: string;
}

export function toolSuccess(content: string): ToolResult {
  return Object.freeze({ content, isError: false });
}

export function toolError(errorCode: string, message: string): ToolResult {
  if (errorCode.trim().length === 0) {
    throw new Error("tool error code must not be empty");
  }
  return Object.freeze({
    content: `Error [${errorCode}]: ${message}`,
    isError: true,
    errorCode,
  });
}

export function copyToolResult(result: ToolResult): ToolResult {
  if (!isToolResult(result)) {
    throw new Error("tool result must satisfy the ToolResult contract");
  }
  if (!result.isError) {
    return toolSuccess(result.content);
  }
  const errorCode = result.errorCode;
  if (errorCode === undefined) {
    throw new Error("error tool result requires an errorCode");
  }
  return Object.freeze({ content: result.content, isError: true, errorCode });
}

export interface ToolDefinition<Input> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  readonly effect: EffectClass;
  readonly handler: (input: Input, context: ToolContext) => Promise<ToolResult> | ToolResult;
}

export interface StoredToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly effect: EffectClass;
  readonly invoke: (input: unknown, context: ToolContext) => Promise<ToolResult>;
}

export interface PreparedToolCall {
  readonly call: ToolCall;
  readonly definition?: StoredToolDefinition;
  readonly arguments?: unknown;
  readonly error?: ToolResult;
}

export function freezePreparedToolCall(
  // 使用 structuredClone 复制参数并递归冻结，防止 approval 与 handler 接触外部变异。
  call: ToolCall,
  definition: StoredToolDefinition,
  argumentsValue: unknown,
): PreparedToolCall {
  return Object.freeze({
    call: toolCall(call.id, call.name, call.arguments),
    definition,
    arguments: freezeInput(structuredClone(argumentsValue)),
  });
}

export class ToolRegistry {
  // 工具注册表按名称索引所有定义，prepare 做 JSON 解析与 Zod 校验。
  readonly #definitions: Map<string, StoredToolDefinition>;
  readonly #mutable: boolean;

  constructor(definitions: ReadonlyMap<string, StoredToolDefinition> = new Map(), mutable = true) {
    this.#definitions = new Map(definitions);
    this.#mutable = mutable;
  }

  get names(): readonly string[] {
    return Object.freeze([...this.#definitions.keys()]);
  }

  register<Input>(definition: ToolDefinition<Input>): void {
    if (!this.#mutable) {
      throw new Error("tool registry snapshot is immutable");
    }
    if (!/^[A-Za-z0-9_]+$/.test(definition.name)) {
      throw new Error(`invalid tool name: ${definition.name}`);
    }
    if (definition.description.trim().length === 0) {
      throw new Error("tool description must not be empty");
    }
    if (this.#definitions.has(definition.name)) {
      throw new Error(`tool already registered: ${definition.name}`);
    }

    const stored: StoredToolDefinition = Object.freeze({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      effect: definition.effect,
      // 再次解析确保即使调用方绕过 prepare，也不会把未校验输入传给 handler。
      invoke: async (input: unknown, context: ToolContext) =>
        definition.handler(definition.inputSchema.parse(input), context),
    });
    this.#definitions.set(definition.name, stored);
  }

  snapshot(): ToolRegistry {
    // 每轮使用不可变快照，避免模型请求与执行之间的注册表被篡改。
    return new ToolRegistry(this.#definitions, false);
  }

  openAITools(): readonly OpenAIToolSchema[] {
    return Object.freeze(
      [...this.#definitions.values()].map((definition) => ({
        type: "function" as const,
        function: {
          name: definition.name,
          description: definition.description,
          parameters: z.toJSONSchema(definition.inputSchema) as Readonly<Record<string, unknown>>,
        },
      })),
    );
  }

  // JSON 解析和 Zod 校验先于权限策略；错误直接返回结构化工具错误。
  prepare(call: ToolCall): PreparedToolCall {
    // JSON 解析与 Zod 校验先于权限策略；错误直接返回结构化工具错误，策略始终面对可信定义和参数。
    // 解析与 schema 校验先于权限策略；策略永远面对可信的工具定义和参数。
    const definition = this.#definitions.get(call.name);
    if (definition === undefined) {
      return { call, error: toolError("unknown_tool", `Unknown tool: ${call.name}`) };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(call.arguments);
    } catch {
      // 工具故障转成可回填消息，循环可继续让模型决定下一步。
      return {
        call,
        definition,
        error: toolError("invalid_json", "Tool arguments must be valid JSON"),
      };
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return {
        call,
        definition,
        error: toolError("invalid_arguments", "Tool arguments must be a JSON object"),
      };
    }

    const parsed = definition.inputSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        call,
        definition,
        error: toolError("invalid_arguments", "Tool arguments failed schema validation"),
      };
    }
    // Pre Hook 只能通过 updatedInput 显式改写，不能就地修改受信任的准备结果。
    return freezePreparedToolCall(call, definition, parsed.data);
  }

  async invoke(prepared: PreparedToolCall, context: ToolContext): Promise<ToolResult> {
    if (prepared.error !== undefined) {
      return prepared.error;
    }
    if (prepared.definition === undefined || prepared.arguments === undefined) {
      throw new Error("prepared tool call is incomplete");
    }
    try {
      const result: unknown = await prepared.definition.invoke(prepared.arguments, context);
      if (!isToolResult(result)) {
        return toolError("invalid_tool_result", "Tool handler returned an invalid result");
      }
      return result;
    } catch {
      return toolError("tool_execution_error", "Tool execution failed");
    }
  }
}

function freezeInput<Input>(value: Input, seen: WeakSet<object> = new WeakSet()): Input {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value)) {
    freezeInput(nested, seen);
  }
  return Object.freeze(value);
}

export function isToolResult(value: unknown): value is ToolResult {
  // handler 返回值同样属于不可信边界，阻止畸形对象污染会话历史。
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const content = Reflect.get(value, "content");
  const isError = Reflect.get(value, "isError");
  const errorCode = Reflect.get(value, "errorCode");
  if (typeof content !== "string" || typeof isError !== "boolean") {
    return false;
  }
  if (isError) {
    return typeof errorCode === "string" && errorCode.trim().length > 0;
  }
  return errorCode === undefined;
}
