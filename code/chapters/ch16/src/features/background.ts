// 后台任务运行时：以持久化 Job 为状态源，Supervisor 负责容量、取消、超时和事件发布，Dispatcher 只分流显式可后台工具。
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { isRuntimeEvent, type EventInbox } from "../core/events.js";
import type { RuntimeEvent } from "../core/events.js";
import type {
  PreparedToolCall,
  ToolContext,
  ToolDefinition,
  ToolRegistry,
  ToolResult,
} from "../core/tools.js";
import { isToolResult, toolError, toolSuccess } from "../core/tools.js";
import type { BackgroundShellInput } from "./builtin-tools.js";

// 长耗时命令关键词白名单；未显式指定 run_in_background 时，Dispatcher 据此决定是否进入后台。
const BACKGROUND_MARKERS = Object.freeze([
  "cargo build",
  "compile",
  "deploy",
  "docker build",
  "npm install",
  "pip install",
  "pytest",
]);

// 后台作业六态：running 是唯一运行态，其余都是终态；状态迁移由 Supervisor 与 store 共同保证。
export const BackgroundJobStatus = Object.freeze({
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  TIMED_OUT: "timed_out",
  CANCELLED: "cancelled",
  INTERRUPTED: "interrupted",
} as const);
export type BackgroundJobStatus = (typeof BackgroundJobStatus)[keyof typeof BackgroundJobStatus];

// 后台领域错误的公共基类；errorCode 是工具层可返回的稳定错误码。
export class BackgroundError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackgroundError";
    this.errorCode = errorCode;
  }
}

// 后台并发容量已满，拒绝新作业。
export class BackgroundCapacityError extends BackgroundError {
  constructor(message: string) {
    super("background_capacity", message);
    this.name = "BackgroundCapacityError";
  }
}

// Supervisor 已关闭，拒绝新作业。
export class BackgroundClosedError extends BackgroundError {
  constructor(message: string) {
    super("background_closed", message);
    this.name = "BackgroundClosedError";
  }
}

// 按规范 ID 查不到持久化后台作业。
export class BackgroundJobNotFoundError extends BackgroundError {
  constructor(message: string) {
    super("background_job_not_found", message);
    this.name = "BackgroundJobNotFoundError";
  }
}

// 当前作业状态不允许执行目标操作，例如取消已结束的作业。
export class BackgroundJobStateError extends BackgroundError {
  constructor(message: string) {
    super("background_job_state", message);
    this.name = "BackgroundJobStateError";
  }
}

// 后台持久化层写入、读取、路径校验或 schema 校验失败。
export class BackgroundStorageError extends BackgroundError {
  constructor(message: string, options?: ErrorOptions) {
    super("background_storage_error", message, options);
    this.name = "BackgroundStorageError";
  }
}

// 关闭 Supervisor 时等待运行中 worker 收束超时。
export class BackgroundCloseTimeoutError extends BackgroundError {
  constructor(message: string) {
    super("background_close_timeout", message);
    this.name = "BackgroundCloseTimeoutError";
  }
}

export interface BackgroundJobOptions {
  // 规范 UUID，唯一标识作业并作为磁盘文件名。
  readonly id: string;
  // 触发该作业的工具调用 id，用于终态事件回到原调用上下文。
  readonly sourceToolCallId: string;
  // 触发作业的工具名，模型可见。
  readonly toolName: string;
  // 当前状态；running 与终态的不变量由构造器校验。
  readonly status: BackgroundJobStatus;
  // running 必须为 null，终态必须是非空 ToolResult。
  readonly result: ToolResult | null;
}

// 领域对象在构造时验证状态不变量：running 无结果，终态必须有匹配的 ToolResult。
export class BackgroundJob {
  // 规范 UUID；外部输入无法影响文件系统路径。
  readonly id: string;
  // 回填原工具调用，事件注入时可关联到触发它的回合。
  readonly sourceToolCallId: string;
  // 来源工具名。
  readonly toolName: string;
  // 当前持久化状态。
  readonly status: BackgroundJobStatus;
  // 终态结果，或 running 状态的 null。
  readonly result: ToolResult | null;

