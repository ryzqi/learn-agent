// 受控 Git Worktree 领域与运行时：把任务租约、分支、目录、执行上下文和清理审计绑定为一条状态链。
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";

import type { ToolContext, ToolDefinition, ToolRegistry, ToolResult } from "../core/tools.js";
import type { ToolContextProvider } from "../core/loop.js";
import { toolError, toolSuccess } from "../core/tools.js";
import { canonicalAgentName } from "./mailbox.js";
import { canonicalTaskId, TaskError, TaskStatus } from "./tasks.js";
import type { TaskCompletion } from "./tasks.js";
import {
  canonicalClaimToken,
  type LeasedTaskStore,
  type TaskClaim,
  type TaskClaimService,
} from "./work-stealing.js";

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const INVALID_REF_CHARACTERS = new Set([" ", "~", "^", ":", "?", "*", "[", "\\"]);

export class GitExecutionError extends Error {
  // 仅表示 Git 进程无法启动或超时；普通非零退出码由结构化结果承载。
  override readonly name = "GitExecutionError";
}

export interface GitCommandResult {
  // 保留退出码与双流，领域层不解析 shell 拼接文本。
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitRunner {
  // 参数数组直接映射 argv，cwd 必须由适配器验证为真实目录。
  run(argumentsValue: readonly string[], cwd: string): Promise<GitCommandResult>;
}

export const WorktreeStatus = Object.freeze({
  RESERVED: "reserved",
  ACTIVE: "active",
  KEPT: "kept",
  NEEDS_REVIEW: "needs_review",
  REMOVED: "removed",
} as const);

export type WorktreeStatus = (typeof WorktreeStatus)[keyof typeof WorktreeStatus];

export const WorktreeAction = Object.freeze({
  RESERVE: "reserve",
  CREATE: "create",
  KEEP: "keep",
  NEEDS_REVIEW: "needs_review",
  REMOVE: "remove",
} as const);

export type WorktreeAction = (typeof WorktreeAction)[keyof typeof WorktreeAction];

export class WorktreeError extends TaskError {
  // 沿用 TaskError 稳定 code，工具边界可直接返回结构化失败。
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = "WorktreeError";
  }
}

export class WorktreeRepositoryError extends WorktreeError {
  // 仓库根、Git 元数据或引用解析不满足受控条件。
  constructor(message: string, options?: ErrorOptions) {
    super("worktree_repository_error", message, options);
    this.name = "WorktreeRepositoryError";
  }
}

export class WorktreeStateError extends WorktreeError {
  // binding 状态、任务状态或迁移前提冲突。
  constructor(message: string, options?: ErrorOptions) {
    super("worktree_invalid_state", message, options);
    this.name = "WorktreeStateError";
  }
}

export class WorktreeGitError extends WorktreeError {
  // Git 命令已执行，但结果不满足领域预期。
  constructor(message: string, options?: ErrorOptions) {
    super("worktree_git_error", message, options);
    this.name = "WorktreeGitError";
  }
}

export class WorktreeContextError extends WorktreeError {
  // 工具上下文缺少 claim/scope 或与当前租约不一致。
  constructor(message: string, options?: ErrorOptions) {
    super("worktree_context_error", message, options);
    this.name = "WorktreeContextError";
  }
}

export interface WorktreeBindingOptions {
  // task/name 唯一确定 branch 与 relativePath，调用方不能自定义任意目录。
  readonly taskId: string;
  readonly name: string;
  readonly branch: string;
  readonly relativePath: string;
  readonly integrationRef: string;
  readonly baselineCommit: string;
  readonly branchTip: string | null;
  readonly status: WorktreeStatus;
  readonly reviewReason: string | null;
  readonly createdAtUtc: Date;
  readonly updatedAtUtc: Date;
}

export class WorktreeBinding {
  // 当前状态快照；SQLite 事件表另行保存不可变历史。
  readonly taskId: string;
  readonly name: string;
  readonly branch: string;
  readonly relativePath: string;
  readonly integrationRef: string;
  readonly baselineCommit: string;
  readonly branchTip: string | null;
  readonly status: WorktreeStatus;
  readonly reviewReason: string | null;
  readonly createdAtUtc: Date;
  readonly updatedAtUtc: Date;

