import { z } from "zod";

import type { ToolCall } from "./messages.js";
import { toolCall } from "./messages.js";
import type { OpenAIToolSchema } from "./model.js";

// effect 是权限策略和工具列表可见性的最小事实来源，不依赖工具名称猜测。
export type EffectClass = "read" | "write" | "execute" | "external";
// concurrency 是 Dispatcher 判断工具能否转后台执行的显式契约，缺省为 inline。
export type ConcurrencyClass = "inline" | "background_eligible";

export interface ToolContext {
  readonly workspace: string;
  readonly identity: string;
  readonly idempotencyKey?: string;
  readonly taskId?: string;
  readonly claimToken?: string;
  readonly worktreeName?: string;
  readonly executionScope?: object;
}

export interface ToolResult {
  readonly content: string;
  readonly isError: boolean;
  readonly errorCode?: string;
}

// 成功和失败都返回不可变 ToolResult；错误必须携带稳定错误码。
export function toolSuccess(content: string): ToolResult {
  return Object.freeze({ content, isError: false });
}

export function toolError(errorCode: string, message: string): ToolResult {
  if (errorCode.trim().length === 0) {
    throw new Error("tool error code must not be empty");
  }
  // 失败结果必须提供稳定 errorCode，便于模型、Hook 和存储层分类处理。
  return Object.freeze({
    content: `Error [${errorCode}]: ${message}`,
    isError: true,
    errorCode,
  });
}

// 任何进入 canonical history 的工具结果都深拷贝，防止 handler 内部可变对象污染会话。
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
  readonly inputSchemaJson?: Readonly<Record<string, unknown>>;
  readonly effect: EffectClass;
  readonly concurrency?: ConcurrencyClass;
  // source 标识 builtin 或 mcp:... 来源，供权限策略和审计判断工具边界。
  readonly source?: string;
  readonly handler: (input: Input, context: ToolContext) => Promise<ToolResult> | ToolResult;
}

// StoredToolDefinition 隐藏泛型 Input，统一把 schema 校验放在 invoke 边界。
export interface StoredToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly inputSchemaJson?: Readonly<Record<string, unknown>>;
  readonly effect: EffectClass;
  readonly concurrency: ConcurrencyClass;
  readonly source: string;
  readonly invoke: (input: unknown, context: ToolContext) => Promise<ToolResult>;
}

export interface PreparedToolCall {
  readonly call: ToolCall;
  readonly definition?: StoredToolDefinition;
  readonly arguments?: unknown;
  readonly error?: ToolResult;
}