  // 构造时统一校验标识、状态和结果组合；对象构造后保持不可变。
  constructor(options: BackgroundJobOptions) {
    this.id = canonicalBackgroundId(options.id);
    if (
      typeof options.sourceToolCallId !== "string" ||
      options.sourceToolCallId.trim().length === 0
    ) {
      throw new BackgroundStorageError("background source tool call id must not be empty");
    }
    if (typeof options.toolName !== "string" || options.toolName.trim().length === 0) {
      throw new BackgroundStorageError("background tool name must not be empty");
    }
    if (!isBackgroundJobStatus(options.status)) {
      throw new BackgroundStorageError("background job status is invalid");
    }
    if (options.status === BackgroundJobStatus.RUNNING) {
      if (options.result !== null) {
        throw new BackgroundStorageError("running background job cannot have a result");
      }
    } else {
      if (!isToolResult(options.result)) {
        throw new BackgroundStorageError("terminal background job requires a result");
      }
      if (options.status === BackgroundJobStatus.COMPLETED && options.result.isError) {
        throw new BackgroundStorageError("completed background job requires a successful result");
      }
      if (options.status !== BackgroundJobStatus.COMPLETED && !options.result.isError) {
        throw new BackgroundStorageError("non-completed background job requires an error result");
      }
    }
    this.sourceToolCallId = options.sourceToolCallId;
    this.toolName = options.toolName;
    this.status = options.status;
    this.result = options.result;
    Object.freeze(this);
  }
}

// 持久化边界：Supervisor 只依赖这五个操作，文件、数据库或其他实现可以替换。
export interface BackgroundJobStore {
  // 先持久化 running 记录；成功返回后 Supervisor 才启动 worker。
  createRunning(input: {
    readonly jobId: string;
    readonly sourceToolCallId: string;
    readonly toolName: string;
  }): Promise<BackgroundJob>;
  // 仅把 running 原子迁移到终态；后到写者返回 undefined，避免重复发布终态。
  finishRunning(
    jobId: string,
    status: Exclude<BackgroundJobStatus, "running">,
    result: ToolResult,
  ): Promise<BackgroundJob | undefined>;
  // 进程启动恢复时把所有遗留 running 标记为 interrupted，并返回本次迁移的作业。
  interruptRunning(): Promise<readonly BackgroundJob[]>;
  // 读取单个持久化作业；不存在时抛出稳定领域错误。
  getJob(jobId: string): Promise<BackgroundJob>;
  // 读取完整作业快照，供工具查询和恢复使用。
  listJobs(): Promise<readonly BackgroundJob[]>;
}

// 后台工作负载函数；signal 用于向实际执行传播取消或超时。
export type BackgroundOperation = (signal: AbortSignal) => Promise<ToolResult>;

// 可替换的执行边界；测试可以注入受控 executor，生产环境使用 AsyncJobExecutor。
export interface JobExecutor {
  execute(operation: BackgroundOperation, signal: AbortSignal): Promise<ToolResult>;
}

// 默认 executor：直接执行后台 operation，并透传 AbortSignal。
export class AsyncJobExecutor implements JobExecutor {
  async execute(operation: BackgroundOperation, signal: AbortSignal): Promise<ToolResult> {
    return await operation(signal);
  }
}

// 后台作业终态事件；实现 RuntimeEvent，由 EventInbox 注入 Agent Loop。
export class BackgroundJobEvent implements RuntimeEvent {
  // 事件唯一 id；Loop 用它去重，避免同一结果重复进入历史。
  readonly eventId: string;
  // 对应持久化作业 id。
  readonly jobId: string;
  // 触发作业的工具调用 id。
  readonly sourceToolCallId: string;
  // 触发作业的工具名。
  readonly toolName: string;
  // 终态状态；后台事件不会发布 running。
  readonly status: Exclude<BackgroundJobStatus, "running">;
  // 终态结果。
  readonly result: ToolResult;

  // 构造时校验标识与终态结果，构造后事件不可变。
  constructor(options: {
    readonly eventId: string;
    readonly jobId: string;
    readonly sourceToolCallId: string;
    readonly toolName: string;
    readonly status: Exclude<BackgroundJobStatus, "running">;
    readonly result: ToolResult;
  }) {
    this.eventId = canonicalBackgroundId(options.eventId);
    this.jobId = canonicalBackgroundId(options.jobId);
    if (options.sourceToolCallId.trim().length === 0 || options.toolName.trim().length === 0) {
      throw new Error("background event identifiers must not be empty");
    }
    if (!isToolResult(options.result)) {
      throw new Error("BackgroundJobEvent requires a terminal ToolResult");
    }
    this.sourceToolCallId = options.sourceToolCallId;
    this.toolName = options.toolName;
    this.status = options.status;
    this.result = options.result;
    Object.freeze(this);
  }