  constructor(options: WorktreeBindingOptions) {
    // 集中校验命名、路径、引用、状态/原因配对与时间单调性，随后冻结实例。
    this.taskId = canonicalTaskId(options.taskId);
    this.name = canonicalAgentName(options.name);
    if (options.branch !== `wt/${this.name}`) {
      throw new WorktreeStateError("Worktree branch must match the managed name");
    }
    if (options.relativePath !== `.agent_tutorial/worktrees/${this.name}`) {
      throw new WorktreeStateError("Worktree path must match the managed name");
    }
    if (!isWorktreeStatus(options.status))
      throw new WorktreeStateError("Worktree status is invalid");
    const reason = normalizeReason(options.reviewReason);
    if (options.status === WorktreeStatus.NEEDS_REVIEW ? reason === null : reason !== null) {
      throw new WorktreeStateError("Worktree review reason does not match its status");
    }
    this.branch = options.branch;
    this.relativePath = options.relativePath;
    this.integrationRef = canonicalIntegrationRef(options.integrationRef);
    this.baselineCommit = canonicalGitObjectId(options.baselineCommit);
    this.branchTip = options.branchTip === null ? null : canonicalGitObjectId(options.branchTip);
    this.status = options.status;
    this.reviewReason = reason;
    this.createdAtUtc = validUtcDate(options.createdAtUtc, "Worktree creation time");
    this.updatedAtUtc = validUtcDate(options.updatedAtUtc, "Worktree update time");
    if (this.updatedAtUtc < this.createdAtUtc) {
      throw new WorktreeStateError("Worktree updatedAtUtc precedes createdAtUtc");
    }
    Object.freeze(this);
  }
}

export interface WorktreeEventOptions {
  // 事件复制当次 binding 关键字段，使审计不依赖后续状态表。
  readonly sequence: number;
  readonly action: WorktreeAction;
  readonly status: WorktreeStatus;
  readonly taskId: string;
  readonly name: string;
  readonly branch: string;
  readonly relativePath: string;
  readonly integrationRef: string;
  readonly baselineCommit: string;
  readonly branchTip: string | null;
  readonly reason: string | null;
  readonly createdAtUtc: Date;
}

export class WorktreeEvent {
  // sequence 由 SQLite 自增生成，action 必须与目标 status 一一对应。
  readonly sequence: number;
  readonly action: WorktreeAction;
  readonly status: WorktreeStatus;
  readonly taskId: string;
  readonly name: string;
  readonly branch: string;
  readonly relativePath: string;
  readonly integrationRef: string;
  readonly baselineCommit: string;
  readonly branchTip: string | null;
  readonly reason: string | null;
  readonly createdAtUtc: Date;

  constructor(options: WorktreeEventOptions) {
    // 复用 WorktreeBinding 校验事件负载，审计表不会接受更宽松的数据。
    if (!Number.isInteger(options.sequence) || options.sequence <= 0) {
      throw new WorktreeStateError("Worktree event sequence must be positive");
    }
    if (!isWorktreeAction(options.action) || !isWorktreeStatus(options.status)) {
      throw new WorktreeStateError("Worktree event action or status is invalid");
    }
    if (eventStatus(options.action) !== options.status) {
      throw new WorktreeStateError("Worktree event action and status do not match");
    }
    const binding = new WorktreeBinding({
      taskId: options.taskId,
      name: options.name,
      branch: options.branch,
      relativePath: options.relativePath,
      integrationRef: options.integrationRef,
      baselineCommit: options.baselineCommit,
      branchTip: options.branchTip,
      status: options.status,
      reviewReason: options.reason,
      createdAtUtc: options.createdAtUtc,
      updatedAtUtc: options.createdAtUtc,
    });
    this.sequence = options.sequence;
    this.action = options.action;
    this.status = options.status;
    this.taskId = binding.taskId;
    this.name = binding.name;
    this.branch = binding.branch;
    this.relativePath = binding.relativePath;
    this.integrationRef = binding.integrationRef;
    this.baselineCommit = binding.baselineCommit;
    this.branchTip = binding.branchTip;
    this.reason = binding.reviewReason;
    this.createdAtUtc = binding.createdAtUtc;
    Object.freeze(this);
  }
}

export interface WorktreeStore extends LeasedTaskStore {
  // task、binding、claim token 与 append-only event 必须由同一原子存储实现。
  reserveWorktree(binding: WorktreeBinding): Promise<WorktreeBinding>;
  activateWorktree(
    taskId: string,
    options: { readonly branchTip: string; readonly occurredAtUtc: Date },
  ): Promise<WorktreeBinding>;
  keepWorktree(
    taskId: string,
    options: { readonly branchTip: string; readonly occurredAtUtc: Date },
  ): Promise<WorktreeBinding>;
  markWorktreeNeedsReview(
    taskId: string,
    options: {
      readonly branchTip: string | null;
      readonly reason: string;
      readonly occurredAtUtc: Date;
    },
  ): Promise<WorktreeBinding>;
  markWorktreeRemoved(
    taskId: string,
    options: { readonly branchTip: string; readonly occurredAtUtc: Date },
  ): Promise<WorktreeBinding>;
  getWorktreeBinding(taskId: string): Promise<WorktreeBinding>;
  listWorktreeEvents(): Promise<readonly WorktreeEvent[]>;
  claimNextBound(owner: string): Promise<TaskClaim | undefined>;
  lookupClaim(claimToken: string): Promise<TaskClaim | undefined>;
}

