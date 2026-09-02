// 第 12 章任务 DAG 的领域模型与工具注册：Task 构造器、TaskStore 接口和五个任务工具共用同一套校验边界。
import { z } from "zod";

import type { ToolDefinition, ToolRegistry } from "../core/tools.js";
import { toolError, toolSuccess } from "../core/tools.js";

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

// 任务三态是迁移的唯一来源；blocked 不落盘，而是由依赖图在 claim 时派生。
export const TaskStatus = Object.freeze({
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
} as const);

// 状态集合是任务迁移的单一来源；pending/in_progress/completed 之外的状态不会进入模型。
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export interface TaskOptions {
  // 规范 UUID，唯一标识任务。
  readonly id: string;
  // 任务标题，用于模型规划与列表展示。
  readonly subject: string;
  // 任务详细说明，可为空字符串。
  readonly description: string;
  // 当前状态；pending 无 owner，其他状态必须有 owner。
  readonly status: TaskStatus;
  // 认领者身份；pending 必须为 null。
  readonly owner: string | null;
  // 依赖任务的规范 UUID；依赖未完成时任务不可 claim。
  readonly blockedBy: readonly string[];
}

export class Task {
  // Task 构造器集中维护状态、owner 与依赖的领域不变量，存储层不得绕过它。
  // 规范 UUID，同时是存储文件名和引用 key。
  readonly id: string;
  // 归一化后的任务标题。
  readonly subject: string;
  // 归一化后的任务说明。
  readonly description: string;
  // 当前任务状态。
  readonly status: TaskStatus;
  // 当前 owner；pending 必须为 null。
  readonly owner: string | null;
  // 上游依赖 id 列表，冻结后不可修改。
  readonly blockedBy: readonly string[];

  constructor(options: TaskOptions) {
    this.id = canonicalTaskId(options.id);
    this.subject = normalizeSubject(options.subject);
    this.description = normalizeDescription(options.description);
    if (!isTaskStatus(options.status)) {
      throw new TaskStorageError("task status is invalid");
    }
    this.status = options.status;
    this.owner = normalizeOptionalOwner(options.owner);
    this.blockedBy = normalizeDependencies(options.blockedBy);
    if (this.status === TaskStatus.PENDING && this.owner !== null) {
      throw new TaskStorageError("pending task must not have an owner");
    }
    if (this.status !== TaskStatus.PENDING && this.owner === null) {
      throw new TaskStorageError("in-progress or completed task requires an owner");
    }
    Object.freeze(this.blockedBy);
    Object.freeze(this);
  }
}

export interface TaskCompletion {
  // 本次完成的任务。
  readonly task: Task;
  // 因本次完成而从 blocked 变为 ready 的 pending 任务。
  readonly unblocked: readonly Task[];
}

// 任务领域错误基类；code 用于工具层返回稳定错误码。
export class TaskError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskError";
    this.code = code;
  }
}

// 任务不存在。
export class TaskNotFoundError extends TaskError {
  constructor(message: string) {
    super("task_not_found", message);
    this.name = "TaskNotFoundError";
  }
}

// 依赖图不满足无环或引用约束。
export class TaskGraphError extends TaskError {
  constructor(message: string, options?: ErrorOptions) {
    super("task_graph_error", message, options);
    this.name = "TaskGraphError";
  }
}

// 任务状态不允许当前迁移。
export class TaskStateError extends TaskError {
  constructor(message: string, code = "task_invalid_state") {
    super(code, message);
    this.name = "TaskStateError";
  }
}

// 任务仍被未完成任务阻塞，claim 被拒绝。
export class TaskBlockedError extends TaskStateError {
  readonly taskId: string;
  readonly blockedBy: readonly string[];

  constructor(taskId: string, blockedBy: readonly string[]) {
    super(`Task ${taskId} is blocked by: ${blockedBy.join(", ")}`, "task_blocked");
    this.name = "TaskBlockedError";
    this.taskId = taskId;
    this.blockedBy = Object.freeze([...blockedBy]);
  }
}

