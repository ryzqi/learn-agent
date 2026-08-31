// scripts/probe-ch18.mts —— 第 18 章探测脚本（临时用，跑完可删）
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import initSqlJs from "sql.js";

import { SubprocessGitRunner } from "../chapters/ch18/src/adapters/git.js";
import { NodeWorkspaceFileSystem } from "../chapters/ch18/src/adapters/filesystem.js";
import { SqliteTaskStore } from "../chapters/ch18/src/adapters/task-sqlite.js";
import { AgentRunner } from "../chapters/ch18/src/core/loop.js";
import { assistantMessage, toolCall } from "../chapters/ch18/src/core/messages.js";
import type { ModelClient, ModelReply, ModelRequest } from "../chapters/ch18/src/core/model.js";
import type { ToolContext } from "../chapters/ch18/src/core/tools.js";
import { ToolRegistry } from "../chapters/ch18/src/core/tools.js";
import { createChapterTwoTools } from "../chapters/ch18/src/features/builtin-tools.js";
import { TaskStatus } from "../chapters/ch18/src/features/tasks.js";
import {
  leasedTaskToolDefinitions,
  registerTeammateLeasedTaskTools,
  WorkStealingRuntime,
} from "../chapters/ch18/src/features/work-stealing.js";
import type { GitCommandResult, GitRunner } from "../chapters/ch18/src/features/worktrees.js";
import {
  canonicalIntegrationRef,
  registerWorktreeTools,
  WorktreeRuntime,
} from "../chapters/ch18/src/features/worktrees.js";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const EXPERIMENT = process.argv[2] ?? "all";
const CLOCK_BASE = new Date("2026-08-30T10:00:00.000Z");

function section(name: string): boolean {
  const selected = EXPERIMENT === "all" || EXPERIMENT === name;
  if (selected) console.log(`\n===== ${name} =====`);
  return selected;
}

async function withTempDir<T>(operation: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "probe-ch18-"));
  try {
    return await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function git(cwd: string, ...argumentsValue: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...argumentsValue], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.stdout.trim();
}

// 建一个干净的 Git 仓库：main 分支 + 一个初始提交 + 忽略 .agent_tutorial/
async function gitRepository(root: string): Promise<void> {
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Probe");
  await git(root, "config", "user.email", "probe@example.test");
  await writeFile(join(root, ".gitignore"), ".agent_tutorial/\n", "utf8");
  await writeFile(join(root, "config.ts"), "export const value = 0;\n", "utf8");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
}

function seqId(start: number): () => string {
  let next = start;
  return () => {
    const hex = next.toString(16).padStart(12, "0");
    next += 1;
    return `00000000-0000-4000-8000-${hex}`;
  };
}

class Clock {
  value = new Date(CLOCK_BASE);
  now(): Date {
    return new Date(this.value);
  }
}

function errorLine(error: unknown): string {
  if (error instanceof Error) return `${error.constructor.name}: ${error.message}`;
  return `未知错误: ${String(error)}`;
}

function short(id: string): string {
  return id.slice(-4);
}

async function readSqlite(
  path: string,
): Promise<(sql: string) => readonly Record<string, unknown>[]> {
  const SQL = await initSqlJs({
    locateFile: (file: string) => join(dirname(require.resolve("sql.js")), file),
  });
  const database = new SQL.Database(new Uint8Array(await readFile(path)));
  return (sql: string) => {
    const statement = database.prepare(sql);
    const rows: Record<string, unknown>[] = [];
    while (statement.step()) rows.push(statement.getAsObject() as Record<string, unknown>);
    statement.free();
    return rows;
  };
}

// 一次性搭好本章的三件套：SQLite store、WorktreeRuntime、WorkStealingRuntime。
async function components(root: string, idBase = 0x1801) {
  await gitRepository(root);
  const clock = new Clock();
  const store = new SqliteTaskStore(root, {
    idGenerator: seqId(idBase),
    claimTokenGenerator: seqId(idBase + 0x10),
    clock,
    leaseDurationMs: 60_000,
  });
  const worktrees = new WorktreeRuntime({
    workspace: root,
    store,
    gitRunner: new SubprocessGitRunner(),
    clock: () => clock.now(),
  });
  await worktrees.validateRepository();
  const workStealing = new WorkStealingRuntime({ store, claimService: worktrees });
  return { clock, store, worktrees, workStealing };
}

