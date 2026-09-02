import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, test, vi } from "vitest";

import { SubprocessGitRunner } from "../src/adapters/git.js";
import { JsonBackgroundJobStore } from "../src/adapters/background-json.js";
import { JsonCronStore } from "../src/adapters/cron-json.js";
import { FileMailboxStore } from "../src/adapters/mailbox-json.js";
import { AjvMcpSchemaValidator } from "../src/adapters/mcp-schema.js";
import { JsonProtocolStore } from "../src/adapters/protocol-json.js";
import { SqliteTaskStore, type SqliteTaskStoreOptions } from "../src/adapters/task-sqlite.js";
import { buildAgent, type BuildDependencies } from "../src/bootstrap.js";
import type { CommandRunner } from "../src/core/commands.js";
import {
  assistantMessage,
  toolCall,
  userMessage,
  validateToolPairing,
} from "../src/core/messages.js";
import { EventInbox } from "../src/core/events.js";
import type { ModelClient, ModelReply, ModelRequest } from "../src/core/model.js";
import {
  ModelOverloadedError,
  ModelPromptTooLongError,
  ModelRateLimitError,
} from "../src/core/model.js";
import type { ApprovalProvider, AuditSink, PermissionRequest } from "../src/core/permissions.js";
import { PermissionDecision } from "../src/core/permissions.js";
import { HookRegistry, HookResult } from "../src/core/hooks.js";
import { P20 } from "../src/core/profiles.js";
import { TaskStatus } from "../src/features/tasks.js";
import { JobSupervisor } from "../src/features/background.js";
import { CronRuntime } from "../src/features/cron.js";
import {
  McpCallResult,
  McpPublishedTool,
  McpRuntime,
  McpServerSpec,
  McpToolPolicy,
} from "../src/features/mcp-tools.js";
import type { McpConnection, McpConnectionFactory } from "../src/features/mcp-tools.js";
import { MemoryRecord, MemoryStore, MemoryType } from "../src/features/memory.js";
import { ProtocolRequestStatus, ProtocolRuntime } from "../src/features/protocol.js";
import { RecoveryConfig } from "../src/features/recovery.js";
import { TeammateRuntime } from "../src/features/teammates.js";
import { WorkStealingRuntime, type WorkStealingSleeper } from "../src/features/work-stealing.js";
import { WorktreeRuntime, WorktreeStatus } from "../src/features/worktrees.js";

const execFileAsync = promisify(execFile);
const LEAD_TOOLS = [
  "shell",
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "todo_write",
  "task",
  "load_skill",
  "create_task",
  "get_task",
  "list_tasks",
  "claim_task",
  "complete_task",
  "query_background_job",
  "cancel_background_job",
  "create_worktree",
  "keep_worktree",
  "remove_worktree",
  "schedule_cron",
  "spawn_teammate",
  "send_message",
  "request_shutdown",
  "review_plan",
  "connect_mcp",
  "disconnect_mcp",
] as const;
const TASK_A = "00000000-0000-4000-8000-000000000201";
const TASK_B = "00000000-0000-4000-8000-000000000202";
const TOKEN_B = "00000000-0000-4000-8000-000000000212";
const LARGE_MCP_TEXT = "结果".repeat(20_000);

class HarnessClock {
  #value: Date;

  constructor(value = new Date("2026-08-01T00:00:00.000Z")) {
    this.#value = new Date(value);
  }

  now(): Date {
    return new Date(this.#value);
  }

  advance(milliseconds: number): void {
    this.#value = new Date(this.#value.getTime() + milliseconds);
  }
}

class ImmediateSleeper implements WorkStealingSleeper {
  async sleep(seconds: number, wakeup: AbortSignal): Promise<void> {
    void seconds;
    void wakeup;
  }
}

function sequence(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) {
      throw new Error("test ID sequence was exhausted");
    }
    index += 1;
    return value;
  };
}

class AllowApproval implements ApprovalProvider {
  async decide(_request: PermissionRequest): Promise<PermissionDecision> {
    return new PermissionDecision("allow", "test approval", "test");
  }
}

class NoopAudit implements AuditSink {
  async record(_request: PermissionRequest, _decision: PermissionDecision): Promise<void> {}
}

class HarnessModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  #started = false;

  async complete(request: ModelRequest): Promise<ModelReply> {
    validateToolPairing(request.messages);
    this.requests.push(request);
    if (request.tools.length === 0) {
      const system = requireSystemPrompt(request);
      return {
        message: assistantMessage(system.includes("选择与查询") ? '["full-harness"]' : "[]"),
        finishReason: "stop",
      };
    }
    if (!this.#started) {
      this.#started = true;
      return {
        message: assistantMessage(null, [
          toolCall("connect-p20", "connect_mcp", '{"alias":"fake"}'),
          toolCall(
            "escape-p20",
            "write_file",
            JSON.stringify({ path: "../outside.txt", content: "must not be written" }),
          ),
        ]),
        finishReason: "tool_calls",
      };
    }
    return { message: assistantMessage("P20 full harness verified"), finishReason: "stop" };
  }
}

class DagModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  #mainPhase = 0;

  async complete(request: ModelRequest): Promise<ModelReply> {
    validateToolPairing(request.messages);
    this.requests.push(request);
    if (request.tools.length === 0) {
      const system = requireSystemPrompt(request);
      if (system.includes("请将当前 Agent 历史压缩")) {
        return {
          message: assistantMessage(
            JSON.stringify({
              current_goal: "验证完整 Harness",
              key_findings: ["大 MCP 结果已落盘"],
              files_read_or_changed: [],
              remaining_work: [],
              user_constraints: [],
            }),
          ),
          finishReason: "stop",
        };
      }
      if (system.includes("选择与查询")) {
        return { message: assistantMessage('["full-harness"]'), finishReason: "stop" };
      }
      return { message: assistantMessage("[]"), finishReason: "stop" };
    }

    const phase = this.#mainPhase;
    this.#mainPhase += 1;
    if (phase === 0) {
      return {
        message: assistantMessage(null, [
          toolCall("connect-dag", "connect_mcp", '{"alias":"fake"}'),
          toolCall(
            "escape-dag",
            "write_file",
            JSON.stringify({ path: "../outside.txt", content: "must not be written" }),
          ),
        ]),
        finishReason: "tool_calls",
      };
    }
    if (phase === 1) {
      return {
        message: assistantMessage(null, [
          toolCall("large-dag", "mcp__fake__lookup", '{"query":"needle"}'),
          toolCall(
            "todo-dag",
            "todo_write",
            JSON.stringify({
              todos: [
                { content: "完成 A", status: "in_progress" },
                { content: "等待 A 后完成 B", status: "pending" },
              ],
            }),
          ),
          toolCall(
            "task-a-dag",
            "create_task",
            JSON.stringify({ subject: "A", description: "先完成 A" }),
          ),
          toolCall(
            "task-b-dag",
            "create_task",
            JSON.stringify({ subject: "B", description: "依赖 A", blocked_by: [TASK_A] }),
          ),
        ]),
        finishReason: "tool_calls",
      };
    }
    if (phase === 2) {
      return {
        message: assistantMessage(null, [toolCall("list-dag", "list_tasks", "{}")]),
        finishReason: "tool_calls",
      };
    }
    return { message: assistantMessage("DAG is ready"), finishReason: "stop" };
  }
}

class GateModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  #protocol: ProtocolRuntime | undefined;
  #leadPhase = 0;
  #planSubmitted = false;

  attachProtocol(protocol: ProtocolRuntime): void {
    this.#protocol = protocol;
  }

  async complete(request: ModelRequest): Promise<ModelReply> {
    validateToolPairing(request.messages);
    this.requests.push(request);
    if (request.tools.length === 0) {
      return { message: assistantMessage("[]"), finishReason: "stop" };
    }

    const names = toolNames(request);
    if (!names.includes("task")) {
      const autoClaim = request.messages.find(
        (message) =>
          message.role === "user" &&
          message.content !== null &&
          message.content.startsWith("<auto-claimed-task>"),
      );
      if (autoClaim !== undefined && autoClaim.content !== null) {
        const payload = /<auto-claimed-task>\n(.+)\n<\/auto-claimed-task>/su.exec(
          autoClaim.content,
        )?.[1];
        if (payload === undefined) {
          throw new Error("auto claim prompt did not contain a payload");
        }
        const claim = JSON.parse(payload) as { readonly claim_token: string };
        return {
          message: assistantMessage(null, [
            toolCall(
              "worker-write",
              "write_file",
              JSON.stringify({ path: "worker.txt", content: "worker" }),
            ),
            toolCall(
              "worker-complete",
              "complete_task",
              JSON.stringify({ task_id: TASK_B, claim_token: claim.claim_token }),
            ),
          ]),
          finishReason: "tool_calls",
        };
      }
      if (
        request.messages.some(
          (message) => message.role === "user" && message.content.includes("Plan approved"),
        )
      ) {
        return { message: assistantMessage("plan acknowledged"), finishReason: "stop" };
      }
      if (!this.#planSubmitted) {
        this.#planSubmitted = true;
        return {
          message: assistantMessage(null, [
            toolCall("worker-plan", "submit_plan", '{"plan":"完成 B 并写入绑定 Worktree"}'),
            toolCall(
              "blocked-write",
              "write_file",
              JSON.stringify({ path: "before-approval.txt", content: "must not be written" }),
            ),
          ]),
          finishReason: "tool_calls",
        };
      }
      return { message: assistantMessage("plan submitted"), finishReason: "stop" };
    }

    const phase = this.#leadPhase;
    this.#leadPhase += 1;
    if (phase === 0) {
      return {
        message: assistantMessage(null, [
          toolCall(
            "spawn-worker",
            "spawn_teammate",
            JSON.stringify({ name: "worker", role: "implementer", prompt: "submit the plan" }),
          ),
        ]),
        finishReason: "tool_calls",
      };
    }
    if (phase === 1) {
      return { message: assistantMessage("teammate started"), finishReason: "stop" };
    }
    if (phase === 2) {
      const protocol = this.#protocol;
      if (protocol === undefined) {
        throw new Error("GateModel protocol was not attached");
      }
      const pending = (await protocol.store.listRequests()).find(
        (requestItem) => requestItem.status === ProtocolRequestStatus.Pending,
      );
      if (pending === undefined) {
        throw new Error("teammate plan was not submitted");
      }
      return {
        message: assistantMessage(null, [
          toolCall(
            "approve-worker",
            "review_plan",
            JSON.stringify({ request_id: pending.id, approve: true, feedback: "Proceed" }),
          ),
        ]),
        finishReason: "tool_calls",
      };
    }
    return { message: assistantMessage("plan approved"), finishReason: "stop" };
  }
}