// owner 与当前认领者不匹配。
export class TaskOwnershipError extends TaskError {
  constructor(message: string) {
    super("task_owner_mismatch", message);
    this.name = "TaskOwnershipError";
  }
}

// 任务存储层读写或 schema 校验失败。
export class TaskStorageError extends TaskError {
  constructor(message: string, options?: ErrorOptions) {
    super("task_storage_error", message, options);
    this.name = "TaskStorageError";
  }
}

export interface CreateTaskInput {
  // 必填任务标题。
  readonly subject: string;
  // 可选说明；缺省由 store 归一化为空字符串。
  readonly description?: string;
  // 可选上游依赖；缺省为空。
  readonly blockedBy?: readonly string[];
}

// TaskStore 是所有持久化实现必须满足的窄接口，工具层不依赖 JSON 或 SQLite 具体实现。
export interface TaskStore {
  // 任务图操作以完整 Task 返回，调用者不能通过局部补丁跳过状态迁移校验。
  // 在锁内创建任务，并校验唯一 id、依赖存在性和全图无环。
  createTask(input: CreateTaskInput): Promise<Task>;
  // 按规范 UUID 读取单个任务。
  getTask(taskId: string): Promise<Task>;
  // 返回按 id 排序的完整任务图快照。
  listTasks(): Promise<readonly Task[]>;
  // 仅把 ready pending 任务原子迁移为指定 owner 的 in_progress。
  claimTask(taskId: string, owner: string): Promise<Task>;
  // 仅由当前 owner 完成 in_progress 任务，并返回直接解除阻塞的 pending 任务。
  completeTask(taskId: string, owner: string): Promise<TaskCompletion>;
}

// 工具 schema 都使用 .strict()，额外字段会在任何副作用前被拒绝。
const taskIdSchema = z.string().regex(CANONICAL_UUID, "task_id must be a canonical UUID");
const createTaskSchema = z
  .object({
    subject: z.string().trim().min(1),
    description: z.string().trim().default(""),
    blocked_by: z.array(taskIdSchema).default([]),
  })
  .strict();
const taskIdInputSchema = z.object({ task_id: taskIdSchema }).strict();
const listTasksInputSchema = z.object({}).strict();

// 工具参数沿用磁盘命名 blocked_by，避免模型可见字段与存储格式之间出现另一层映射。
export function registerTaskTools(registry: ToolRegistry, store: TaskStore): void {
  // 五个工具统一由这里注册，schema 与 handler 都来自同一 ToolDefinition。
  registry.register(createTaskDefinition(store));
  registry.register(
    // get_task 是只读查询，不改变状态或 owner。
    taskIdDefinition(
      "get_task",
      "Read one persistent project task by canonical UUID. Read-only; it does not change status or owner.",
      "read",
      store,
    ),
  );
  registry.register({
    name: "list_tasks",
    // 返回完整图快照，调用方才能根据依赖和 ready 状态做规划。
    description:
      "List the complete persistent project task graph sorted by ID. Use it before create_task to find canonical UUIDs or before claim_task to find ready tasks.",
    inputSchema: listTasksInputSchema,
    effect: "read",
    handler: async (_input, _context) => {
      try {
        // 返回完整图而不是局部任务，避免模型只看到部分依赖关系。
        const tasks = await store.listTasks();
        return toolSuccess(encodePayload({ tasks: tasks.map(taskPayload) }));
      } catch (error) {
        return taskToolError(error);
      }
    },
  });
  registry.register(
    // claim 的 owner 只来自 ToolContext.identity，模型不能选择替谁完成任务。
    taskIdDefinition(
      "claim_task",
      "Atomically claim a ready pending task as the current identity. Owner is set by the runtime identity; do not pass an owner argument.",
      "write",
      store,
    ),
  );
  registry.register({
    name: "complete_task",
    // 完成者只能来自可信 ToolContext.identity。
    description:
      "Complete a claimed task owned by the current identity. Returns the completed task and any pending tasks directly unblocked by this completion.",
    inputSchema: taskIdInputSchema,
    effect: "write",
    handler: async (input, context) => {
      try {
        const completion = await store.completeTask(
          input.task_id,
          normalizeOwner(context.identity),
        );
        return toolSuccess(
          encodePayload({
            task: taskPayload(completion.task),
            unblocked: completion.unblocked.map(taskPayload),
          }),
        );
      } catch (error) {
        return taskToolError(error);
      }
    },
  });
}