// 记录每一条 Git 命令，同时真正执行它，用来观察清理链路的确切调用顺序。
class RecordingGitRunner implements GitRunner {
  readonly calls: string[] = [];
  readonly #inner = new SubprocessGitRunner();

  async run(argumentsValue: readonly string[], cwd: string): Promise<GitCommandResult> {
    const result = await this.#inner.run(argumentsValue, cwd);
    this.calls.push(`git ${argumentsValue.join(" ")} -> ${result.returncode}`);
    return result;
  }
}

// 只让 `git worktree add` 失败，其他命令照常执行，用来观察 reserved 的保留证据。
class FailingAddGitRunner implements GitRunner {
  readonly #inner = new SubprocessGitRunner();

  async run(argumentsValue: readonly string[], cwd: string): Promise<GitCommandResult> {
    if (argumentsValue[0] === "worktree" && argumentsValue[1] === "add") {
      return { returncode: 128, stdout: "", stderr: "fatal: injected failure" };
    }
    return await this.#inner.run(argumentsValue, cwd);
  }
}

// 只让 `git status` 报错，用来观察 review reason 不泄露原始 stderr。
class FailingStatusGitRunner implements GitRunner {
  readonly #inner = new SubprocessGitRunner();

  async run(argumentsValue: readonly string[], cwd: string): Promise<GitCommandResult> {
    if (argumentsValue[0] === "status") {
      return { returncode: 128, stdout: "", stderr: "fatal: injected status failure" };
    }
    return await this.#inner.run(argumentsValue, cwd);
  }
}

// 按脚本回放模型输出，只关心 tool call 的顺序，不需要真实 OpenAI。
class ScriptedModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  readonly #replies: ModelReply[];

  constructor(replies: readonly ModelReply[]) {
    this.#replies = [...replies];
  }

  async complete(request: ModelRequest): Promise<ModelReply> {
    this.requests.push(request);
    const reply = this.#replies.shift();
    if (reply === undefined) throw new Error("脚本模型收到了预期外的请求");
    return reply;
  }
}