const taskIdSchema = z.strictObject({ task_id: z.string().uuid().toLowerCase() });
const createWorktreeSchema = z.strictObject({
  task_id: z.string().uuid().toLowerCase(),
  name: z.string().trim().min(1),
  integration_ref: z.string().trim().min(1),
});

// 受控 worktree 将任务、分支和执行上下文绑定，清理无法证明安全时一律转人工审查。
export class WorktreeRuntime implements TaskClaimService, ToolContextProvider {
  // workspaceRoot 固定为仓库根；所有受管路径都由 binding.relativePath 派生。
  readonly #workspaceRoot: string;
  readonly #store: WorktreeStore;
  readonly #git: GitRunner;
  readonly #clock: () => Date;
  // executionScope -> claimToken 映射，同一回复中连续的 tool call 共享此绑定。
  readonly #scopeClaims = new WeakMap<object, string>();
  #repositoryValidated = false;

  constructor(options: {
    readonly workspace: string;
    readonly store: WorktreeStore;
    readonly gitRunner: GitRunner;
    readonly clock?: () => Date;
  }) {
    // 构造时只验证依赖形状；真实仓库检查由 validateRepository 显式执行并缓存。
    if (typeof options.workspace !== "string" || options.workspace.trim().length === 0) {
      throw new TypeError("workspace must be a non-empty string");
    }
    if (!isWorktreeStore(options.store)) throw new TypeError("store must implement WorktreeStore");
    if (typeof options.gitRunner.run !== "function")
      throw new TypeError("gitRunner must implement run()");
    if (options.clock !== undefined && typeof options.clock !== "function") {
      throw new TypeError("clock must be a function");
    }
    this.#workspaceRoot = resolve(options.workspace);
    this.#store = options.store;
    this.#git = options.gitRunner;
    this.#clock = options.clock === undefined ? () => new Date() : options.clock;
  }

  get workspaceRoot(): string {
    // AgentRunner 用该值确认 provider 与初始 workspace 属于同一根。
    return this.#workspaceRoot;
  }

  get store(): WorktreeStore {
    // WorkStealingRuntime 通过引用身份确认 claim service 与 SQLite store 没有分叉。
    return this.#store;
  }

  get leadToolDefinitions(): ReturnType<typeof worktreeToolDefinitions> {
    // 管理工具只注册给 Lead，子执行者只消费已绑定执行目录。
    return worktreeToolDefinitions(this);
  }

