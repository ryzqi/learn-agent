import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { JsonBackgroundJobStore } from "../src/adapters/background-json.js";
import { JsonCronStore } from "../src/adapters/cron-json.js";
import { FileMailboxStore } from "../src/adapters/mailbox-json.js";
import { JsonProtocolStore } from "../src/adapters/protocol-json.js";
import { SqliteTaskStore } from "../src/adapters/task-sqlite.js";
import { EventInbox } from "../src/core/events.js";
import type { RuntimeEvent } from "../src/core/events.js";
import { AgentRunner } from "../src/core/loop.js";
import { assistantMessage, toolCall } from "../src/core/messages.js";
import type { ModelClient, ModelReply, ModelRequest } from "../src/core/model.js";
import { ToolRegistry } from "../src/core/tools.js";
import { JobSupervisor } from "../src/features/background.js";
import { CronRuntime } from "../src/features/cron.js";
import {
  ProtocolRequestKind,
  ProtocolRequestStatus,
  ProtocolRuntime,
} from "../src/features/protocol.js";
import { createProtocolMailboxMessage, ProtocolMessageKind } from "../src/features/mailbox.js";
import { TaskStatus } from "../src/features/tasks.js";
import { TeammateRuntime, TeammateStateError } from "../src/features/teammates.js";
import {
  registerTeammateLeasedTaskTools,
  type WorkStealingSleeper,
  WorkStealingRuntime,
} from "../src/features/work-stealing.js";

const TASK = "00000000-0000-4000-8000-000000001721";
const TASK_B = "00000000-0000-4000-8000-000000001722";
const TASK_C = "00000000-0000-4000-8000-000000001723";
const TOKEN = "00000000-0000-4000-8000-000000001731";
const TOKEN_B = "00000000-0000-4000-8000-000000001732";
const TOKEN_C = "00000000-0000-4000-8000-000000001733";

function sequence(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) throw new Error("sequence exhausted");
    return value;
  };
}

class ImmediateSleeper implements WorkStealingSleeper {
  readonly calls: number[] = [];

  async sleep(seconds: number, _wakeup: AbortSignal): Promise<void> {
    this.calls.push(seconds);
  }
}

class BlockingSleeper implements WorkStealingSleeper {
  started!: () => void;
  readonly ready = new Promise<void>((resolve) => {
    this.started = resolve;
  });
  calls = 0;
  readonly #callWaiters = new Map<number, () => void>();

  async sleep(_seconds: number, wakeup: AbortSignal): Promise<void> {
    this.calls += 1;
    const callWaiter = this.#callWaiters.get(this.calls);
    if (callWaiter !== undefined) {
      this.#callWaiters.delete(this.calls);
      callWaiter();
    }
    this.started();
    if (wakeup.aborted) return;
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        wakeup.removeEventListener("abort", finish);
        resolve();
      };
      wakeup.addEventListener("abort", finish, { once: true });
      if (wakeup.aborted) finish();
    });
  }

  async waitForCall(call: number): Promise<void> {
    if (this.calls >= call) return;
    await new Promise<void>((resolve) => {
      this.#callWaiters.set(call, resolve);
    });
  }
}

class TwoWakeSleeper implements WorkStealingSleeper {
  calls = 0;
  readonly #callWaiters = new Map<number, () => void>();
  readonly #blockedCalls: number;

  constructor(blockedCalls = 2) {
    this.#blockedCalls = blockedCalls;
  }

  async sleep(_seconds: number, wakeup: AbortSignal): Promise<void> {
    this.calls += 1;
    const callWaiter = this.#callWaiters.get(this.calls);
    if (callWaiter !== undefined) {
      this.#callWaiters.delete(this.calls);
      callWaiter();
    }
    if (this.calls > this.#blockedCalls || wakeup.aborted) return;
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        wakeup.removeEventListener("abort", finish);
        resolve();
      };
      wakeup.addEventListener("abort", finish, { once: true });
      if (wakeup.aborted) finish();
    });
  }

  async waitForCall(call: number): Promise<void> {
    if (this.calls >= call) return;
    await new Promise<void>((resolve) => {
      this.#callWaiters.set(call, resolve);
    });
  }
}

class AutoCompleteModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  #claimToken: string | undefined;
  #taskId: string | undefined;

  async complete(request: ModelRequest): Promise<ModelReply> {
    this.requests.push(request);
    const last = request.messages.at(-1);
    if (last?.role === "user" && last.content.startsWith("<auto-claimed-task>")) {
      const payloadLine = last.content.split("\n")[1];
      if (payloadLine === undefined) throw new Error("auto-claim prompt is incomplete");
      const payload = JSON.parse(payloadLine) as {
        readonly claim_token?: string;
        readonly task?: { readonly id?: string };
      };
      this.#claimToken = payload.claim_token;
      this.#taskId = payload.task?.id;
      if (this.#claimToken === undefined || this.#taskId === undefined) {
        throw new Error("auto-claim prompt is incomplete");
      }
      return {
        message: assistantMessage(null, [
          toolCall(
            "complete-auto-task",
            "complete_task",
            JSON.stringify({ task_id: this.#taskId, claim_token: this.#claimToken }),
          ),
        ]),
        finishReason: "tool_calls",
      };
    }
    if (last?.role === "tool") {
      return { message: assistantMessage("auto task completed"), finishReason: "stop" };
    }
    return { message: assistantMessage("mailbox task completed"), finishReason: "stop" };
  }
}

class ClaimCoordinator {
  initialCount = 0;
  readonly firstClaims = new Map<string, string>();
  #resolveInitial!: () => void;
  #resolveFirstClaims!: () => void;
  readonly #initialReady = new Promise<void>((resolve) => {
    this.#resolveInitial = resolve;
  });
  readonly #firstClaimsReady = new Promise<void>((resolve) => {
    this.#resolveFirstClaims = resolve;
  });

  async waitForInitialWorkers(): Promise<void> {
    await this.#initialReady;
  }

  async recordFirstClaim(name: string, taskId: string): Promise<void> {
    this.firstClaims.set(name, taskId);
    if (this.firstClaims.size === 2) this.#resolveFirstClaims();
    await this.#firstClaimsReady;
  }

  recordInitialWorker(): void {
    this.initialCount += 1;
    if (this.initialCount === 2) this.#resolveInitial();
  }
}

class CoordinatedAutoCompleteModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  readonly #name: string;
  readonly #coordinator: ClaimCoordinator;
  #currentTaskId: string | undefined;
  #currentClaimToken: string | undefined;

  constructor(name: string, coordinator: ClaimCoordinator) {
    this.#name = name;
    this.#coordinator = coordinator;
  }

  async complete(request: ModelRequest): Promise<ModelReply> {
    this.requests.push(request);
    const last = request.messages.at(-1);
    if (last === undefined) throw new Error("model request is missing the final message");
    if (last.role === "user" && last.content.startsWith("<auto-claimed-task>")) {
      const payloadLine = last.content.split("\n")[1];
      if (payloadLine === undefined) throw new Error("auto-claim prompt is incomplete");
      const payload = JSON.parse(payloadLine) as {
        readonly claim_token?: string;
        readonly task?: { readonly id?: string };
      };
      const claimToken = payload.claim_token;
      const taskId = payload.task?.id;
      if (claimToken === undefined || taskId === undefined) {
        throw new Error("auto-claim prompt is incomplete");
      }
      this.#currentTaskId = taskId;
      this.#currentClaimToken = claimToken;
      if (taskId === TASK || taskId === TASK_B) {
        await this.#coordinator.recordFirstClaim(this.#name, taskId);
      }
      return {
        message: assistantMessage(null, [
          toolCall(
            `complete-${taskId}`,
            "complete_task",
            JSON.stringify({ task_id: taskId, claim_token: claimToken }),
          ),
        ]),
        finishReason: "tool_calls",
      };
    }
    if (last.role === "tool") {
      if (this.#currentTaskId === undefined || this.#currentClaimToken === undefined) {
        throw new Error("task completion result has no active claim");
      }
      this.#currentTaskId = undefined;
      this.#currentClaimToken = undefined;
      return { message: assistantMessage("task completed"), finishReason: "stop" };
    }
    this.#coordinator.recordInitialWorker();
    await this.#coordinator.waitForInitialWorkers();
    return { message: assistantMessage("ready"), finishReason: "stop" };
  }
}