if (section("trace")) {
  await withTempDir(async (root) => {
    const { store, worktrees } = await components(root);
    const step = (index: number, text: string): void => console.log(`[${index}] ${text}`);
    const a = await store.createTask({ subject: "重构认证模块" });
    const b = await store.createTask({ subject: "重构登录页" });
    step(1, `Lead 建了两条任务：A=…${short(a.id)} B=…${short(b.id)}`);

    const alice = await worktrees.createWorktree({
      taskId: a.id,
      name: "alice",
      integrationRef: "refs/heads/main",
    });
    const bob = await worktrees.createWorktree({
      taskId: b.id,
      name: "bob",
      integrationRef: "refs/heads/main",
    });
    step(2, `binding alice: ${alice.status} branch=${alice.branch} path=${alice.relativePath}`);
    step(3, `binding bob:   ${bob.status} branch=${bob.branch} path=${bob.relativePath}`);
    step(
      4,
      `任务状态没被创建 binding 推进：${(await store.listTasks()).map((task) => `${task.subject}(${task.status})`).join(" ")}`,
    );

    const aliceClaim = await worktrees.claimNext("alice");
    const bobClaim = await worktrees.claimNext("bob");
    if (aliceClaim === undefined || bobClaim === undefined) throw new Error("两侧都应认领成功");
    step(
      5,
      `alice 认领 ${aliceClaim.task.subject} token=…${short(aliceClaim.claimToken)}；bob 认领 ${bobClaim.task.subject} token=…${short(bobClaim.claimToken)}`,
    );

    const aliceContext = await worktrees.resolve(
      Object.freeze({ workspace: root, identity: "alice", claimToken: aliceClaim.claimToken }),
    );
    const bobContext = await worktrees.resolve(
      Object.freeze({ workspace: root, identity: "bob", claimToken: bobClaim.claimToken }),
    );
    step(6, `alice 解析到的 cwd: ${aliceContext.workspace.replace(root, "<root>")}`);
    step(7, `bob 解析到的 cwd:   ${bobContext.workspace.replace(root, "<root>")}`);

    await writeFile(join(aliceContext.workspace, "config.ts"), "// alice 的版本\n", "utf8");
    await writeFile(join(bobContext.workspace, "config.ts"), "// bob 的版本\n", "utf8");
    step(8, `alice 的 config.ts: ${JSON.stringify(await readFile(join(aliceContext.workspace, "config.ts"), "utf8"))}`);
    step(9, `bob 的 config.ts:   ${JSON.stringify(await readFile(join(bobContext.workspace, "config.ts"), "utf8"))}`);
    step(10, `主目录 config.ts:   ${JSON.stringify(await readFile(join(root, "config.ts"), "utf8"))}`);

    await git(aliceContext.workspace, "add", "config.ts");
    await git(aliceContext.workspace, "commit", "-m", "alice: rework config");
    await git(root, "merge", "--ff-only", "wt/alice");
    step(11, `alice 的分支已并入 main，main 顶端 = ${(await git(root, "rev-parse", "HEAD")).slice(0, 7)}`);

    await git(bobContext.workspace, "add", "config.ts");
    await git(bobContext.workspace, "commit", "-m", "bob: rework config");
    step(12, `bob 提交了但没有并入 main，wt/bob 顶端 = ${(await git(bobContext.workspace, "rev-parse", "HEAD")).slice(0, 7)}`);

    await store.completeTask(a.id, "alice", aliceClaim.claimToken);
    await store.completeTask(b.id, "bob", bobClaim.claimToken);
    step(13, `两条任务都 completed：${(await store.listTasks()).map((task) => `${task.subject}(${task.status})`).join(" ")}`);

    const removedAlice = await worktrees.removeWorktree(a.id);
    step(14, `remove alice → ${removedAlice.status}${removedAlice.reviewReason === null ? "" : `（${removedAlice.reviewReason}）`}`);
    const removedBob = await worktrees.removeWorktree(b.id);
    step(15, `remove bob   → ${removedBob.status}（${removedBob.reviewReason}）`);
    step(16, `剩下的分支：${(await git(root, "branch", "--format=%(refname:short)")).split("\n").join(" ")}`);
    step(17, `Git 仍登记的 worktree 数：${(await git(root, "worktree", "list")).split("\n").length}`);

    const events = await worktrees.store.listWorktreeEvents();
    step(
      18,
      `审计事件（按 sequence）：\n     ${events.map((event) => `#${event.sequence} ${event.name} ${event.action} -> ${event.status}${event.reason === null ? "" : ` (${event.reason})`}`).join("\n     ")}`,
    );
  });
}

if (section("lock")) {
  await withTempDir(async (root) => {
    // 第一组：两人共享同一个目录，写入用"锁"严格排队。
    const shared = join(root, "shared");
    await mkdir(shared, { recursive: true });
    let held = false;
    const withLock = async (owner: string, work: () => Promise<void>): Promise<void> => {
      if (held) throw new Error("锁被并发持有，这里不会发生");
      held = true;
      console.log(`  ${owner} 拿到 config.ts 的锁`);
      await work();
      held = false;
      console.log(`  ${owner} 释放锁`);
    };
    await withLock("alice", async () => {
      await writeFile(join(shared, "config.ts"), "// alice 的版本\n", "utf8");
    });
    await withLock("bob", async () => {
      await writeFile(join(shared, "config.ts"), "// bob 的版本\n", "utf8");
    });
    console.log(`共享目录最终内容: ${JSON.stringify(await readFile(join(shared, "config.ts"), "utf8"))}`);
    console.log("锁全程没有被并发持有，alice 的改动依然消失了：串行化只保证顺序，不保存版本。\n");

    // 第二组：同一段写入，落在两个受管 Worktree 里。
    const repository = join(root, "repository");
    await mkdir(repository, { recursive: true });
    const { store, worktrees } = await components(repository);
    const a = await store.createTask({ subject: "alice 的活" });
    const b = await store.createTask({ subject: "bob 的活" });
    const aliceBinding = await worktrees.createWorktree({
      taskId: a.id,
      name: "alice",
      integrationRef: "refs/heads/main",
    });
    const bobBinding = await worktrees.createWorktree({
      taskId: b.id,
      name: "bob",
      integrationRef: "refs/heads/main",
    });
    await writeFile(join(repository, aliceBinding.relativePath, "config.ts"), "// alice 的版本\n", "utf8");
    await writeFile(join(repository, bobBinding.relativePath, "config.ts"), "// bob 的版本\n", "utf8");
    console.log(`alice worktree: ${JSON.stringify(await readFile(join(repository, aliceBinding.relativePath, "config.ts"), "utf8"))}`);
    console.log(`bob   worktree: ${JSON.stringify(await readFile(join(repository, bobBinding.relativePath, "config.ts"), "utf8"))}`);
    console.log(`主目录        : ${JSON.stringify(await readFile(join(repository, "config.ts"), "utf8"))}`);
    const commonDir = await git(join(repository, aliceBinding.relativePath), "rev-parse", "--git-common-dir");
    console.log(`两个 worktree 共享同一个对象库：${JSON.stringify(commonDir.replace(repository.replaceAll("\\", "/"), "<root>"))}`);
  });
}