  async validateRepository(): Promise<void> {
    // 所有 Worktree 操作的前置门禁：workspace 必须是主仓库真实根目录，
    // 这样 relativePath、.git/common-dir 和后续清理检查才共享同一坐标系。
    // 只接受 Git repository root：Worktree 路径以仓库根为基准，
    // 子目录无法形成可控的隔离边界。验证通过后缓存，避免每次工具调用重复探测。
    if (this.#repositoryValidated) return;
    let root: string;
    try {
      root = await realpath(this.#workspaceRoot);
      if (!(await stat(root)).isDirectory()) throw new Error("workspace is not a directory");
    } catch (error) {
      throw new WorktreeRepositoryError("workspace is not a Git repository", { cause: error });
    }
    const inside = await this.#runGit(["rev-parse", "--is-inside-work-tree"], root);
    if (inside.returncode !== 0 || inside.stdout.trim() !== "true") {
      throw new WorktreeRepositoryError("workspace is not a Git repository");
    }
    const top = await this.#runGit(["rev-parse", "--show-toplevel"], root);
    if (top.returncode !== 0)
      throw new WorktreeRepositoryError("workspace is not a Git repository");
    let repositoryRoot: string;
    try {
      repositoryRoot = await realpath(top.stdout.trim());
    } catch (error) {
      throw new WorktreeRepositoryError("Git repository root could not be resolved", {
        cause: error,
      });
    }
    if (repositoryRoot !== root) {
      throw new WorktreeRepositoryError("workspace is not a Git repository root");
    }
    this.#repositoryValidated = true;
  }

  async createWorktree(input: {
    readonly taskId: string;
    readonly name: string;
    readonly integrationRef: string;
  }): Promise<WorktreeBinding> {
    // 创建流程把持久化 binding 当作意图记录，把 Git 当作外部副作用；
    // 只有 worktree、branch 和 branch tip 全部回读确认后，才允许激活 binding。
    // 跨系统创建不能假装原子：先在 SQLite 持久化 reserved 意图，
    // 再执行 git worktree add；只有 Git 验证成功后事务迁移到 active。
    await this.validateRepository();
    const taskId = canonicalTaskId(input.taskId);
    const name = canonicalAgentName(input.name);
    const integrationRef = canonicalIntegrationRef(input.integrationRef);
    const task = await this.#store.getTask(taskId);
    if (task.status !== TaskStatus.PENDING) {
      throw new WorktreeStateError(
        `Task ${task.id} is ${task.status}; creating a worktree requires pending`,
      );
    }
    const baseline = await this.#resolveCommit(integrationRef, this.#workspaceRoot);
    const now = this.#now();
    const binding = await this.#store.reserveWorktree(
      new WorktreeBinding({
        taskId,
        name,
        branch: `wt/${name}`,
        relativePath: `.agent_tutorial/worktrees/${name}`,
        integrationRef,
        baselineCommit: baseline,
        branchTip: null,
        status: WorktreeStatus.RESERVED,
        reviewReason: null,
        createdAtUtc: now,
        updatedAtUtc: now,
      }),
    );
    const path = await this.#prepareNewWorktreePath(binding);
    const result = await this.#runGit(
      ["worktree", "add", "-b", binding.branch, path, binding.baselineCommit],
      this.#workspaceRoot,
    );
    if (result.returncode !== 0)
      throw new WorktreeGitError("Git could not create the reserved worktree");
    const branchTip = await this.#resolveCommit("HEAD", path);
    const branch = await this.#runGit(["branch", "--show-current"], path);
    if (branch.returncode !== 0 || branch.stdout.trim() !== binding.branch) {
      throw new WorktreeGitError("Git created a worktree with an unexpected branch");
    }
    return await this.#store.activateWorktree(binding.taskId, {
      branchTip,
      occurredAtUtc: this.#now(),
    });
  }

  async keepWorktree(taskId: string): Promise<WorktreeBinding> {
    // 仅处理 completed + active；有未提交修改时转 needs_review。
    // 显式保留已完成任务的 Worktree，供 review 或后续处理；
    // branch tip 无法证明时转 needs_review，不伪造保留成功。
    const binding = await this.#completedBinding(taskId, [WorktreeStatus.ACTIVE]);
    let branchTip: string;
    try {
      const path = await this.#registeredWorktreePath(binding, true);
      branchTip = await this.#resolveCommit("HEAD", path);
    } catch (error) {
      if (!(error instanceof WorktreeError)) throw error;
      return await this.#needsReview(
        binding,
        binding.branchTip,
        "managed worktree path or branch tip could not be resolved",
      );
    }
    return await this.#store.keepWorktree(binding.taskId, {
      branchTip,
      occurredAtUtc: this.#now(),
    });
  }

  async removeWorktree(taskId: string): Promise<WorktreeBinding> {
    // 删除前验证受管路径与 Git 注册表；无法证明安全时保留现场供人工审查。
    // 仅清理已完成、无改动且确认已并入集成分支的工作树，避免删除未交付内容。
    // 清理链路逐步证明：registered path、git status clean、branch tip 已并入
    // integration ref、detach HEAD、删除分支、git worktree remove；
    // 任一步失败都转为 needs_review，保留现场供人工处理。
    const binding = await this.#completedBinding(taskId, [
      WorktreeStatus.ACTIVE,
      WorktreeStatus.KEPT,
      WorktreeStatus.NEEDS_REVIEW,
    ]);
    let path: string;
    try {
      path = await this.#registeredWorktreePath(binding, true);
    } catch (error) {
      if (!(error instanceof WorktreeError)) throw error;
      return await this.#needsReview(
        binding,
        binding.branchTip,
        "managed worktree path is unavailable or escapes the workspace",
      );
    }
    if (!(await this.#isRegisteredWorktree(binding, path))) {
      return await this.#needsReview(
        binding,
        binding.branchTip,
        "managed path is not the registered worktree and branch",
      );
    }
    const status = await this.#runGit(["status", "--porcelain=v1", "--untracked-files=all"], path);
    if (status.returncode !== 0) {
      return await this.#needsReview(
        binding,
        binding.branchTip,
        "git status could not prove the worktree is clean",
      );
    }
    if (status.stdout.length > 0) {
      return await this.#needsReview(
        binding,
        binding.branchTip,
        "worktree has uncommitted changes",
      );
    }
    let branchTip: string;
    let integrationTip: string;
    try {
      branchTip = await this.#resolveCommit("HEAD", path);
      integrationTip = await this.#resolveCommit(binding.integrationRef, this.#workspaceRoot);
    } catch (error) {
      if (!(error instanceof WorktreeError)) throw error;
      return await this.#needsReview(
        binding,
        binding.branchTip,
        "integration ref or branch tip could not be resolved",
      );
    }
    const ancestry = await this.#runGit(
      ["merge-base", "--is-ancestor", branchTip, integrationTip],
      this.#workspaceRoot,
    );
    if (ancestry.returncode !== 0) {
      return await this.#needsReview(
        binding,
        branchTip,
        "worktree branch tip is not contained by the integration ref",
      );
    }
    const detach = await this.#runGit(["switch", "--detach", branchTip], path);
    if (detach.returncode !== 0) {
      return await this.#needsReview(
        binding,
        branchTip,
        "git could not detach the managed worktree",
      );
    }
    const deleteBranch = await this.#runGit(["branch", "-d", binding.branch], this.#workspaceRoot);
    if (deleteBranch.returncode !== 0) {
      return await this.#needsReview(
        binding,
        branchTip,
        "git could not safely delete the integrated branch",
      );
    }
    const removal = await this.#runGit(["worktree", "remove", path], this.#workspaceRoot);
    if (removal.returncode !== 0) {
      return await this.#needsReview(
        binding,
        branchTip,
        "git could not remove the detached worktree",
      );
    }
    return await this.#store.markWorktreeRemoved(binding.taskId, {
      branchTip,
      occurredAtUtc: this.#now(),
    });
  }

  async claimTask(taskId: string, context: ToolContext): Promise<TaskClaim> {
    // 手动认领只允许 active binding，owner 仍由 ToolContext.identity 提供。
    // 手动认领必须落在 active Worktree 上，并把 claimToken 关联到当前 executionScope，
    // 让同一 assistant 回复中后续 tool call 可以直接解析到该 Worktree。
    const binding = await this.#store.getWorktreeBinding(taskId);
    if (binding.status !== WorktreeStatus.ACTIVE) {
      throw new WorktreeStateError(`Task ${binding.taskId} does not have an active worktree`);
    }
    if (context.executionScope === undefined) {
      throw new WorktreeContextError("Task claim requires an execution scope");
    }
    const claim = await this.#store.claimTask(binding.taskId, context.identity);
    this.#scopeClaims.set(context.executionScope, claim.claimToken);
    return claim;
  }

  async claimNext(owner: string): Promise<TaskClaim | undefined> {
    // 自动认领只扫描 active binding 对应的 ready task。
    // 自动认领走 claimNextBound：只挑已有 active binding 的 ready task，
    // 避免 idle polling 绕过 Worktree 约束。
    return await this.#store.claimNextBound(owner);
  }

  async completeTask(
    taskId: string,
    claimToken: string,
    context: ToolContext,
  ): Promise<TaskCompletion> {
    // 完成前先用当前 context 重新解析 claim，再核对显式 task/claimToken；
    // 完成只更新 store，不修改 executionScope；后续调用仍由 resolve() 按租约重新校验。
    const resolved = await this.resolve(context);
    const normalizedTaskId = canonicalTaskId(taskId);
    const normalizedToken = canonicalClaimToken(claimToken);
    if (resolved.taskId !== normalizedTaskId || resolved.claimToken !== normalizedToken) {
      throw new WorktreeContextError("Task completion does not match the resolved execution claim");
    }
    const outcome = await this.#store.completeTask(
      normalizedTaskId,
      context.identity,
      normalizedToken,
    );
    return outcome;
  }

  async resolve(context: ToolContext): Promise<ToolContext> {
    // 优先使用显式 token，其次使用同一 assistant 回复的 executionScope 映射；
    // 成功后只替换 workspace 并补充 task/claim/worktree 字段。
    // 每次工具调用重新解析租约，防止旧 token 或其他身份越过任务的隔离边界。
    // 解析优先级为显式 claimToken、executionScope 映射，最后是无 claim 的主 workspace；
    // 有 claim 时必须通过 owner、task、binding、Worktree 名和路径校验。
    const token = this.#explicitContextToken(context);
    if (!token.required) {
      if (context.taskId !== undefined) {
        throw new WorktreeContextError("Explicit task context does not have an active claim");
      }
      return contextForWorkspace(context, this.#workspaceRoot);
    }
    let claim: TaskClaim | undefined;
    try {
      claim = await this.#store.lookupClaim(token.value);
    } catch (error) {
      if (error instanceof TaskError) {
        throw new WorktreeContextError("Execution claim is no longer active", { cause: error });
      }
      throw error;
    }
    if (claim === undefined) {
      throw new WorktreeContextError("Execution claim does not have a known active lease");
    }
    if (claim.task.owner !== context.identity) {
      throw new WorktreeContextError("Execution identity does not own the active Task claim");
    }
    if (context.taskId !== undefined && context.taskId !== claim.task.id) {
      throw new WorktreeContextError("Execution task does not match the active Task claim");
    }
    const binding = await this.#store.getWorktreeBinding(claim.task.id);
    if (binding.status !== WorktreeStatus.ACTIVE) {
      throw new WorktreeContextError("Active Task claim does not have an active worktree binding");
    }
    if (context.worktreeName !== undefined && context.worktreeName !== binding.name) {
      throw new WorktreeContextError("Execution worktree does not match the active Task binding");
    }
    const path = await this.#registeredWorktreePath(binding, true);
    return Object.freeze({
      ...context,
      workspace: path,
      taskId: claim.task.id,
      claimToken: claim.claimToken,
      worktreeName: binding.name,
    });
  }

  async #completedBinding(
    taskId: string,
    allowed: readonly WorktreeStatus[],
  ): Promise<WorktreeBinding> {
    // 终态操作共用任务 completed 与允许状态检查，避免 keep/remove 各自漂移。
    // 终态操作前统一验证 Task 已 completed 且 binding 处于允许状态。
    await this.validateRepository();
    const normalized = canonicalTaskId(taskId);
    const task = await this.#store.getTask(normalized);
    if (task.status !== TaskStatus.COMPLETED) {
      throw new WorktreeStateError(
        `Task ${task.id} is ${task.status}; worktree finalization requires completed`,
      );
    }
    const binding = await this.#store.getWorktreeBinding(normalized);
    if (!allowed.includes(binding.status)) {
      throw new WorktreeStateError(
        `Worktree binding ${binding.taskId} is ${binding.status}; transition is not allowed`,
      );
    }
    return binding;
  }

  async #needsReview(
    binding: WorktreeBinding,
    branchTip: string | null,
    reason: string,
  ): Promise<WorktreeBinding> {
    // 这是所有“无法证明可安全清理”分支的统一出口；保留现状比伪造迁移更安全，
    // 因此 kept/needs_review 不会被重复改写，active 才会追加审计事件。
    // 清理失败统一落 needs_review；非 active 状态直接保持现状，避免重复或虚构迁移。
    if (binding.status !== WorktreeStatus.ACTIVE) return binding;
    return await this.#store.markWorktreeNeedsReview(binding.taskId, {
      branchTip,
      reason,
      occurredAtUtc: this.#now(),
    });
  }

  async #resolveCommit(reference: string, cwd: string): Promise<string> {
    // `rev-parse --verify <ref>^{commit}` 把分支或标签固定到不可变对象 ID。
    // 用 git rev-parse --verify 固定 commit，避免把任意字符串交给 shell 或弱引用解析。
    const result = await this.#runGit(["rev-parse", "--verify", `${reference}^{commit}`], cwd);
    if (result.returncode !== 0) {
      throw new WorktreeRepositoryError("Git reference could not be resolved to a commit");
    }
    try {
      return canonicalGitObjectId(result.stdout.trim());
    } catch (error) {
      throw new WorktreeRepositoryError("Git returned an invalid commit object ID", {
        cause: error,
      });
    }
  }

  // 用 git rev-parse 核对 worktree 仍登记在主仓库 .git 下，且当前分支与 binding 一致。
  async #isRegisteredWorktree(binding: WorktreeBinding, path: string): Promise<boolean> {
    // 同时核对 path、branch 与 HEAD，不能只凭目录存在认定受管。
    const [top, common, branch] = await Promise.all([
      this.#runGit(["rev-parse", "--show-toplevel"], path),
      this.#runGit(["rev-parse", "--git-common-dir"], path),
      this.#runGit(["branch", "--show-current"], path),
    ]);
    if (top.returncode !== 0 || common.returncode !== 0 || branch.returncode !== 0) return false;
    try {
      const topPath = await realpath(top.stdout.trim());
      const rawCommon = common.stdout.trim();
      const commonPath = await realpath(isAbsolute(rawCommon) ? rawCommon : join(path, rawCommon));
      const expectedCommon = await realpath(join(this.#workspaceRoot, ".git"));
      return (
        topPath === path && commonPath === expectedCommon && branch.stdout.trim() === binding.branch
      );
    } catch {
      return false;
    }
  }

  // Git 子进程启动失败统一转为 returncode -1，让调用方按命令失败处理而不是中断运行。
  async #runGit(argumentsValue: readonly string[], cwd: string): Promise<GitCommandResult> {
    // 适配器异常转换为领域错误，普通非零退出码仍由具体操作解释。
    try {
      return await this.#git.run(argumentsValue, cwd);
    } catch (error) {
      if (error instanceof GitExecutionError) return { returncode: -1, stdout: "", stderr: "" };
      throw error;
    }
  }

  async #prepareNewWorktreePath(binding: WorktreeBinding): Promise<string> {
    // 新建目录必须位于固定根内且尚不存在，父目录创建后再次校验边界。
    // 只创建受管父目录并校验真实路径仍在 workspace 内，目标路径必须尚不存在。
    const path = await this.#registeredWorktreePath(binding, false);
    const parent = join(path, "..");
    try {
      await mkdir(parent, { recursive: true });
      const resolvedParent = await realpath(parent);
      if (resolvedParent !== resolve(parent) || !isWithin(this.#workspaceRoot, resolvedParent)) {
        throw new Error("parent escapes workspace");
      }
    } catch (error) {
      throw new WorktreeStateError("Managed worktree parent could not be created", {
        cause: error,
      });
    }
    try {
      await lstat(path);
      throw new WorktreeStateError("Managed worktree path already exists");
    } catch (error) {
      if (error instanceof WorktreeStateError) throw error;
      if (isNodeError(error, "ENOENT")) return path;
      throw new WorktreeStateError("Managed worktree path could not be inspected", {
        cause: error,
      });
    }
  }

  async #registeredWorktreePath(binding: WorktreeBinding, mustExist: boolean): Promise<string> {
    // 清理和保留操作重新验证真实路径，防止目录被链接替换或逃逸。
    // 从持久化 binding 重建受管路径；mustExist 时再验证目录真实存在且未逃逸 workspace。
    const expected = `.agent_tutorial/worktrees/${binding.name}`;
    if (binding.relativePath !== expected) {
      throw new WorktreeStateError("Persisted worktree path is not managed by this runtime");
    }
    const path = join(this.#workspaceRoot, ".agent_tutorial", "worktrees", binding.name);
    if (!mustExist) return path;
    try {
      const resolved = await realpath(path);
      if (
        !(await stat(resolved)).isDirectory() ||
        resolved !== path ||
        !isWithin(this.#workspaceRoot, resolved)
      ) {
        throw new Error("managed path escapes workspace");
      }
      return resolved;
    } catch (error) {
      throw new WorktreeStateError(
        "Managed worktree path does not exist or escapes the workspace",
        {
          cause: error,
        },
      );
    }
  }

  #explicitContextToken(
    context: ToolContext,
  ): { readonly required: true; readonly value: string } | { readonly required: false } {
    // 显式 token 是跨回复恢复凭据；scope 只在单次 assistant 回复内建立短时关联。
    // 显式 claimToken 优先级最高；executionScope 只作为同一回复内前序认领的短时关联。
    // 两种来源都不存在时返回“非必需”，由 resolve 决定是否回落到主 workspace。
    if (context.claimToken !== undefined) {
      try {
        return { required: true, value: canonicalClaimToken(context.claimToken) };
      } catch (error) {
        throw new WorktreeContextError("Execution claim token is invalid", { cause: error });
      }
    }
    if (context.executionScope !== undefined) {
      const token = this.#scopeClaims.get(context.executionScope);
      if (token !== undefined) return { required: true, value: token };
    }
    return { required: false };
  }

  #now(): Date {
    // 返回时钟副本，状态迁移时间不会被外部修改。
    const value = this.#clock();
    return validUtcDate(value, "Worktree clock");
  }
}

