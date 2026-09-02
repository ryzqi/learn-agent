// 组合根：按章节 profile 选择能力并组装工具、权限、Hook、后台/Cron/队友/协议与 MCP 运行时；P20 以完整 Harness 统一资源边界。
import { NodeWorkspaceFileSystem } from "./adapters/filesystem.js";
import { PowerShellRunner } from "./adapters/powershell.js";
import type { CommandRunner } from "./core/commands.js";
import type { WorkspaceFileSystem } from "./core/filesystem.js";
import { HookRegistry } from "./core/hooks.js";
import { AgentRunner } from "./core/loop.js";
import type { AsyncResource, ToolDispatcher } from "./core/loop.js";
import type { ModelClient } from "./core/model.js";
import type { ApprovalProvider, AuditSink } from "./core/permissions.js";
import { PermissionPolicy, PermissionRule } from "./core/permissions.js";
import type { ChapterProfile } from "./core/profiles.js";
import { profileForChapter } from "./core/profiles.js";
import type { ToolRegistry } from "./core/tools.js";
import { createChapterOneTools, createChapterTwoTools } from "./features/builtin-tools.js";
import {
  BackgroundDispatcher,
  registerBackgroundJobTools,
  type JobSupervisor,
} from "./features/background.js";
import type { CronRuntime } from "./features/cron.js";
import type { TeammateRuntime } from "./features/teammates.js";
import type { ProtocolRuntime } from "./features/protocol.js";
import { CompactionManager, ModelHistorySummarizer } from "./features/compaction.js";
import { MemorySession, MemoryStore, ModelMemoryQueries } from "./features/memory.js";
import {
  DynamicPromptProvider,
  DynamicPromptRenderer,
  type JsonObject,
} from "./features/prompting.js";
import { RecoveryManager } from "./features/recovery.js";
import type { RecoveryConfig } from "./features/recovery.js";
import { SkillRegistry } from "./features/skills.js";
import { SubagentTool } from "./features/subagents.js";
import { registerTaskTools } from "./features/tasks.js";
import type { TaskStore } from "./features/tasks.js";
import {
  registerLeasedTaskTools,
  registerTeammateLeasedTaskTools,
} from "./features/work-stealing.js";
import type { WorkStealingRuntime } from "./features/work-stealing.js";
import { registerWorktreeTools } from "./features/worktrees.js";
import type { WorktreeRuntime } from "./features/worktrees.js";
import { TodoTracker } from "./features/todos.js";
import type { McpRuntime } from "./features/mcp-tools.js";

export const BASE_SYSTEM_PROMPT =
  "You are a coding agent. Use tools when needed, inspect their results, and answer accurately.";
const TODO_SYSTEM_PROMPT =
  "\nFor complex tasks, call todo_write with the complete task snapshot and update it when the plan changes.";
const SKILLS_SYSTEM_PROMPT =
  "\n\nAvailable workspace Skills are listed below. Load one with load_skill only when its instructions are relevant:\n";
const EMPTY_SKILLS_CATALOG = "(No workspace Skills are currently available.)";

// Full Harness 在唯一组装根验证各运行时共享的存储、事件流与关闭责任。
export interface BuildDependencies {
  readonly model: ModelClient;
  readonly workspace: string;
  readonly commandRunner?: CommandRunner;
  readonly fileSystem?: WorkspaceFileSystem;
  readonly approvalProvider?: ApprovalProvider;
  readonly auditSink?: AuditSink;
  readonly hooks?: HookRegistry;
  readonly maxTurns?: number;
  readonly identity?: string;
  readonly recoveryConfig?: RecoveryConfig;
  readonly taskStore?: TaskStore;
  readonly workStealingRuntime?: WorkStealingRuntime;
  readonly worktreeRuntime?: WorktreeRuntime;
  // MCP runtime 由组合根注入；连接与动态工具发布都归入 Runner 的资源生命周期。
  readonly mcpRuntime?: McpRuntime;
  readonly backgroundSupervisor?: JobSupervisor;
  readonly cronRuntime?: CronRuntime;
  readonly teammateRuntime?: TeammateRuntime;
  readonly protocolRuntime?: ProtocolRuntime;
}