if (section("state")) {
  await withTempDir(async (root) => {
    const { store, worktrees } = await components(root);
    const task = await store.createTask({ subject: "三条状态线" });
    const line = async (label: string): Promise<void> => {
      const current = await store.getTask(task.id);
      let bindingText = "（无 binding）";
      try {
        bindingText = (await worktrees.store.getWorktreeBinding(task.id)).status;
      } catch {
        bindingText = "（无 binding）";
      }
      const query = await readSqlite(store.databasePath);
      const raw = query("SELECT claim_token FROM tasks")[0]?.claim_token;
      const token = typeof raw === "string" ? `…${short(raw)}` : "null";
      console.log(
        `${label.padEnd(22, " ")} task=${current.status.padEnd(11, " ")} owner=${String(current.owner).padEnd(6, " ")} token=${token.padEnd(6, " ")} binding=${bindingText}`,
      );
    };
    await line("createTask 之后");
    await worktrees.createWorktree({
      taskId: task.id,
      name: "alice",
      integrationRef: "refs/heads/main",
    });
    await line("createWorktree 之后");
    const claim = await worktrees.claimNext("alice");
    if (claim === undefined) throw new Error("应认领成功");
    await line("claimNext 之后");
    await store.completeTask(task.id, "alice", claim.claimToken);
    await line("completeTask 之后");
    await worktrees.keepWorktree(task.id);
    await line("keepWorktree 之后");

    const query = await readSqlite(store.databasePath);
    console.log(`\ntasks 表里没有 worktree 字段：${query("SELECT * FROM tasks").map((row) => Object.keys(row).join(", "))}`);
    console.log(`binding 独立成表：${query("SELECT * FROM worktree_bindings").map((row) => Object.keys(row).join(", "))}`);
  });
}

if (section("reserve")) {
  await withTempDir(async (root) => {
    await gitRepository(root);
    const clock = new Clock();
    const store = new SqliteTaskStore(root, {
      idGenerator: seqId(0x1841),
      claimTokenGenerator: seqId(0x1851),
      clock,
    });
    const worktrees = new WorktreeRuntime({
      workspace: root,
      store,
      gitRunner: new FailingAddGitRunner(),
      clock: () => clock.now(),
    });
    await worktrees.validateRepository();
    const task = await store.createTask({ subject: "git add 会失败" });
    try {
      await worktrees.createWorktree({
        taskId: task.id,
        name: "alice",
        integrationRef: "refs/heads/main",
      });
      console.log("不应该走到这里");
    } catch (error) {
      console.log(`createWorktree 抛出：${errorLine(error)}`);
    }
    const binding = await store.getWorktreeBinding(task.id);
    console.log(`binding 状态仍是：${binding.status}（branch_tip=${String(binding.branchTip)}）`);
    console.log(`Task 状态仍是：  ${(await store.getTask(task.id)).status}`);
    console.log(
      `审计事件：${(await store.listWorktreeEvents()).map((event) => `#${event.sequence} ${event.action}->${event.status}`).join(" ")}`,
    );
    console.log(`自动认领会不会捡到它：${String(await worktrees.claimNext("alice"))}（reserved 不是 active）`);
    const branches = await git(root, "branch", "--format=%(refname:short)");
    console.log(`Git 分支：${branches.split("\n").join(" ")}（没有留下半个 wt/alice）`);
  });
}

