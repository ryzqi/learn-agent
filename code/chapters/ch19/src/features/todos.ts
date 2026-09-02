// TODO 会话计划：用完整快照工具 todo_write 管理模型可见任务列表，并在计划长期未更新时向下一轮模型请求注入提醒。
import { z } from "zod";

import type { ChatMessage } from "../core/messages.js";
import { systemMessage } from "../core/messages.js";
import type { ToolDefinition, ToolResult } from "../core/tools.js";
import { toolSuccess } from "../core/tools.js";

// 单次计划快照的数量上限，防止模型一次性塞入超大数组。
// 会话级 TODO capability：用完整计划快照对抗长上下文中的任务遗忘。
// 边界：状态只存在于单次 AgentRunner 生命周期，不做跨会话或磁盘持久化；
// 提醒只注入下一次模型请求，不写入正式消息历史。
export const MAX_TODOS = 50;
// 连续未更新计划的其他工具轮次数，达到后会在下一次模型请求前提醒。
export const STALE_TOOL_ROUNDS = 3;
// 注入的提醒保持固定文案，测试和模型上下文都能观察到同一契约。
export const TODO_STALE_REMINDER =
  "Keep the TODO list current. Call todo_write with the complete task snapshot when the plan changes.";
// 三个合法状态作为工具 schema 的唯一取值来源。
export const TODO_STATUSES = Object.freeze(["pending", "in_progress", "completed"] as const);
// TODO 工具只接受完整快照，防止增量补丁让模型与实际计划状态漂移。
export type TodoStatus = (typeof TODO_STATUSES)[number];

// 单项先 trim 再校验，并拒绝未知字段，避免脏数据进入会话计划。
const todoItemSchema = z
  .object({
    content: z
      .string()
      .transform((content) => content.trim())
      .pipe(z.string().min(1, "todo content must not be empty")),
    status: z.enum(TODO_STATUSES),
  })
  .strict();

// 工具参数始终是完整快照，不做增量补丁，保持模型看到的计划与内部状态一致。
const todoWriteSchema = z
  .object({
    todos: z.array(todoItemSchema).max(MAX_TODOS),
  })
  .strict();

// 已校验且冻结的计划项，tracker 只保存这种内部安全形态。
export type TodoItem = Readonly<z.output<typeof todoItemSchema>>;
// 工具 handler 的内部入参；只在 schema 校验成功后才会进入写入路径。
type TodoWriteInput = z.output<typeof todoWriteSchema>;

// TodoTracker 是会话级状态：每次构建 Agent 都新建实例，避免跨会话共享计划。
export class TodoTracker {
  // 观察每轮工具调用；计划长期未更新时，在下次模型请求前注入提醒。
  // 当前完整计划快照；替换而非原地修改，使工具输出与内存状态一一对应。
  #todos: readonly TodoItem[] = Object.freeze([]);
  // 自上次写计划以来发生的非 TODO 工具轮数，不统计没有工具调用的模型回复。
  #nonTodoToolRounds = 0;
  // 暴露给 ToolRegistry 的唯一写入口，handler 闭包保证不会写入其他 tracker 实例。
  readonly toolDefinition: ToolDefinition<TodoWriteInput>;

  // 每个 AgentRunner 独立构造 tracker，避免不同用户或工作区共享任务计划。
  constructor() {
    // toolDefinition 与当前 tracker 绑定，作为工具和观察器共享同一份会话状态。
    this.toolDefinition = Object.freeze({
      name: "todo_write",
      description: "Replace the current TODO list with a complete task snapshot.",
      inputSchema: todoWriteSchema,
      effect: "write",
      handler: (input: TodoWriteInput) => this.#writeTodos(input),
    });
  }

  get todos(): readonly TodoItem[] {
    // 只读暴露当前快照，供测试和上层检查，不开放外部修改入口。
    return this.#todos;
  }

  recordToolRound(toolNames: readonly string[]): void {
    // 一轮中出现 todo_write 即视为新快照，重置陈旧计数器。
    if (toolNames.length === 0) {
      return;
    }
    if (toolNames.includes(this.toolDefinition.name)) {
      this.#nonTodoToolRounds = 0;
      return;
    }
    this.#nonTodoToolRounds += 1;
  }

  // 达到陈旧阈值时仅为下一次请求生成临时系统消息，不污染可回放的历史。
  beforeModel(): readonly ChatMessage[] {
    if (this.#nonTodoToolRounds < STALE_TOOL_ROUNDS) {
      return [];
    }
    // 提醒是请求级上下文；立即清零可避免后续每轮重复注入。
    this.#nonTodoToolRounds = 0;
    return Object.freeze([systemMessage(TODO_STALE_REMINDER)]);
  }

  // 成功后原子替换全部计划并重置计数；不会接受部分更新或保留过期项。
  #writeTodos(input: TodoWriteInput): ToolResult {
    // 先由 Zod 完整校验，再一次替换快照；失败路径不会触碰旧状态。
    this.#todos = Object.freeze(
      input.todos.map((item) => Object.freeze({ content: item.content, status: item.status })),
    );
    this.#nonTodoToolRounds = 0;
    return toolSuccess(serializeSnapshot(this.#todos));
  }
}

// 将快照序列化为 ASCII JSON，保证工具结果可安全嵌入模型上下文而不依赖终端编码。
function serializeSnapshot(todos: readonly TodoItem[]): string {
  // 使用确定性 JSON 作为模型可见状态，方便下一轮完整替换。
  const json = JSON.stringify({
    todos: todos.map((item) => ({ content: item.content, status: item.status })),
  });
  const ascii: string[] = [];

  // 非 BMP 字符拆成 UTF-16 代理对，保持 JSON 的 Unicode 转义合法。
  for (const character of json) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      throw new Error("todo snapshot contained an invalid Unicode value");
    }

    if (codePoint <= 0x7f) {
      ascii.push(character);
      continue;
    }

    if (codePoint <= 0xffff) {
      ascii.push(`\\u${codePoint.toString(16).padStart(4, "0")}`);
      continue;
    }

    const offset = codePoint - 0x10000;
    const high = 0xd800 + (offset >> 10);
    const low = 0xdc00 + (offset & 0x3ff);
    ascii.push(`\\u${high.toString(16)}\\u${low.toString(16)}`);
  }

  return ascii.join("");
}
