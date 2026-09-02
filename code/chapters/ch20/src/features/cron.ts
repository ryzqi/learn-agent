// Cron 运行时：以持久化五字段计划为输入，经 CronStore 排程、EventInbox 发布事件，并由 Supervisor 托管轮询 worker。
import { randomUUID } from "node:crypto";

import { CronExpressionParser } from "cron-parser";
import { z } from "zod";

import { isRuntimeEvent, type EventInbox, type RuntimeEvent } from "../core/events.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../core/tools.js";
import { toolError, toolSuccess } from "../core/tools.js";
import type { JobSupervisor } from "./background.js";

// Cron 领域错误基类；errorCode 是工具边界可稳定返回的机器可读分类。
export class CronError extends Error {
  // 不暴露底层异常类型，调用方只依赖稳定错误码。
  readonly errorCode: string;
  constructor(errorCode: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CronError";
    this.errorCode = errorCode;
  }
}
// 五字段表达式、时区或时间输入不满足调度契约。
export class CronExpressionError extends CronError {
  constructor(message: string) {
    super("cron_expression_error", message);
  }
}
// 快照损坏、持久化失败或锁异常统一映射为可预测的 CronStorageError。
export class CronStorageError extends CronError {
  constructor(message: string, options?: ErrorOptions) {
    super("cron_storage_error", message, options);
  }
}
// 查询或确认引用了不存在的 job/event 时显式失败，不伪装成空结果。
export class CronJobNotFoundError extends CronError {
  constructor(message: string) {
    super("cron_job_not_found", message);
  }
}
// 运行时关闭后仍调用 schedule/start/tick 时立即失败，避免关闭边界外继续调度。
export class CronClosedError extends CronError {
  constructor(message: string) {
    super("cron_closed", message);
  }
}

export interface CronJob {
  // 计划持久化下一触发槽位和上次槽位，避免重启或重复 tick 造成重复执行。
  readonly id: string;
  // 归一化后的五字段 Cron 表达式。
  readonly cron: string;
  // 到期事件启动独立 Agent 回合时使用的用户意图。
  readonly prompt: string;
  // IANA 时区名；槽位计算以此时区的本地日历为准。
  readonly timezone: string;
  // false 表示触发一次后删除计划。
  readonly recurring: boolean;
  // true 表示计划与 outbox 跨进程重启保留。
  readonly durable: boolean;
  // 创建计划的主体；事件回合继承该身份，而不是当前 CLI 用户。
  readonly identity: string;
  // 下一次允许生成事件的 UTC 瞬时。
  readonly nextRunAtUtc: Date;
  // 上一次已生成事件的槽位，用于审计和防重复。
  readonly lastSlotAtUtc: Date | null;
}

export interface CronEvent extends RuntimeEvent {
  // 判别字段让共享 EventInbox 区分 Cron 与后台作业终态。
  readonly kind: "cron";
  readonly eventId: string;
  readonly jobId: string;
  // 事件携带原计划身份，Loop 用它构造隔离的 ToolContext。
  readonly identity: string;
  readonly prompt: string;
  readonly timezone: string;
  readonly durable: boolean;
  // 实际触发的 UTC 槽位，而非 scheduler 扫描时间。
  readonly slotAtUtc: Date;
}

// 存储契约隔离“如何持久化”与“何时调度”：runtime 只依赖原子 tick、outbox 和 leader lease。
export interface CronStore {
  // 创建计划并计算严格晚于 nowUtc 的首个槽位。
  scheduleCron(input: {
    cron: string;
    prompt: string;
    timezone: string;
    recurring: boolean;
    durable: boolean;
    identity: string;
    nowUtc: Date;
  }): Promise<CronJob>;
  // 合并 durable 与 session-only 状态读取单个计划。
  getJob(id: string): Promise<CronJob>;
  // 返回两个生命周期的有序计划快照。
  listJobs(): Promise<readonly CronJob[]>;
  // 原子生成所有已到期事件并推进或删除对应计划。
  tick(nowUtc: Date, includeDurable?: boolean): Promise<readonly CronEvent[]>;
  // 读取尚未确认的 outbox，事件在 ack 前可重复被 scheduler 观察到。
  pendingEvents(includeDurable?: boolean): Promise<readonly CronEvent[]>;
  // 从 session 或 durable outbox 删除已消费事件。
  ackEvent(eventId: string): Promise<boolean>;
  // 非阻塞争夺 durable scheduler leader；失败实例仍可调度本地 session job。
  tryAcquireLeader(): Promise<boolean>;
  // 释放当前实例持有的 leader lease。
  releaseLeader(): Promise<void>;
}