if (section("audit")) {
  await withTempDir(async (root) => {
    const { store, worktrees } = await components(root);
    const task = await store.createTask({ subject: "审计与状态同事务" });
    await worktrees.createWorktree({
      taskId: task.id,
      name: "alice",
      integrationRef: "refs/heads/main",
    });
    const claim = await worktrees.claimNext("alice");
    if (claim === undefined) throw new Error("应认领成功");
    await store.completeTask(task.id, "alice", claim.claimToken);
    await worktrees.keepWorktree(task.id);

    const events = await store.listWorktreeEvents();
    console.log("worktree_events（append-only）：");
    for (const event of events) {
      console.log(
        `  #${event.sequence} ${event.action.padEnd(13, " ")} status=${event.status.padEnd(12, " ")} branch_tip=${event.branchTip === null ? "null" : event.branchTip.slice(0, 7)} at=${event.createdAtUtc.toISOString()}`,
      );
    }

    const query = await readSqlite(store.databasePath);
    for (const sql of [
      "UPDATE worktree_events SET action = 'remove' WHERE sequence = 1",
      "DELETE FROM worktree_events WHERE sequence = 1",
    ]) {
      try {
        query(sql);
        console.log(`${sql} → 竟然成功了`);
      } catch (error) {
        console.log(`${sql}\n  → ${errorLine(error)}`);
      }
    }
    console.log(`\nCHECK 约束也挡住非法组合，试着手写一个 needs_review 但不给理由：`);
    try {
      query(
        "UPDATE worktree_bindings SET status = 'needs_review', review_reason = NULL WHERE name = 'alice'",
      );
      console.log("  → 竟然成功了");
    } catch (error) {
      console.log(`  → ${errorLine(error)}`);
    }
  });
}

if (section("routing")) {
  await withTempDir(async (root) => {
    const { store, worktrees } = await components(root);
    const task = await store.createTask({ subject: "同一回复里 claim 再写文件" });
    const binding = await worktrees.createWorktree({
      taskId: task.id,
      name: "alice",
      integrationRef: "refs/heads/main",
    });

    // Lead 的工具面：文件工具 + 认领工具 + 三个 Worktree 生命周期工具。
    const tools = createChapterTwoTools(
      { run: async () => ({ output: "", exitCode: 0, timedOut: false, truncated: false }) },
      new NodeWorkspaceFileSystem(),
    );
    registerTeammateLeasedTaskTools(tools, store, worktrees);
    registerWorktreeTools(tools, worktrees);

    const seen: string[] = [];
    const model = new ScriptedModel([
      {
        message: assistantMessage(null, [
          toolCall("c1", "claim_task", JSON.stringify({ task_id: task.id })),
          toolCall("w1", "write_file", JSON.stringify({ path: "config.ts", content: "// alice\n" })),
        ]),
        finishReason: "tool_calls",
      },
      { message: assistantMessage("done"), finishReason: "stop" },
    ]);
    const runner = new AgentRunner({
      model,
      tools,
      systemPrompt: "probe",
      workspace: root,
      identity: "alice",
      toolContextProvider: {
        workspaceRoot: root,
        resolve: async (context: ToolContext) => {
          const resolved = await worktrees.resolve(context);
          seen.push(resolved.workspace.replace(root, "<root>"));
          return resolved;
        },
      },
    });

    const result = await runner.run("claim then write");
    console.log(`最终文本：${result.finalText}`);
    console.log(`两次工具调用解析出的 cwd：\n  claim_task → ${seen[0]}\n  write_file → ${seen[1]}`);
    console.log(`worktree 里的 config.ts：${JSON.stringify(await readFile(join(root, binding.relativePath, "config.ts"), "utf8"))}`);
    console.log(`主目录 config.ts：      ${JSON.stringify(await readFile(join(root, "config.ts"), "utf8"))}`);
    await runner.close();
  });
}

