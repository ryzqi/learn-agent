// 组合根：按章节能力选择基础设施、工具集、权限策略、Hook、TODO 观察器、Skill 目录、持久任务存储和后台作业 Supervisor。
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

// 固定身份与行为基线；动态渲染时作为 identity section 的起点，非动态时仍为完整 system prompt。
export const BASE_SYSTEM_PROMPT =
  "You are a coding agent. Use tools when needed, inspect their results, and answer accurately.";
// 复杂任务的 TODO 跟踪指令，在动态和非动态模式下都适用。
const TODO_SYSTEM_PROMPT =
  "\nFor complex tasks, call todo_write with the complete task snapshot and update it when the plan changes.";
// Skill 目录插入提示，只在非动态模式下使用；动态模式下由 DynamicPromptRenderer 处理。
const SKILLS_SYSTEM_PROMPT =
  "\n\nAvailable workspace Skills are listed below. Load one with load_skill only when its instructions are relevant:\n";
const EMPTY_SKILLS_CATALOG = "(No workspace Skills are currently available.)";

// P14 要求 Cron 与后台 Supervisor 共享事件收件箱，调度事件沿同一回注路径进入 Loop。
export interface BuildDependencies {
  // 外部边界均可注入，离线测试无需启动真实进程或网络客户端。
  readonly model: ModelClient;
  readonly workspace: string;
  readonly commandRunner?: CommandRunner;
  readonly fileSystem?: WorkspaceFileSystem;
  readonly approvalProvider?: ApprovalProvider;
  readonly auditSink?: AuditSink;
  readonly hooks?: HookRegistry;
  readonly maxTurns?: number;
  // identity 只用作动态 Prompt context 字段；缺省时回退为 "user"。
  readonly identity?: string;
  // recoveryConfig 只在 P11+ 能力位上出现，由 CLI 或测试显式构造。
  readonly recoveryConfig?: RecoveryConfig;
  // taskStore 只在 P12+ 能力位上出现，与任务工具和子 Agent 共享同一持久化图。
  readonly taskStore?: TaskStore;
  // backgroundSupervisor 只在 P13+ 能力位上出现，由 CLI 或测试显式构造。
  readonly backgroundSupervisor?: JobSupervisor;
  // cronRuntime 只在 P14+ 能力位上出现，并必须共享 backgroundSupervisor 的 EventInbox。
  readonly cronRuntime?: CronRuntime;
}

