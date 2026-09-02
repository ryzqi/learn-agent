// 权限策略在工具执行前集中裁决，并将最终决策写入审计边界；P16 的 plan gate 以不可变规则组合进入队友策略。
import type { WorkspaceWriteBoundary } from "./filesystem.js";
import type { PreparedToolCall, ToolContext, ToolResult } from "./tools.js";
import { toolError } from "./tools.js";

// 权限策略在工具执行前集中裁决，并将最终决策写入审计边界。
// 所有合法决策行为的冻结集合，运行期校验与类型联合共同以它为单一来源。
export const PERMISSION_BEHAVIORS = Object.freeze(["allow", "deny", "ask", "passthrough"] as const);
// 权限参与方可返回的行为：ask 必须经审批收敛，passthrough 最终归为默认 allow。
export type PermissionBehavior = (typeof PERMISSION_BEHAVIORS)[number];

// 权限请求、规则或决策违反领域契约时抛出的稳定错误类型。
export class PermissionContractError extends Error {}

// 在构造边界校验未知值是否为受支持的权限行为。
export function isPermissionBehavior(value: unknown): value is PermissionBehavior {
  // 显式枚举保证新增 behavior 时所有校验点都必须更新。
  return PERMISSION_BEHAVIORS.some((behavior) => behavior === value);
}

// 一个不可变的权限结论，记录行为、可解释原因和产生该结论的来源。
export class PermissionDecision {
  // 最终行为；deny/ask/allow/passthrough 的优先级由策略合并器统一解释。
  // 最终或中间决策行为。
  readonly behavior: PermissionBehavior;
  // 面向用户和审计的稳定理由，不承载异常堆栈。
  // 面向审计和模型的非空说明。
  readonly reason: string;
  // 标识决定来源，便于区分系统边界、规则、审批和默认路径。
  // 规则、审批器或默认策略的稳定来源名。
  readonly source: string;

  // 校验三个决策字段并冻结实例，防止决策在审计和执行之间被篡改。
  constructor(behavior: PermissionBehavior, reason: string, source: string) {
    if (!isPermissionBehavior(behavior)) {
      throw new PermissionContractError("behavior must be a PermissionBehavior");
    }
    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw new PermissionContractError("permission decision reason must not be empty");
    }
    if (typeof source !== "string" || source.trim().length === 0) {
      throw new PermissionContractError("permission decision source must not be empty");
    }
    this.behavior = behavior;
    this.reason = reason;
    this.source = source;
    Object.freeze(this);
  }

  // 仅 allow 表示 handler 可以实际执行；ask/passthrough 不能直接放行。
  get isAllowed(): boolean {
    return this.behavior === "allow";
  }

  // 将最终 deny 转成工具消息；其他中间行为必须由 PermissionPolicy 先收敛。
  toToolResult(): ToolResult {
    // 只有最终拒绝能回填为工具结果；ask 与 passthrough 必须先被策略消解。
    if (this.behavior !== "deny") {
      throw new PermissionContractError("only a final deny decision can become a tool result");
    }
    return toolError("permission_denied", this.reason);
  }
}

// 创建 PermissionRequest 所需的已准备调用、受控上下文和可选上游建议。
export interface PermissionRequestOptions {
  // 已完成 schema 校验且被冻结的调用快照，权限层不能重新解析原始 JSON。
  // 已通过工具名称与参数 schema 校验的调用。
  readonly prepared: PreparedToolCall;
  // workspace 和 identity 决定路径边界与 P16 plan gate 的主体。
  // 本次调用的工作区和身份边界。
  readonly context: ToolContext;
  // Hook 或规则建议，最终仍需经过 strongestDecision 合并。
  // 先前参与方给出的不可变候选决策。
  readonly recommendations?: readonly PermissionDecision[];
  // 当前 ask 决策交给审批器时的候选结论。
  // 传给人工审批器的 ask 决策，不能伪装为 allow 或 deny。
  readonly proposedDecision?: PermissionDecision;
}

// 权限策略的输入值对象；只接受有效工具调用以避免权限层承担参数修复职责。
export class PermissionRequest {
  // 权限决策唯一消费的调用快照。
  // 仅接受已完成 schema 校验的调用，权限层不负责修复无效工具参数。
  readonly prepared: PreparedToolCall;
  // 执行身份和工作区边界，不能由工具输入伪造。
  readonly context: ToolContext;
  // 所有参与者的建议冻结副本，防止审批过程中被修改。
  readonly recommendations: readonly PermissionDecision[];
  // 仅 ask 请求存在；allow/deny 不能伪装成待审批状态。
  readonly proposedDecision: PermissionDecision | undefined;