if (section("failclosed")) {
  await withTempDir(async (root) => {
    const { store, worktrees } = await components(root);
    const bound = await store.createTask({ subject: "已绑定" });
    await worktrees.createWorktree({
      taskId: bound.id,
      name: "alice",
      integrationRef: "refs/heads/main",
    });
    const claim = await worktrees.claimNext("alice");
    if (claim === undefined) throw new Error("应认领成功");

    const attempt = async (
      label: string,
      context: Partial<ToolContext> & { readonly identity: string },
    ): Promise<void> => {
      try {
        const resolved = await worktrees.resolve(
          Object.freeze({ workspace: root, ...context }) as ToolContext,
        );
        console.log(`${label.padEnd(26, " ")} → ${resolved.workspace.replace(root, "<root>")}`);
      } catch (error) {
        console.log(`${label.padEnd(26, " ")} → ${errorLine(error)}`);
      }
    };

    await attempt("正确 identity + token", { identity: "alice", claimToken: claim.claimToken });
    await attempt("错 identity", { identity: "bob", claimToken: claim.claimToken });
    await attempt("错 task_id", {
      identity: "alice",
      taskId: "00000000-0000-4000-8000-000000009999",
      claimToken: claim.claimToken,
    });
    await attempt("没生成过的 token", {
      identity: "alice",
      claimToken: "00000000-0000-4000-8000-000000009999",
    });
    await attempt("格式错误的 token", { identity: "alice", claimToken: "not-a-token" });
    await attempt("错 worktree 名", {
      identity: "alice",
      claimToken: claim.claimToken,
      worktreeName: "bob",
    });
    await attempt("完全没有 claim", { identity: "alice" });
    await attempt("只给 task_id 不给 token", { identity: "alice", taskId: bound.id });

    await store.completeTask(bound.id, "alice", claim.claimToken);
    await attempt("完成后再用旧 token", { identity: "alice", claimToken: claim.claimToken });
  });
}

if (section("auto")) {
  await withTempDir(async (root) => {
    const { store, worktrees, workStealing } = await components(root);
    const unbound = await store.createTask({ subject: "没有 worktree 的任务" });
    const bound = await store.createTask({ subject: "有 worktree 的任务" });
    await worktrees.createWorktree({
      taskId: bound.id,
      name: "alice",
      integrationRef: "refs/heads/main",
    });
    console.log(`任务板顺序：${(await store.listTasks()).map((task) => `${task.subject}(${task.status})`).join(" / ")}`);
    console.log(`未绑定任务排在前面，但 claimNext 只会挑已绑定的那条：`);
    const first = await workStealing.claimNext("alice");
    console.log(`  第一次 claimNext → ${first === undefined ? "undefined" : first.task.subject}`);
    console.log(`  未绑定任务状态   → ${(await store.getTask(unbound.id)).status}`);
    const second = await workStealing.claimNext("bob");
    console.log(`  第二次 claimNext（bob）→ ${String(second)}（没有第二个 active binding）`);
    if (first !== undefined) {
      console.log(`\n自动认领 prompt 长这样：\n${workStealing.renderClaimPrompt(first)}`);
    }
  });
}