  // 把事件序列化为模型可见的纯 JSON 数据，字段名与持久化 payload 保持一致。
  toPayload(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      event_id: this.eventId,
      job_id: this.jobId,
      kind: "background_job",
      result: {
        content: this.result.content,
        error_code: this.result.errorCode ?? null,
        is_error: this.result.isError,
      },
      source_tool_call_id: this.sourceToolCallId,
      status: this.status,
      tool_name: this.toolName,
    });
  }
}

// Supervisor 内部用于管理单个运行中作业的控制句柄。
interface JobControl {
  // 被 Supervisor 追踪的 worker 收束 Promise。
  readonly task: Promise<void>;
  // 触发与执行、超时并列竞速的主动取消信号。
  readonly cancel: () => void;
}

// 内部取消信号；用于区分主动取消与作业自身失败，不对外暴露。
class CancellationSignalError extends Error {}

// Supervisor 是后台 coroutine 的唯一 owner：控制容量、超时、取消、关闭，并把终态发布为 typed event。
export class JobSupervisor {
  // Supervisor 管理后台作业的持久状态、取消和终态事件，隔离当前模型回合。
  // 持久化作业的唯一事实源；所有查询都读它，worker 只负责执行。
  readonly #store: BackgroundJobStore;
  // 终态事件进入 Agent Loop 的单向队列。
  readonly #inbox: EventInbox;
  // 执行后台 operation 的可注入边界。
  readonly #executor: JobExecutor;
  // 并发运行上限。
  readonly #capacity: number;
  // 单个作业执行超时。
  readonly #timeoutMs: number;
  // 关闭时等待所有 worker 收束的上限。
  readonly #closeTimeoutMs: number;
  // 作业 id 生成器，测试可注入确定性 UUID。
  readonly #idGenerator: () => string;
  // 事件 id 生成器，测试可注入确定性 UUID。
  readonly #eventIdGenerator: () => string;
  // 运行中作业 id 到控制句柄的映射；终态或失败后删除。
  readonly #jobControls = new Map<string, JobControl>();
  // 所有被追踪的 worker Promise；close 时等待它们全部 settle。
  readonly #managedTasks = new Set<Promise<unknown>>();
  // 受管理的长期协程的 AbortController，close 时统一中止。
  readonly #managedControllers = new Map<Promise<void>, AbortController>();
  // 构造时启动的恢复 promise；后续提交、查询和关闭都要先等它完成。
  readonly #ready: Promise<void>;
  // 关闭标记；为 true 后拒绝新作业。
  #closed = false;