function createTaskDefinition(store: TaskStore): ToolDefinition<z.infer<typeof createTaskSchema>> {
  return {
    name: "create_task",
    // blocked_by 必须引用 list_tasks/get_task 返回的规范 UUID。
    description:
      "Create a persistent project task after planning. blocked_by must contain canonical task UUIDs returned by list_tasks or get_task.",
    inputSchema: createTaskSchema,
    effect: "write",
    handler: async (input) => {
      try {
        // handler 只做输入到 TaskStore 的转发；全图校验与原子写入由持久化边界负责。
        const task = await store.createTask({
          subject: input.subject,
          description: input.description,
          blockedBy: input.blocked_by,
        });
        return toolSuccess(encodePayload(taskPayload(task)));
      } catch (error) {
        return taskToolError(error);
      }
    },
  };
}

function taskIdDefinition(
  name: "get_task" | "claim_task",
  description: string,
  effect: "read" | "write",
  store: TaskStore,
): ToolDefinition<z.infer<typeof taskIdInputSchema>> {
  // get/claim 共用 task_id schema，只有 store 调用和 effect 不同。
  // get/claim 共用 task_id schema；claim 的 owner 只来自 ToolContext.identity，不接受模型参数。
  return {
    name,
    description,
    inputSchema: taskIdInputSchema,
    effect,
    handler: async (input, context) => {
      try {
        const task =
          name === "get_task"
            ? await store.getTask(input.task_id)
            : await store.claimTask(input.task_id, normalizeOwner(context.identity));
        return toolSuccess(encodePayload(taskPayload(task)));
      } catch (error) {
        return taskToolError(error);
      }
    },
  };
}

function taskToolError(error: unknown) {
  // 已知领域错误保留稳定错误码；未知异常继续向上抛，避免吞掉程序缺陷。
  if (error instanceof TaskError) {
    return toolError(error.code, error.message);
  }
  throw error;
}

export function canonicalTaskId(value: string): string {
  // 所有 ID 都先归一为 canonical UUID，外部路径字符串无法进入文件系统。
  if (typeof value !== "string" || !CANONICAL_UUID.test(value)) {
    throw new TaskGraphError("task id must be a canonical UUID");
  }
  return value;
}

export function normalizeOwner(value: string): string {
  if (typeof value !== "string") {
    throw new TaskOwnershipError("task owner must be a string");
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TaskOwnershipError("task owner must not be empty");
  }
  return normalized;
}

function normalizeOptionalOwner(value: string | null): string | null {
  return value === null ? null : normalizeOwner(value);
}

function normalizeSubject(value: string): string {
  if (typeof value !== "string") {
    throw new TaskStorageError("task subject must be a string");
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TaskStorageError("task subject must not be empty");
  }
  return normalized;
}

function normalizeDescription(value: string): string {
  if (typeof value !== "string") {
    throw new TaskStorageError("task description must be a string");
  }
  return value.trim();
}

function normalizeDependencies(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values)) {
    throw new TaskStorageError("task dependencies must be an array");
  }
  const normalized = values.map(canonicalTaskId);
  if (new Set(normalized).size !== normalized.length) {
    throw new TaskGraphError("task dependencies must be unique");
  }
  return normalized;
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    value === TaskStatus.PENDING ||
    value === TaskStatus.IN_PROGRESS ||
    value === TaskStatus.COMPLETED
  );
}

function taskPayload(task: Task): Readonly<Record<string, unknown>> {
  // 返回给模型的字段使用磁盘命名 blocked_by，避免 wire format 与存储格式不一致。
  return {
    blocked_by: [...task.blockedBy],
    description: task.description,
    id: task.id,
    owner: task.owner,
    status: task.status,
    subject: task.subject,
  };
}

function encodePayload(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(value);
}