if (section("cleanup")) {
  // 场景 1：worktree 里的提交已经并入 main，清理链路应当完整走完并留下 removed。
  await withTempDir(async (root) => {
    await gitRepository(root);
    const clock = new Clock();
    const store = new SqliteTaskStore(root, {
      idGenerator: seqId(0x1801),
      claimTokenGenerator: seqId(0x1811),
      clock,
      leaseDurationMs: 60_000,
    });
    const recorder = new RecordingGitRunner();
    const worktrees = new WorktreeRuntime({
      workspace: root,
      store,
      gitRunner: recorder,
      clock: () => clock.now(),
    });
    await worktrees.validateRepository();
    const task = await store.createTask({ subject: "已合并，可以删" });
    const binding = await worktrees.createWorktree({
      taskId: task.id,
      name: "alice",
      integrationRef: "refs/heads/main",
    });
    const claim = await worktrees.claimNext("alice");
    if (claim === undefined) throw new Error("应认领成功");
    const worktreePath = join(root, binding.relativePath);
    await writeFile(join(worktreePath, "config.ts"), "export const value = 1;\n", "utf8");
    await git(worktreePath, "commit", "-am", "alice: bump value");
    const aliceTip = await git(worktreePath, "rev-parse", "HEAD");
    await git(root, "merge", "--ff-only", binding.branch);
    await store.completeTask(task.id, "alice", claim.claimToken);

    recorder.calls.length = 0;
    const removed = await worktrees.removeWorktree(task.id);
    console.log(`remove_worktree 逐条证明用到的 Git 命令：`);
    for (const call of recorder.calls) console.log(`  ${call}`);
    console.log(`最终 binding：status=${removed.status} branch_tip=${removed.branchTip?.slice(0, 7)} review_reason=${String(removed.reviewReason)}`);
    console.log(`branch_tip 与 alice 分支最后一次提交一致：${removed.branchTip === aliceTip}`);
    console.log(`git worktree list 里还剩：${(await git(root, "worktree", "list", "--porcelain")).split("\n").filter((line) => line.startsWith("worktree ")).length} 个`);
    console.log(`alice 分支还在吗：${JSON.stringify(await git(root, "branch", "--list", binding.branch))}`);
    console.log(`main 上还有 alice 的提交吗：${JSON.stringify(await readFile(join(root, "config.ts"), "utf8"))}`);
  });

  // 场景 2：没合并 / 有脏改动 / git status 报错，三条都必须落在 needs_review。
  const scenarios: readonly {
    readonly label: string;
    readonly dirty: boolean;
    readonly merge: boolean;
    readonly failStatus: boolean;
  }[] = [
    { label: "有未提交改动", dirty: true, merge: true, failStatus: false },
    { label: "没并入 main", dirty: false, merge: false, failStatus: false },
    { label: "git status 自己报错", dirty: false, merge: true, failStatus: true },
  ];
  for (const scenario of scenarios) {
    await withTempDir(async (root) => {
      await gitRepository(root);
      const clock = new Clock();
      const store = new SqliteTaskStore(root, {
        idGenerator: seqId(0x1801),
        claimTokenGenerator: seqId(0x1811),
        clock,
        leaseDurationMs: 60_000,
      });
      const worktrees = new WorktreeRuntime({
        workspace: root,
        store,
        gitRunner: scenario.failStatus ? new FailingStatusGitRunner() : new SubprocessGitRunner(),
        clock: () => clock.now(),
      });
      await worktrees.validateRepository();
      const task = await store.createTask({ subject: scenario.label });
      const binding = await worktrees.createWorktree({
        taskId: task.id,
        name: "alice",
        integrationRef: "refs/heads/main",
      });
      const claim = await worktrees.claimNext("alice");
      if (claim === undefined) throw new Error("应认领成功");
      const worktreePath = join(root, binding.relativePath);
      await writeFile(join(worktreePath, "config.ts"), "export const value = 1;\n", "utf8");
      if (!scenario.dirty) await git(worktreePath, "commit", "-am", "alice: bump value");
      if (scenario.merge && !scenario.dirty) await git(root, "merge", "--ff-only", binding.branch);
      await store.completeTask(task.id, "alice", claim.claimToken);

      const result = await worktrees.removeWorktree(task.id);
      console.log(`\n${scenario.label} → status=${result.status}`);
      console.log(`  review_reason: ${String(result.reviewReason)}`);
      console.log(`  目录还在：${(await git(root, "worktree", "list", "--porcelain")).includes(binding.relativePath.replaceAll("\\", "/"))}`);
      console.log(`  分支还在：${(await git(root, "branch", "--list", binding.branch)).length > 0}`);
      const query = await readSqlite(store.databasePath);
      console.log(`  事件序列：${query("SELECT action, status FROM worktree_events ORDER BY sequence").map((row) => `${String(row["action"])}/${String(row["status"])}`).join(" → ")}`);
    });
  }
}