// P20 把运行时状态渲染成动态 Prompt 的最后一段 runtime_status。
// 这里只汇总可同步读取的事实：后台是否仍有工作、MCP 当前连接哪些 alias。
// 状态栏不替代 EventInbox：事件仍在请求前消费，状态只帮助模型判断下一轮是否等待。
function fullHarnessRuntimeStatus(dependencies: BuildDependencies): JsonObject {
  // statusProvider 只读取当前快照，不触发连接、任务或事件副作用；动态 Prompt 的职责是观察而非调度。
  const pendingWork =
    dependencies.backgroundSupervisor?.hasPendingWork === true ||
    dependencies.cronRuntime?.hasPendingWork === true ||
    dependencies.teammateRuntime?.hasPendingWork === true;
  const mcpConnections =
    dependencies.mcpRuntime === undefined ? [] : dependencies.mcpRuntime.connectedAliases;
  return Object.freeze({
    mcp_connections: Object.freeze([...mcpConnections]),
    pending_work: pendingWork,
  });
}

// 按固定 profile 组合累计能力，避免任意依赖组合绕过章节契约。
export function buildAgent(profile: ChapterProfile, dependencies: BuildDependencies): AgentRunner {
  // Full Harness 的构造顺序固定为“先验证依赖，再注册工具，最后交给 Runner 托管资源”；
  // 这样任何失败都发生在明确的组合边界内，不会留下半装配的 Agent。
  validateBuildDependencies(profile, dependencies);
  const commandRunner =
    dependencies.commandRunner === undefined ? new PowerShellRunner() : dependencies.commandRunner;
  const fileSystem =
    dependencies.fileSystem === undefined ? new NodeWorkspaceFileSystem() : dependencies.fileSystem;
  const standardTools = createStandardTools(
    profile,
    commandRunner,
    fileSystem,
    profile.capabilities.has("background"),
  );
  const tools = standardTools.tools;
  const todoTracker = standardTools.todoTracker;
  const identity = dependencies.identity === undefined ? "user" : dependencies.identity;
  const dynamicPrompt = profile.capabilities.has("dynamic_prompt");
  const skillRegistry = profile.capabilities.has("skills")
    ? SkillRegistry.scan(dependencies.workspace)
    : undefined;
  const basePermissionPolicy = permissionPolicyForProfile(profile, fileSystem, dependencies);
  const permissionPolicy = basePermissionPolicy;
  const teammatePermissionPolicy =
    dependencies.protocolRuntime === undefined || basePermissionPolicy === undefined
      ? basePermissionPolicy
      : basePermissionPolicy.withRules([dependencies.protocolRuntime.planGateRule]);
  const compactionManager = profile.capabilities.has("compaction")
    ? new CompactionManager({
        workspace: dependencies.workspace,
        summarizer: new ModelHistorySummarizer(dependencies.model),
      })
    : undefined;
  let modelRequestExecutor: RecoveryManager | undefined;
  if (dependencies.recoveryConfig !== undefined) {
    if (compactionManager === undefined) {
      throw new Error("recovery capability requires compaction");
    }
    modelRequestExecutor = new RecoveryManager({
      model: dependencies.model,
      compaction: compactionManager,
      config: dependencies.recoveryConfig,
    });
  }
  const memorySession = profile.capabilities.has("memory")
    ? createMemorySession(dependencies, !dynamicPrompt)
    : undefined;
  const hooks =
    dependencies.hooks === undefined && profile.capabilities.has("hooks")
      ? new HookRegistry()
      : dependencies.hooks;
  if (profile.capabilities.has("subagent")) {
    if (hooks === undefined || permissionPolicy === undefined) {
      throw new Error("subagent capability requires hooks and permission policy");
    }
    const subagent = new SubagentTool({
      modelFactory: () => dependencies.model,
      toolsFactory: () => {
        const childTools = createStandardTools(profile, commandRunner, fileSystem, false).tools;
        if (skillRegistry !== undefined) {
          childTools.register(skillRegistry.toolDefinition);
        }
        if (usesJsonTaskStore(profile) && dependencies.taskStore !== undefined) {
          registerTaskTools(childTools, dependencies.taskStore);
        }
        if (dependencies.workStealingRuntime !== undefined) {
          registerLeasedTaskTools(
            childTools,
            dependencies.workStealingRuntime.store,
            dependencies.workStealingRuntime.claimService,
          );
        }
        return childTools;
      },
      hooks,
      permissionPolicy,
      ...(dependencies.worktreeRuntime === undefined
        ? {}
        : { toolContextProvider: dependencies.worktreeRuntime }),
    });
    tools.register(subagent.toolDefinition);
  }
  if (skillRegistry !== undefined) {
    tools.register(skillRegistry.toolDefinition);
  }
  if (dependencies.taskStore !== undefined) {
    registerTaskTools(tools, dependencies.taskStore);
  }
  if (dependencies.workStealingRuntime !== undefined) {
    // Lead 注册全部任务工具；Teammate 在 factory 内注册无 create_task 的版本。
    registerLeasedTaskTools(
      tools,
      dependencies.workStealingRuntime.store,
      dependencies.workStealingRuntime.claimService,
    );
  }
  if (dependencies.backgroundSupervisor !== undefined) {
    // 主 Agent 注册后台查询与取消工具；子 Agent 不接收后台 Supervisor，因此不暴露这些能力。
    registerBackgroundJobTools(tools, dependencies.backgroundSupervisor);
  }
  if (dependencies.worktreeRuntime !== undefined) {
    registerWorktreeTools(tools, dependencies.worktreeRuntime);
  }
  if (dependencies.cronRuntime !== undefined) {
    tools.register(dependencies.cronRuntime.toolDefinition);
  }
  if (dependencies.teammateRuntime !== undefined) {
    tools.register(dependencies.teammateRuntime.spawnToolDefinition);
    tools.register(dependencies.teammateRuntime.sendToolDefinition);
    if (dependencies.protocolRuntime !== undefined) {
      // Lead 获得 request_shutdown/review_plan；submit_plan 只注册给队友 factory。
      const [requestShutdownTool, reviewPlanTool] =
        dependencies.protocolRuntime.leadToolDefinitions;
      tools.register(requestShutdownTool);
      tools.register(reviewPlanTool);
      // configureProtocol 校验共享依赖，确保协议消息能路由回同一个 MailboxStore。
      dependencies.teammateRuntime.configureProtocol(dependencies.protocolRuntime);
    }
    if (dependencies.workStealingRuntime !== undefined) {
      dependencies.teammateRuntime.configureWorkStealing(dependencies.workStealingRuntime);
    }
    const teammateRuntime = dependencies.teammateRuntime;
    teammateRuntime.configureRunnerFactory((name, role, sendDefinition) => {
      // 持续 Teammate 只获得受限文件/消息工具与协议/任务工具，不暴露 create_task。
      const teammateTools = standardTools.tools.subset(["shell", "read_file", "write_file"]);
      teammateTools.register(sendDefinition);
      if (dependencies.protocolRuntime !== undefined) {
        teammateTools.register(dependencies.protocolRuntime.submitPlanToolDefinition);
      }
      if (dependencies.workStealingRuntime !== undefined) {
        // 队友任务工具使用 worker 专用注册入口，与 Lead 的 create_task 边界保持分离。
        registerTeammateLeasedTaskTools(
          teammateTools,
          dependencies.workStealingRuntime.store,
          dependencies.workStealingRuntime.claimService,
        );
      }
      const teammateCompaction = new CompactionManager({
        workspace: dependencies.workspace,
        summarizer: new ModelHistorySummarizer(dependencies.model),
      });
      const teammateRecovery =
        dependencies.recoveryConfig === undefined
          ? undefined
          : new RecoveryManager({
              model: dependencies.model,
              compaction: teammateCompaction,
              config: dependencies.recoveryConfig,
            });
      return new AgentRunner({
        model: dependencies.model,
        tools: teammateTools,
        systemPrompt: `You are ${name}, serving as ${role}.`,
        workspace: dependencies.workspace,
        identity: name,
        ...(teammatePermissionPolicy === undefined
          ? {}
          : { permissionPolicy: teammatePermissionPolicy }),
        ...(hooks === undefined ? {} : { hooks }),
        historyProcessor: teammateCompaction,
        toolResultProcessor: async (results) =>
          (await teammateCompaction.compactToolResults(results)).results,
        ...(teammateRecovery === undefined ? {} : { modelRequestExecutor: teammateRecovery }),
        ...(dependencies.maxTurns === undefined ? {} : { maxTurns: dependencies.maxTurns }),
        ...(dependencies.worktreeRuntime === undefined
          ? {}
          : { toolContextProvider: dependencies.worktreeRuntime }),
      });
    });
  }
  if (dependencies.mcpRuntime !== undefined) {
    // 管理工具只进入 Lead registry；远程工具在 connect 成功后由 runtime 动态发布。
    dependencies.mcpRuntime.install(tools);
  }
  const toolDispatcher: ToolDispatcher | undefined =
    dependencies.backgroundSupervisor === undefined
      ? undefined
      : new BackgroundDispatcher(tools, dependencies.backgroundSupervisor);
  let systemPrompt =
    todoTracker === undefined ? BASE_SYSTEM_PROMPT : `${BASE_SYSTEM_PROMPT}${TODO_SYSTEM_PROMPT}`;
  if (!dynamicPrompt && skillRegistry !== undefined) {
    const catalog = skillRegistry.renderCatalog();
    systemPrompt = `${systemPrompt}${SKILLS_SYSTEM_PROMPT}${catalog.length === 0 ? EMPTY_SKILLS_CATALOG : catalog}`;
  }
  const systemPromptProvider = dynamicPrompt
    ? new DynamicPromptProvider({
        renderer: new DynamicPromptRenderer(),
        identity: systemPrompt,
        tools,
        workspace: dependencies.workspace,
        context: Object.freeze({ chapter: profile.chapter, identity }),
        ...(profile.capabilities.has("full_harness")
          ? {
              // P20 的状态段参与 DynamicPromptRenderer 缓存键，因此连接或待处理工作变化会让下一次请求重渲染。
              // P20 使用 statusProvider，让 MCP 连接与后台状态在当前请求重新读取，并保持在提示尾部。
              statusProvider: () => fullHarnessRuntimeStatus(dependencies),
            }
          : {}),
        ...(skillRegistry === undefined ? {} : { skills: skillRegistry }),
        ...(memorySession === undefined ? {} : { memory: memorySession }),
      })
    : undefined;
  const eventPump =
    dependencies.teammateRuntime ?? dependencies.cronRuntime ?? dependencies.backgroundSupervisor;
  // 事件泵按队友 > cron > 后台的优先级选择，保证同一轮只有一个消费者。
  // Full Harness 把所有异步运行时交给 AgentRunner 统一管理，关闭时按注册顺序逆序释放。
  const resources: readonly AsyncResource[] = Object.freeze([
    ...(dependencies.backgroundSupervisor === undefined ? [] : [dependencies.backgroundSupervisor]),
    ...(dependencies.cronRuntime === undefined ? [] : [dependencies.cronRuntime]),
    ...(dependencies.teammateRuntime === undefined ? [] : [dependencies.teammateRuntime]),
    ...(dependencies.mcpRuntime === undefined ? [] : [dependencies.mcpRuntime]),
  ]);
  return new AgentRunner({
    model: dependencies.model,
    tools,
    systemPrompt,
    workspace: dependencies.workspace,
    ...(systemPromptProvider === undefined ? {} : { systemPromptProvider }),
    ...(dependencies.identity === undefined ? {} : { identity }),
    ...(permissionPolicy === undefined ? {} : { permissionPolicy }),
    ...(hooks === undefined ? {} : { hooks }),
    ...(todoTracker === undefined ? {} : { toolRoundObserver: todoTracker }),
    ...(compactionManager === undefined
      ? {}
      : {
          historyProcessor: compactionManager,
          toolResultProcessor: async (results) =>
            (await compactionManager.compactToolResults(results)).results,
        }),
    ...(memorySession === undefined ? {} : { turnLifecycle: memorySession }),
    ...(modelRequestExecutor === undefined ? {} : { modelRequestExecutor }),
    ...(toolDispatcher === undefined ? {} : { toolDispatcher }),
    ...(dependencies.worktreeRuntime === undefined
      ? {}
      : { toolContextProvider: dependencies.worktreeRuntime }),
    ...(eventPump === undefined ? {} : { eventPump }),
    ...(resources.length === 0 ? {} : { resources }),
    ...(dependencies.maxTurns === undefined ? {} : { maxTurns: dependencies.maxTurns }),
  });
}