class BlockingCommandRunner implements CommandRunner {
  readonly commands: string[] = [];
  #release!: () => void;
  readonly #released = new Promise<void>((resolveRelease) => {
    this.#release = resolveRelease;
  });

  release(): void {
    this.#release();
  }

  async run(command: string, _cwd: string) {
    this.commands.push(command);
    await this.#released;
    return { output: "background complete", exitCode: 0, timedOut: false, truncated: false };
  }
}

class BackgroundCronModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  readonly eventKinds: string[] = [];
  readonly #releaseBackground: () => void;
  #phase = 0;

  constructor(releaseBackground: () => void) {
    this.#releaseBackground = releaseBackground;
  }

  async complete(request: ModelRequest): Promise<ModelReply> {
    validateToolPairing(request.messages);
    this.requests.push(request);
    if (request.tools.length === 0) {
      return { message: assistantMessage("[]"), finishReason: "stop" };
    }
    const runtimeMessage = [...request.messages]
      .reverse()
      .find(
        (message) =>
          message.role === "user" &&
          message.content !== null &&
          message.content.includes('"runtime_event"'),
      );
    if (runtimeMessage !== undefined && runtimeMessage.content !== null) {
      if (runtimeMessage.content.includes('"kind":"background_job"')) {
        this.eventKinds.push("background_job");
        return { message: assistantMessage("background event handled"), finishReason: "stop" };
      }
      if (runtimeMessage.content.includes('"kind":"cron"')) {
        this.eventKinds.push("cron");
        return { message: assistantMessage("cron event handled"), finishReason: "stop" };
      }
    }
    if (this.#phase === 0) {
      this.#phase += 1;
      return {
        message: assistantMessage(null, [
          toolCall(
            "background-call",
            "shell",
            JSON.stringify({ command: "npm install", run_in_background: true }),
          ),
        ]),
        finishReason: "tool_calls",
      };
    }
    const latest = request.messages.at(-1);
    if (latest?.role !== "tool" || !latest.content.includes('"status":"running"')) {
      throw new Error("background placeholder was not returned to the model");
    }
    this.#phase += 1;
    this.#releaseBackground();
    return { message: assistantMessage("background placeholder"), finishReason: "stop" };
  }
}

class RecoveryHarnessModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  readonly failures: string[] = [];
  #mainAttempts = 0;

  async complete(request: ModelRequest): Promise<ModelReply> {
    validateToolPairing(request.messages);
    this.requests.push(request);
    if (request.tools.length === 0) {
      return {
        message: assistantMessage(
          JSON.stringify({
            current_goal: "完成恢复测试",
            key_findings: ["prompt-too-long 已触发一次摘要"],
            files_read_or_changed: [],
            remaining_work: [],
            user_constraints: [],
          }),
        ),
        finishReason: "stop",
      };
    }
    const attempt = this.#mainAttempts;
    this.#mainAttempts += 1;
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
    if (attempt === 6) {
      return { message: assistantMessage("recovered"), finishReason: "stop" };
    }
    throw new Error("recovery model received an unexpected request");
  }
}

class StopHarnessModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  #mainCalls = 0;

  async complete(request: ModelRequest): Promise<ModelReply> {
    validateToolPairing(request.messages);
    this.requests.push(request);
    if (request.tools.length === 0) {
      return { message: assistantMessage("[]"), finishReason: "stop" };
    }
    this.#mainCalls += 1;
    return {
      message: assistantMessage(this.#mainCalls === 1 ? "intermediate" : "final"),
      finishReason: "stop",
    };
  }
}

class FakeConnection implements McpConnection {
  closeCalls = 0;
  callCalls = 0;
  readonly #largeOutput: boolean;
  #resolveFailure: (() => void) | undefined;
  readonly #failure: Promise<void>;

  constructor(largeOutput = false) {
    this.#largeOutput = largeOutput;
    this.#failure = new Promise<void>((resolveFailure) => {
      this.#resolveFailure = resolveFailure;
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

  async callTool(
    _name: string,
    _argumentsValue: Readonly<Record<string, unknown>>,
    _options: { readonly timeoutSeconds: number; readonly signal?: AbortSignal },
  ): Promise<McpCallResult> {
    this.callCalls += 1;
    return new McpCallResult({
      content: this.#largeOutput ? [{ type: "text", text: LARGE_MCP_TEXT }] : [],
      structuredContent: {},
      isError: false,
    });
  }

  async waitForFailure(): Promise<void> {
    await this.#failure;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    const resolveFailure = this.#resolveFailure;
    if (resolveFailure === undefined) {
      throw new Error("fake MCP failure waiter was not initialized");
    }
    resolveFailure();
    this.#resolveFailure = undefined;
  }
}

class FakeFactory implements McpConnectionFactory {
  readonly connection: FakeConnection;

  constructor(connection: FakeConnection) {
    this.connection = connection;
  }

