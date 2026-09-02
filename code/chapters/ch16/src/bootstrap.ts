// 组合根：按章节能力选择基础设施、工具集、权限策略、Hook、TODO 观察器、Skill 目录、持久任务存储和后台作业 Supervisor；P16 追加协议运行时与 plan gate。
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
import { DynamicPromptProvider, DynamicPromptRenderer } from "./features/prompting.js";
import { RecoveryManager } from "./features/recovery.js";
import type { RecoveryConfig } from "./features/recovery.js";
import { SkillRegistry } from "./features/skills.js";
import { SubagentTool } from "./features/subagents.js";
import { registerTaskTools } from "./features/tasks.js";
import type { TaskStore } from "./features/tasks.js";
import { TodoTracker } from "./features/todos.js";

export const BASE_SYSTEM_PROMPT =
  "You are a coding agent. Use tools when needed, inspect their results, and answer accurately.";
const TODO_SYSTEM_PROMPT =
  "\nFor complex tasks, call todo_write with the complete task snapshot and update it when the plan changes.";
const SKILLS_SYSTEM_PROMPT =
  "\n\nAvailable workspace Skills are listed below. Load one with load_skill only when its instructions are relevant:\n";
const EMPTY_SKILLS_CATALOG = "(No workspace Skills are currently available.)";

// P16 将协议运行时的 plan gate 追加到队友权限策略，不能由 Hook 绕过。
export interface BuildDependencies {
  // 模型调用与摘要、恢复、队友 Runner 共用的外部模型边界。
  readonly model: ModelClient;
  // 所有文件、状态和持久化适配器使用的工作区根。
  readonly workspace: string;
  // Shell 工具的执行适配器；未注入时由组合根创建默认实现。
  readonly commandRunner?: CommandRunner;
  // 文件工具的 workspace 边界适配器。
  readonly fileSystem?: WorkspaceFileSystem;
  // ask 权限的审批边界，P03+ 缺失时策略 fail-closed。
  readonly approvalProvider?: ApprovalProvider;
  // 最终权限决策的审计边界。
  readonly auditSink?: AuditSink;
  // 生命周期 Hook 注册表，只有具备 hooks 能力的 profile 才允许注入。
  readonly hooks?: HookRegistry;
  // Agent Loop 单次运行允许的最大模型回合数。
  readonly maxTurns?: number;
  // 当前 Agent 身份，用于工具上下文和动态 Prompt。
  readonly identity?: string;
  // P11+ 恢复与 fallback 模型的统一 deadline 配置。
  readonly recoveryConfig?: RecoveryConfig;
  // P12+ 任务工具使用的持久化任务图。
  readonly taskStore?: TaskStore;
  // P13+ 后台作业 supervisor，与事件 Inbox 共享生命周期。
  readonly backgroundSupervisor?: JobSupervisor;
  // P14+ Cron runtime，与 supervisor 共享事件泵。
  readonly cronRuntime?: CronRuntime;
  // P15+ 队友 runtime，Lead 与每名队友共享 mailbox 传输。
  readonly teammateRuntime?: TeammateRuntime;
  // P16 唯一协议编排实例；必须绑定同一个 teammateRuntime 与 MailboxStore。
  readonly protocolRuntime?: ProtocolRuntime;
}

export function buildAgent(profile: ChapterProfile, dependencies: BuildDependencies): AgentRunner {
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
  if (profile.capabilities.has("task_dag_json") && dependencies.taskStore === undefined) {
    throw new Error("taskStore is required for chapter 12 or later");
  }
  if (!profile.capabilities.has("task_dag_json") && dependencies.taskStore !== undefined) {
    throw new Error("taskStore requires chapter 12 or later");
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
  // P16 的协议能力必须显式注入 ProtocolRuntime，旧章节也不允许误带协议依赖。
  if (profile.capabilities.has("protocol") && dependencies.protocolRuntime === undefined) {
    throw new Error("protocolRuntime is required for chapter 16 or later");
  }
  if (!profile.capabilities.has("protocol") && dependencies.protocolRuntime !== undefined) {
    throw new Error("protocolRuntime requires chapter 16 or later");
  }
  // 协议与队友必须共享同一个 TeammateRuntime 和 MailboxStore，否则请求与投递会写向不同状态。
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
  // plan gate 只追加到队友权限策略；Lead 仍使用原策略，避免 Lead 的工具被协议状态误拦。
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
        if (dependencies.taskStore !== undefined) {
          registerTaskTools(childTools, dependencies.taskStore);
        }
        return childTools;
      },
      hooks,
      permissionPolicy,
    });
    tools.register(subagent.toolDefinition);
  }
  if (skillRegistry !== undefined) {
    tools.register(skillRegistry.toolDefinition);
  }
  if (dependencies.taskStore !== undefined) {
    registerTaskTools(tools, dependencies.taskStore);
  }
  if (dependencies.backgroundSupervisor !== undefined) {
    // 主 Agent 注册后台查询与取消工具；子 Agent 不接收后台 Supervisor，因此不暴露这些能力。
    registerBackgroundJobTools(tools, dependencies.backgroundSupervisor);
  }
  if (dependencies.cronRuntime !== undefined) {
    tools.register(dependencies.cronRuntime.toolDefinition);
  }
  // 注册 Lead 协议工具，并让 TeammateRuntime 在启动前绑定 ProtocolRuntime。
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
    const teammateRuntime = dependencies.teammateRuntime;
    teammateRuntime.configureRunnerFactory((name, role, sendDefinition) => {
      const teammateTools = standardTools.tools.subset(["shell", "read_file", "write_file"]);
      teammateTools.register(sendDefinition);
      if (dependencies.protocolRuntime !== undefined) {
        // 队友只多一个 submit_plan，不能获得 Lead 审批/关机工具。
        teammateTools.register(dependencies.protocolRuntime.submitPlanToolDefinition);
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
      });
    });
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
        ...(skillRegistry === undefined ? {} : { skills: skillRegistry }),
        ...(memorySession === undefined ? {} : { memory: memorySession }),
      })
    : undefined;
  const eventPump =
    dependencies.teammateRuntime ?? dependencies.cronRuntime ?? dependencies.backgroundSupervisor;
  // 资源按注入顺序的逆序释放：Teammate 先于 Cron，Cron 再先于 JobSupervisor。
  const resources: readonly AsyncResource[] = Object.freeze([
    ...(dependencies.backgroundSupervisor === undefined ? [] : [dependencies.backgroundSupervisor]),
    ...(dependencies.cronRuntime === undefined ? [] : [dependencies.cronRuntime]),
    ...(dependencies.teammateRuntime === undefined ? [] : [dependencies.teammateRuntime]),
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
    ...(eventPump === undefined ? {} : { eventPump }),
    ...(resources.length === 0 ? {} : { resources }),
    ...(dependencies.maxTurns === undefined ? {} : { maxTurns: dependencies.maxTurns }),
  });
}

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

interface StandardTools {
  // 按 profile 裁剪后的标准工具注册表快照。
  readonly tools: ToolRegistry;
  // P05+ 的 TODO 状态器，缺失表示本章不暴露 TODO 能力。
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

function permissionPolicyForProfile(
  profile: ChapterProfile,
  fileSystem: WorkspaceFileSystem,
  dependencies: BuildDependencies,
): PermissionPolicy | undefined {
  // 未启用 policy 的章节仍可注入 approvalProvider，但不会引入规则和 audit 的硬依赖。
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