// 组装前的统一契约校验：能力声明和运行时依赖必须精确匹配，避免漏配或混用。
function validateBuildDependencies(profile: ChapterProfile, dependencies: BuildDependencies): void {
  // 这里的引用身份检查是 Full Harness 的装配门禁：同一 store、EventInbox、Cron、队友和 MCP 资源
  // 必须由同一组合根创建，避免“功能都存在但各自持有状态”的假完整实现。
  if (profileForChapter(profile.chapter) !== profile) {
    throw new Error("profile must be a fixed chapter profile");
  }
  if (dependencies.hooks !== undefined && !profile.capabilities.has("hooks")) {
    throw new Error("hooks require chapter 4 or later");
  }
  if (dependencies.recoveryConfig !== undefined && !profile.capabilities.has("recovery")) {
    throw new Error("recoveryConfig requires chapter 11 or later");
  }
  if (profile.capabilities.has("recovery") && dependencies.recoveryConfig === undefined) {
    throw new Error("recoveryConfig is required for chapter 11 or later");
  }
  const requiresJsonTaskStore = usesJsonTaskStore(profile);
  if (requiresJsonTaskStore && dependencies.taskStore === undefined) {
    throw new Error("taskStore is required for chapter 12 or later");
  }
  if (!requiresJsonTaskStore && dependencies.taskStore !== undefined) {
    throw new Error("taskStore requires chapter 12 or later");
  }
  if (
    profile.capabilities.has("task_dag_sqlite") &&
    dependencies.workStealingRuntime === undefined
  ) {
    throw new Error("workStealingRuntime is required for chapter 17 or later");
  }
  if (
    !profile.capabilities.has("task_dag_sqlite") &&
    dependencies.workStealingRuntime !== undefined
  ) {
    throw new Error("workStealingRuntime requires chapter 17 or later");
  }
  if (profile.capabilities.has("worktree") && dependencies.worktreeRuntime === undefined) {
    throw new Error("worktreeRuntime is required for chapter 18 or later");
  }
  if (!profile.capabilities.has("worktree") && dependencies.worktreeRuntime !== undefined) {
    throw new Error("worktreeRuntime requires chapter 18 or later");
  }
  if (profile.capabilities.has("mcp") && dependencies.mcpRuntime === undefined) {
    throw new Error("mcpRuntime is required for chapter 19 or later");
  }
  if (!profile.capabilities.has("mcp") && dependencies.mcpRuntime !== undefined) {
    throw new Error("mcpRuntime requires chapter 19 or later");
  }
  if (
    dependencies.worktreeRuntime !== undefined &&
    (dependencies.workStealingRuntime === undefined ||
      dependencies.workStealingRuntime.store !== dependencies.worktreeRuntime.store ||
      dependencies.workStealingRuntime.claimService !== dependencies.worktreeRuntime)
  ) {
    throw new Error(
      "worktreeRuntime must be the WorkStealingRuntime claim service and share its store",
    );
  }
  if (profile.capabilities.has("background") && dependencies.backgroundSupervisor === undefined) {
    throw new Error("backgroundSupervisor is required for chapter 13 or later");
  }
  if (!profile.capabilities.has("background") && dependencies.backgroundSupervisor !== undefined) {
    throw new Error("backgroundSupervisor requires chapter 13 or later");
  }
  if (profile.capabilities.has("cron") && dependencies.cronRuntime === undefined) {
    throw new Error("cronRuntime is required for chapter 14 or later");
  }
  if (!profile.capabilities.has("cron") && dependencies.cronRuntime !== undefined) {
    throw new Error("cronRuntime requires chapter 14 or later");
  }
  if (
    dependencies.cronRuntime !== undefined &&
    (dependencies.backgroundSupervisor === undefined ||
      dependencies.cronRuntime.supervisor !== dependencies.backgroundSupervisor ||
      dependencies.cronRuntime.eventInbox !== dependencies.backgroundSupervisor.eventInbox)
  ) {
    throw new Error("cronRuntime must share the background supervisor and event inbox");
  }
  if (profile.capabilities.has("teammate") && dependencies.teammateRuntime === undefined) {
    throw new Error("teammateRuntime is required for chapter 15 or later");
  }
  if (!profile.capabilities.has("teammate") && dependencies.teammateRuntime !== undefined) {
    throw new Error("teammateRuntime requires chapter 15 or later");
  }
  if (profile.capabilities.has("protocol") && dependencies.protocolRuntime === undefined) {
    throw new Error("protocolRuntime is required for chapter 16 or later");
  }
  if (!profile.capabilities.has("protocol") && dependencies.protocolRuntime !== undefined) {
    throw new Error("protocolRuntime requires chapter 16 or later");
  }
  if (
    dependencies.protocolRuntime !== undefined &&
    (dependencies.teammateRuntime === undefined ||
      dependencies.protocolRuntime.teamRuntime !== dependencies.teammateRuntime ||
      dependencies.protocolRuntime.mailboxStore !== dependencies.teammateRuntime.mailboxStore)
  ) {
    throw new Error("protocolRuntime must share the teammate runtime and mailbox store");
  }
  if (
    dependencies.teammateRuntime !== undefined &&
    (dependencies.backgroundSupervisor === undefined ||
      dependencies.cronRuntime === undefined ||
      dependencies.teammateRuntime.supervisor !== dependencies.backgroundSupervisor ||
      dependencies.teammateRuntime.eventInbox !== dependencies.backgroundSupervisor.eventInbox ||
      dependencies.teammateRuntime.cronRuntime !== dependencies.cronRuntime)
  ) {
    throw new Error(
      "teammateRuntime must share the background supervisor, EventInbox, and CronRuntime",
    );
  }
}