export function worktreeToolDefinitions(
  runtime: WorktreeRuntime,
): readonly [
  ToolDefinition<z.output<typeof createWorktreeSchema>>,
  ToolDefinition<z.output<typeof taskIdSchema>>,
  ToolDefinition<z.output<typeof taskIdSchema>>,
] {
  // create/keep/remove 均为 Lead 管理命令，handler 只转换领域错误。
  return Object.freeze([
    {
      name: "create_worktree",
      description: "Create and bind a managed Git worktree for one pending project task.",
      inputSchema: createWorktreeSchema,
      effect: "external",
      handler: async (input: z.output<typeof createWorktreeSchema>) => {
        try {
          return toolSuccess(
            encodeBinding(
              await runtime.createWorktree({
                taskId: input.task_id,
                name: input.name,
                integrationRef: input.integration_ref,
              }),
            ),
          );
        } catch (error) {
          return worktreeToolError(error);
        }
      },
    },
    {
      name: "keep_worktree",
      description: "Keep a completed task's managed worktree for deliberate follow-up.",
      inputSchema: taskIdSchema,
      effect: "write",
      handler: async (input: z.output<typeof taskIdSchema>) => {
        try {
          return toolSuccess(encodeBinding(await runtime.keepWorktree(input.task_id)));
        } catch (error) {
          return worktreeToolError(error);
        }
      },
    },
    {
      name: "remove_worktree",
      description: "Remove a completed, clean, explicitly integrated managed worktree.",
      inputSchema: taskIdSchema,
      effect: "external",
      handler: async (input: z.output<typeof taskIdSchema>) => {
        try {
          return toolSuccess(encodeBinding(await runtime.removeWorktree(input.task_id)));
        } catch (error) {
          return worktreeToolError(error);
        }
      },
    },
  ] as const);
}