// 可注入时钟确保测试和排程都使用同一个 UTC 事实源。
export interface CronClock {
  now(): Date;
}
// 可取消睡眠边界；关闭 runtime 时用于立即唤醒轮询 worker。
export interface CronSleeper {
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}
// schedule_cron 工具可见输入；身份和当前时间只能来自可信运行时上下文。
export interface ScheduleCronInput {
  readonly cron: string;
  readonly prompt: string;
  readonly timezone: string;
  readonly recurring: boolean;
  readonly durable: boolean;
}

// 工具输入只允许业务字段；id、identity 和 nextRunAtUtc 由运行时生成或从上下文取得。
const scheduleCronSchema = z
  .object({
    cron: z.string(),
    prompt: z.string(),
    timezone: z.string(),
    recurring: z.boolean(),
    durable: z.boolean(),
  })
  .strict();

export class CronRuntime {
  // CronRuntime 通过共享 Supervisor 托管 worker，并以 leader lease 防止多实例重复调度。
  readonly #store: CronStore;
  readonly #inbox: EventInbox;
  readonly #supervisor: JobSupervisor;
  readonly #clock: CronClock;
  readonly #sleeper: CronSleeper;
  readonly #pollMilliseconds: number;
  // 构造期固定的工具定义，保证动态 Prompt 中的 schema 与 handler 同源。
  readonly #toolDefinition: ToolDefinition<ScheduleCronInput>;
  // 已发布但尚未 ack 的事件 id，防止轮询把同一 outbox 记录重复推入 Inbox。
  readonly #queued = new Set<string>();
  // 只有 leader 实例可以推进 durable 计划。
  #leader = false;
  // 关闭后拒绝 schedule/start/tick。
  #closed = false;
  // scheduler 是 supervisor 下的单个受管 worker；失败会被暂存并在下一次公开操作时抛出。
  #worker: Promise<void> | undefined;
  // scheduler 的取消控制器独立保存，以便 close 先停止轮询再等待 worker。
  #schedulerAbort: AbortController | undefined;
  // worker 异常不会静默丢失，后续公开操作或 close 会重新抛出。
  #schedulerFailure: unknown | undefined;
  // 有待处理事件时通知 AgentRunner.runEvents 的可选回调。
  #wakeup: (() => Promise<void>) | undefined;
  // 串行化手动 tick 与 scheduler tick，避免相邻扫描交错推进状态。
  #tickTail: Promise<void> = Promise.resolve();

