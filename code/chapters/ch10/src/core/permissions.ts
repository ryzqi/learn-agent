// 权限策略在工具执行前集中裁决，并将最终决策写入审计边界。
import type { WorkspaceWriteBoundary } from "./filesystem.js";
import type { PreparedToolCall, ToolContext, ToolResult } from "./tools.js";
import { toolError } from "./tools.js";

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

// 不可变裁决值；只有最终 deny 才能转成模型可见的工具错误结果。
// 一个不可变的权限结论，记录行为、可解释原因和产生该结论的来源。
export class PermissionDecision {
  // 最终或中间决策行为。
  readonly behavior: PermissionBehavior;
  // 面向审计和模型的非空说明。
  readonly reason: string;
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
  // 已通过工具名称与参数 schema 校验的调用。
  readonly prepared: PreparedToolCall;
  // 本次调用的工作区和身份边界。
  readonly context: ToolContext;
  // 先前参与方给出的不可变候选决策。
  readonly recommendations?: readonly PermissionDecision[];
  // 传给人工审批器的 ask 决策，不能伪装为 allow 或 deny。
  readonly proposedDecision?: PermissionDecision;
}

// 把已校验工具调用、运行时上下文与各参与者建议封装成不可变请求，供规则和审批共同消费。
// 权限策略的输入值对象；只接受有效工具调用以避免权限层承担参数修复职责。
export class PermissionRequest {
  // 仅接受已完成 schema 校验的调用，权限层不负责修复无效工具参数。
  readonly prepared: PreparedToolCall;
  readonly context: ToolContext;
  readonly recommendations: readonly PermissionDecision[];
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
export type PermissionMatcher = (request: PermissionRequest) => boolean;

// 创建一条策略规则所需的静态元数据和匹配函数。
export interface PermissionRuleOptions {
  // 审计和决策 source 使用的稳定规则名。
  readonly name: string;
  // 规则匹配后提出的行为。
  readonly behavior: PermissionBehavior;
  // 规则决策的可解释原因。
  readonly reason: string;
  // 对 PermissionRequest 的匹配条件。
  readonly matches: PermissionMatcher;
}

// 规则由名称、行为、原因和匹配函数组成，不持有工具执行逻辑。
// 不可变的单条权限规则；只提出候选决策，合并优先级由策略统一控制。
export class PermissionRule {
  readonly name: string;
  readonly behavior: PermissionBehavior;
  readonly reason: string;
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

  // 匹配时返回带规则来源的决策；不匹配时返回 undefined 让后续参与方继续判断。
  evaluate(request: PermissionRequest): PermissionDecision | undefined {
    // 匹配不成功时不产生决定，交由后续参与方或默认值处理。
    if (!this.matches(request)) {
      return undefined;
    }
    return new PermissionDecision(this.behavior, this.reason, this.name);
  }
}

export interface ApprovalProvider {
  // 异步边界；异常、非法返回、无终端输入均为 fail-closed 的拒绝理由。
  decide(request: PermissionRequest): Promise<PermissionDecision>;
}

export interface AuditSink {
  // 审计记录在最终决定产生后调用，失败则阻止 handler 执行。
  record(request: PermissionRequest, decision: PermissionDecision): Promise<void>;
}

// 创建 PermissionPolicy 的可选参与方；省略的参与方由默认 fail-closed 规则补齐。
export interface PermissionPolicyOptions {
  // 按顺序评估的静态规则集合。
  readonly rules?: readonly PermissionRule[];
  // 处理 ask 决策的人工或外部审批边界。
  readonly approval?: ApprovalProvider;
  // 最终决策的必经审计边界。
  readonly audit?: AuditSink;
  // 对写路径执行真实路径安全检查的基础设施边界。
  readonly writeBoundary?: WorkspaceWriteBoundary;
}

// 统一合并系统边界、规则和人工审批，并在执行前产出唯一最终决策。
export class PermissionPolicy {
  // 决策顺序固定为工作区边界、匹配规则、默认策略和人工审批。
  readonly #rules: readonly PermissionRule[];
  readonly #approval: ApprovalProvider | undefined;
  readonly #audit: AuditSink | undefined;
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

  // 系统硬边界、默认 shell 审批、规则建议统一按保守优先级合并，再决定是否走人工审批。
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
    candidates.push(...request.recommendations, ...this.#evaluateRules(request));

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

  // 规则异常也 fail-closed，不因单个规则崩溃放行工具调用。
  // 求值全部规则；单条规则异常转为 deny，避免策略缺陷扩大工具权限。
  #evaluateRules(request: PermissionRequest): readonly PermissionDecision[] {
    return this.#rules
      .map((rule) => {
        try {
          return rule.evaluate(request);
        } catch {
          // 单条规则的故障按拒绝处理，防止策略异常造成未审查的副作用。
          return new PermissionDecision("deny", `Permission rule failed: ${rule.name}`, rule.name);
        }
      })
      .filter((decision): decision is PermissionDecision => decision !== undefined);
  }

  // 没有 approval、approval 抛错或返回非法值时都按 deny 处理；只有显式 allow/deny 才被接受。
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

  // 写工具且带 path 时做真实路径边界检查；解析失败按 deny 处理，避免“不知道能不能写”就放行。
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

// 多条建议冲突时选择最保守行为，避免宽松规则覆盖显式拒绝。
// 在冲突候选中选择最保守的 deny、ask、allow；没有候选时返回 passthrough。
function strongestDecision(decisions: readonly PermissionDecision[]): PermissionDecision {
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

// 人工审批没有被明确授予时默认拒绝，避免未配置审批人的 ask 变成放行。
// 缺失、异常或无效的审批响应统一转换为拒绝，保证 ask 永不静默放行。
function implicitApprovalDenial(proposed: PermissionDecision): PermissionDecision {
  // 审批提供者异常或返回无效决策时 fail closed。
  return new PermissionDecision(
    "deny",
    `Approval was not explicitly granted: ${proposed.reason}`,
    "approval",
  );
}

// execute effect 默认需要人工审批，Shell 调用不能由工具自身决定放行。
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