export function buildAgent(profile: ChapterProfile, dependencies: BuildDependencies): AgentRunner {
  if (profileForChapter(profile.chapter) !== profile) {
    // 运行时校验 profile 引用相等性，防止调用方传入损坏或动态构造的 profile。
    throw new Error("profile must be a fixed chapter profile");
  }
  if (dependencies.hooks !== undefined && !profile.capabilities.has("hooks")) {
    // hooks 能力在 P04 之前不可用，调用方传入 hooks 时须同时打开 hooks 能力位。
    throw new Error("hooks require chapter 4 or later");
  }
  if (dependencies.recoveryConfig !== undefined && !profile.capabilities.has("recovery")) {
    throw new Error("recoveryConfig requires chapter 11 or later");
  }
  if (profile.capabilities.has("recovery") && dependencies.recoveryConfig === undefined) {
    // recovery 能力与配置必须成对出现，避免 P11 静默退化成 raw ModelClient。
    throw new Error("recoveryConfig is required for chapter 11 or later");
  }
  if (profile.capabilities.has("task_dag_json") && dependencies.taskStore === undefined) {
    // DAG 能力不能静默降级为内存任务，缺少持久化边界时直接拒绝组装。
    throw new Error("taskStore is required for chapter 12 or later");
  }
  if (!profile.capabilities.has("task_dag_json") && dependencies.taskStore !== undefined) {
    throw new Error("taskStore requires chapter 12 or later");
  }
  if (profile.capabilities.has("background") && dependencies.backgroundSupervisor === undefined) {
    // 后台能力不能静默降级为同步 shell，缺少 Supervisor 时直接拒绝组装。
    throw new Error("backgroundSupervisor is required for chapter 13 or later");
  }
  if (!profile.capabilities.has("background") && dependencies.backgroundSupervisor !== undefined) {
    throw new Error("backgroundSupervisor requires chapter 13 or later");
  }
  if (profile.capabilities.has("cron") && dependencies.cronRuntime === undefined) {
    // Cron 能力不能静默退化为仅后台事件，缺少共享 CronRuntime 时直接拒绝组装。
    throw new Error("cronRuntime is required for chapter 14 or later");
  }
  if (!profile.capabilities.has("cron") && dependencies.cronRuntime !== undefined) {
    throw new Error("cronRuntime requires chapter 14 or later");
  }
  if (
    dependencies.cronRuntime !== undefined &&
    // 拒绝分离的运行时，避免调度完成事件写入无人消费的 Inbox。
    (dependencies.backgroundSupervisor === undefined ||
      dependencies.cronRuntime.supervisor !== dependencies.backgroundSupervisor ||
      dependencies.cronRuntime.eventInbox !== dependencies.backgroundSupervisor.eventInbox)
  ) {
    throw new Error("cronRuntime must share the background supervisor and event inbox");
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
  // identity 缺省 fallback 与 AgentRunner 构造器一致，保证 context 字段始终非空。
  const identity = dependencies.identity === undefined ? "user" : dependencies.identity;
  // dynamic_prompt 开启时由 DynamicPromptProvider 每轮重新渲染系统提示，关闭时回退静态字符串。
  const dynamicPrompt = profile.capabilities.has("dynamic_prompt");
  // 章节组装阶段扫描一次；运行时 load_skill 仍会复查真实路径。
  const skillRegistry = profile.capabilities.has("skills")
    ? SkillRegistry.scan(dependencies.workspace)
    : undefined;
  // 权限策略由 profile 能力位决定；子代理复用同一策略，不能绕过父审批。
  const permissionPolicy = permissionPolicyForProfile(profile, fileSystem, dependencies);
  // 同一压缩管理器同时服务请求历史和工具结果两条边界。
  const compactionManager = profile.capabilities.has("compaction")
    ? new CompactionManager({
        workspace: dependencies.workspace,
        summarizer: new ModelHistorySummarizer(dependencies.model),
      })
    : undefined;
  let modelRequestExecutor: RecoveryManager | undefined;
  // 响应式压缩复用同一个 CompactionManager，保证协议组拆分规则与主动压缩一致。
  if (dependencies.recoveryConfig !== undefined) {
    if (compactionManager === undefined) {
      throw new Error("recovery capability requires compaction");
    }
    // 恢复依赖同一压缩管理器，prompt-too-long 时才能保持协议组完整地缩减历史。
    modelRequestExecutor = new RecoveryManager({
      model: dependencies.model,
      compaction: compactionManager,
      config: dependencies.recoveryConfig,
    });
  }
  // 启用动态 Prompt 时关闭 MemorySession.beforeModel() 的独立消息注入，由 Provider 统一输出记忆正文。
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
    // 子代理在 P06+ 启用，要求 hooks 与 permissionPolicy 共同构成跨 Agent 边界。
    const subagent = new SubagentTool({
      modelFactory: () => dependencies.model,
      toolsFactory: () => {
        const childTools = createStandardTools(profile, commandRunner, fileSystem, false).tools;
        if (skillRegistry !== undefined) {
          // 子代理共享 Skill 元数据快照，但每次创建独立工具注册表，避免跨任务状态泄漏。
          childTools.register(skillRegistry.toolDefinition);
        }
        if (dependencies.taskStore !== undefined) {
          // 子 Agent 与主 Agent 使用同一个 TaskStore，看到的是同一张项目图。
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
    // 主 Agent 固定注册技能工具，保持工具列表顺序稳定。
    tools.register(skillRegistry.toolDefinition);
  }
  if (dependencies.taskStore !== undefined) {
    // 主 Agent 直接注册持久任务工具，与子 Agent 使用同一个 TaskStore。
    registerTaskTools(tools, dependencies.taskStore);
  }
  if (dependencies.backgroundSupervisor !== undefined) {
    // 主 Agent 注册后台查询与取消工具；子 Agent 不接收后台 Supervisor，因此不暴露这些能力。
    registerBackgroundJobTools(tools, dependencies.backgroundSupervisor);
  }
  if (dependencies.cronRuntime !== undefined) {
    // P14 注册 schedule_cron，调度事件经同一 Supervisor/Inbox 回注 Loop。
    tools.register(dependencies.cronRuntime.toolDefinition);
  }
  // 只有 P13 才注入 BackgroundDispatcher；同步章节仍直接调用 ToolRegistry，不改变权限和 Hook 顺序。
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
  // P14 优先使用 CronRuntime 作为事件泵；未启用 Cron 时退回 BackgroundSupervisor。
  const eventPump = dependencies.cronRuntime ?? dependencies.backgroundSupervisor;
  // 资源按注入顺序保存，AgentRunner.close() 逆序关闭；Cron 在 Supervisor 之后注入，因此先关闭。
  const resources: readonly AsyncResource[] = Object.freeze([
    ...(dependencies.backgroundSupervisor === undefined ? [] : [dependencies.backgroundSupervisor]),
    ...(dependencies.cronRuntime === undefined ? [] : [dependencies.cronRuntime]),
  ]);
  return new AgentRunner({
    // 固定 systemPrompt 保留为 fallback；provider 存在时每轮通过 render() 获取渲染结果。
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
          // 请求历史在模型调用前准备；工具结果在回填 canonical history 前经处理器。
          historyProcessor: compactionManager,
          toolResultProcessor: async (results) =>
            (await compactionManager.compactToolResults(results)).results,
        }),
    // 记忆生命周期与请求级压缩互补：压缩改变模型看到的旧历史，记忆在回合边界读写持久层。
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
  // emitContextMessages 为 false 时关闭 MemorySession.beforeModel() 的独立注入。
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
  readonly tools: ToolRegistry;
  readonly todoTracker?: TodoTracker;
}

function createStandardTools(
  profile: ChapterProfile,
  commandRunner: CommandRunner,
  fileSystem: WorkspaceFileSystem,
  background: boolean,
): StandardTools {
  // createStandardTools 封装章节通用工具注册：先创建 shell 与文件工具集，再按 profile 能力决定是否追加 todo 工具。
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
  // permissionPolicyForProfile 根据 profile 的 policy 能力组合权限策略；子代理复用同一套策略。
  if (!profile.capabilities.has("policy")) {
    // 没有 policy 能力时只接受外部注入的 approvalProvider；审计与写边界由外部控制。
    return dependencies.approvalProvider === undefined
      ? undefined
      : new PermissionPolicy({ approval: dependencies.approvalProvider });
  }
  if (dependencies.approvalProvider === undefined) {
    // 有 policy 能力时必须同时提供 approvalProvider，否则干脆断开发起路径。
    throw new Error("approvalProvider is required for chapter 3 or later");
  }
  if (dependencies.auditSink === undefined) {
    // policy 能力要求可审计的决策记录，缺少审计 sink 时拒绝启动。
    throw new Error("auditSink is required for chapter 3 or later");
  }
  return new PermissionPolicy({
    // 只提升写入工具；Shell 的执行审批由策略默认规则统一处理。
    rules: [
      new PermissionRule({
        // 文件写入审批规则：只有 write_file/edit_file 触发确认弹窗。
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