  // 绑定共享 store、Inbox、Supervisor 与可注入时间边界；构造器本身不启动 worker。
  constructor(options: {
    store: CronStore;
    inbox: EventInbox;
    supervisor: JobSupervisor;
    clock: CronClock;
    sleeper?: CronSleeper;
    pollMilliseconds?: number;
  }) {
    const pollMilliseconds = options.pollMilliseconds ?? 1_000;
    if (!Number.isFinite(pollMilliseconds) || pollMilliseconds <= 0) {
      throw new TypeError("pollMilliseconds must be positive");
    }
    this.#store = options.store;
    this.#inbox = options.inbox;
    this.#supervisor = options.supervisor;
    this.#clock = options.clock;
    this.#sleeper = options.sleeper ?? {
      sleep: async (milliseconds, signal) =>
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, milliseconds);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        }),
    };
    this.#pollMilliseconds = pollMilliseconds;
    this.#toolDefinition = {
      name: "schedule_cron",
      description: "Schedule a recurring or one-shot prompt with a five-field Cron expression.",
      inputSchema: scheduleCronSchema,
      effect: "write",
      handler: async (input, context) => await this.#schedule(input, context),
    };
  }

  // 暴露固定 schedule_cron 定义供组合根注册。
  get toolDefinition(): ToolDefinition<ScheduleCronInput> {
    return this.#toolDefinition;
  }
  // 暴露共享 Inbox 仅用于组合一致性校验。
  get eventInbox(): EventInbox {
    return this.#inbox;
  }
  // 暴露共享 Supervisor 仅用于组合一致性校验和资源所有权确认。
  get supervisor(): JobSupervisor {
    return this.#supervisor;
  }
  // 事件泵的 pending 状态沿用 Supervisor 中仍未收束的受管任务。
  get hasPendingWork(): boolean {
    return this.#supervisor.hasPendingWork;
  }
  // 首次消费事件前等待 Supervisor 完成持久化恢复。
  async ready(): Promise<void> {
    await this.#supervisor.ready();
  }
  // 非阻塞代理共享 Inbox 的 FIFO drain。
  drainEvents(limit?: number): readonly RuntimeEvent[] {
    return this.#inbox.drain(limit);
  }
  // 阻塞等待共享 Inbox 至少出现一条事件。
  async waitForEvents(limit?: number): Promise<readonly RuntimeEvent[]> {
    return await this.#inbox.wait(limit);
  }
  // 仅 CronEvent 需要删除持久 outbox；其他共享事件由各自运行时负责语义。
  async acknowledgeEvents(events: readonly RuntimeEvent[]): Promise<void> {
    if (!Array.isArray(events) || !events.every((event) => isRuntimeEvent(event))) {
      throw new TypeError("events must contain RuntimeEvent values");
    }
    for (const event of events) {
      if (isCronEvent(event)) {
        try {
          const acknowledged = await this.#store.ackEvent(event.eventId);
          if (!acknowledged) {
            throw new CronStorageError(`Cron event is no longer pending: ${event.eventId}`);
          }
          this.#queued.delete(event.eventId);
        } catch (error) {
          this.#queued.delete(event.eventId);
          throw error;
        }
      }
    }
  }
  // 绑定空闲唤醒回调；回调只请求运行事件回合，不绕过 Runner 的运行锁。
  bindWakeup(wakeup: () => Promise<void>): void {
    this.#wakeup = wakeup;
  }
  // 启动时把 scheduler 注册为 supervisor 的受管任务，并同步转发取消信号。
  start(): void {
    if (this.#closed) throw new CronClosedError("CronRuntime is closed");
    this.#throwSchedulerFailure();
    if (this.#worker !== undefined) return;
    const schedulerAbort = new AbortController();
    const worker = this.#supervisor.startManaged(async (supervisorSignal) => {
      supervisorSignal.addEventListener("abort", () => schedulerAbort.abort(), { once: true });
      await this.#runScheduler(schedulerAbort.signal);
    }, "cron-scheduler");
    this.#worker = worker;
    this.#schedulerAbort = schedulerAbort;
    void worker.then(
      () => {
        if (this.#worker === worker) {
          this.#worker = undefined;
          this.#schedulerAbort = undefined;
        }
      },
      (error: unknown) => {
        this.#schedulerFailure = error;
        if (this.#worker === worker) {
          this.#worker = undefined;
          this.#schedulerAbort = undefined;
        }
      },
    );
  }
  // 执行一次 leader 争夺、到期迁移、事件发布和可选 Runner 唤醒。
  async tick(): Promise<void> {
    // tickTail 串行化所有 tick，保证读取、排程和发布事件不会并发交错。
    if (this.#closed) throw new CronClosedError("CronRuntime is closed");
    this.#throwSchedulerFailure();
    const previous = this.#tickTail;
    let release!: () => void;
    this.#tickTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.#closed) throw new CronClosedError("CronRuntime is closed");
      await this.#ensureLeader();
      await this.#store.tick(this.#clock.now(), this.#leader);
      await this.#publishPending();
      if (
        this.#wakeup !== undefined &&
        (await this.#store.pendingEvents(this.#leader)).length > 0
      ) {
        await this.#wakeup();
      }
    } finally {
      release();
    }
  }
  // 关闭顺序为停止 scheduler、等待 tick、释放 leader，并聚合所有清理失败。
  async close(): Promise<void> {
    if (this.#closed && this.#worker === undefined && !this.#leader) {
      this.#throwSchedulerFailure();
      return;
    }
    this.#closed = true;
    const failures: unknown[] = [];
    const worker = this.#worker;
    this.#worker = undefined;
    const schedulerAbort = this.#schedulerAbort;
    this.#schedulerAbort = undefined;
    schedulerAbort?.abort();
    if (worker !== undefined) {
      try {
        await worker;
      } catch (error) {
        failures.push(error);
      }
    }
    await this.#tickTail;
    if (this.#leader) {
      try {
        await this.#store.releaseLeader();
        this.#leader = false;
      } catch (error) {
        failures.push(error);
      }
    }
    if (this.#schedulerFailure !== undefined && !failures.includes(this.#schedulerFailure)) {
      failures.push(this.#schedulerFailure);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "CronRuntime close failed");
  }
  async #runScheduler(signal: AbortSignal): Promise<void> {
    // 后台循环只负责“tick + 等待”，不直接执行 cron prompt，业务动作仍要回到 Agent Loop。
    try {
      while (!this.#closed && !signal.aborted) {
        await this.tick();
        await this.#sleeper.sleep(this.#pollMilliseconds, signal);
      }
    } finally {
      if (this.#leader) {
        await this.#store.releaseLeader();
        this.#leader = false;
      }
    }
  }
  async #ensureLeader(): Promise<void> {
    // leader lease 使用非阻塞尝试；拿不到锁时只为本 session 的 session-only job 生成事件。
    if (!this.#leader) this.#leader = await this.#store.tryAcquireLeader();
  }
  // 将 detached scheduler 的失败重新带回受控调用边界。
  #throwSchedulerFailure(): void {
    if (this.#schedulerFailure !== undefined) throw this.#schedulerFailure;
  }
  async #publishPending(): Promise<void> {
    // 已发布的 pending event 在内存中去重，避免 ack 前重复轮询导致重复投递。
    for (const event of await this.#store.pendingEvents(this.#leader)) {
      if (this.#queued.has(event.eventId)) continue;
      this.#inbox.publish(event);
      this.#queued.add(event.eventId);
    }
  }
  async #schedule(input: ScheduleCronInput, context: ToolContext): Promise<ToolResult> {
    // 工具边界把已建模的 CronError 转成可返回的 tool result，意外异常继续向上传播。
    if (this.#closed) {
      return toolError("cron_closed", "CronRuntime is closed");
    }
    try {
      const job = await this.#store.scheduleCron({
        ...input,
        identity: context.identity,
        nowUtc: this.#clock.now(),
      });
      return toolSuccess(JSON.stringify(serializeCronJob(job)));
    } catch (error) {
      if (error instanceof CronError) return toolError(error.errorCode, error.message);
      throw error;
    }
  }
}