  // 注入依赖并校验容量和超时；构造时立即开始恢复遗留 running 作业。
  constructor(options: {
    readonly store: BackgroundJobStore;
    readonly inbox: EventInbox;
    readonly executor?: JobExecutor;
    readonly capacity?: number;
    readonly timeoutMs?: number;
    readonly closeTimeoutMs?: number;
    readonly idGenerator?: () => string;
    readonly eventIdGenerator?: () => string;
  }) {
    if (
      options.capacity !== undefined &&
      (!Number.isInteger(options.capacity) || options.capacity <= 0)
    ) {
      throw new Error("capacity must be a positive integer");
    }
    const timeoutMs = options.timeoutMs === undefined ? 120_000 : options.timeoutMs;
    const closeTimeoutMs = options.closeTimeoutMs === undefined ? 10_000 : options.closeTimeoutMs;
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      !Number.isFinite(closeTimeoutMs) ||
      closeTimeoutMs <= 0
    ) {
      throw new Error("timeouts must be positive finite numbers");
    }
    this.#store = options.store;
    this.#inbox = options.inbox;
    this.#executor = options.executor === undefined ? new AsyncJobExecutor() : options.executor;
    this.#capacity = options.capacity === undefined ? 4 : options.capacity;
    this.#timeoutMs = timeoutMs;
    this.#closeTimeoutMs = closeTimeoutMs;
    this.#idGenerator = options.idGenerator === undefined ? randomUUID : options.idGenerator;
    this.#eventIdGenerator =
      options.eventIdGenerator === undefined ? randomUUID : options.eventIdGenerator;
    this.#ready = this.#recover();
  }

  // 当前仍被追踪的 worker 数量。
  get activeCount(): number {
    return this.#managedTasks.size;
  }

  // 暴露事件队列给 Loop 或测试，但保持 Supervisor 对事件发布路径的独占控制。
  get eventInbox(): EventInbox {
    return this.#inbox;
  }

  // 是否存在尚未收束的后台作业；Loop 据此决定是否等待事件。
  get hasPendingWork(): boolean {
    return this.#jobControls.size > 0;
  }

  // 等待构造期恢复完成；恢复完成后持久化状态才可用于查询和提交。
  async ready(): Promise<void> {
    await this.#ready;
  }

  // 取走当前已就绪的事件；limit 可选，缺省取完整批次。
  drainEvents(limit?: number): readonly RuntimeEvent[] {
    return this.#inbox.drain(limit);
  }

  // 阻塞等待至少一条已就绪事件，再按 limit 取走。
  async waitForEvents(limit?: number): Promise<readonly RuntimeEvent[]> {
    return await this.#inbox.wait(limit);
  }

  // 确认事件已由 Loop 消费；当前实现只校验契约，为后续持久化 ack 保留边界。
  acknowledgeEvents(events: readonly RuntimeEvent[]): void {
    if (!Array.isArray(events) || !events.every((event) => isRuntimeEvent(event))) {
      throw new TypeError("events must contain RuntimeEvent values");
    }
  }

  // 提交后台作业：先做容量与关闭检查，再落盘 running，最后启动 worker。
  async submit(input: {
    readonly sourceToolCallId: string;
    readonly toolName: string;
    readonly operation: BackgroundOperation;
  }): Promise<string> {
    // 提交顺序固定为“容量检查 -> 先落盘 running -> 再登记 worker”，拒绝时不启动任何副作用。
    await this.#ready;
    if (this.#closed) {
      throw new BackgroundClosedError("JobSupervisor is closed");
    }
    if (this.#jobControls.size >= this.#capacity) {
      throw new BackgroundCapacityError(`Background job capacity ${this.#capacity} is full`);
    }
    const jobId = nextId(this.#idGenerator, "background job");
    await this.#store.createRunning({
      jobId,
      sourceToolCallId: input.sourceToolCallId,
      toolName: input.toolName,
    });
    let cancel: () => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new CancellationSignalError("background job cancelled"));
    });
    const task = this.#track(this.#runJob(jobId, input.operation, cancelled));
    this.#jobControls.set(jobId, { task, cancel });
    return jobId;
  }

  // 查询只读持久化状态，不启动 worker；未知 ID 由 store 转为稳定领域错误。
  async getJob(jobId: string): Promise<BackgroundJob> {
    await this.#ready;
    return await this.#store.getJob(canonicalBackgroundId(jobId));
  }

  // 取消运行中的作业并等待 worker 收束；非运行中作业明确报状态错误。
  async cancel(jobId: string): Promise<void> {
    await this.#ready;
    const normalized = canonicalBackgroundId(jobId);
    const control = this.#jobControls.get(normalized);
    if (control === undefined) {
      const job = await this.#store.getJob(normalized);
      throw new BackgroundJobStateError(
        `Background job ${job.id} is ${job.status}; expected running`,
      );
    }
    control.cancel();
    await control.task;
  }

  // 等待当前所有后台作业收束，用于测试或资源关闭前的同步点。
  async waitIdle(): Promise<void> {
    await this.#ready;
    while (this.#jobControls.size > 0) {
      await Promise.all([...this.#jobControls.values()].map((control) => control.task));
    }
  }

  // 关闭流程先停止新提交并取消运行中作业，再等待 worker 在限时内收束。
  async close(): Promise<void> {
    // 关闭先停止新提交并取消仍在运行的作业，再等待其收束。
    await this.#ready;
    if (this.#closed && this.#managedTasks.size === 0) {
      return;
    }
    this.#closed = true;
    for (const control of this.#jobControls.values()) {
      control.cancel();
    }
    for (const controller of this.#managedControllers.values()) {
      controller.abort();
    }
    const settled = Promise.allSettled([...this.#managedTasks]);
    await withTimeout(
      settled,
      this.#closeTimeoutMs,
      new BackgroundCloseTimeoutError("Managed tasks did not stop before close timeout"),
    );
  }

  // startManaged 注册受管理的长期协程（如 Cron scheduler），关闭时会自动中止其 AbortController。
  startManaged(
    operation: (signal: AbortSignal) => Promise<void>,
    _name = "managed-task",
  ): Promise<void> {
    if (this.#closed) {
      throw new BackgroundClosedError("JobSupervisor is closed");
    }
    if (typeof operation !== "function") {
      throw new TypeError("managed operation must be a function");
    }
    const controller = new AbortController();
    const task = this.#track(Promise.resolve().then(() => operation(controller.signal)));
    this.#managedControllers.set(task, controller);
    void task.then(
      () => this.#managedControllers.delete(task),
      () => this.#managedControllers.delete(task),
    );
    return task;
  }

  // 恢复流程把上次进程遗留的 running 全部迁移为 interrupted，并为每条迁移发布事件。
  async #recover(): Promise<void> {
    const interrupted = await this.#store.interruptRunning();
    for (const job of interrupted) {
      await this.#publishEvent(job);
    }
  }

  // 把 worker Promise 加入管理集合；取消信号不会作为未处理 rejection 泄漏。
  #track(operation: Promise<void>): Promise<void> {
    const tracked = operation.then(
      () => undefined,
      (error: unknown) => {
        if (!(error instanceof CancellationSignalError)) {
          throw error;
        }
      },
    );
    this.#managedTasks.add(tracked);
    void tracked.then(
      () => this.#managedTasks.delete(tracked),
      () => this.#managedTasks.delete(tracked),
    );
    return tracked;
  }

  // 运行单个后台作业：竞速执行、取消、超时，并按结果迁移到对应终态。
  async #runJob(
    jobId: string,
    operation: BackgroundOperation,
    cancelled: Promise<never>,
  ): Promise<void> {
    const controller = new AbortController();
    const execution = this.#executor.execute(operation, controller.signal);
    // Executor 可能在取消后仍有收尾逻辑；始终等待它结束，避免 close 返回时残留 worker。
    const timeoutHandle = timeout(this.#timeoutMs);
    try {
      const result = await Promise.race([execution, cancelled, timeoutHandle.promise]);
      if (!isToolResult(result)) {
        await this.#finish(
          jobId,
          BackgroundJobStatus.FAILED,
          toolError("background_contract_error", "Background executor returned an invalid result"),
        );
      } else {
        await this.#finish(
          jobId,
          result.isError ? BackgroundJobStatus.FAILED : BackgroundJobStatus.COMPLETED,
          result,
        );
      }
    } catch (error) {
      if (error instanceof CancellationSignalError) {
        controller.abort();
        await execution.catch(() => undefined);
        await this.#finish(
          jobId,
          BackgroundJobStatus.CANCELLED,
          toolError("background_cancelled", "Background job was cancelled"),
        );
      } else if (error instanceof TimeoutMarker) {
        controller.abort();
        await execution.catch(() => undefined);
        await this.#finish(
          jobId,
          BackgroundJobStatus.TIMED_OUT,
          toolError("background_timeout", "Background job timed out"),
        );
      } else {
        controller.abort();
        await execution.catch(() => undefined);
        await this.#finish(
          jobId,
          BackgroundJobStatus.FAILED,
          toolError("background_execution_error", "Background job execution failed"),
        );
      }
    } finally {
      timeoutHandle.cancel();
      this.#jobControls.delete(jobId);
    }
  }

  // 把 running 原子迁移为终态；只有 store 返回的胜出写入才发布事件。
  async #finish(
    jobId: string,
    status: Exclude<BackgroundJobStatus, "running">,
    result: ToolResult,
  ): Promise<void> {
    const job = await this.#store.finishRunning(jobId, status, result);
    if (job !== undefined) {
      await this.#publishEvent(job);
    }
  }

  // 校验终态后构造后台事件并发布到 inbox；事件发布失败会让本轮收束失败。
  async #publishEvent(job: BackgroundJob): Promise<void> {
    if (job.result === null || job.status === BackgroundJobStatus.RUNNING) {
      throw new BackgroundStorageError("terminal background job is missing its result");
    }
    const event = new BackgroundJobEvent({
      eventId: nextId(this.#eventIdGenerator, "runtime event"),
      jobId: job.id,
      sourceToolCallId: job.sourceToolCallId,
      toolName: job.toolName,
      status: job.status,
      result: job.result,
    });
    this.#inbox.publish(event);
  }
}