async function waitForEventWithin(
  runtime: TeammateRuntime,
  timeoutMs = 15_000,
): Promise<readonly RuntimeEvent[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Timed out waiting for teammate result")), timeoutMs);
  });
  try {
    return await Promise.race([runtime.waitForEvents(1), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForSleeperCallWithin(
  sleeper: { waitForCall(call: number): Promise<void> },
  call: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out waiting for sleeper call ${call}`)),
      1_000,
    );
  });
  try {
    await Promise.race([sleeper.waitForCall(call), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function collectEvents(
  runtime: TeammateRuntime,
  count: number,
): Promise<readonly RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  while (events.length < count) {
    events.push(...(await waitForEventWithin(runtime)));
  }
  return events;
}

describe("P17 teammate work stealing", () => {
  test("requires ProtocolRuntime before enabling work stealing", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch17-runtime-"));
    const inbox = new EventInbox();
    const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
    const cron = new CronRuntime({
      store: new JsonCronStore(root),
      inbox,
      supervisor,
      clock: { now: () => new Date("2026-07-31T08:00:00.000Z") },
    });
    const teammates = new TeammateRuntime({
      store: new FileMailboxStore(root),
      inbox,
      supervisor,
      cronRuntime: cron,
    });
    try {
      expect(() =>
        teammates.configureWorkStealing(
          new WorkStealingRuntime({ store: new SqliteTaskStore(root) }),
        ),
      ).toThrow(TeammateStateError);
    } finally {
      await teammates.close();
      await cron.close();
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("claims and completes ready SQLite work after mailbox work, without inventing an idle event", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch17-runtime-"));
    const inbox = new EventInbox();
    const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
    const cron = new CronRuntime({
      store: new JsonCronStore(root),
      inbox,
      supervisor,
      clock: { now: () => new Date("2026-07-31T08:00:00.000Z") },
    });
    const teammates = new TeammateRuntime({
      store: new FileMailboxStore(root),
      inbox,
      supervisor,
      cronRuntime: cron,
    });
    const tasks = new SqliteTaskStore(root, {
      idGenerator: () => TASK,
      claimTokenGenerator: () => TOKEN,
    });
    const workStealing = new WorkStealingRuntime({
      store: tasks,
      sleeper: new ImmediateSleeper(),
      maxIdlePolls: 2,
    });
    const model = new AutoCompleteModel();
    const protocol = new ProtocolRuntime({ store: new JsonProtocolStore(root), team: teammates });
    teammates.configureProtocol(protocol);
    teammates.configureWorkStealing(workStealing);
    teammates.configureRunnerFactory((name, role, sendDefinition) => {
      const tools = new ToolRegistry();
      tools.register(sendDefinition);
      registerTeammateLeasedTaskTools(tools, workStealing.store, workStealing.claimService);
      return new AgentRunner({
        model,
        tools,
        systemPrompt: `You are ${name}, serving as ${role}.`,
        workspace: root,
        identity: name,
      });
    });
    try {
      await tasks.createTask({ subject: "autonomous" });
      const plan = await protocol.store.createRequest({
        kind: ProtocolRequestKind.PlanApproval,
        sender: "alice",
        target: "lead",
        content: "Complete the SQLite task.",
      });
      await protocol.store.consumeResponse(
        createProtocolMailboxMessage({
          id: "00000000-0000-4000-8000-000000001741",
          sender: "lead",
          recipient: "alice",
          kind: ProtocolMessageKind.PlanApprovalResponse,
          requestId: plan.id,
          content: "Approved",
          approved: true,
          createdAtUtc: new Date("2026-07-31T08:00:00.000Z"),
        }),
      );
      await teammates.start();
      await teammates.spawn({ name: "alice", role: "worker", prompt: "be ready", sender: "lead" });
      const events = [...(await teammates.waitForEvents(1)), ...(await teammates.waitForEvents(1))];
      expect(events).toHaveLength(2);
      expect((await tasks.getTask(TASK)).status).toBe(TaskStatus.COMPLETED);
      expect((await protocol.store.getRequest(plan.id)).status).toBe(
        ProtocolRequestStatus.Approved,
      );
      expect(
        model.requests.some((request) =>
          request.messages.some(
            (message) =>
              message.role === "user" && message.content.startsWith("<auto-claimed-task>"),
          ),
        ),
      ).toBe(true);
      await teammates.acknowledgeEvents(events);
      await teammates.waitForIdleTimeout("alice");
      expect(teammates.idleTimeoutCount("alice")).toBe(1);
      expect(teammates.drainEvents()).toEqual([]);
    } finally {
      await teammates.close();
      await cron.close();
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("coordinates two claims before one worker unlocks and completes their dependent task", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch17-runtime-"));
    const inbox = new EventInbox();
    const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
    const cron = new CronRuntime({
      store: new JsonCronStore(root),
      inbox,
      supervisor,
      clock: { now: () => new Date("2026-07-31T08:00:00.000Z") },
    });
    const teammates = new TeammateRuntime({
      store: new FileMailboxStore(root),
      inbox,
      supervisor,
      cronRuntime: cron,
    });
    const protocol = new ProtocolRuntime({ store: new JsonProtocolStore(root), team: teammates });
    const tasks = new SqliteTaskStore(root, {
      idGenerator: sequence([TASK, TASK_B, TASK_C]),
      claimTokenGenerator: sequence([TOKEN, TOKEN_B, TOKEN_C]),
    });
    const workStealing = new WorkStealingRuntime({
      store: tasks,
      sleeper: new BlockingSleeper(),
    });
    const coordinator = new ClaimCoordinator();
    const models = new Map<string, CoordinatedAutoCompleteModel>();
    teammates.configureProtocol(protocol);
    teammates.configureWorkStealing(workStealing);
    teammates.configureRunnerFactory((name, role, sendDefinition) => {
      const tools = new ToolRegistry();
      tools.register(sendDefinition);
      registerTeammateLeasedTaskTools(tools, workStealing.store, workStealing.claimService);
      const model = new CoordinatedAutoCompleteModel(name, coordinator);
      models.set(name, model);
      return new AgentRunner({
        model,
        tools,
        systemPrompt: `You are ${name}, serving as ${role}.`,
        workspace: root,
        identity: name,
      });
    });
    try {
      const first = await tasks.createTask({ subject: "A" });
      const second = await tasks.createTask({ subject: "B" });
      await tasks.createTask({ subject: "C", blockedBy: [first.id, second.id] });
      await teammates.start();
      await Promise.all([
        teammates.spawn({ name: "alice", role: "worker", prompt: "ready", sender: "lead" }),
        teammates.spawn({ name: "bob", role: "worker", prompt: "ready", sender: "lead" }),
      ]);
      const events = await collectEvents(teammates, 5);
      const restored = await tasks.listTasks();
      expect(coordinator.firstClaims).toHaveLength(2);
      expect(new Set(coordinator.firstClaims.values())).toEqual(new Set([TASK, TASK_B]));
      expect(restored.map((task) => task.status)).toEqual([
        TaskStatus.COMPLETED,
        TaskStatus.COMPLETED,
        TaskStatus.COMPLETED,
      ]);
      const alice = models.get("alice");
      const bob = models.get("bob");
      if (alice === undefined || bob === undefined) throw new Error("worker models are missing");
      expect(alice.requests.length).toBeGreaterThan(1);
      expect(bob.requests.length).toBeGreaterThan(1);
      await teammates.acknowledgeEvents(events);
    } finally {
      await teammates.close();
      await cron.close();
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("routes a delivered shutdown before looking at a ready SQLite task", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch17-runtime-"));
    const inbox = new EventInbox();
    const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
    const cron = new CronRuntime({
      store: new JsonCronStore(root),
      inbox,
      supervisor,
      clock: { now: () => new Date("2026-07-31T08:00:00.000Z") },
    });
    const mailbox = new FileMailboxStore(root);
    const teammates = new TeammateRuntime({ store: mailbox, inbox, supervisor, cronRuntime: cron });
    const protocol = new ProtocolRuntime({ store: new JsonProtocolStore(root), team: teammates });
    const tasks = new SqliteTaskStore(root, {
      idGenerator: () => TASK,
      claimTokenGenerator: () => TOKEN,
    });
    const sleeper = new BlockingSleeper();
    const workStealing = new WorkStealingRuntime({ store: tasks, sleeper });
    const model = new AutoCompleteModel();
    teammates.configureProtocol(protocol);
    teammates.configureWorkStealing(workStealing);
    teammates.configureRunnerFactory((name, role, sendDefinition) => {
      const tools = new ToolRegistry();
      tools.register(sendDefinition);
      registerTeammateLeasedTaskTools(tools, workStealing.store, workStealing.claimService);
      return new AgentRunner({
        model,
        tools,
        systemPrompt: `You are ${name}, serving as ${role}.`,
        workspace: root,
        identity: name,
      });
    });
    try {
      await teammates.start();
      await teammates.spawn({ name: "alice", role: "worker", prompt: "ready", sender: "lead" });
      const initial = await teammates.waitForEvents(1);
      await teammates.acknowledgeEvents(initial);
      await sleeper.ready;
      await tasks.createTask({ subject: "must remain pending" });
      await protocol.requestShutdown("alice");
      const response = await teammates.waitForEvents(1);
      expect(response[0]?.toPayload().kind).toBe("protocol");
      expect((await tasks.getTask(TASK)).status).toBe(TaskStatus.PENDING);
      expect(model.requests).toHaveLength(1);
    } finally {
      await teammates.close();
      await cron.close();
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("blocks automatic claim for a pending plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch17-runtime-"));
    const inbox = new EventInbox();
    const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
    const cron = new CronRuntime({
      store: new JsonCronStore(root),
      inbox,
      supervisor,
      clock: { now: () => new Date() },
    });
    const teammates = new TeammateRuntime({
      store: new FileMailboxStore(root),
      inbox,
      supervisor,
      cronRuntime: cron,
    });
    const protocol = new ProtocolRuntime({ store: new JsonProtocolStore(root), team: teammates });
    const tasks = new SqliteTaskStore(root, {
      idGenerator: () => TASK,
      claimTokenGenerator: () => TOKEN,
    });
    const sleeper = new ImmediateSleeper();
    const workStealing = new WorkStealingRuntime({
      store: tasks,
      sleeper,
      maxIdlePolls: 2,
    });
    const model = new AutoCompleteModel();
    teammates.configureProtocol(protocol);
    teammates.configureWorkStealing(workStealing);
    teammates.configureRunnerFactory((name, role, sendDefinition) => {
      const tools = new ToolRegistry();
      tools.register(sendDefinition);
      registerTeammateLeasedTaskTools(tools, workStealing.store, workStealing.claimService);
      return new AgentRunner({
        model,
        tools,
        systemPrompt: `You are ${name}, serving as ${role}.`,
        workspace: root,
        identity: name,
      });
    });
    try {
      await tasks.createTask({ subject: "requires approval" });
      await protocol.store.createRequest({
        kind: ProtocolRequestKind.PlanApproval,
        sender: "alice",
        target: "lead",
        content: "approve first",
      });
      await teammates.start();
      await teammates.spawn({ name: "alice", role: "worker", prompt: "ready", sender: "lead" });
      const initial = await teammates.waitForEvents(1);
      await teammates.acknowledgeEvents(initial);
      await teammates.waitForIdleTimeout("alice");
      expect((await tasks.getTask(TASK)).status).toBe(TaskStatus.PENDING);
      expect(teammates.idleTimeoutCount("alice")).toBe(1);
      expect(sleeper.calls).toEqual([5, 5]);
      expect(supervisor.activeCount).toBe(0);
    } finally {
      await teammates.close();
      await cron.close();
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resets idle polling after each delivered mailbox task", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch17-runtime-"));
    const inbox = new EventInbox();
    const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
    const cron = new CronRuntime({
      store: new JsonCronStore(root),
      inbox,
      supervisor,
      clock: { now: () => new Date("2026-07-31T08:00:00.000Z") },
    });
    const teammates = new TeammateRuntime({
      store: new FileMailboxStore(root),
      inbox,
      supervisor,
      cronRuntime: cron,
    });
    const protocol = new ProtocolRuntime({ store: new JsonProtocolStore(root), team: teammates });
    const sleeper = new TwoWakeSleeper();
    const workStealing = new WorkStealingRuntime({
      store: new SqliteTaskStore(root),
      sleeper,
      maxIdlePolls: 2,
    });
    teammates.configureProtocol(protocol);
    teammates.configureWorkStealing(workStealing);
    teammates.configureRunnerFactory((name, role, sendDefinition) => {
      const tools = new ToolRegistry();
      tools.register(sendDefinition);
      registerTeammateLeasedTaskTools(tools, workStealing.store, workStealing.claimService);
      return new AgentRunner({
        model: new AutoCompleteModel(),
        tools,
        systemPrompt: `You are ${name}, serving as ${role}.`,
        workspace: root,
        identity: name,
      });
    });
    try {
      await teammates.start();
      await teammates.spawn({ name: "alice", role: "worker", prompt: "ready", sender: "lead" });
      const initial = await waitForEventWithin(teammates);
      await teammates.acknowledgeEvents(initial);
      await waitForSleeperCallWithin(sleeper, 1);
      await teammates.send({ to: "alice", content: "first", sender: "lead" });
      const first = await waitForEventWithin(teammates);
      await teammates.acknowledgeEvents(first);
      await waitForSleeperCallWithin(sleeper, 2);
      await teammates.send({ to: "alice", content: "second", sender: "lead" });
      const second = await waitForEventWithin(teammates);
      await teammates.acknowledgeEvents(second);
      await teammates.waitForIdleTimeout("alice");
      expect(teammates.idleTimeoutCount("alice")).toBe(1);
      expect(sleeper.calls).toBe(4);
    } finally {
      await teammates.close();
      await cron.close();
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not consume the idle limit when a mailbox wakeup interrupts polling", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch17-runtime-"));
    const inbox = new EventInbox();
    const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
    const cron = new CronRuntime({
      store: new JsonCronStore(root),
      inbox,
      supervisor,
      clock: { now: () => new Date("2026-07-31T08:00:00.000Z") },
    });
    const teammates = new TeammateRuntime({
      store: new FileMailboxStore(root),
      inbox,
      supervisor,
      cronRuntime: cron,
    });
    const protocol = new ProtocolRuntime({ store: new JsonProtocolStore(root), team: teammates });
    const sleeper = new TwoWakeSleeper(1);
    const workStealing = new WorkStealingRuntime({
      store: new SqliteTaskStore(root),
      sleeper,
      maxIdlePolls: 1,
    });
    teammates.configureProtocol(protocol);
    teammates.configureWorkStealing(workStealing);
    teammates.configureRunnerFactory((name, role, sendDefinition) => {
      const tools = new ToolRegistry();
      tools.register(sendDefinition);
      registerTeammateLeasedTaskTools(tools, workStealing.store, workStealing.claimService);
      return new AgentRunner({
        model: new AutoCompleteModel(),
        tools,
        systemPrompt: `You are ${name}, serving as ${role}.`,
        workspace: root,
        identity: name,
      });
    });
    try {
      await teammates.start();
      await teammates.spawn({ name: "alice", role: "worker", prompt: "ready", sender: "lead" });
      const initial = await waitForEventWithin(teammates);
      await teammates.acknowledgeEvents(initial);
      await waitForSleeperCallWithin(sleeper, 1);
      await teammates.send({ to: "alice", content: "wakeup task", sender: "lead" });
      const result = await waitForEventWithin(teammates);
      await teammates.acknowledgeEvents(result);
      await teammates.waitForIdleTimeout("alice");
      expect(teammates.idleTimeoutCount("alice")).toBe(1);
    } finally {
      await teammates.close();
      await cron.close();
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("blocks automatic claim for a rejected plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch17-runtime-"));
    const inbox = new EventInbox();
    const supervisor = new JobSupervisor({ store: new JsonBackgroundJobStore(root), inbox });
    const cron = new CronRuntime({
      store: new JsonCronStore(root),
      inbox,
      supervisor,
      clock: { now: () => new Date("2026-07-31T08:00:00.000Z") },
    });
    const teammates = new TeammateRuntime({
      store: new FileMailboxStore(root),
      inbox,
      supervisor,
      cronRuntime: cron,
    });
    const protocol = new ProtocolRuntime({ store: new JsonProtocolStore(root), team: teammates });
    const tasks = new SqliteTaskStore(root, {
      idGenerator: () => TASK,
      claimTokenGenerator: () => TOKEN,
    });
    const workStealing = new WorkStealingRuntime({
      store: tasks,
      sleeper: new ImmediateSleeper(),
      maxIdlePolls: 2,
    });
    teammates.configureProtocol(protocol);
    teammates.configureWorkStealing(workStealing);
    teammates.configureRunnerFactory((name, role, sendDefinition) => {
      const tools = new ToolRegistry();
      tools.register(sendDefinition);
      registerTeammateLeasedTaskTools(tools, workStealing.store, workStealing.claimService);
      return new AgentRunner({
        model: new AutoCompleteModel(),
        tools,
        systemPrompt: `You are ${name}, serving as ${role}.`,
        workspace: root,
        identity: name,
      });
    });
    try {
      await tasks.createTask({ subject: "rejected work" });
      const plan = await protocol.store.createRequest({
        kind: ProtocolRequestKind.PlanApproval,
        sender: "alice",
        target: "lead",
        content: "Do not run this task.",
      });
      await protocol.store.consumeResponse(
        createProtocolMailboxMessage({
          id: "00000000-0000-4000-8000-000000001742",
          sender: "lead",
          recipient: "alice",
          kind: ProtocolMessageKind.PlanApprovalResponse,
          requestId: plan.id,
          content: "Rejected",
          approved: false,
          createdAtUtc: new Date("2026-07-31T08:00:00.000Z"),
        }),
      );
      await teammates.start();
      await teammates.spawn({ name: "alice", role: "worker", prompt: "ready", sender: "lead" });
      const initial = await teammates.waitForEvents(1);
      await teammates.acknowledgeEvents(initial);
      await teammates.waitForIdleTimeout("alice");
      expect((await protocol.store.getRequest(plan.id)).status).toBe(
        ProtocolRequestStatus.Rejected,
      );
      expect((await tasks.getTask(TASK)).status).toBe(TaskStatus.PENDING);
    } finally {
      await teammates.close();
      await cron.close();
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