if (section("tools")) {
  await withTempDir(async (root) => {
    const { store, worktrees } = await components(root);
    const names = (registry: ToolRegistry): string => registry.names.join(", ");

    const lead = createChapterTwoTools(
      { run: async () => ({ output: "", exitCode: 0, timedOut: false, truncated: false }) },
      new NodeWorkspaceFileSystem(),
    );
    for (const definition of leasedTaskToolDefinitions(store, worktrees)) lead.register(definition);
    registerWorktreeTools(lead, worktrees);
    console.log(`Lead：     ${names(lead)}`);

    const teammate = createChapterTwoTools(
      { run: async () => ({ output: "", exitCode: 0, timedOut: false, truncated: false }) },
      new NodeWorkspaceFileSystem(),
    );
    registerTeammateLeasedTaskTools(teammate, store, worktrees);
    console.log(`Teammate： ${names(teammate)}`);

    console.log(`\n三个 Worktree 工具的 effect 分类：`);
    for (const definition of worktrees.leadToolDefinitions) {
      console.log(`  ${definition.name.padEnd(16, " ")} effect=${definition.effect}`);
    }
    console.log(`\nLead 有 create_task 吗：        ${lead.names.includes("create_task")}`);
    console.log(`Teammate 有 create_task 吗：    ${teammate.names.includes("create_task")}`);
    console.log(`Teammate 有 create_worktree 吗：${teammate.names.includes("create_worktree")}`);

    // 模型真正看到的返回值：create_worktree 的 wire format。
    const task = await store.createTask({ subject: "看一眼工具返回的 JSON" });
    const [create] = worktrees.leadToolDefinitions;
    const result = await create.handler(
      { task_id: task.id, name: "alice", integration_ref: "refs/heads/main" },
      Object.freeze({ workspace: root, identity: "lead" }),
    );
    console.log(`\ncreate_worktree 返回给模型的内容（isError=${result.isError}）：`);
    console.log(JSON.stringify(JSON.parse(result.content), null, 2).replace(/^/gmu, "  "));

    // 同名再建一次：唯一约束在 SQLite 层挡住，工具返回结构化错误而不是抛异常。
    const duplicate = await store.createTask({ subject: "重名" });
    const conflict = await create.handler(
      { task_id: duplicate.id, name: "alice", integration_ref: "refs/heads/main" },
      Object.freeze({ workspace: root, identity: "lead" }),
    );
    console.log(`\n同名再建一次 → isError=${conflict.isError} errorCode=${String(conflict.errorCode)}`);
    console.log(`  ${conflict.content}`);
  });
}

if (section("guard")) {
  // 非 Git 目录：状态创建之前就必须失败，且不留下 .agent_tutorial。
  await withTempDir(async (root) => {
    const plain = join(root, "not-a-repo");
    await mkdir(plain, { recursive: true });
    const store = new SqliteTaskStore(plain, { idGenerator: seqId(0x1801) });
    const worktrees = new WorktreeRuntime({
      workspace: plain,
      store,
      gitRunner: new SubprocessGitRunner(),
    });
    try {
      await worktrees.validateRepository();
      console.log("非 Git 目录 → 竟然通过了");
    } catch (error) {
      console.log(`非 Git 目录 → ${errorLine(error)}`);
    }
    const task = await store.createTask({ subject: "在非仓库里建 worktree" });
    try {
      await worktrees.createWorktree({
        taskId: task.id,
        name: "alice",
        integrationRef: "refs/heads/main",
      });
      console.log("createWorktree → 竟然通过了");
    } catch (error) {
      console.log(`createWorktree → ${errorLine(error)}`);
    }
    const query = await readSqlite(store.databasePath);
    console.log(`worktree_bindings 行数：${String(query("SELECT COUNT(*) AS n FROM worktree_bindings")[0]?.["n"])}`);
    console.log(`worktree_events 行数：  ${String(query("SELECT COUNT(*) AS n FROM worktree_events")[0]?.["n"])}`);

    // 子目录也不行：workspace 必须正好是仓库根。
    await gitRepository(root);
    const nested = join(root, "src");
    await mkdir(nested, { recursive: true });
    const nestedRuntime = new WorktreeRuntime({
      workspace: nested,
      store: new SqliteTaskStore(nested, { idGenerator: seqId(0x1801) }),
      gitRunner: new SubprocessGitRunner(),
    });
    try {
      await nestedRuntime.validateRepository();
      console.log(`仓库子目录 → 竟然通过了`);
    } catch (error) {
      console.log(`仓库子目录 → ${errorLine(error)}`);
    }
  });

  console.log(`\ncanonicalIntegrationRef 的输入校验：`);
  for (const candidate of [
    "refs/heads/main",
    "refs/remotes/origin/main",
    "main",
    "HEAD",
    "refs/heads/../../etc/passwd",
    "refs/heads/main@{1}",
    "refs/heads/feature branch",
    "refs/heads/main/",
    " refs/heads/main",
  ]) {
    try {
      console.log(`  ${JSON.stringify(candidate).padEnd(34, " ")} → ${canonicalIntegrationRef(candidate)}`);
    } catch (error) {
      console.log(`  ${JSON.stringify(candidate).padEnd(34, " ")} → ${errorLine(error)}`);
    }
  }
}
