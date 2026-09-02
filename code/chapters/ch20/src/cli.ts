#!/usr/bin/env node

// CLI 是真实运行入口：负责参数解析、环境读取、模型与持久化资源装配、用户审批/审计边界，以及执行/清理错误归一。
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { createRequire } from "node:module";
import { stdin, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import { NodeWorkspaceFileSystem } from "./adapters/filesystem.js";
import { SubprocessGitRunner } from "./adapters/git.js";
import { StdioMcpConnectionFactory } from "./adapters/mcp-client.js";
import { AjvMcpSchemaValidator } from "./adapters/mcp-schema.js";
import { OpenAIChatModel } from "./adapters/openai-chat.js";
import { JsonTaskStore } from "./adapters/task-json.js";
import { SqliteTaskStore } from "./adapters/task-sqlite.js";
import { JsonBackgroundJobStore } from "./adapters/background-json.js";
import { JsonCronStore } from "./adapters/cron-json.js";
import { FileMailboxStore } from "./adapters/mailbox-json.js";
import { JsonProtocolStore } from "./adapters/protocol-json.js";
import { buildAgent } from "./bootstrap.js";
import type { BuildDependencies } from "./bootstrap.js";
import { ConfigurationError, settingsFromEnvFile, settingsFromMapping } from "./config.js";
import type { HookContext } from "./core/hooks.js";
import { HookRegistry, HookResult } from "./core/hooks.js";
import type { ApprovalProvider, AuditSink } from "./core/permissions.js";
import { PermissionDecision } from "./core/permissions.js";
import type { PermissionRequest } from "./core/permissions.js";
import type { ChapterProfile } from "./core/profiles.js";
import { profileForChapter } from "./core/profiles.js";
import { EventInbox } from "./core/events.js";
import { JobSupervisor } from "./features/background.js";
import { CronRuntime } from "./features/cron.js";
import { TeammateRuntime } from "./features/teammates.js";
import { ProtocolRuntime } from "./features/protocol.js";
import { RecoveryConfig } from "./features/recovery.js";
import { WorkStealingRuntime } from "./features/work-stealing.js";
import { WorktreeRuntime } from "./features/worktrees.js";
import { McpRuntime, McpServerSpec, McpToolPolicy } from "./features/mcp-tools.js";

const require = createRequire(import.meta.url);

// 终端审批在真实交互入口实现；非 TTY 默认拒绝，避免无人值守时自动放行工具。
class TerminalApprovalProvider implements ApprovalProvider {
  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    const definition = request.prepared.definition;
    const proposed = request.proposedDecision;
    if (definition === undefined || proposed === undefined) {
      throw new Error("approval request is incomplete");
    }
    stderr.write(`\n工具调用需要批准: ${definition.name}\n`);
    stderr.write(`原因: ${proposed.reason}\n`);
    stderr.write(`参数: ${JSON.stringify(request.prepared.arguments)}\n`);
    if (!stdin.isTTY) {
      stderr.write("无交互输入，默认拒绝。\n");
      return new PermissionDecision(
        "deny",
        "No interactive approval input was available",
        "terminal-approval",
      );
    }

    const terminal = createInterface({ input: stdin, output: stderr });
    try {
      const answer = await terminal.question("允许本次调用? [y/N] ");
      const normalized = answer.trim().toLowerCase();
      const allowed = normalized === "y" || normalized === "yes";
      return new PermissionDecision(
        allowed ? "allow" : "deny",
        allowed ? "User approved this tool call" : "User denied this tool call",
        "terminal-approval",
      );
    } finally {
      terminal.close();
    }
  }
}

// 终端审计把权限决策写入 stderr，使真实运行保留最小可追踪记录。
class TerminalAuditSink implements AuditSink {
  async record(request: PermissionRequest, decision: PermissionDecision): Promise<void> {
    const definition = request.prepared.definition;
    if (definition === undefined) {
      throw new Error("audit request is incomplete");
    }
    stderr.write(
      `[Permission] ${definition.name}: ${decision.behavior} (${decision.source}) - ${decision.reason}\n`,
    );
  }
}

interface RunArguments {
  readonly chapter: number;
  readonly prompt: string;
}

// LiveRuntime 记录 execute 需要单独兜底关闭的运行时；buildAgent 成功后由 Runner 统一释放。
interface LiveRuntime {
  // buildAgent 成功后 dependencies.resources 接管这些对象；失败时 execute 通过显式字段兜底关闭。
  readonly model: OpenAIChatModel;
  readonly dependencies: BuildDependencies;
  readonly worktreeRuntime?: WorktreeRuntime;
  readonly backgroundSupervisor?: JobSupervisor;
  readonly cronRuntime?: CronRuntime;
  readonly teammateRuntime?: TeammateRuntime;
  readonly mcpRuntime?: McpRuntime;
}