  // 验证请求状态、复制建议并冻结对象，保证审批与审计看到同一快照。
  constructor(options: PermissionRequestOptions) {
    if (
      options.prepared.error !== undefined ||
      options.prepared.definition === undefined ||
      options.prepared.arguments === undefined
    ) {
      throw new PermissionContractError("permission request requires a valid prepared tool call");
    }
    const recommendations = options.recommendations === undefined ? [] : options.recommendations;
    if (
      !Array.isArray(recommendations) ||
      !recommendations.every((decision) => decision instanceof PermissionDecision)
    ) {
      throw new PermissionContractError("recommendations must contain PermissionDecision values");
    }
    if (
      options.proposedDecision !== undefined &&
      (!(options.proposedDecision instanceof PermissionDecision) ||
        options.proposedDecision.behavior !== "ask")
    ) {
      throw new PermissionContractError("proposedDecision must be an ask PermissionDecision");
    }
    this.prepared = options.prepared;
    this.context = options.context;
    this.recommendations = Object.freeze([...recommendations]);
    this.proposedDecision = options.proposedDecision;
    Object.freeze(this);
  }
}

// 规则的纯匹配谓词；异常由策略视作拒绝而不是放行。
export type PermissionMatcher = (request: PermissionRequest) => boolean | Promise<boolean>;

// 创建一条策略规则所需的静态元数据和匹配函数。
export interface PermissionRuleOptions {
  // 规则名称同时作为审计 source 和异常定位标签。
  // 审计和决策 source 使用的稳定规则名。
  readonly name: string;
  // 匹配后提出的候选行为，最终仍受系统硬边界约束。
  // 规则匹配后提出的行为。
  readonly behavior: PermissionBehavior;
  // 面向审计和审批器的稳定说明。
  // 规则决策的可解释原因。
  readonly reason: string;
  // 根据完整 PermissionRequest 决定规则是否适用。
  // 对 PermissionRequest 的匹配条件。
  readonly matches: PermissionMatcher;
}

// 不可变的单条权限规则；只提出候选决策，合并优先级由策略统一控制。
export class PermissionRule {
  // 冻结规则身份，避免运行中修改 plan gate 的语义。
  readonly name: string;
  // 匹配成功时贡献的候选行为。
  readonly behavior: PermissionBehavior;
  // 匹配成功时写入决策的稳定理由。
  readonly reason: string;
  // 可异步访问协议状态的匹配器。
  readonly matches: PermissionMatcher;

  // 校验规则元数据和回调可调用性，再冻结规则供策略长期复用。
  constructor(options: PermissionRuleOptions) {
    // 规则名称、行为和原因在构造时受类型保护；匹配函数则接受任意运行时检验。
    if (typeof options.name !== "string" || options.name.trim().length === 0) {
      throw new PermissionContractError("permission rule name must not be empty");
    }
    if (!isPermissionBehavior(options.behavior)) {
      throw new PermissionContractError("permission rule behavior must be a PermissionBehavior");
    }
    if (typeof options.reason !== "string" || options.reason.trim().length === 0) {
      throw new PermissionContractError("permission rule reason must not be empty");
    }
    if (typeof options.matches !== "function") {
      throw new PermissionContractError("permission rule matcher must be callable");
    }
    this.name = options.name;
    this.behavior = options.behavior;
    this.reason = options.reason;
    this.matches = options.matches;
    Object.freeze(this);
  }

  async evaluate(request: PermissionRequest): Promise<PermissionDecision | undefined> {
    // matcher 支持异步；规则自身不吞异常，策略层会把异常统一转成 deny。
    if (!(await this.matches(request))) {
      return undefined;
    }
    return new PermissionDecision(this.behavior, this.reason, this.name);
  }
}

export interface ApprovalProvider {
  // 只接收已合并的 ask 请求，必须返回显式 allow 或 deny 才能放行。
  // 异步边界；异常、非法返回、无终端输入均为 fail-closed 的拒绝理由。
  decide(request: PermissionRequest): Promise<PermissionDecision>;
}