export function registerWorktreeTools(registry: ToolRegistry, runtime: WorktreeRuntime): void {
  // create/keep/remove 三个工具都只操作 runtime，不直接读写 Git 或 SQLite。
  const [create, keep, remove] = worktreeToolDefinitions(runtime);
  registry.register(create);
  registry.register(keep);
  registry.register(remove);
}

// 集成引用必须是显式 refs/... 安全引用，拒绝空格、..、@{ 等可能逃逸 Git 语义的输入。
export function canonicalIntegrationRef(value: string): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !value.startsWith("refs/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{") ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint === undefined || INVALID_REF_CHARACTERS.has(character) || codePoint < 32;
    })
  ) {
    throw new WorktreeStateError("integration_ref must be an explicit safe refs/... Git reference");
  }
  return value;
}

// Git object id 只接受全小写 SHA-1/SHA-256，防止弱校验或字符串拼接导致错误提交。
export function canonicalGitObjectId(value: string): string {
  if (typeof value !== "string" || !OBJECT_ID.test(value)) {
    throw new WorktreeStateError("Git object ID must be a lowercase SHA-1 or SHA-256 hex string");
  }
  return value;
}

function isWorktreeStore(value: unknown): value is WorktreeStore {
  // 依赖最小结构契约，具体持久化实现可替换为测试 double。
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "reserveWorktree") === "function" &&
    typeof Reflect.get(value, "activateWorktree") === "function" &&
    typeof Reflect.get(value, "keepWorktree") === "function" &&
    typeof Reflect.get(value, "markWorktreeNeedsReview") === "function" &&
    typeof Reflect.get(value, "markWorktreeRemoved") === "function" &&
    typeof Reflect.get(value, "getWorktreeBinding") === "function" &&
    typeof Reflect.get(value, "listWorktreeEvents") === "function" &&
    typeof Reflect.get(value, "claimNextBound") === "function" &&
    typeof Reflect.get(value, "lookupClaim") === "function"
  );
}