// JSON 任务存储只在 SQLite DAG 出现前启用；SQLite 章节之后必须用新的 store 契约。
function usesJsonTaskStore(profile: ChapterProfile): boolean {
  return profile.capabilities.has("task_dag_json") && !profile.capabilities.has("task_dag_sqlite");
}

// 记忆会话绑定模型查询器与持久化 store，并决定是否把记忆作为系统提示静态注入。
function createMemorySession(
  dependencies: BuildDependencies,
  emitContextMessages: boolean,
): MemorySession {
  const queries = new ModelMemoryQueries(dependencies.model);
  return new MemorySession({
    store: new MemoryStore({ workspace: dependencies.workspace }),
    selector: queries,
    extractor: queries,
    consolidator: queries,
    emitContextMessages,
  });
}

// 标准工具与可选 TODO 观察器一起返回，组合根负责后续扩展注册。
interface StandardTools {
  readonly tools: ToolRegistry;
  readonly todoTracker?: TodoTracker;
}

function createStandardTools(
  profile: ChapterProfile,
  commandRunner: CommandRunner,
  fileSystem: WorkspaceFileSystem,
  background: boolean,
): StandardTools {
  const tools =
    profile.chapter === 1
      ? createChapterOneTools(commandRunner, background)
      : createChapterTwoTools(commandRunner, fileSystem, background);
  const todoTracker = profile.capabilities.has("todo") ? new TodoTracker() : undefined;
  if (todoTracker === undefined) {
    return Object.freeze({ tools });
  }
  tools.register(todoTracker.toolDefinition);
  return Object.freeze({ tools, todoTracker });
}

// 权限策略只基于工具 effect/name 与工作区写边界声明规则，审批与审计由 CLI/测试注入。
function permissionPolicyForProfile(
  profile: ChapterProfile,
  fileSystem: WorkspaceFileSystem,
  dependencies: BuildDependencies,
): PermissionPolicy | undefined {
  if (!profile.capabilities.has("policy")) {
    return dependencies.approvalProvider === undefined
      ? undefined
      : new PermissionPolicy({ approval: dependencies.approvalProvider });
  }
  if (dependencies.approvalProvider === undefined) {
    throw new Error("approvalProvider is required for chapter 3 or later");
  }
  if (dependencies.auditSink === undefined) {
    throw new Error("auditSink is required for chapter 3 or later");
  }
  return new PermissionPolicy({
    rules: [
      new PermissionRule({
        name: "confirm-file-write",
        behavior: "ask",
        reason: "File writes require explicit approval from chapter 3 onward",
        matches: (request) => {
          const name = request.prepared.definition?.name;
          return name === "write_file" || name === "edit_file";
        },
      }),
    ],
    approval: dependencies.approvalProvider,
    audit: dependencies.auditSink,
    writeBoundary: fileSystem,
  });
}