function serializeCronJob(job: CronJob): Record<string, unknown> {
  // 工具返回值使用稳定 snake_case 字段，避免 Date 实例被环境相关方式序列化。
  return {
    id: job.id,
    cron: job.cron,
    prompt: job.prompt,
    timezone: job.timezone,
    recurring: job.recurring,
    durable: job.durable,
    identity: job.identity,
    next_run_at_utc: job.nextRunAtUtc.toISOString(),
    last_slot_at_utc: job.lastSlotAtUtc?.toISOString() ?? null,
  };
}

// 共享事件队列中的最小判别检查；完整字段在创建和持久化恢复边界校验。
export function isCronEvent(value: RuntimeEvent): value is CronEvent {
  return typeof value === "object" && value !== null && Reflect.get(value, "kind") === "cron";
}
// 构造不可变 CronEvent，并把 identity/eventId 映射为 Loop 的上下文身份与幂等键。
export function createCronEvent(
  options: Omit<CronEvent, "kind" | "toPayload" | "contextIdentity" | "idempotencyKey">,
): CronEvent {
  return Object.freeze({
    ...options,
    kind: "cron" as const,
    contextIdentity: options.identity,
    idempotencyKey: options.eventId,
    toPayload: () =>
      Object.freeze({
        event_id: options.eventId,
        job_id: options.jobId,
        kind: "cron",
        identity: options.identity,
        prompt: options.prompt,
        timezone: options.timezone,
        durable: options.durable,
        slot_at_utc: options.slotAtUtc.toISOString(),
      }),
  });
}
// 规范 UUID 同时用于状态键和 outbox 幂等标识，拒绝任何可形成路径片段的输入。
export function canonicalCronId(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
  )
    throw new CronStorageError("Cron id must be a canonical UUID");
  return value;
}
export function validateCronExpression(value: string): string {
  // 先做五段、步进和反向范围的显式检查，再交给 cron-parser，坏表达式不会进入持久化。
  if (typeof value !== "string" || !value.trim())
    throw new CronExpressionError("Cron expression must not be empty");
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.split(" ").length !== 5)
    throw new CronExpressionError("Cron expression must contain exactly five fields");
  for (const item of normalized.split(" ").flatMap((field) => field.split(","))) {
    const range = item.split("/", 1)[0]?.split("-");
    if (
      range?.length === 2 &&
      /^\d+$/u.test(range[0] ?? "") &&
      /^\d+$/u.test(range[1] ?? "") &&
      Number(range[0]) > Number(range[1])
    )
      throw new CronExpressionError("Invalid descending Cron range");
  }
  try {
    CronExpressionParser.parse(normalized, {
      currentDate: new Date("2000-01-01T00:00:00Z"),
      tz: "UTC",
    });
  } catch (_error) {
    throw new CronExpressionError(`Invalid Cron expression: ${value}`);
  }
  return normalized;
}
export function nextCronOccurrence(expression: string, timezone: string, afterUtc: Date): Date {
  // cron-parser 负责本地日历计算；候选 UTC instant 返回前还要经过 DST gap/fold 策略。
  const normalized = validateCronExpression(expression);
  const normalizedTimezone = validateCronTimezone(timezone);
  if (!(afterUtc instanceof Date) || !Number.isFinite(afterUtc.valueOf()))
    throw new CronExpressionError("Cron clock value must be a valid UTC Date");
  try {
    const iterator = CronExpressionParser.parse(normalized, {
      currentDate: afterUtc,
      tz: normalizedTimezone,
    });
    return adjustDstOccurrence(normalized, normalizedTimezone, afterUtc, iterator.next().toDate());
  } catch (error) {
    if (error instanceof CronExpressionError) throw error;
    throw new CronExpressionError(`Invalid Cron timezone or expression: ${timezone}`);
  }
}