function isWorktreeStatus(value: unknown): value is WorktreeStatus {
  return Object.values(WorktreeStatus).includes(value as WorktreeStatus);
}

function isWorktreeAction(value: unknown): value is WorktreeAction {
  return Object.values(WorktreeAction).includes(value as WorktreeAction);
}

function eventStatus(action: WorktreeAction): WorktreeStatus {
  // 每个审计动作只对应一个目标状态。
  if (action === WorktreeAction.RESERVE) return WorktreeStatus.RESERVED;
  if (action === WorktreeAction.CREATE) return WorktreeStatus.ACTIVE;
  if (action === WorktreeAction.KEEP) return WorktreeStatus.KEPT;
  if (action === WorktreeAction.NEEDS_REVIEW) return WorktreeStatus.NEEDS_REVIEW;
  return WorktreeStatus.REMOVED;
}

function normalizeReason(value: string | null): string | null {
  // needs_review 必须保留非空原因，其他状态必须为 null。
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorktreeStateError("reviewReason must not be empty");
  }
  return value.trim();
}

// worktree 转换时间统一使用有效 Date，返回副本避免外部修改。
function validUtcDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new WorktreeStateError(`${label} must be a valid Date`);
  }
  return new Date(value.getTime());
}

function contextForWorkspace(context: ToolContext, workspace: string): ToolContext {
  // 创建新冻结对象，不原地修改权限、Hook 与 handler 共享的上下文。
  const {
    taskId: _taskId,
    claimToken: _claimToken,
    worktreeName: _worktreeName,
    ...base
  } = context;
  return Object.freeze({ ...base, workspace });
}

function worktreeToolError(error: unknown): ToolResult {
  // 仅领域错误降级为工具结果，未知编程错误继续抛出。
  if (error instanceof TaskError) return toolError(error.code, error.message);
  throw error;
}

function encodeBinding(binding: WorktreeBinding): string {
  // 工具输出使用 snake_case，日期固定为 UTC ISO 字符串。
  return JSON.stringify({
    baseline_commit: binding.baselineCommit,
    branch: binding.branch,
    branch_tip: binding.branchTip,
    created_at_utc: binding.createdAtUtc.toISOString(),
    integration_ref: binding.integrationRef,
    name: binding.name,
    relative_path: binding.relativePath,
    review_reason: binding.reviewReason,
    status: binding.status,
    task_id: binding.taskId,
    updated_at_utc: binding.updatedAtUtc.toISOString(),
  });
}

// 用相对路径判断候选路径是否仍在根目录内，避免字符串前缀误判。
function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

// 从 fs 错误对象读取 code，区分 ENOENT 等可处理错误。
function isNodeError(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null && Reflect.get(value, "code") === code;
}