export interface AuditSink {
  // 记录最终决策；审计失败由策略调用边界向上暴露。
  // 审计记录在最终决定产生后调用，失败则阻止 handler 执行。
  record(request: PermissionRequest, decision: PermissionDecision): Promise<void>;
}

// 创建 PermissionPolicy 的可选参与方；省略的参与方由默认 fail-closed 规则补齐。
export interface PermissionPolicyOptions {
  // 顺序注册的业务规则，最终按行为强度合并。
  // 按顺序评估的静态规则集合。
  readonly rules?: readonly PermissionRule[];
  // ask 决策的人工或自动审批边界。
  // 处理 ask 决策的人工或外部审批边界。
  readonly approval?: ApprovalProvider;
  // 最终决策的持久审计边界。
  // 最终决策的必经审计边界。
  readonly audit?: AuditSink;
  // write 工具的真实 workspace 路径校验器。
  // 对写路径执行真实路径安全检查的基础设施边界。
  readonly writeBoundary?: WorkspaceWriteBoundary;
}

// 统一合并系统边界、规则和人工审批，并在执行前产出唯一最终决策。
export class PermissionPolicy {
  // 规则冻结快照；withRules 通过新实例追加，避免污染 Lead 策略。
  // 决策顺序固定为工作区边界、匹配规则、默认策略和人工审批。
  readonly #rules: readonly PermissionRule[];
  // 缺失时 ask fail-closed 为 deny。
  readonly #approval: ApprovalProvider | undefined;
  // 可选审计 sink，记录所有最终结论。
  readonly #audit: AuditSink | undefined;
  // 只由 write 工具使用的路径边界适配器。
  readonly #writeBoundary: WorkspaceWriteBoundary | undefined;

  // 验证规则列表并固定所有参与方引用；运行时决策不允许更换策略组成。
  constructor(options: PermissionPolicyOptions = {}) {
    const rules = options.rules === undefined ? [] : options.rules;
    if (!Array.isArray(rules) || !rules.every((rule) => rule instanceof PermissionRule)) {
      throw new PermissionContractError("rules must contain PermissionRule values");
    }
    this.#rules = Object.freeze([...rules]);
    this.#approval = options.approval;
    this.#audit = options.audit;
    this.#writeBoundary = options.writeBoundary;
  }

