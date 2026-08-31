// scripts/probe-ch20.mts —— 第 20 章探测脚本（临时用，跑完可删）
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { JsonBackgroundJobStore } from "../chapters/ch20/src/adapters/background-json.js";
import { JsonCronStore } from "../chapters/ch20/src/adapters/cron-json.js";
import { SubprocessGitRunner } from "../chapters/ch20/src/adapters/git.js";
import { FileMailboxStore } from "../chapters/ch20/src/adapters/mailbox-json.js";
import { AjvMcpSchemaValidator } from "../chapters/ch20/src/adapters/mcp-schema.js";
import { JsonProtocolStore } from "../chapters/ch20/src/adapters/protocol-json.js";
import { SqliteTaskStore } from "../chapters/ch20/src/adapters/task-sqlite.js";
import { buildAgent } from "../chapters/ch20/src/bootstrap.js";
import type { BuildDependencies } from "../chapters/ch20/src/bootstrap.js";
import { EventInbox } from "../chapters/ch20/src/core/events.js";
import type { RuntimeEvent } from "../chapters/ch20/src/core/events.js";
import { HookRegistry } from "../chapters/ch20/src/core/hooks.js";
import { AgentRunner } from "../chapters/ch20/src/core/loop.js";
import type { AsyncResource } from "../chapters/ch20/src/core/loop.js";
import {
  assistantMessage,
  toolCall,
  toolMessage,
  userMessage,
  validateToolPairing,
} from "../chapters/ch20/src/core/messages.js";
import type { ChatMessage } from "../chapters/ch20/src/core/messages.js";
import type { ModelClient, ModelReply, ModelRequest } from "../chapters/ch20/src/core/model.js";
import {
  ModelOverloadedError,
  ModelPromptTooLongError,
  ModelRateLimitError,
} from "../chapters/ch20/src/core/model.js";
import { PermissionDecision } from "../chapters/ch20/src/core/permissions.js";
import type {
  ApprovalProvider,
  AuditSink,
  PermissionRequest,
} from "../chapters/ch20/src/core/permissions.js";
import { P19, P20, profileForChapter } from "../chapters/ch20/src/core/profiles.js";
import type { Capability, ChapterProfile } from "../chapters/ch20/src/core/profiles.js";
import { ToolRegistry, toolSuccess } from "../chapters/ch20/src/core/tools.js";
import type { ToolResult } from "../chapters/ch20/src/core/tools.js";
import { JobSupervisor } from "../chapters/ch20/src/features/background.js";
import { CronRuntime } from "../chapters/ch20/src/features/cron.js";
import {
  DynamicPromptProvider,
  DynamicPromptRenderer,
} from "../chapters/ch20/src/features/prompting.js";
import {
  McpCallResult,
  McpPublishedTool,
  McpRuntime,
  McpServerSpec,
  McpToolPolicy,
} from "../chapters/ch20/src/features/mcp-tools.js";
import type {
  McpConnection,
  McpConnectionFactory,
} from "../chapters/ch20/src/features/mcp-tools.js";
import { ProtocolRuntime } from "../chapters/ch20/src/features/protocol.js";
import { RecoveryConfig } from "../chapters/ch20/src/features/recovery.js";
import { TeammateRuntime } from "../chapters/ch20/src/features/teammates.js";
import { WorkStealingRuntime } from "../chapters/ch20/src/features/work-stealing.js";
import type { WorkStealingSleeper } from "../chapters/ch20/src/features/work-stealing.js";
import { WorktreeRuntime } from "../chapters/ch20/src/features/worktrees.js";

const EXPERIMENT = process.argv[2] ?? "all";

function section(name: string): boolean {
  const selected = EXPERIMENT === "all" || EXPERIMENT === name;
  if (selected) console.log(`\n===== ${name} =====`);
  return selected;
}

function step(index: number, text: string): void {
  console.log(`[${index}] ${text}`);
}