// 使用 Intl 验证并归一化 IANA 时区名；不接受本地环境的隐式默认时区。
export function validateCronTimezone(value: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new CronExpressionError("Cron timezone must not be empty");
  const normalized = value.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date(0));
  } catch (_error) {
    throw new CronExpressionError(`Unknown Cron timezone: ${value}`);
  }
  return normalized;
}

// 以下 helper 把 UTC instant 投影到业务时区的本地字段，并按标准 DOM/DOW OR 语义做 DST 修正。
interface LocalCronParts {
  // UTC instant 投影到业务时区后的本地日历字段。
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: number;
}

interface CronFieldSet {
  // 五字段表达式解析后的离散集合，用于 DST 修正阶段重新判定候选。
  readonly minutes: CronField;
  readonly hours: CronField;
  readonly days: CronField;
  readonly months: CronField;
  readonly weekdays: CronField;
}

interface CronField {
  // 当前字段允许的数值集合。
  readonly values: ReadonlySet<number>;
  // 保留字段是否为通配符，以实现标准 DOM/DOW OR 语义。
  readonly wildcard: boolean;
}

function adjustDstOccurrence(
  expression: string,
  timezone: string,
  afterUtc: Date,
  candidate: Date,
): Date {
  // cron-parser 对 gap/fold 的候选时间不是唯一答案：gap 推进到首个有效时刻，
  // fold 让同一个本地钟面保留两个不同的 UTC instant。
  let fields: CronFieldSet;
  try {
    fields = parseCronFieldSets(expression);
  } catch {
    return candidate;
  }
  const candidateParts = localCronParts(candidate, timezone);
  if (!matchesCronFields(candidateParts, fields)) {
    let cursor = candidate;
    let currentOffset = timezoneOffsetMinutes(cursor, candidateParts);
    for (let index = 0; index < 360; index += 1) {
      const previous = new Date(cursor.valueOf() - 60_000);
      const previousParts = localCronParts(previous, timezone);
      const previousOffset = timezoneOffsetMinutes(previous, previousParts);
      if (currentOffset > previousOffset) return cursor;
      cursor = previous;
      currentOffset = previousOffset;
    }
  }
  if (afterUtc.getSeconds() === 0 && afterUtc.getMilliseconds() === 0) {
    const afterParts = localCronParts(afterUtc, timezone);
    if (matchesCronFields(afterParts, fields)) {
      const initialOffset = timezoneOffsetMinutes(afterUtc, afterParts);
      for (let index = 1; index <= 360; index += 1) {
        const repeated = new Date(afterUtc.valueOf() + index * 60_000);
        const repeatedParts = localCronParts(repeated, timezone);
        const repeatedOffset = timezoneOffsetMinutes(repeated, repeatedParts);
        if (
          repeatedOffset < initialOffset &&
          repeatedParts.year === afterParts.year &&
          repeatedParts.month === afterParts.month &&
          repeatedParts.day === afterParts.day &&
          repeatedParts.hour === afterParts.hour &&
          repeatedParts.minute === afterParts.minute &&
          matchesCronFields(repeatedParts, fields)
        )
          return repeated;
      }
    }
  }
  return candidate;
}