  async open(_spec: McpServerSpec, _signal?: AbortSignal): Promise<McpConnection> {
    return this.connection;
  }
}

async function git(root: string, ...argumentsValue: string[]): Promise<void> {
  await execFileAsync("git", ["--no-pager", ...argumentsValue], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch20-"));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Agent Tutorial Tests");
  await git(root, "config", "user.email", "agent-tutorial@example.test");
  await writeFile(join(root, ".gitignore"), ".agent_tutorial/\n", "utf8");
  await git(root, "add", ".gitignore");
  await git(root, "commit", "-m", "initial");
  return root;
}

async function writeContextSources(root: string): Promise<void> {
  const skill = join(root, "skills", "harness-skill");
  await mkdir(skill, { recursive: true });
  await writeFile(
    join(skill, "SKILL.md"),
    '---\nname: "harness-skill"\ndescription: "完整 Harness Skill"\n---\n# Private body\n',
    "utf8",
  );
  await new MemoryStore({ workspace: root, idGenerator: () => "seed" }).add(
    new MemoryRecord({
      name: "full-harness",
      description: "完整组合规则",
      kind: MemoryType.PROJECT,
      body: "P20 必须复用单一 AgentRunner。",
    }),
  );
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

function traceClose(resource: { close(): Promise<void> }, name: string, trace: string[]): void {
  const close = resource.close.bind(resource);
  vi.spyOn(resource, "close").mockImplementation(async () => {
    trace.push(name);
    await close();
  });
}

async function createDependencies(
  root: string,
  model: ModelClient,
  mcpRuntime: McpRuntime,
  hooks: HookRegistry,
  options: {
    readonly commandRunner?: CommandRunner;
    readonly taskStore?: SqliteTaskStoreOptions;
  } = {},
): Promise<{
  dependencies: BuildDependencies;
  supervisor: JobSupervisor;
  cron: CronRuntime;
  teammates: TeammateRuntime;
  protocol: ProtocolRuntime;
  taskStore: SqliteTaskStore;
  worktrees: WorktreeRuntime;
  workStealing: WorkStealingRuntime;
  clock: HarnessClock;
  cronStore: JsonCronStore;
}> {
  const inbox = new EventInbox();
  const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
  const clock = new HarnessClock();
  const cronStore = new JsonCronStore(root);
  const cron = new CronRuntime({
    store: cronStore,
    inbox,
    supervisor,
    clock,
  });
  const teammates = new TeammateRuntime({
    store: new FileMailboxStore(root),
    inbox,
    supervisor,
    cronRuntime: cron,
  });
  const protocol = new ProtocolRuntime({ store: new JsonProtocolStore(root), team: teammates });
  const taskStore = new SqliteTaskStore(root, options.taskStore);
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
  return {
    dependencies: {
      model,
      workspace: root,
      ...(options.commandRunner === undefined ? {} : { commandRunner: options.commandRunner }),
      hooks,
      approvalProvider: new AllowApproval(),
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
    taskStore,
    worktrees,
    workStealing,
    clock,
    cronStore,
  };
}

function toolNames(request: ModelRequest): readonly string[] {
  return request.tools.map((tool) => tool.function.name);
}

function requireSystemPrompt(request: ModelRequest): string {
  const message = request.messages.find((candidate) => candidate.role === "system");
  if (message === undefined) {
    throw new Error("expected a system prompt in the model request");
  }
  return message.content;
}

function requireRequest(request: ModelRequest | undefined): ModelRequest {
  if (request === undefined) {
    throw new Error("expected a model request");
  }
  return request;
}

async function hasPath(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("chapter 20 full harness", () => {
  test("combines dynamic context, MCP policy, pairing, and resource ownership", async () => {
    const root = await createRepository();
    const outside = resolve(dirname(root), "outside.txt");
    await rm(outside, { force: true });
    await writeContextSources(root);
    const connection = new FakeConnection();
    const runtime = createRuntime(connection);
    const hooks = new HookRegistry();
    const hookEvents: string[] = [];
    hooks.register("UserPromptSubmit", () => {
      hookEvents.push("UserPromptSubmit");
      return new HookResult();
    });
    const model = new HarnessModel();
    const { dependencies, supervisor, cron, teammates } = await createDependencies(
      root,
      model,
      runtime,
      hooks,
    );
    const runner = buildAgent(P20, dependencies);
    const closeOrder: string[] = [];
    traceClose(runtime, "mcp", closeOrder);
    traceClose(teammates, "teammate", closeOrder);
    traceClose(cron, "cron", closeOrder);
    traceClose(supervisor, "supervisor", closeOrder);

    try {
      const result = await runner.run("验证完整 Harness");
      const mainRequests = model.requests.filter((request) => request.tools.length > 0);
      const initialRequest = requireRequest(mainRequests[0]);
      const nextRequest = requireRequest(mainRequests[1]);
      const initialPrompt = requireSystemPrompt(initialRequest);
      const nextPrompt = requireSystemPrompt(nextRequest);
      const toolMessages = result.history.filter((message) => message.role === "tool");

      expect(result.finalText).toBe("P20 full harness verified");
      expect(runtime.connectedAliases).toEqual(["fake"]);
      expect(mainRequests).toHaveLength(2);
      expect(toolNames(initialRequest)).toEqual(LEAD_TOOLS);
      expect(toolNames(initialRequest)).not.toContain("mcp__fake__lookup");
      expect(toolNames(nextRequest)).toContain("mcp__fake__lookup");
      expect(initialPrompt).toContain("harness-skill");
      expect(initialPrompt).toContain("完整 Harness Skill");
      expect(initialPrompt).toContain("P20 必须复用单一 AgentRunner。");
      expect(initialPrompt).toContain(
        '## runtime_status\n{"mcp_connections":[],"pending_work":false}',
      );
      expect(initialPrompt).not.toContain("mcp__fake__lookup");
      expect(nextPrompt).toContain("mcp__fake__lookup");
      expect(nextPrompt).toContain(
        '## runtime_status\n{"mcp_connections":["fake"],"pending_work":false}',
      );
      expect(await hasPath(outside)).toBe(false);
      expect(toolMessages.map((message) => message.toolCallId)).toEqual([
        "connect-p20",
        "escape-p20",
      ]);
      expect(toolMessages[1]?.content).toContain("permission_denied");
      validateToolPairing(result.history);
      expect(hookEvents).toEqual(["UserPromptSubmit"]);
      expect(connection.callCalls).toBe(0);
    } finally {
      await runner.close();
      expect(runtime.isClosed).toBe(true);
      expect(connection.closeCalls).toBe(1);
      expect(supervisor.activeCount).toBe(0);
      expect(cron.hasPendingWork).toBe(false);
      expect(teammates.hasPendingWork).toBe(false);
      expect(closeOrder).toEqual(["mcp", "teammate", "cron", "supervisor"]);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("persists a large MCP result while retaining TODO and DAG state", async () => {
    const root = await createRepository();
    const outside = resolve(dirname(root), "outside.txt");
    await rm(outside, { force: true });
    await writeContextSources(root);
    const connection = new FakeConnection(true);
    const runtime = createRuntime(connection);
    const model = new DagModel();
    const hooks = new HookRegistry();
    const harness = await createDependencies(root, model, runtime, hooks, {
      taskStore: {
        idGenerator: sequence([TASK_A, TASK_B]),
      },
    });
    const runner = buildAgent(P20, harness.dependencies);

    try {
      const result = await runner.run("验证 DAG 和大结果");
      const mainRequests = model.requests.filter((request) => request.tools.length > 0);
      const largeResult = result.history.find(
        (message) => message.role === "tool" && message.toolCallId === "large-dag",
      );
      const todoResult = result.history.find(
        (message) => message.role === "tool" && message.toolCallId === "todo-dag",
      );
      if (largeResult === undefined || largeResult.role !== "tool") {
        throw new Error("large MCP result was not preserved");
      }
      if (todoResult === undefined || todoResult.role !== "tool") {
        throw new Error("TODO result was not preserved");
      }
      const artifactRelativePath = /^path: (.+)$/mu.exec(largeResult.content)?.[1];
      if (artifactRelativePath === undefined) {
        throw new Error("large MCP result did not include an artifact path");
      }
      const artifact = await readFile(join(root, ...artifactRelativePath.split("/")), "utf8");
      const todoPayload = JSON.parse(todoResult.content) as {
        readonly todos: readonly { readonly content: string; readonly status: string }[];
      };
      const tasks = await harness.taskStore.listTasks();
      const taskB = await harness.taskStore.getTask(TASK_B);

      expect(result.finalText).toBe("DAG is ready");
      expect(mainRequests).toHaveLength(4);
      expect(toolNames(requireRequest(mainRequests[1]))).toContain("mcp__fake__lookup");
      expect(artifact).toContain(LARGE_MCP_TEXT);
      expect(await readdir(join(root, ".agent_tutorial", "artifacts"))).toHaveLength(1);
      expect(todoPayload.todos).toEqual([
        { content: "完成 A", status: "in_progress" },
        { content: "等待 A 后完成 B", status: "pending" },
      ]);
      expect(tasks.map((task) => task.id)).toEqual([TASK_A, TASK_B]);
      expect(taskB.status).toBe(TaskStatus.PENDING);
      expect(taskB.blockedBy).toEqual([TASK_A]);
      expect(connection.callCalls).toBe(1);
      validateToolPairing(result.history);
    } finally {
      await runner.close();
      expect(runtime.isClosed).toBe(true);
      expect(connection.closeCalls).toBe(1);
      expect(harness.supervisor.activeCount).toBe(0);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("delivers background and cron completions as typed events exactly once", async () => {
    const root = await createRepository();
    const connection = new FakeConnection();
    const runtime = createRuntime(connection);
    const commandRunner = new BlockingCommandRunner();
    const model = new BackgroundCronModel(commandRunner.release.bind(commandRunner));
    const harness = await createDependencies(root, model, runtime, new HookRegistry(), {
      commandRunner,
    });
    const runner = buildAgent(P20, harness.dependencies);

    try {
      const result = await runner.run("启动后台任务");
      expect(result.finalText).toBe("background event handled");
      expect(commandRunner.commands).toEqual(["npm install"]);
      const placeholder = result.history.find(
        (message) => message.role === "tool" && message.toolCallId === "background-call",
      );
      expect(placeholder?.content).toContain('"status":"running"');

      const scheduledAt = harness.clock.now();
      const job = await harness.cronStore.scheduleCron({
        cron: "* * * * *",
        prompt: "检查 CI",
        timezone: "UTC",
        recurring: false,
        durable: true,
        identity: "cron-owner",
        nowUtc: scheduledAt,
      });
      harness.clock.advance(job.nextRunAtUtc.getTime() - scheduledAt.getTime());
      await harness.cron.tick();
      const cronResult = await runner.runEvents();
      expect(cronResult?.finalText).toBe("cron event handled");
      await expect(runner.runEvents()).resolves.toBeUndefined();

      expect(model.eventKinds).toEqual(["background_job", "cron"]);
      expect(await harness.cronStore.pendingEvents()).toEqual([]);
      expect((await new JsonBackgroundJobStore(root).listJobs())[0]?.status).toBe("completed");
      validateToolPairing(result.history);
      validateToolPairing(cronResult?.history ?? []);
    } finally {
      commandRunner.release();
      await runner.close();
      expect(runtime.isClosed).toBe(true);
      expect(connection.closeCalls).toBe(0);
      expect(harness.supervisor.activeCount).toBe(0);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps recovery attempts outside canonical history and compacts prompt-too-long once", async () => {
    const root = await createRepository();
    const connection = new FakeConnection();
    const runtime = createRuntime(connection);
    const model = new RecoveryHarnessModel();
    const harness = await createDependencies(root, model, runtime, new HookRegistry());
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
      const mainRequests = model.requests.filter((request) => request.tools.length > 0);
      const summaryRequests = model.requests.filter((request) => request.tools.length === 0);
      const transcriptFiles = (await readdir(join(root, ".agent_tutorial", "artifacts"))).filter(
        (file) => file.startsWith("transcript-") && file.endsWith(".jsonl"),
      );

      expect(result.finalText).toBe("recovered");
      expect(model.failures).toEqual(["429", "529", "529", "529", "length", "prompt-too-long"]);
      expect(mainRequests).toHaveLength(7);
      expect(mainRequests.map((request) => request.model)).toEqual([
        "primary",
        "primary",
        "primary",
        "primary",
        "fallback",
        "fallback",
        "fallback",
      ]);
      expect(mainRequests.map((request) => request.maxTokens)).toEqual([
        8_000, 8_000, 8_000, 8_000, 8_000, 64_000, 64_000,
      ]);
      expect(summaryRequests).toHaveLength(2);
      expect(
        summaryRequests.filter((request) =>
          request.messages.some(
            (message) => message.role === "system" && message.content.includes("历史压缩"),
          ),
        ),
      ).toHaveLength(1);
      expect(
        result.history.some(
          (message) =>
            message.role === "assistant" &&
            message.content !== null &&
            message.content.includes("prompt-too-long 已触发一次摘要"),
        ),
      ).toBe(false);
      expect(transcriptFiles).toHaveLength(1);
      expect(result.history).toEqual([userMessage("验证恢复边界"), assistantMessage("recovered")]);
      expect(result.history.some((message) => message.content?.includes("discarded"))).toBe(false);
      validateToolPairing(result.history);
    } finally {
      await runner.close();
      expect(runtime.isClosed).toBe(true);
      expect(connection.closeCalls).toBe(0);
      expect(harness.supervisor.activeCount).toBe(0);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("forces one Stop continuation and then accepts the final model answer", async () => {
    const root = await createRepository();
    const connection = new FakeConnection();
    const runtime = createRuntime(connection);
    const model = new StopHarnessModel();
    const hooks = new HookRegistry();
    let stopCalls = 0;
    hooks.register("Stop", (context) => {
      stopCalls += 1;
      if (stopCalls === 1) {
        return new HookResult({ forceContinue: userMessage("继续完成最终回答") });
      }
      expect(context.stopHookActive).toBe(true);
      return new HookResult();
    });
    const harness = await createDependencies(root, model, runtime, hooks);
    const runner = buildAgent(P20, harness.dependencies);

    try {
      const result = await runner.run("验证 Stop");
      const assistantTexts = result.history
        .filter((message) => message.role === "assistant")
        .map((message) => message.content);

      expect(result.finalText).toBe("final");
      expect(stopCalls).toBe(2);
      expect(model.requests.filter((request) => request.tools.length > 0)).toHaveLength(2);
      expect(assistantTexts).toEqual(["intermediate", "final"]);
      expect(result.history).toContainEqual(userMessage("继续完成最终回答"));
      validateToolPairing(result.history);
    } finally {
      await runner.close();
      expect(runtime.isClosed).toBe(true);
      expect(connection.closeCalls).toBe(0);
      expect(harness.supervisor.activeCount).toBe(0);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rebuilds task, memory, cron outbox, and worktree state without replaying an acked event", async () => {
    const root = await createRepository();
    await writeContextSources(root);
    const connection = new FakeConnection();
    const runtime = createRuntime(connection);
    const model = new StopHarnessModel();
    const harness = await createDependencies(root, model, runtime, new HookRegistry(), {
      taskStore: { idGenerator: () => TASK_A },
    });
    const task = await harness.taskStore.createTask({
      subject: "rebuild task",
      description: "restore the durable harness state",
    });
    const binding = await harness.worktrees.createWorktree({
      taskId: task.id,
      name: "rebuild",
      integrationRef: "refs/heads/main",
    });
    const runner = buildAgent(P20, harness.dependencies);
    let rebuiltRunner: ReturnType<typeof buildAgent> | undefined;

    try {
      const firstNow = harness.clock.now();
      const firstJob = await harness.cronStore.scheduleCron({
        cron: "* * * * *",
        prompt: "消费一次",
        timezone: "UTC",
        recurring: false,
        durable: true,
        identity: "cron-owner",
        nowUtc: firstNow,
      });
      harness.clock.advance(firstJob.nextRunAtUtc.getTime() - firstNow.getTime());
      await harness.cron.tick();
      const consumed = await harness.cronStore.pendingEvents();
      expect(consumed).toHaveLength(1);
      const consumedEventId = consumed[0]?.eventId;
      if (consumedEventId === undefined) {
        throw new Error("consumed cron event was not persisted");
      }
      await expect(runner.runEvents()).resolves.toMatchObject({ finalText: "intermediate" });
      expect(await harness.cronStore.pendingEvents()).toEqual([]);

      const secondNow = harness.clock.now();
      const pendingJob = await harness.cronStore.scheduleCron({
        cron: "* * * * *",
        prompt: "等待重建",
        timezone: "UTC",
        recurring: false,
        durable: true,
        identity: "cron-owner",
        nowUtc: secondNow,
      });
      harness.clock.advance(pendingJob.nextRunAtUtc.getTime() - secondNow.getTime());
      await harness.cron.tick();
      const pending = await harness.cronStore.pendingEvents();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.eventId).not.toBe(consumedEventId);
      const pendingEventId = pending[0]?.eventId;
      if (pendingEventId === undefined) {
        throw new Error("pending cron event was not persisted");
      }

      await runner.close();
      const rebuilt = await createDependencies(
        root,
        new StopHarnessModel(),
        createRuntime(new FakeConnection()),
        new HookRegistry(),
      );
      rebuiltRunner = buildAgent(P20, rebuilt.dependencies);
      const records = await new MemoryStore({ workspace: root }).records();
      const restoredEvents = await rebuilt.cronStore.pendingEvents();

      expect(await rebuilt.taskStore.getTask(TASK_A)).toMatchObject({
        id: TASK_A,
        subject: "rebuild task",
        status: TaskStatus.PENDING,
      });
      expect(await rebuilt.worktrees.store.getWorktreeBinding(TASK_A)).toMatchObject({
        taskId: TASK_A,
        name: "rebuild",
        status: WorktreeStatus.ACTIVE,
      });
      expect(await hasPath(join(root, binding.relativePath))).toBe(true);
      expect(records.map((record) => record.name)).toEqual(["full-harness"]);
      expect(restoredEvents.map((event) => event.eventId)).toEqual([pendingEventId]);

      await rebuilt.cron.tick();
      const rebuiltResult = await rebuiltRunner.runEvents();
      expect(rebuiltResult?.finalText).toBe("intermediate");
      await expect(rebuiltRunner.runEvents()).resolves.toBeUndefined();
      expect(await rebuilt.cronStore.pendingEvents()).toEqual([]);
    } finally {
      await rebuiltRunner?.close();
      await runner.close();
      expect(harness.supervisor.activeCount).toBe(0);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("gates teammate effects before approval and routes the approved claim into its worktree", async () => {
    const root = await createRepository();
    await writeContextSources(root);
    const connection = new FakeConnection();
    const runtime = createRuntime(connection);
    const model = new GateModel();
    const hooks = new HookRegistry();
    const harness = await createDependencies(root, model, runtime, hooks, {
      taskStore: {
        idGenerator: () => TASK_B,
        claimTokenGenerator: () => TOKEN_B,
      },
    });
    model.attachProtocol(harness.protocol);
    const task = await harness.taskStore.createTask({
      subject: "B",
      description: "完成绑定 Worktree 中的任务",
    });
    const binding = await harness.worktrees.createWorktree({
      taskId: task.id,
      name: "worker",
      integrationRef: "refs/heads/main",
    });
    const runner = buildAgent(P20, harness.dependencies);

    try {
      const initialResult = await runner.run("让 teammate 完成 B");
      expect(initialResult.finalText).toBe("teammate started");
      await harness.teammates.waitForIdleTimeout("worker");
      const result = await runner.runEvents();
      if (result === undefined) {
        throw new Error("expected the teammate result event to resume the lead");
      }
      await vi.waitFor(
        async () =>
          await expect(harness.taskStore.getTask(TASK_B)).resolves.toMatchObject({
            status: TaskStatus.COMPLETED,
            owner: "worker",
          }),
        { timeout: 2_000, interval: 10 },
      );
      const requests = await harness.protocol.store.listRequests();

      expect(result.finalText).toBe("plan approved");
      expect(await harness.taskStore.getTask(TASK_B)).toMatchObject({
        status: TaskStatus.COMPLETED,
        owner: "worker",
      });
      expect((await harness.worktrees.store.getWorktreeBinding(TASK_B)).status).toBe(
        WorktreeStatus.ACTIVE,
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]?.status).toBe(ProtocolRequestStatus.Approved);
      const workerWriteResult = model.requests
        .flatMap((request) => request.messages)
        .find((message) => message.role === "tool" && message.toolCallId === "worker-write");
      expect(workerWriteResult?.content).toContain("Wrote");
      await expect(readFile(join(root, "before-approval.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(join(root, binding.relativePath, "worker.txt"), "utf8")).resolves.toBe(
        "worker",
      );
      await expect(readFile(join(root, "worker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await harness.supervisor.waitIdle();
      validateToolPairing(result.history);
    } finally {
      await runner.close();
      expect(runtime.isClosed).toBe(true);
      expect(connection.closeCalls).toBe(0);
      expect(harness.supervisor.activeCount).toBe(0);
      await rm(root, { recursive: true, force: true });
    }
  });
});
