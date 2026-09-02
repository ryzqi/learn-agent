import { resolve } from "node:path";

import type { SystemPromptProvider } from "../core/loop.js";
import { MemorySession } from "./memory.js";
import { SkillRegistry } from "./skills.js";
import { ToolRegistry } from "../core/tools.js";

// P10 动态系统提示渲染：身份、工具、工作区、Skill 与记忆由各自数据源提供，按固定顺序组装。

// JSON 类型只允许可稳定序列化的值，函数、符号、Date 等对象不进入 Prompt。
export type JsonScalar = boolean | number | string | null;
export interface JsonObject {
  // 仅允许字符串键；值递归受 JsonValue 约束，保证可稳定序列化。
  readonly [key: string]: JsonValue;
}

export type JsonValue = JsonScalar | readonly JsonValue[] | JsonObject;

export class PromptContextError extends Error {
  // 动态 prompt 只接收可稳定序列化的 JSON 上下文，拒绝函数、原型对象和循环引用。
  override readonly name: string = "PromptContextError";
}

export interface DynamicPromptRendererOptions {
  // Prompt 可见的身份文本，渲染前会 trim 并拒绝空值。
  readonly identity: string;
  // 工具名称快照决定 tools section 和缓存键。
  readonly tools: ToolRegistry;
  // 规范化绝对工作区路径，供模型理解当前操作边界。
  readonly workspace: string;
  // 额外结构化上下文；不得包含函数、循环引用或非有限数。
  readonly context: JsonObject;
  // 可选 Skill 摘要来源，正文仍由 SkillRegistry 按需加载。
  readonly skills?: SkillRegistry;
  // 可选记忆会话，只读取当前回合已选择的记忆。
  readonly memory?: MemorySession;
}

export class DynamicPromptRenderer {
  // 缓存键覆盖所有模型可见输入，任何工具、记忆或 Skill 变化都会失效。
  // 上一次完整输入的稳定 JSON 键；不同 section 数据不会误命中缓存。
  #lastKey: string | undefined;
  // 与 #lastKey 对应的最终 prompt 文本。
  #lastPrompt: string | undefined;
  // 仅用于观测缓存复用次数，不影响渲染结果。
  #cacheHits = 0;

  // 缓存命中次数用于测试和观测，证明相同输入不会重复组装字符串。
  get cacheHits(): number {
    return this.#cacheHits;
  }

  // render 是唯一入口：先校验对象类型，再规范化 context、生成缓存键并输出固定顺序 sections。
  render(options: DynamicPromptRendererOptions): string {
    const identity = normalizeIdentity(options.identity);
    if (!(options.tools instanceof ToolRegistry)) {
      throw new TypeError("tools must be ToolRegistry");
    }
    if (typeof options.workspace !== "string" || options.workspace.trim().length === 0) {
      throw new TypeError("workspace must be a non-empty string");
    }
    if (options.skills !== undefined && !(options.skills instanceof SkillRegistry)) {
      throw new TypeError("skills must be SkillRegistry or undefined");
    }
    if (options.memory !== undefined && !(options.memory instanceof MemorySession)) {
      throw new TypeError("memory must be MemorySession or undefined");
    }

    // context 先转成规范 JSON，后续缓存键和展示文本都基于同一份规范化值。
    const context = normalizeContext(options.context);
    const contextJson = stableJson(context);
    const tools = options.tools.names;
    const workspace = resolve(options.workspace);
    // Skill 目录和选中记忆按需读取；正文仍由各自模块持有，这里只拿渲染所需摘要。
    const skillCatalog = options.skills === undefined ? "" : options.skills.renderCatalog();
    const memoryBody =
      options.memory === undefined || options.memory.selected.length === 0
        ? ""
        : options.memory.renderSelected();
    // 缓存键覆盖所有模型可见输入，任一运行态变化都会失效。
    const key = stableJson({
      context,
      identity,
      memory: memoryBody,
      skills: skillCatalog,
      tools: [...tools],
      workspace,
    });
    if (key === this.#lastKey && this.#lastPrompt !== undefined) {
      this.#cacheHits += 1;
      return this.#lastPrompt;
    }

    // 工具列表为空也输出 "(none)"，让模型明确知道当前没有可用工具。
    const toolCatalog = tools.length === 0 ? "(none)" : tools.map((name) => `- ${name}`).join("\n");
    const sections = [
      // 固定段落顺序让提示词可预测，后续可选段落只追加不插队。
      `## identity\n${identity}\ncontext: ${contextJson}`,
      `## tools\n${toolCatalog}`,
      `## workspace\n${workspace}`,
    ];
    if (skillCatalog.length > 0) {
      sections.push(`## skills\n${skillCatalog}`);
    }
    if (memoryBody.length > 0) {
      sections.push(`## memory\n${memoryBody}`);
    }
    // 固定 section 顺序是契约；可选 section 只追加到尾部，不改变前面内容的相对位置。
    const prompt = sections.join("\n\n");
    this.#lastKey = key;
    this.#lastPrompt = prompt;
    return prompt;
  }
}