export function freezePreparedToolCall(
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

// 工具注册表保存冻结定义，并在分发前按上下文与 schema 建立调用边界；
// P19 通过批量注册/撤销与不可变快照支持 MCP 连接的动态工具生命周期。
export class ToolRegistry {
  readonly #definitions: Map<string, StoredToolDefinition>;
  readonly #sourceDefinitions: WeakMap<object, StoredToolDefinition>;
  readonly #mutable: boolean;
  // 版本号只在成功整体变更后递增；snapshot 与 live registry 版本一致，但不共享 Map。
  #version: number;

  constructor(
    definitions: ReadonlyMap<string, StoredToolDefinition> = new Map(),
    mutable = true,
    version = 0,
  ) {
    this.#definitions = new Map(definitions);
    this.#sourceDefinitions = new WeakMap();
    this.#mutable = mutable;
    this.#version = version;
  }

  get names(): readonly string[] {
    return Object.freeze([...this.#definitions.keys()]);
  }

  get version(): number {
    return this.#version;
  }

  // 单个工具注册委托给批量入口，保持校验、冻结与版本递增行为一致。
  register<Input>(definition: ToolDefinition<Input>): StoredToolDefinition {
    const registered = this.registerMany([definition]);
    const stored = registered[0];
    if (stored === undefined) {
      throw new Error("tool registry failed to register a definition");
    }
    return stored;
  }

  registerMany<Input>(
    definitions: readonly ToolDefinition<Input>[],
  ): readonly StoredToolDefinition[] {
    if (!this.#mutable) {
      throw new Error("tool registry snapshot is immutable");
    }
    if (definitions.length === 0) {
      return Object.freeze([]);
    }

    // 批量注册先整体校验，任一名称冲突都失败，避免留下半个 MCP 连接的工具集。
    const names = definitions.map((definition) => definition.name);
    if (new Set(names).size !== names.length) {
      throw new Error("tool registry batch contains duplicate names");
    }
    for (const definition of definitions) {
      validateDefinition(definition);
      if (this.#definitions.has(definition.name)) {
        throw new Error(`tool already registered: ${definition.name}`);
      }
    }

    const storedDefinitions = definitions.map((definition) => this.#storeDefinition(definition));
    for (const stored of storedDefinitions) {
      this.#definitions.set(stored.name, stored);
    }
    this.#version += 1;
    return Object.freeze(storedDefinitions);
  }

  unregisterMany(definitions: readonly StoredToolDefinition[]): void;
  unregisterMany<Input>(definitions: readonly ToolDefinition<Input>[]): void;
  unregisterMany(definitions: readonly unknown[]): void {
    if (!this.#mutable) {
      throw new Error("tool registry snapshot is immutable");
    }
    if (definitions.length === 0) {
      return;
    }

    // 撤销时按对象身份匹配当前注册项，防止旧连接状态误删重连后的同名工具。
    const storedDefinitions = definitions.map((definition) => this.#storedDefinition(definition));
    const names = storedDefinitions.map((definition) => definition.name);
    if (new Set(names).size !== names.length) {
      throw new Error("tool registry unregister batch contains duplicate names");
    }
    for (const stored of storedDefinitions) {
      const current = this.#definitions.get(stored.name);
      if (current === undefined) {
        throw new Error(`tool is not registered: ${stored.name}`);
      }
      if (current !== stored) {
        throw new Error(`tool definition does not match registry: ${stored.name}`);
      }
    }
    for (const stored of storedDefinitions) {
      this.#definitions.delete(stored.name);
    }
    this.#version += 1;
  }

  // 统一生成冻结的 StoredToolDefinition；source 缺省为 builtin，MCP 工具显式标记来源。
  #storeDefinition<Input>(definition: ToolDefinition<Input>): StoredToolDefinition {
    const source = definition.source === undefined ? "builtin" : definition.source;
    const stored: StoredToolDefinition = Object.freeze({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      ...(definition.inputSchemaJson === undefined
        ? {}
        : { inputSchemaJson: definition.inputSchemaJson }),
      effect: definition.effect,
      concurrency: definition.concurrency === undefined ? "inline" : definition.concurrency,
      source,
      invoke: async (input: unknown, context: ToolContext) =>
        definition.handler(definition.inputSchema.parse(input), context),
    });
    this.#sourceDefinitions.set(definition, stored);
    return stored;
  }

  // 撤销凭据可以是 StoredToolDefinition，也可以是本注册表发布过的原始 ToolDefinition。
  #storedDefinition(value: unknown): StoredToolDefinition {
    if (isStoredToolDefinition(value)) {
      return value;
    }
    if (typeof value !== "object" || value === null) {
      throw new TypeError("tool registry definitions must be tool definitions");
    }
    const stored = this.#sourceDefinitions.get(value);
    if (stored === undefined) {
      throw new Error("tool definition was not registered by this registry");
    }
    return stored;
  }

  snapshot(): ToolRegistry {
    // 返回不可变快照，正在执行的回合不会被后续 MCP 连接/断开影响。
    return new ToolRegistry(this.#definitions, false, this.#version);
  }

  subset(names: readonly string[]): ToolRegistry {
    // subset 只暴露显式声明的工具，队友运行时用它限制模型可调用的能力。
    const definitions = new Map<string, StoredToolDefinition>();
    for (const name of names) {
      const definition = this.#definitions.get(name);
      if (definition === undefined) throw new Error(`tool does not exist: ${name}`);
      definitions.set(name, definition);
    }
    return new ToolRegistry(definitions, true, this.#version);
  }

  openAITools(): readonly OpenAIToolSchema[] {
    // 模型侧 schema 与运行时 handler 同源，避免平行定义漂移。
    return Object.freeze(
      [...this.#definitions.values()].map((definition) => ({
        type: "function" as const,
        function: {
          name: definition.name,
          description: definition.description,
          parameters:
            definition.inputSchemaJson ??
            (z.toJSONSchema(definition.inputSchema) as Readonly<Record<string, unknown>>),
        },
      })),
    );
  }

  prepare(call: ToolCall): PreparedToolCall {
    // 参数是不可信输入：先解析 JSON，再按 schema 校验，最后冻结完整调用快照。
    const definition = this.#definitions.get(call.name);
    if (definition === undefined) {
      // 工具故障转成可回填消息，循环可继续让模型决定下一步。
      return { call, error: toolError("unknown_tool", `Unknown tool: ${call.name}`) };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(call.arguments);
    } catch {
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
      // handler 异常统一归一为 tool_execution_error，不让内部错误文本直接进入模型上下文。
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

// 工具名、描述和来源在注册边界校验，避免非法名称或空白描述进入模型 schema。
function validateDefinition<Input>(definition: ToolDefinition<Input>): void {
  if (!/^[A-Za-z0-9_]+$/.test(definition.name)) {
    throw new Error(`invalid tool name: ${definition.name}`);
  }
  if (definition.description.trim().length === 0) {
    throw new Error("tool description must not be empty");
  }
  if (definition.source !== undefined && definition.source.trim().length === 0) {
    throw new Error("tool source must not be empty");
  }
}

function isStoredToolDefinition(value: unknown): value is StoredToolDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "name") === "string" &&
    typeof Reflect.get(value, "invoke") === "function" &&
    typeof Reflect.get(value, "source") === "string"
  );
}

// 深冻结工具参数，防止 handler 或后续 Hook 修改共享对象。
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

// handler 返回值同样属于不可信边界，阻止畸形对象污染会话历史。
export function isToolResult(value: unknown): value is ToolResult {
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