  // 规则组合返回新策略而不是原地修改；P16 的 plan gate 借此只追加到队友策略，不污染 Lead 策略。
  withRules(rules: readonly PermissionRule[]): PermissionPolicy {
    if (!Array.isArray(rules) || !rules.every((rule) => rule instanceof PermissionRule)) {
      throw new PermissionContractError("rules must contain PermissionRule values");
    }
    return new PermissionPolicy({
      rules: [...this.#rules, ...rules],
      ...(this.#approval === undefined ? {} : { approval: this.#approval }),
      ...(this.#audit === undefined ? {} : { audit: this.#audit }),
      ...(this.#writeBoundary === undefined ? {} : { writeBoundary: this.#writeBoundary }),
    });
  }

  // 按固定优先级计算最终 allow 或 deny；审计失败会向调用方传播并阻止工具执行。
  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    if (!(request instanceof PermissionRequest)) {
      throw new PermissionContractError("request must be a PermissionRequest");
    }
    // 系统硬边界先参与合并，后续 allow 不能覆盖它产生的 deny。
    const candidates: PermissionDecision[] = [];
    const workspaceBoundary = await this.#workspaceBoundaryDecision(request);
    if (workspaceBoundary !== undefined) {
      candidates.push(workspaceBoundary);
    }
    const shellDefault = shellDefaultDecision(request);
    if (shellDefault !== undefined) {
      candidates.push(shellDefault);
    }
    candidates.push(...request.recommendations, ...(await this.#evaluateRules(request)));

    const proposed = strongestDecision(candidates);
    let final: PermissionDecision;
    if (proposed.behavior === "ask") {
      // 人工审批只能将 ask 收敛为 allow 或 deny，不能重新引入中间状态。
      final = await this.#resolveApproval(request, proposed);
    } else if (proposed.behavior === "passthrough") {
      final = new PermissionDecision("allow", "No permission rule blocked the request", "default");
    } else {
      final = proposed;
    }
    if (this.#audit !== undefined) {
      await this.#audit.record(request, final);
    }
    return final;
  }

  async #evaluateRules(request: PermissionRequest): Promise<readonly PermissionDecision[]> {
    // 并行求值全部规则，再按 deny > ask > allow 合并；任一规则异常按 deny fail-closed。
    const results = await Promise.all(
      this.#rules.map(async (rule) => {
        try {
          return await rule.evaluate(request);
        } catch {
          // 单条规则的故障按拒绝处理，防止策略异常造成未审查的副作用。
          return new PermissionDecision("deny", `Permission rule failed: ${rule.name}`, rule.name);
        }
      }),
    );
    return results.filter((decision): decision is PermissionDecision => decision !== undefined);
  }

  async #resolveApproval(
    request: PermissionRequest,
    proposed: PermissionDecision,
  ): Promise<PermissionDecision> {
    if (this.#approval === undefined) {
      return implicitApprovalDenial(proposed);
    }
    const approvalRequest = new PermissionRequest({
      prepared: request.prepared,
      context: request.context,
      recommendations: request.recommendations,
      proposedDecision: proposed,
    });
    let decision: unknown;
    try {
      decision = await this.#approval.decide(approvalRequest);
    } catch {
      return new PermissionDecision("deny", "Approval provider failed; request denied", "approval");
    }
    if (!(decision instanceof PermissionDecision)) {
      return new PermissionDecision(
        "deny",
        "Approval provider returned an invalid decision",
        "approval",
      );
    }
    if (decision.behavior === "allow" || decision.behavior === "deny") {
      return decision;
    }
    return implicitApprovalDenial(proposed);
  }

  async #workspaceBoundaryDecision(
    request: PermissionRequest,
  ): Promise<PermissionDecision | undefined> {
    const definition = request.prepared.definition;
    const argumentsValue = request.prepared.arguments;
    if (definition === undefined || argumentsValue === undefined) {
      throw new PermissionContractError("permission request lost validated tool data");
    }
    if (definition.effect !== "write") {
      return undefined;
    }
    const rawPath = Reflect.get(argumentsValue as object, "path");
    if (rawPath === undefined) {
      return undefined;
    }
    if (typeof rawPath !== "string") {
      return new PermissionDecision("deny", "Write path is invalid", "workspace-boundary");
    }
    if (this.#writeBoundary === undefined) {
      return undefined;
    }
    try {
      // 真实路径解析由组合根注入的文件系统边界完成，core 不依赖具体 adapter。
      const allowed = await this.#writeBoundary.isPathWithinWorkspace(
        request.context.workspace,
        rawPath,
      );
      if (typeof allowed !== "boolean") {
        throw new PermissionContractError("write boundary must return a boolean");
      }
      return allowed
        ? undefined
        : new PermissionDecision(
            "deny",
            "Writing outside the workspace is forbidden",
            "workspace-boundary",
          );
    } catch {
      return new PermissionDecision(
        "deny",
        "Write path could not be resolved safely",
        "workspace-boundary",
      );
    }
  }
}

// 在冲突候选中选择最保守的 deny、ask、allow；没有候选时返回 passthrough。
function strongestDecision(decisions: readonly PermissionDecision[]): PermissionDecision {
  // deny 是系统硬边界，优先级最高；ask 次之；只有没有任何参与者拒绝时才落到 allow。
  // 多条建议冲突时选择最保守行为，避免宽松规则覆盖显式拒绝。
  for (const behavior of ["deny", "ask", "allow"] as const) {
    const decision = decisions.find((candidate) => candidate.behavior === behavior);
    if (decision !== undefined) {
      return decision;
    }
  }
  return new PermissionDecision(
    "passthrough",
    "No permission participant made a decision",
    "default",
  );
}

// 缺失、异常或无效的审批响应统一转换为拒绝，保证 ask 永不静默放行。
function implicitApprovalDenial(proposed: PermissionDecision): PermissionDecision {
  // 审批提供者异常或返回无效决策时 fail closed。
  return new PermissionDecision(
    "deny",
    `Approval was not explicitly granted: ${proposed.reason}`,
    "approval",
  );
}

// 所有 execute 工具的默认候选为 ask，即使没有显式匹配规则也需要人工批准。
function shellDefaultDecision(request: PermissionRequest): PermissionDecision | undefined {
  // 未被规则命中的 execute 工具仍默认要求批准。
  const definition = request.prepared.definition;
  if (definition === undefined) {
    throw new PermissionContractError("permission request lost its tool definition");
  }
  if (definition.effect !== "execute") {
    return undefined;
  }
  return new PermissionDecision("ask", "Shell execution requires approval", "shell-default");
}