export interface DynamicPromptProviderOptions extends DynamicPromptRendererOptions {
  // Provider 复用该 renderer 的缓存和规范化逻辑。
  readonly renderer: DynamicPromptRenderer;
}

// Provider 对 AgentRunner 暴露零参数 render()，把渲染器与运行态对象的绑定收在组合根。
export class DynamicPromptProvider implements SystemPromptProvider {
  // Provider 在每轮请求时重新渲染，读取当前工具、Skill 与选中记忆。
  readonly #renderer: DynamicPromptRenderer;
  readonly #identity: string;
  readonly #tools: ToolRegistry;
  readonly #workspace: string;
  readonly #context: JsonObject;
  readonly #skills: SkillRegistry | undefined;
  readonly #memory: MemorySession | undefined;

  constructor(options: DynamicPromptProviderOptions) {
    if (!(options.renderer instanceof DynamicPromptRenderer)) {
      throw new TypeError("renderer must be DynamicPromptRenderer");
    }
    // Provider 在构建阶段绑定运行态对象，后续 render() 只做转发，不重新发现依赖。
    this.#renderer = options.renderer;
    this.#identity = options.identity;
    this.#tools = options.tools;
    this.#workspace = options.workspace;
    this.#context = options.context;
    this.#skills = options.skills;
    this.#memory = options.memory;
  }

  render(): string {
    return this.#renderer.render({
      identity: this.#identity,
      tools: this.#tools,
      workspace: this.#workspace,
      context: this.#context,
      ...(this.#skills === undefined ? {} : { skills: this.#skills }),
      ...(this.#memory === undefined ? {} : { memory: this.#memory }),
    });
  }
}

function normalizeIdentity(identity: string): string {
  // identity 是 Prompt 可见输入，空字符串会在进入缓存前失败。
  if (typeof identity !== "string") {
    throw new TypeError("identity must be a string");
  }
  const normalized = identity.trim();
  if (normalized.length === 0) {
    throw new Error("identity must not be empty");
  }
  return normalized;
}

function normalizeContext(context: unknown): JsonObject {
  // context 必须是普通 JSON object；对象之外的类型直接拒绝。
  if (!isPlainObject(context)) {
    throw new PromptContextError("context must be a JSON object");
  }
  const normalized = normalizeJsonValue(context, new Set<object>());
  if (!isPlainObject(normalized)) {
    throw new PromptContextError("context must be a JSON object");
  }
  return normalized;
}

// 递归规范化所有嵌套值：拒绝 NaN、无穷大、symbol key、非普通对象和循环引用。
function normalizeJsonValue(value: unknown, active: Set<object>): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new PromptContextError("context contains a non-finite JSON number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    // active 集合保存当前递归路径上的对象，用于检测循环引用。
    if (active.has(value)) {
      throw new PromptContextError("context contains a cyclic JSON array");
    }
    active.add(value);
    try {
      return Object.freeze(value.map((item) => normalizeJsonValue(item, active)));
    } finally {
      active.delete(value);
    }
  }
  if (isPlainObject(value)) {
    // 只接受字符串 key；对象 key 排序后构造，使缓存和展示输入稳定。
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
      throw new PromptContextError("context JSON object keys must be strings");
    }
    if (active.has(value)) {
      throw new PromptContextError("context contains a cyclic JSON object");
    }
    active.add(value);
    try {
      const normalized: Record<string, JsonValue> = {};
      for (const key of Object.keys(value).sort(compareText)) {
        Object.defineProperty(normalized, key, {
          configurable: false,
          enumerable: true,
          value: normalizeJsonValue(value[key], active),
          writable: false,
        });
      }
      return Object.freeze(normalized);
    } finally {
      active.delete(value);
    }
  }
  throw new PromptContextError("context contains an unsupported JSON value");
}

// 普通对象指原型恰为 Object.prototype 的对象；类实例、Map、Set 等不作为 JSON object 接受。
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

// 对规范 JSON 递归按键排序序列化，确保语义相同的 context 总是生成同一缓存键。
function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// 简单字符串排序用于稳定对象 key，避免依赖引擎默认枚举顺序。
function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