// 只接受 --chapter/--prompt；固定章节入口会自动补上 chapter，其他参数立即失败。
function parseRunArguments(argv: readonly string[], fixedChapter?: number): RunArguments {
  const args = fixedChapter === undefined ? argv : ["--chapter", String(fixedChapter), ...argv];
  let chapter: number | undefined;
  let prompt: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--chapter") {
      const value = args[index + 1];
      if (value === undefined || !/^(?:[1-9]|1[0-9]|20)$/.test(value)) {
        throw new Error("--chapter must be an integer from 1 to 20");
      }
      chapter = Number(value);
      index += 1;
      continue;
    }
    if (arg === "--prompt") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error("--prompt must not be empty");
      }
      prompt = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${String(arg)}`);
  }
  if (chapter === undefined || prompt === undefined) {
    throw new Error("Both --chapter and --prompt are required");
  }
  return { chapter, prompt };
}

// execute 负责真实资源生命周期：先创建共享运行时，再运行 Agent，最后按统一失败列表关闭。
async function execute(profile: ChapterProfile, prompt: string): Promise<number> {
  // 先创建一个可追踪的 LiveRuntime，再把同一 dependencies 交给 buildAgent；
  // Runner 接管成功路径，构造失败路径仍能按创建顺序回收已启动资源。
  const workspace = resolve(process.cwd());
  const runtime = createLiveRuntime(profile, workspace);
  const {
    model,
    dependencies,
    worktreeRuntime,
    backgroundSupervisor,
    cronRuntime,
    teammateRuntime,
    mcpRuntime,
  } = runtime;
  let runner: ReturnType<typeof buildAgent> | undefined;
  const failures: unknown[] = [];
  let exitCode: number | undefined;
  try {
    // 在创建任何运行状态前先验证 cwd 是 Git repository root，避免在错误目录留下任务库。
    if (worktreeRuntime !== undefined) await worktreeRuntime.validateRepository();
    runner = buildAgent(profile, dependencies);
    if (teammateRuntime !== undefined) {
      // 队友结果到达 Lead mailbox 后，立即请求独立 event turn。
      teammateRuntime.bindWakeup(async () => {
        if (runner === undefined) {
          throw new Error("Teammate wakeup received before AgentRunner was built");
        }
        await runner.runEvents();
      });
    }
    if (cronRuntime !== undefined) {
      // Cron wakeup 在 runner 就绪后绑定，事件回合由同一个 AgentRunner 消费。
      cronRuntime.bindWakeup(async () => {
        if (runner === undefined) {
          throw new Error("Cron wakeup received before AgentRunner was built");
        }
        await runner.runEvents();
      });
      cronRuntime.start();
    }
    const result = await runner.run(prompt);
    stdout.write(`${result.finalText}\n`);
    exitCode = 0;
  } catch (error) {
    failures.push(error);
  }
  if (runner !== undefined) {
    try {
      await runner.close();
    } catch (error) {
      failures.push(error);
    }
  } else {
    // buildAgent 失败时没有统一 resources，需要按创建顺序兜底关闭。
    for (const resource of [mcpRuntime, teammateRuntime, cronRuntime, backgroundSupervisor]) {
      if (resource === undefined) continue;
      try {
        await resource.close();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  try {
    await model.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "CLI execution or cleanup failed");
  if (exitCode === undefined) throw new Error("CLI execution completed without an exit code");
  return exitCode;
}

// 根据章节能力构造真实运行时，并复用同一个 supervisor、inbox 和 store，避免各运行时持有独立状态。
function createLiveRuntime(profile: ChapterProfile, workspace: string): LiveRuntime {
  // 这是 P20 唯一的真实组合根：所有跨能力共享关系在此建立，返回对象只读以防执行阶段换依赖。
  const envPath = resolve(workspace, ".env");
  const requiresFallback = profile.capabilities.has("recovery");
  const settings = existsSync(envPath)
    ? settingsFromEnvFile(envPath, requiresFallback)
    : settingsFromMapping({}, requiresFallback);
  const model = new OpenAIChatModel(settings);
  const fileSystem = new NodeWorkspaceFileSystem();
  const taskStore =
    profile.capabilities.has("task_dag_json") && !profile.capabilities.has("task_dag_sqlite")
      ? new JsonTaskStore(workspace)
      : undefined;
  // 单个 SqliteTaskStore 同时注入 Lead、Subagent 和 Teammate factory，避免数据库分叉。
  const sqliteTaskStore = profile.capabilities.has("task_dag_sqlite")
    ? new SqliteTaskStore(workspace)
    : undefined;
  // P18 WorktreeRuntime 同时实现 TaskClaimService 与 ToolContextProvider，并复用同一个 SQLite store。
  const worktreeRuntime =
    profile.capabilities.has("worktree") && sqliteTaskStore !== undefined
      ? new WorktreeRuntime({
          workspace,
          store: sqliteTaskStore,
          gitRunner: new SubprocessGitRunner(),
        })
      : undefined;
  // WorkStealingRuntime 与 Worktree 共享 store/claim service，让认领和工具上下文指向同一任务集。
  const workStealingRuntime =
    sqliteTaskStore === undefined
      ? undefined
      : new WorkStealingRuntime({
          store: sqliteTaskStore,
          ...(worktreeRuntime === undefined ? {} : { claimService: worktreeRuntime }),
        });
  // 后台 supervisor 与 EventInbox 是 Cron/Teammate 共用的单一事件源。
  const backgroundSupervisor = profile.capabilities.has("background")
    ? new JobSupervisor({ store: new JsonBackgroundJobStore(workspace), inbox: new EventInbox() })
    : undefined;
  const cronRuntime = profile.capabilities.has("cron")
    ? createCronRuntime(workspace, backgroundSupervisor)
    : undefined;
  const teammateRuntime = profile.capabilities.has("teammate")
    ? createTeammateRuntime(workspace, backgroundSupervisor, cronRuntime)
    : undefined;
  const protocolRuntime =
    profile.capabilities.has("protocol") && teammateRuntime !== undefined
      ? new ProtocolRuntime({
          store: new JsonProtocolStore(workspace),
          team: teammateRuntime,
        })
      : undefined;
  // 协议运行时复用队友的 TeammateRuntime/MailboxStore，请求状态落在独立 JsonProtocolStore。
  // 只有 profile 声明了 mcp 能力时才创建运行时，避免低章额外启动子进程。
  const mcpRuntime = profile.capabilities.has("mcp") ? createMcpRuntime() : undefined;
  const dependencies: BuildDependencies = {
    model,
    workspace,
    fileSystem,
    approvalProvider: new TerminalApprovalProvider(),
    auditSink: new TerminalAuditSink(),
    ...(profile.capabilities.has("hooks") ? { hooks: liveHooks() } : {}),
    ...(requiresFallback
      ? {
          recoveryConfig: new RecoveryConfig({
            primaryModel: settings.model,
            fallbackModel: requiredFallbackModel(settings.fallbackModel),
          }),
        }
      : {}),
    ...(taskStore === undefined ? {} : { taskStore }),
    ...(workStealingRuntime === undefined ? {} : { workStealingRuntime }),
    ...(worktreeRuntime === undefined ? {} : { worktreeRuntime }),
    ...(backgroundSupervisor === undefined ? {} : { backgroundSupervisor }),
    ...(cronRuntime === undefined ? {} : { cronRuntime }),
    ...(teammateRuntime === undefined ? {} : { teammateRuntime }),
    ...(protocolRuntime === undefined ? {} : { protocolRuntime }),
    ...(mcpRuntime === undefined ? {} : { mcpRuntime }),
  };
  return Object.freeze({
    model,
    dependencies,
    ...(worktreeRuntime === undefined ? {} : { worktreeRuntime }),
    ...(backgroundSupervisor === undefined ? {} : { backgroundSupervisor }),
    ...(cronRuntime === undefined ? {} : { cronRuntime }),
    ...(teammateRuntime === undefined ? {} : { teammateRuntime }),
    ...(mcpRuntime === undefined ? {} : { mcpRuntime }),
  });
}

// 本地演示固定连接两个 stdio demo server；远程工具 policy 与 schema 校验都由 CLI 组装注入。
function createMcpRuntime(): McpRuntime {
  // 本地演示允许 allowlist 固定声明四个远程工具及其 effect；生产应由配置提供。
  const policies = Object.freeze([
    new McpToolPolicy({ remoteName: "lookup", effect: "read" }),
    new McpToolPolicy({ remoteName: "fail", effect: "read" }),
    new McpToolPolicy({ remoteName: "delay", effect: "read" }),
    new McpToolPolicy({ remoteName: "terminate", effect: "external" }),
  ]);
  const sourceServerScript = fileURLToPath(new URL("./mcp-servers/demo.ts", import.meta.url));
  const builtServerScript = fileURLToPath(new URL("./mcp-servers/demo.js", import.meta.url));
  const useSourceServer = existsSync(sourceServerScript);
  const serverScript = useSourceServer ? sourceServerScript : builtServerScript;
  const tsxCli = join(dirname(require.resolve("tsx")), "cli.mjs");
  const serverCommand = process.execPath;
  const serverPrefix = useSourceServer ? [tsxCli] : [];
  // 两个 demo server 共用同一组 policy，但 alias 不同，验证同名远程工具经 alias 隔离后不冲突。
  const servers: readonly (readonly [string, string])[] = [
    ["demo_alpha", "alpha"],
    ["demo_beta", "beta"],
  ] as const;
  const specs = servers.map(
    ([alias, label]) =>
      new McpServerSpec({
        alias,
        command: serverCommand,
        args: [...serverPrefix, serverScript, "--label", label],
        toolPolicies: policies,
        startupTimeoutSeconds: 5,
        toolTimeoutSeconds: 5,
      }),
  );
  // stdio adapter 和 Ajv schema validator 由 CLI 组装后注入 McpRuntime。
  return new McpRuntime({
    servers: specs,
    connectionFactory: new StdioMcpConnectionFactory(),
    schemaValidator: new AjvMcpSchemaValidator(),
  });
}

// Cron 复用 supervisor 的 EventInbox，确保周期事件与后台任务进入同一条事件流。
function createCronRuntime(workspace: string, supervisor: JobSupervisor | undefined): CronRuntime {
  if (supervisor === undefined) {
    throw new Error("cron capability requires background supervisor");
  }
  return new CronRuntime({
    store: new JsonCronStore(workspace),
    inbox: supervisor.eventInbox,
    supervisor,
    clock: { now: () => new Date() },
  });
}

// 队友复用后台 supervisor 与 cron 的 inbox/supervisor，避免 mailbox、cron、后台任务各自处理事件。
function createTeammateRuntime(
  workspace: string,
  supervisor: JobSupervisor | undefined,
  cronRuntime: CronRuntime | undefined,
): TeammateRuntime {
  if (supervisor === undefined || cronRuntime === undefined) {
    throw new Error("teammate capability requires background supervisor and cron runtime");
  }
  return new TeammateRuntime({
    store: new FileMailboxStore(workspace),
    inbox: supervisor.eventInbox,
    supervisor,
    cronRuntime,
  });
}

// recovery 必须显式配置 fallback model；缺失时在运行前失败而不是后续降级。
function requiredFallbackModel(fallbackModel: string | undefined): string {
  if (fallbackModel === undefined) {
    throw new ConfigurationError(["OPENAI_FALLBACK_MODEL"]);
  }
  return fallbackModel;
}

// 真实运行 Hook 只输出生命周期事件到 stderr，便于用户确认用户提示、工具调用和停止时机。
function liveHooks(): HookRegistry {
  const hooks = new HookRegistry();
  hooks.register("UserPromptSubmit", () => {
    stderr.write("[Hook] UserPromptSubmit\n");
    return new HookResult();
  });
  hooks.register("PreToolUse", (context: HookContext) => {
    stderr.write(`[Hook] PreToolUse: ${hookToolName(context)}\n`);
    return new HookResult();
  });
  hooks.register("PostToolUse", (context: HookContext) => {
    if (context.result === undefined) {
      throw new Error("PostToolUse context is incomplete");
    }
    const outcome = context.result.isError ? "error" : "ok";
    stderr.write(`[Hook] PostToolUse: ${hookToolName(context)} -> ${outcome}\n`);
    return new HookResult();
  });
  hooks.register("Stop", () => {
    stderr.write("[Hook] Stop\n");
    return new HookResult();
  });
  return hooks;
}

function hookToolName(context: HookContext): string {
  const definition = context.prepared?.definition;
  if (definition === undefined) {
    throw new Error(`${context.event} context is incomplete`);
  }
  return definition.name;
}

export async function runCli(argv: readonly string[]): Promise<number> {
  return runWithErrorHandling(async () => {
    if (argv[0] !== "run") {
      throw new Error("Expected command: run");
    }
    const parsed = parseRunArguments(argv.slice(1));
    return await execute(profileForChapter(parsed.chapter), parsed.prompt);
  });
}

export async function runProfile(
  profile: ChapterProfile,
  argv: readonly string[],
): Promise<number> {
  return runWithErrorHandling(async () => {
    const parsed = parseRunArguments(argv, profile.chapter);
    return await execute(profile, parsed.prompt);
  });
}

// 配置错误与运行失败使用不同退出码，避免调用方把缺失密钥当成普通执行错误。
async function runWithErrorHandling(run: () => Promise<number>): Promise<number> {
  try {
    return await run();
  } catch (error) {
    const label = error instanceof ConfigurationError ? "配置错误" : "运行失败";
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${label}: ${message}\n`);
    return error instanceof ConfigurationError ? 2 : 1;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && fileURLToPath(import.meta.url) === resolve(entryPath)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