async function withTempDir<T>(operation: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "probe-ch20-"));
  try {
    return await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// 只捕获错误消息，实验里要打印的就是这句话本身。
async function reason(operation: () => unknown): Promise<string> {
  try {
    await operation();
    return "(没有报错)";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function statusLine(prompt: string): string {
  return /^## runtime_status\n(.+)$/mu.exec(prompt)?.[1] ?? "(没有 runtime_status)";
}
class AllowApproval implements ApprovalProvider {
  readonly asked: string[] = [];

  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    this.asked.push(request.prepared.definition?.name ?? "(unknown)");
    return new PermissionDecision("allow", "probe approval", "probe");
  }
}

class NoopAudit implements AuditSink {
  readonly records: string[] = [];

  async record(request: PermissionRequest, decision: PermissionDecision): Promise<void> {
    this.records.push(`${request.prepared.definition?.name ?? "?"} -> ${decision.behavior}`);
  }
}

class ImmediateSleeper implements WorkStealingSleeper {
  async sleep(_seconds: number, _wakeup: AbortSignal): Promise<void> {}
}

class ProbeClock {
  #value = new Date("2026-08-01T00:00:00.000Z");

  now(): Date {
    return new Date(this.#value);
  }
}

// 假 MCP 连接：不启动子进程，只申报一个 lookup 工具，便于离线观察动态工具边界。
class FakeConnection implements McpConnection {
  closeCalls = 0;
  callCalls = 0;
  #resolveFailure: (() => void) | undefined;
  readonly #failure: Promise<void>;

  constructor() {
    this.#failure = new Promise<void>((resolve) => {
      this.#resolveFailure = resolve;
    });
  }

  async listTools(): Promise<readonly McpPublishedTool[]> {
    return [
      new McpPublishedTool({
        name: "lookup",
        description: "Look up local fixture data.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      }),
    ];
  }

  async callTool(): Promise<McpCallResult> {
    this.callCalls += 1;
    return new McpCallResult({ content: [], structuredContent: {}, isError: false });
  }

  async waitForFailure(): Promise<void> {
    await this.#failure;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.#resolveFailure?.();
    this.#resolveFailure = undefined;
  }
}
class FakeFactory implements McpConnectionFactory {
  constructor(readonly connection: FakeConnection) {}

  async open(): Promise<McpConnection> {
    return this.connection;
  }
}

function createRuntime(connection: FakeConnection): McpRuntime {
  return new McpRuntime({
    servers: [
      new McpServerSpec({
        alias: "fake",
        command: "unused",
        args: [],
        toolPolicies: [new McpToolPolicy({ remoteName: "lookup", effect: "read" })],
        startupTimeoutSeconds: 1,
        toolTimeoutSeconds: 1,
      }),
    ],
    connectionFactory: new FakeFactory(connection),
    schemaValidator: new AjvMcpSchemaValidator(),
  });
}

interface Harness {
  readonly dependencies: BuildDependencies;
  readonly supervisor: JobSupervisor;
  readonly cron: CronRuntime;
  readonly teammates: TeammateRuntime;
  readonly protocol: ProtocolRuntime;
  readonly worktrees: WorktreeRuntime;
  readonly workStealing: WorkStealingRuntime;
  readonly inbox: EventInbox;
  readonly approval: AllowApproval;
}

// 与 tests/ch20-full-harness.test.ts 的 createDependencies 同构：一个 EventInbox 贯穿三个运行时。
function createHarness(root: string, model: ModelClient, mcpRuntime: McpRuntime): Harness {
  const inbox = new EventInbox();
  const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
  const cron = new CronRuntime({
    store: new JsonCronStore(root),
    inbox,
    supervisor,
    clock: new ProbeClock(),
  });
  const teammates = new TeammateRuntime({
    store: new FileMailboxStore(root),
    inbox,
    supervisor,
    cronRuntime: cron,
  });
  const protocol = new ProtocolRuntime({ store: new JsonProtocolStore(root), team: teammates });
  const taskStore = new SqliteTaskStore(root);
  const worktrees = new WorktreeRuntime({
    workspace: root,
    store: taskStore,
    gitRunner: new SubprocessGitRunner(),
  });
  const workStealing = new WorkStealingRuntime({
    store: taskStore,
    claimService: worktrees,
    sleeper: new ImmediateSleeper(),
    maxIdlePolls: 1,
  });
  const approval = new AllowApproval();
  return {
    dependencies: {
      model,
      workspace: root,
      hooks: new HookRegistry(),
      approvalProvider: approval,
      auditSink: new NoopAudit(),
      recoveryConfig: new RecoveryConfig({ primaryModel: "primary", fallbackModel: "fallback" }),
      backgroundSupervisor: supervisor,
      cronRuntime: cron,
      teammateRuntime: teammates,
      protocolRuntime: protocol,
      workStealingRuntime: workStealing,
      worktreeRuntime: worktrees,
      mcpRuntime,
    },
    supervisor,
    cron,
    teammates,
    protocol,
    worktrees,
    workStealing,
    inbox,
    approval,
  };
}
function systemPromptOf(request: ModelRequest): string {
  const message = request.messages.find((candidate) => candidate.role === "system");
  return message === undefined ? "" : message.content;
}

function toolNamesOf(request: ModelRequest): readonly string[] {
  return request.tools.map((tool) => tool.function.name);
}

// 主回合模型：第一条回复里同时 connect_mcp 和调用刚连上的工具，用来观察快照边界。
class HarnessProbeModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  #started = false;

  async complete(request: ModelRequest): Promise<ModelReply> {
    validateToolPairing(request.messages);
    this.requests.push(request);
    if (request.tools.length === 0) {
      return { message: assistantMessage("[]"), finishReason: "stop" };
    }
    if (!this.#started) {
      this.#started = true;
      return {
        message: assistantMessage(null, [
          toolCall("probe-connect", "connect_mcp", '{"alias":"fake"}'),
          toolCall("probe-mcp", "mcp__fake__lookup", '{"query":"needle"}'),
          toolCall(
            "probe-escape",
            "write_file",
            JSON.stringify({ path: "../outside.txt", content: "must not be written" }),
          ),
        ]),
        finishReason: "tool_calls",
      };
    }
    return { message: assistantMessage("probe done"), finishReason: "stop" };
  }
}

// 恢复实验模型：按顺序抛 429 / 529×3 / length / prompt-too-long，最后成功。
class RecoveryProbeModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  readonly failures: string[] = [];
  #attempts = 0;

  async complete(request: ModelRequest): Promise<ModelReply> {
    validateToolPairing(request.messages);
    this.requests.push(request);
    if (request.tools.length === 0) {
      return {
        message: assistantMessage(
          JSON.stringify({
            current_goal: "验证恢复矩阵",
            key_findings: ["prompt-too-long 触发了一次压缩"],
            files_read_or_changed: [],
            remaining_work: [],
            user_constraints: [],
          }),
        ),
        finishReason: "stop",
      };
    }
    const attempt = this.#attempts;
    this.#attempts += 1;
    if (attempt === 0) {
      this.failures.push("429");
      throw new ModelRateLimitError("rate limited", { retryAfter: "0" });
    }
    if (attempt < 4) {
      this.failures.push("529");
      throw new ModelOverloadedError("overloaded");
    }
    if (attempt === 4) {
      this.failures.push("length");
      return { message: assistantMessage("discarded"), finishReason: "length" };
    }
    if (attempt === 5) {
      this.failures.push("prompt-too-long");
      throw new ModelPromptTooLongError("prompt too long");
    }
    return { message: assistantMessage("recovered"), finishReason: "stop" };
  }
}
// ---------- 实验 1（profile）：累计能力模型与固定档案身份 ----------
if (section("profile")) {
  const counts: string[] = [];
  for (let chapter = 1; chapter <= 20; chapter += 1) {
    counts.push(`P${String(chapter).padStart(2, "0")}=${profileForChapter(chapter).capabilities.size}`);
  }
  step(1, `每章累计能力数：${counts.join(" ")}`);
  const p19 = new Set<Capability>(P19.capabilities);
  const added = [...P20.capabilities].filter((capability) => !p19.has(capability));
  const removed = [...P19.capabilities].filter((capability) => !P20.capabilities.has(capability));
  step(2, `P20 相对 P19 新增：[${added.join(", ")}]，移除：[${removed.join(", ")}]`);
  step(3, `P20 是否仍持有 P19 的每一项能力：${String(removed.length === 0)}`);
  step(4, `profileForChapter(20) === P20：${String(profileForChapter(20) === P20)}`);
  step(5, `profileForChapter(21) → ${await reason(() => profileForChapter(21))}`);
  step(6, `profileForChapter(19.5) → ${await reason(() => profileForChapter(19.5))}`);
  // 自造同形对象即使能力集完全一致，也过不了组合根的身份门禁。
  const lookalike: ChapterProfile = { chapter: 20, capabilities: new Set(P20.capabilities) };
  const model: ModelClient = {
    async complete() {
      return { message: assistantMessage("unused"), finishReason: "stop" as const };
    },
  };
  step(
    7,
    `自造 {chapter:20, capabilities:...} 传给 buildAgent → ${await reason(() =>
      buildAgent(lookalike, { model, workspace: process.cwd() }),
    )}`,
  );
}

// ---------- 实验 2（wiring）：组合根按对象身份校验共享依赖 ----------
if (section("wiring")) {
  await withTempDir(async (root) => {
    const model = new HarnessProbeModel();
    const connection = new FakeConnection();
    const mcpRuntime = createRuntime(connection);
    const harness = createHarness(root, model, mcpRuntime);
    const other = createHarness(root, model, createRuntime(new FakeConnection()));

    step(1, `完整依赖 → ${await reason(() => buildAgent(P20, harness.dependencies))}`);
    step(
      2,
      `换掉 cronRuntime（另一个 supervisor/inbox）→ ${await reason(() =>
        buildAgent(P20, { ...harness.dependencies, cronRuntime: other.cron }),
      )}`,
    );
    step(
      3,
      `只换掉 protocolRuntime → ${await reason(() =>
        buildAgent(P20, { ...harness.dependencies, protocolRuntime: other.protocol }),
      )}`,
    );
    step(
      4,
      `换掉 teammateRuntime + protocolRuntime（两者互相匹配）→ ${await reason(() =>
        buildAgent(P20, {
          ...harness.dependencies,
          teammateRuntime: other.teammates,
          protocolRuntime: other.protocol,
        }),
      )}`,
    );
    step(
      5,
      `换掉 worktreeRuntime（不是 claimService）→ ${await reason(() =>
        buildAgent(P20, { ...harness.dependencies, worktreeRuntime: other.worktrees }),
      )}`,
    );
    const { mcpRuntime: _dropped, ...withoutMcp } = harness.dependencies;
    step(6, `删掉 mcpRuntime → ${await reason(() => buildAgent(P20, withoutMcp))}`);
    step(
      7,
      `把 P20 依赖交给 P18 → ${await reason(() =>
        buildAgent(profileForChapter(18), harness.dependencies),
      )}`,
    );
  });
}
// ---------- 实验 3（status）：runtime_status 固定在最后一段，且参与缓存键 ----------
if (section("status")) {
  const renderer = new DynamicPromptRenderer();
  const registry = new ToolRegistry();
  registry.register({
    name: "read_file",
    description: "read a file",
    inputSchema: z.object({ path: z.string() }),
    effect: "read",
    handler: () => toolSuccess("ok"),
  });
  const base = {
    identity: "lead",
    tools: registry,
    workspace: process.cwd(),
    context: { chapter: 20 },
  } as const;

  const withoutStatus = renderer.render(base);
  step(1, `不传 status 时的段落顺序：${withoutStatus.match(/^## .+$/gmu)?.join(" ") ?? "(无)"}`);
  const first = renderer.render({
    ...base,
    status: { mcp_connections: [], pending_work: false },
  });
  step(2, `传 status 后的段落顺序：${first.match(/^## .+$/gmu)?.join(" ") ?? "(无)"}`);
  step(3, `最后一段内容：${statusLine(first)}`);
  const hitsBefore = renderer.cacheHits;
  renderer.render({ ...base, status: { mcp_connections: [], pending_work: false } });
  step(4, `同样的 status 再渲染一次，cacheHits ${hitsBefore} → ${renderer.cacheHits}`);
  const second = renderer.render({
    ...base,
    status: { mcp_connections: ["fake"], pending_work: true },
  });
  step(5, `只改 status 后 cacheHits 仍是 ${renderer.cacheHits}，说明缓存被判定失效`);
  step(6, `新的最后一段：${statusLine(second)}`);
  const before = first.slice(0, first.indexOf("## runtime_status"));
  const after = second.slice(0, second.indexOf("## runtime_status"));
  step(7, `runtime_status 之前的正文是否完全没变：${String(before === after)}`);
  step(
    8,
    `statusProvider 传非函数 → ${await reason(
      () =>
        new DynamicPromptProvider({
          renderer,
          ...base,
          statusProvider: {} as unknown as () => never,
        }),
    )}`,
  );
}
// ---------- 实验 4（harness）：一次真实回合里四条边界同时生效 ----------
if (section("harness")) {
  await withTempDir(async (root) => {
    const model = new HarnessProbeModel();
    const connection = new FakeConnection();
    const mcpRuntime = createRuntime(connection);
    const harness = createHarness(root, model, mcpRuntime);
    const runner = buildAgent(P20, harness.dependencies);
    try {
      const result = await runner.run("连上 fake 然后查一次");
      const main = model.requests.filter((request) => request.tools.length > 0);
      const firstRequest = main[0];
      const secondRequest = main[1];
      if (firstRequest === undefined || secondRequest === undefined) {
        throw new Error("probe expected two main requests");
      }
      step(1, `模型主请求次数：${main.length}`);
      step(2, `第 1 次请求的工具数：${toolNamesOf(firstRequest).length}`);
      step(
        3,
        `第 1 次请求里有 mcp__fake__lookup 吗：${String(
          toolNamesOf(firstRequest).includes("mcp__fake__lookup"),
        )}`,
      );
      step(4, `第 2 次请求的工具数：${toolNamesOf(secondRequest).length}`);
      step(
        5,
        `第 2 次请求里有 mcp__fake__lookup 吗：${String(
          toolNamesOf(secondRequest).includes("mcp__fake__lookup"),
        )}`,
      );
      step(6, `第 1 次请求的 runtime_status：${statusLine(systemPromptOf(firstRequest))}`);
      step(7, `第 2 次请求的 runtime_status：${statusLine(systemPromptOf(secondRequest))}`);
      step(8, "同一条回复里三个工具调用各自的结果：");
      for (const message of result.history) {
        if (message.role !== "tool") continue;
        console.log(`      ${message.toolCallId} → ${message.content.split("\n")[0] ?? ""}`);
      }
      step(9, `远程 callTool 实际被调用次数：${connection.callCalls}`);
      step(10, `审批被问到的工具：[${harness.approval.asked.join(", ")}]（deny 强于 ask，越界写不进审批）`);
      step(11, `最终回答：${result.finalText}`);
    } finally {
      await runner.close();
      step(12, `close() 之后 McpRuntime.isClosed=${String(mcpRuntime.isClosed)}`);
    }
  });
}

// ---------- 实验 5（snapshot）：快照是不可变副本，不跟随活注册表变化 ----------
if (section("snapshot")) {
  const registry = new ToolRegistry();
  const definition = {
    name: "alpha",
    description: "first tool",
    inputSchema: z.object({}),
    effect: "read" as const,
    handler: () => toolSuccess("alpha"),
  };
  registry.register(definition);
  const snapshot = registry.snapshot();
  step(1, `活注册表 v${registry.version}：[${registry.names.join(", ")}]`);
  step(2, `快照 v${snapshot.version}：[${snapshot.names.join(", ")}]`);
  registry.register({
    name: "beta",
    description: "second tool",
    inputSchema: z.object({}),
    effect: "read" as const,
    handler: () => toolSuccess("beta"),
  });
  step(3, `活注册表新增后 v${registry.version}：[${registry.names.join(", ")}]`);
  step(4, `同一个快照仍是 v${snapshot.version}：[${snapshot.names.join(", ")}]`);
  step(
    5,
    `在快照上 prepare("beta") → ${
      snapshot.prepare(toolCall("x", "beta", "{}")).error?.content ?? "(成功)"
    }`,
  );
  step(
    6,
    `试图往快照里注册 → ${await reason(() =>
      snapshot.register({
        name: "gamma",
        description: "third",
        inputSchema: z.object({}),
        effect: "read" as const,
        handler: () => toolSuccess("gamma"),
      }),
    )}`,
  );
  step(
    7,
    `按名字（不是对象身份）撤销 → ${await reason(() =>
      registry.unregisterMany([{ ...definition }]),
    )}`,
  );
  step(8, `按对象身份撤销 → ${await reason(() => registry.unregisterMany([definition]))}`);
  step(9, `撤销后活注册表 v${registry.version}：[${registry.names.join(", ")}]`);
}
// ---------- 实验 6（pairing）：一个 tool call 必须且只能有一个同 id 的结果 ----------
if (section("pairing")) {
  const call = toolCall("call-1", "read_file", '{"path":"a.txt"}');
  const cases: readonly (readonly [string, readonly ChatMessage[]])[] = [
    ["调用后紧跟同 id 结果", [assistantMessage(null, [call]), toolMessage("ok", "call-1")]],
    ["调用后没有结果就收尾", [assistantMessage(null, [call])]],
    ["调用后跟了别的 id", [assistantMessage(null, [call]), toolMessage("ok", "call-2")]],
    ["调用后先插一条 user", [assistantMessage(null, [call]), userMessage("插话"), toolMessage("ok", "call-1")]],
    ["没有调用却有结果", [toolMessage("ok", "call-1")]],
    [
      "同一 id 回填两次",
      [assistantMessage(null, [call]), toolMessage("ok", "call-1"), toolMessage("ok", "call-1")],
    ],
  ];
  let index = 1;
  for (const [label, history] of cases) {
    step(index, `${label} → ${await reason(() => validateToolPairing(history))}`);
    index += 1;
  }
}

// ---------- 实验 7（close）：逆序关闭、失败聚合、幂等与并发拒绝 ----------
if (section("close")) {
  const trace: string[] = [];
  class TracedResource implements AsyncResource {
    constructor(
      readonly name: string,
      readonly fails = false,
    ) {}

    async close(): Promise<void> {
      trace.push(this.name);
      if (this.fails) throw new Error(`${this.name} close failed`);
    }
  }

  const model: ModelClient = {
    async complete() {
      return { message: assistantMessage("ok"), finishReason: "stop" as const };
    },
  };
  const okRunner = new AgentRunner({
    model,
    tools: new ToolRegistry(),
    systemPrompt: "system",
    workspace: process.cwd(),
    resources: [
      new TracedResource("supervisor"),
      new TracedResource("cron"),
      new TracedResource("teammate"),
      new TracedResource("mcp"),
    ],
  });
  await okRunner.close();
  step(1, `注册顺序 supervisor → cron → teammate → mcp，关闭顺序：${trace.join(" → ")}`);
  await okRunner.close();
  step(2, `再 close() 一次，关闭轨迹仍是 ${trace.length} 条：${String(trace.length === 4)}`);
  step(3, `关闭后还能 run() 吗 → ${await reason(() => okRunner.run("再来一次"))}`);

  trace.length = 0;
  const failRunner = new AgentRunner({
    model,
    tools: new ToolRegistry(),
    systemPrompt: "system",
    workspace: process.cwd(),
    resources: [
      new TracedResource("supervisor", true),
      new TracedResource("cron"),
      new TracedResource("teammate", true),
      new TracedResource("mcp"),
    ],
  });
  try {
    await failRunner.close();
  } catch (error) {
    const aggregate = error as AggregateError;
    step(4, `两个资源关闭失败 → ${aggregate.name}: ${aggregate.message}`);
    step(
      5,
      `聚合里的每一条：[${aggregate.errors.map((item: unknown) => (item as Error).message).join(" | ")}]`,
    );
  }
  step(6, `失败也走完了全部资源：${trace.join(" → ")}`);
}
// ---------- 实验 8（events）：同一事件重复投递只进历史一次 ----------
if (section("events")) {
  class ProbeEvent implements RuntimeEvent {
    constructor(readonly eventId: string) {}

    toPayload(): Readonly<Record<string, unknown>> {
      return Object.freeze({ kind: "background_job", prompt: `事件 ${this.eventId} 完成` });
    }
  }

  const acked: string[] = [];
  const queue: RuntimeEvent[] = [new ProbeEvent("evt-1"), new ProbeEvent("evt-1")];
  const pump = {
    get hasPendingWork(): boolean {
      return queue.length > 0;
    },
    drainEvents(limit = queue.length): readonly RuntimeEvent[] {
      return Object.freeze(queue.splice(0, limit));
    },
    async waitForEvents(limit = queue.length): Promise<readonly RuntimeEvent[]> {
      return this.drainEvents(limit);
    },
    acknowledgeEvents(events: readonly RuntimeEvent[]): void {
      for (const event of events) acked.push(event.eventId);
    },
  };

  const model: ModelClient = {
    async complete(request: ModelRequest) {
      return {
        message: assistantMessage(`收到 ${request.messages.filter((m) => m.role === "user").length} 条 user 消息`),
        finishReason: "stop" as const,
      };
    },
  };
  const runner = new AgentRunner({
    model,
    tools: new ToolRegistry(),
    systemPrompt: "system",
    workspace: process.cwd(),
    eventPump: pump,
  });
  try {
    const first = await runner.runEvents();
    step(1, `第 1 次 runEvents() → ${first?.finalText ?? "(没有事件)"}`);
    const second = await runner.runEvents();
    step(2, `第 2 次 runEvents()（同一个 eventId 再投一遍）→ ${second?.finalText ?? "undefined"}`);
    const events = runner.history.filter(
      (message) => message.role === "user" && message.content.includes("runtime_event"),
    );
    step(3, `canonical history 里的 runtime_event 条数：${events.length}`);
    step(4, `ack 记录：[${acked.join(", ")}]`);
  } finally {
    await runner.close();
  }
}

// ---------- 实验 9（recovery）：恢复尝试不进 canonical history ----------
if (section("recovery")) {
  await withTempDir(async (root) => {
    const model = new RecoveryProbeModel();
    const connection = new FakeConnection();
    const harness = createHarness(root, model, createRuntime(connection));
    const runner = buildAgent(P20, {
      ...harness.dependencies,
      recoveryConfig: new RecoveryConfig({
        primaryModel: "primary",
        fallbackModel: "fallback",
        baseDelaySeconds: 0.001,
        maxDelaySeconds: 0.001,
        jitterRatio: 0,
      }),
    });
    try {
      const result = await runner.run("验证恢复边界");
      const main = model.requests.filter((request) => request.tools.length > 0);
      step(1, `模型侧真实失败序列：[${model.failures.join(", ")}]`);
      step(2, `主请求次数：${main.length}`);
      step(3, `每次请求用的模型：[${main.map((request) => request.model).join(", ")}]`);
      step(4, `每次请求的 maxTokens：[${main.map((request) => request.maxTokens).join(", ")}]`);
      step(5, `最终回答：${result.finalText}`);
      step(6, `canonical history 长度：${result.history.length}`);
      step(
        7,
        `history 内容：${result.history
          .map((message) => `${message.role}:${message.content ?? "(null)"}`)
          .join(" | ")}`,
      );
      step(
        8,
        `history 里有 finish_reason=length 那条被丢弃的回复吗：${String(
          result.history.some((message) => message.content?.includes("discarded") === true),
        )}`,
      );
    } finally {
      await runner.close();
    }
  });
}
// ---------- 实验 10（surface）：Lead 工具面与子执行者裁剪 ----------
if (section("surface")) {
  await withTempDir(async (root) => {
    const model = new HarnessProbeModel();
    const connection = new FakeConnection();
    const mcpRuntime = createRuntime(connection);
    const harness = createHarness(root, model, mcpRuntime);
    const runner = buildAgent(P20, harness.dependencies);
    try {
      await runner.run("列一下工具");
      const main = model.requests.filter((request) => request.tools.length > 0);
      const first = main[0];
      if (first === undefined) throw new Error("probe expected one main request");
      const names = toolNamesOf(first);
      step(1, `Lead 工具面共 ${names.length} 个：`);
      for (const [index, name] of names.entries()) {
        console.log(`      ${String(index + 1).padStart(2, " ")}. ${name}`);
      }
      step(2, `Lead 有 request_shutdown / review_plan：${String(
        names.includes("request_shutdown") && names.includes("review_plan"),
      )}`);
      step(3, `Lead 有 submit_plan：${String(names.includes("submit_plan"))}`);
      step(4, `Lead 有 connect_mcp / disconnect_mcp：${String(
        names.includes("connect_mcp") && names.includes("disconnect_mcp"),
      )}`);
      const teammateSurface = ["shell", "read_file", "write_file"];
      step(5, `队友被裁剪到的内置工具：[${teammateSurface.join(", ")}]，再加 send_message / submit_plan 与租约任务工具`);
      step(6, `队友能看到 connect_mcp 吗：${String(teammateSurface.includes("connect_mcp"))}`);
    } finally {
      await runner.close();
    }
  });
}