// 把已验证的五字段表达式展开为本地匹配集合。
function parseCronFieldSets(expression: string): CronFieldSet {
  const fields = expression.split(" ");
  return {
    minutes: parseCronField(fields[0] ?? "", 0, 59),
    hours: parseCronField(fields[1] ?? "", 0, 23),
    days: parseCronField(fields[2] ?? "", 1, 31),
    months: parseCronField(fields[3] ?? "", 1, 12),
    weekdays: parseCronField(fields[4] ?? "", 0, 7),
  };
}

// 展开逗号、范围和步进语法；周日 7 同时归一为 0。
function parseCronField(value: string, minimum: number, maximum: number): CronField {
  const result = new Set<number>();
  const wildcard = value.split(",").every((item) => item.split("/")[0] === "*");
  for (const item of value.split(",")) {
    const [base, stepText] = item.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step <= 0) throw new Error("invalid step");
    let start = minimum;
    let end = maximum;
    if (base !== "*") {
      const bounds = base?.split("-") ?? [];
      if (bounds.length === 1 && /^\d+$/u.test(bounds[0] ?? "")) {
        start = Number(bounds[0]);
        end = start;
      } else if (
        bounds.length === 2 &&
        /^\d+$/u.test(bounds[0] ?? "") &&
        /^\d+$/u.test(bounds[1] ?? "")
      ) {
        start = Number(bounds[0]);
        end = Number(bounds[1]);
      } else {
        throw new Error("invalid field");
      }
    }
    if (start < minimum || end > maximum || start > end) throw new Error("field out of range");
    for (let current = start; current <= end; current += step) result.add(current);
  }
  if (minimum === 0 && maximum === 7 && result.has(7)) result.add(0);
  return { values: result, wildcard };
}

// 通过 Intl 把 UTC 瞬时转换为指定时区的稳定数字字段。
function localCronParts(value: Date, timezone: string): LocalCronParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  }).formatToParts(value);
  const numeric = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const weekdayNumber = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekday ?? ""];
  if (weekdayNumber === undefined) throw new Error("invalid weekday");
  return {
    year: numeric("year"),
    month: numeric("month"),
    day: numeric("day"),
    hour: numeric("hour"),
    minute: numeric("minute"),
    weekday: weekdayNumber,
  };
}

// 根据同一瞬时的 UTC 值与本地钟面计算时区偏移，用于识别 DST 跳变。
function timezoneOffsetMinutes(value: Date, parts: LocalCronParts): number {
  return (
    (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - value.valueOf()) /
    60_000
  );
}

// 按 Cron 标准处理 day-of-month 与 day-of-week：两者都受限时使用 OR。
function matchesCronFields(parts: LocalCronParts, fields: CronFieldSet): boolean {
  const dayMatches = fields.days.values.has(parts.day);
  const weekdayMatches = fields.weekdays.values.has(parts.weekday);
  const dayOfMonthAndWeekdayMatch =
    fields.days.wildcard && fields.weekdays.wildcard
      ? true
      : fields.days.wildcard
        ? weekdayMatches
        : fields.weekdays.wildcard
          ? dayMatches
          : dayMatches || weekdayMatches;
  return (
    fields.minutes.values.has(parts.minute) &&
    fields.hours.values.has(parts.hour) &&
    fields.months.values.has(parts.month) &&
    dayOfMonthAndWeekdayMatch
  );
}

// 生产环境默认 UUID 生成器；测试可在 store 边界注入确定值。
export function randomCronId(): string {
  return randomUUID();
}