// Dispatcher 仅转交显式标记为 background_eligible 的工具，其余调用保持同步语义。
// 工具分派边界：仅将显式标记为 background_eligible 的调用提交给 Supervisor。
export class BackgroundDispatcher {
  // 原工具注册表；非后台调用仍由它直接执行。
  readonly #tools: ToolRegistry;
  // 后台作业的提交与事件来源。
  readonly #supervisor: JobSupervisor;

  // 绑定工具注册表与 Supervisor，Dispatcher 不持有额外状态。
  constructor(tools: ToolRegistry, supervisor: JobSupervisor) {
    this.#tools = tools;
    this.#supervisor = supervisor;
  }

  // 只有 background_eligible 且满足后台条件时才提交；其余调用保持原同步语义。
  async dispatch(prepared: PreparedToolCall, context: ToolContext): Promise<ToolResult> {
    const definition = prepared.definition;
    const argumentsValue = prepared.arguments;
    if (definition === undefined || argumentsValue === undefined || prepared.error !== undefined) {
      throw new Error("BackgroundDispatcher received an invalid prepared call");
    }
    if (definition.concurrency !== "background_eligible") {
      return await this.#tools.invoke(prepared, context);
    }
    if (!isBackgroundShellInput(argumentsValue)) {
      return toolError(
        "background_contract_error",
        "Background-eligible tool used an unsupported input model",
      );
    }
    if (!shouldRunInBackground(argumentsValue)) {
      return await this.#tools.invoke(prepared, context);
    }
    try {
      const jobId = await this.#supervisor.submit({
        sourceToolCallId: prepared.call.id,
        toolName: definition.name,
        operation: async () => await this.#tools.invoke(prepared, context),
      });
      // 占位结果是普通 ToolResult，立即闭合当前工具轮；真实结果稍后经 EventInbox 注入。
      return toolSuccess(
        JSON.stringify({
          job_id: jobId,
          status: BackgroundJobStatus.RUNNING,
          tool_name: definition.name,
        }),
      );
    } catch (error) {
      if (error instanceof BackgroundError) {
        return toolError(error.errorCode, error.message);
      }
      throw error;
    }
  }
}

