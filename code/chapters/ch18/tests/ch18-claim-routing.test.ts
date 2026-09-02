import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { SubprocessGitRunner } from "../src/adapters/git.js";
import { SqliteTaskStore } from "../src/adapters/task-sqlite.js";
import type { ToolContext } from "../src/core/tools.js";
import { TaskStatus } from "../src/features/tasks.js";
import { WorkStealingRuntime } from "../src/features/work-stealing.js";
import { WorktreeContextError, WorktreeRuntime } from "../src/features/worktrees.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const IDS = ["00000000-0000-4000-8000-000000001901", "00000000-0000-4000-8000-000000001902"];
const TOKENS = ["00000000-0000-4000-8000-000000001951", "00000000-0000-4000-8000-000000001952"];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

class Values {
  readonly #values: string[];
  constructor(values: readonly string[]) {
    this.#values = [...values];
  }
  next = (): string => {
    const value = this.#values.shift();
    if (value === undefined) throw new Error("test sequence exhausted");
    return value;
  };
}

async function git(cwd: string, ...argumentsValue: string[]): Promise<void> {
  await execFileAsync("git", argumentsValue, { cwd, encoding: "utf8", windowsHide: true });
}

async function components(): Promise<{
  readonly root: string;
  readonly store: SqliteTaskStore;
  readonly worktrees: WorktreeRuntime;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch18-claim-"));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Agent Tutorial Tests");
  await git(root, "config", "user.email", "agent-tutorial@example.test");
  await writeFile(join(root, ".gitignore"), ".agent_tutorial/\n", "utf8");
  await git(root, "add", ".gitignore");
  await git(root, "commit", "-m", "initial");
  const ids = new Values(IDS);
  const tokens = new Values(TOKENS);
  const store = new SqliteTaskStore(root, {
    idGenerator: ids.next,
    claimTokenGenerator: tokens.next,
    clock: { now: () => new Date("2026-07-27T19:00:00.000Z") },
  });
  const worktrees = new WorktreeRuntime({
    workspace: root,
    store,
    gitRunner: new SubprocessGitRunner(),
    clock: () => new Date("2026-07-27T19:00:00.000Z"),
  });
  await worktrees.validateRepository();
  return { root, store, worktrees };
}

describe("chapter 18 claim routing", () => {
  test("manual and automatic claims share the active binding service", async () => {
    const { root, store, worktrees } = await components();
    const unbound = await store.createTask({ subject: "unbound", description: "" });
    const bound = await store.createTask({ subject: "bound", description: "" });
    const binding = await worktrees.createWorktree({
      taskId: bound.id,
      name: "bob",
      integrationRef: "refs/heads/main",
    });
    const workStealing = new WorkStealingRuntime({ store, claimService: worktrees });

    const automatic = await workStealing.claimNext("bob");
    if (automatic === undefined) throw new Error("expected active bound task");
    expect(automatic.task.id).toBe(bound.id);
    expect((await store.getTask(unbound.id)).status).toBe(TaskStatus.PENDING);
    const automaticContext: ToolContext = Object.freeze({
      workspace: root,
      identity: "bob",
      claimToken: automatic.claimToken,
      executionScope: Object.freeze({}),
    });
    await expect(worktrees.resolve(automaticContext)).resolves.toMatchObject({
      workspace: join(root, binding.relativePath),
      taskId: bound.id,
      claimToken: automatic.claimToken,
    });
  });

  test("completed claim tokens cannot fall back to the main workspace", async () => {
    const { root, store, worktrees } = await components();
    const task = await store.createTask({ subject: "bound", description: "" });
    await worktrees.createWorktree({
      taskId: task.id,
      name: "alice",
      integrationRef: "refs/heads/main",
    });
    const context: ToolContext = Object.freeze({
      workspace: root,
      identity: "alice",
      executionScope: Object.freeze({}),
    });
    const claim = await worktrees.claimTask(task.id, context);
    await worktrees.completeTask(task.id, claim.claimToken, context);

    await expect(worktrees.resolve(context)).rejects.toBeInstanceOf(WorktreeContextError);
  });

  test("rejects an active token used by the wrong identity or task", async () => {
    const { root, store, worktrees } = await components();
    const task = await store.createTask({ subject: "bound", description: "" });
    await worktrees.createWorktree({
      taskId: task.id,
      name: "alice",
      integrationRef: "refs/heads/main",
    });
    const claim = await worktrees.claimNext("alice");
    if (claim === undefined) throw new Error("expected active bound task");

    await expect(
      worktrees.resolve(
        Object.freeze({
          workspace: root,
          identity: "bob",
          claimToken: claim.claimToken,
          executionScope: Object.freeze({}),
        }),
      ),
    ).rejects.toBeInstanceOf(WorktreeContextError);
    await expect(
      worktrees.resolve(
        Object.freeze({
          workspace: root,
          identity: "alice",
          taskId: "00000000-0000-4000-8000-000000001999",
          claimToken: claim.claimToken,
          executionScope: Object.freeze({}),
        }),
      ),
    ).rejects.toBeInstanceOf(WorktreeContextError);
  });

  test("rejects unknown and malformed explicit claim tokens before workspace fallback", async () => {
    const { root, worktrees } = await components();
    const scope = Object.freeze({});

    await expect(
      worktrees.resolve(
        Object.freeze({
          workspace: root,
          identity: "alice",
          claimToken: "00000000-0000-4000-8000-000000001999",
          executionScope: scope,
        }),
      ),
    ).rejects.toBeInstanceOf(WorktreeContextError);
    await expect(
      worktrees.resolve(
        Object.freeze({
          workspace: root,
          identity: "alice",
          claimToken: "not-a-claim-token",
          executionScope: scope,
        }),
      ),
    ).rejects.toBeInstanceOf(WorktreeContextError);
  });

  test("rejects a scope claim after its lease is no longer active", async () => {
    const { root, store, worktrees } = await components();
    const task = await store.createTask({ subject: "scope claim", description: "" });
    await worktrees.createWorktree({
      taskId: task.id,
      name: "alice",
      integrationRef: "refs/heads/main",
    });
    const scope = Object.freeze({});
    const context: ToolContext = Object.freeze({
      workspace: root,
      identity: "alice",
      executionScope: scope,
    });
    const claim = await worktrees.claimTask(task.id, context);

    await store.completeTask(task.id, "alice", claim.claimToken);

    await expect(worktrees.resolve(context)).rejects.toBeInstanceOf(WorktreeContextError);
  });
});