// 显式布尔值优先；省略时才使用确定性关键词启发式，不预测任意命令耗时。
// 判断 shell 调用是否应后台执行：显式布尔值优先，缺省时才使用关键词启发式。
export function shouldRunInBackground(input: BackgroundShellInput): boolean {
  if (input.run_in_background !== undefined && input.run_in_background !== null) {
    return input.run_in_background;
  }
  const command = input.command.toLowerCase();
  return BACKGROUND_MARKERS.some((marker) => command.includes(marker));
}

// UUID 即文件名来源，外部字符串无法作为路径进入文件系统。
export function canonicalBackgroundId(value: string): string {
  if (typeof value !== "string" || !CANONICAL_UUID.test(value)) {
    throw new BackgroundStorageError("background id must be a canonical UUID");
  }
  return value;
}

// 后台 job/event 的规范 UUID；同时作为磁盘文件名和事件幂等 id，拒绝非规范输入。
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

// 状态值必须是 BackgroundJobStatus 中的字面量；未知字符串按非法输入处理。
function isBackgroundJobStatus(value: unknown): value is BackgroundJobStatus {
  return Object.values(BackgroundJobStatus).includes(value as BackgroundJobStatus);
}

// shell 输入校验只关心后台所需字段；多出的字段由工具 schema 在更早边界拒绝。
function isBackgroundShellInput(value: unknown): value is BackgroundShellInput {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const command = Reflect.get(value, "command");
  const background = Reflect.get(value, "run_in_background");
  return (
    typeof command === "string" &&
    (background === undefined || background === null || typeof background === "boolean")
  );
}

// 调用注入的生成器并强校验返回值，确保任何 id 都能安全用于文件系统和事件去重。
function nextId(generator: () => string, label: string): string {
  try {
    return canonicalBackgroundId(generator());
  } catch (error) {
    throw new BackgroundStorageError(`${label} id generator returned an invalid UUID`, {
      cause: error,
    });
  }
}

// 内部超时标记，用于区分超时与其他拒绝原因。
class TimeoutMarker extends Error {}

// 可取消的超时句柄；promise 触发后调用 cancel 可清理定时器。
interface TimeoutHandle {
  // 永不 resolve、只在截止时间 reject 的竞速 Promise。
  readonly promise: Promise<never>;
  // 作业先完成时清理定时器，防止无效回调保留事件循环。
  cancel(): void;
}

// 创建只 reject 一次的超时 promise，与后台执行/取消 promise 竞争。
function timeout(milliseconds: number): TimeoutHandle {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutMarker()), milliseconds);
  });
  return Object.freeze({
    promise,
    cancel: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
  });
}

// 为任意 promise 套上超时；超时后用给定错误拒绝，并在 finally 中清理定时器。
async function withTimeout<T>(promise: Promise<T>, milliseconds: number, error: Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(error), milliseconds);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

const backgroundJobIdSchema = z.string().regex(CANONICAL_UUID, "job_id must be a canonical UUID");
const backgroundJobIdInputSchema = z.object({ job_id: backgroundJobIdSchema }).strict();

// 后台工具与任务工具共用同一风格：schema 严格、领域错误转稳定 ToolResult、payload 使用磁盘字段名。
export function registerBackgroundJobTools(
  registry: ToolRegistry,
  supervisor: JobSupervisor,
): void {
  // 后台只暴露查询与取消两个工具；创建和运行由 shell Dispatcher 自动完成。
  registry.register(queryBackgroundJobDefinition(supervisor));
  registry.register(cancelBackgroundJobDefinition(supervisor));
}

// 查询工具定义：读取持久化状态与终态结果，不产生副作用。
function queryBackgroundJobDefinition(
  supervisor: JobSupervisor,
): ToolDefinition<z.infer<typeof backgroundJobIdInputSchema>> {
  return {
    name: "query_background_job",
    description: "Read the persisted status and result of one background job.",
    inputSchema: backgroundJobIdInputSchema,
    effect: "read",
    handler: async (input) => {
      try {
        const job = await supervisor.getJob(input.job_id);
        return toolSuccess(JSON.stringify(backgroundJobPayload(job)));
      } catch (error) {
        return backgroundJobToolError(error);
      }
    },
  };
}

// 取消工具定义：取消运行中作业并返回取消后的持久化状态。
function cancelBackgroundJobDefinition(
  supervisor: JobSupervisor,
): ToolDefinition<z.infer<typeof backgroundJobIdInputSchema>> {
  return {
    name: "cancel_background_job",
    description: "Cancel a running background job and persist its cancelled status.",
    inputSchema: backgroundJobIdInputSchema,
    effect: "write",
    handler: async (input) => {
      try {
        await supervisor.cancel(input.job_id);
        const job = await supervisor.getJob(input.job_id);
        return toolSuccess(JSON.stringify(backgroundJobPayload(job)));
      } catch (error) {
        return backgroundJobToolError(error);
      }
    },
  };
}

function backgroundJobToolError(error: unknown) {
  // 已知后台领域错误保留稳定错误码；未知异常继续向上抛，避免吞掉程序缺陷。
  if (error instanceof BackgroundError) {
    return toolError(error.errorCode, error.message);
  }
  throw error;
}

function backgroundJobPayload(job: BackgroundJob): Readonly<Record<string, unknown>> {
  // 模型可见字段与事件 payload 保持一致，result 统一为 content/error_code/is_error 三字段。
  return Object.freeze({
    job_id: job.id,
    status: job.status,
    tool_name: job.toolName,
    source_tool_call_id: job.sourceToolCallId,
    result:
      job.result === null
        ? null
        : {
            content: job.result.content,
            error_code: job.result.errorCode ?? null,
            is_error: job.result.isError,
          },
  });
}
