// 协议运行时：把 shutdown/plan_approval 编排为持久 request/response 状态机，并对外提供 Lead 审批与队友计划提交工具。
import { z } from "zod";

import { PermissionRule } from "../core/permissions.js";
import type { PermissionRequest } from "../core/permissions.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../core/tools.js";
import { toolError, toolSuccess } from "../core/tools.js";
import {
  canonicalAgentName,
  canonicalMailboxMessageId,
  isProtocolMailboxStore,
  type MailboxStore,
  type ProtocolMailboxMessage,
  ProtocolMessageKind,
} from "./mailbox.js";
import type { TeammateStatus } from "./teammates.js";

// 协议只支持 shutdown 与 plan_approval 两类；原文孤立的 request_plan 不进入状态机。
export const ProtocolRequestKind = Object.freeze({
  Shutdown: "shutdown",
  PlanApproval: "plan_approval",
});
export type ProtocolRequestKind = (typeof ProtocolRequestKind)[keyof typeof ProtocolRequestKind];
// 请求状态是封闭集合；终态由 resolution 唯一决定，不保留额外分支。
export const ProtocolRequestStatus = Object.freeze({
  Pending: "pending",
  Approved: "approved",
  Rejected: "rejected",
});
export type ProtocolRequestStatus =
  (typeof ProtocolRequestStatus)[keyof typeof ProtocolRequestStatus];

// 协议错误统一携带 errorCode，工具边界和 Mailbox 路由据此区分可重试与不可重试错误。
export class ProtocolError extends Error {
  readonly errorCode: string;
  constructor(errorCode: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProtocolError";
    this.errorCode = errorCode;
  }
}
export class ProtocolStorageError extends ProtocolError {
  constructor(message: string, options?: ErrorOptions) {
    super("protocol_storage_error", message, options);
    this.name = "ProtocolStorageError";
  }
}
export class ProtocolMismatchError extends ProtocolError {
  constructor(message: string, errorCode = "protocol_mismatch") {
    super(errorCode, message);
    this.name = "ProtocolMismatchError";
  }
}
export class ProtocolNotFoundError extends ProtocolMismatchError {
  constructor(message: string) {
    super(message, "protocol_not_found");
    this.name = "ProtocolNotFoundError";
  }
}
export class ProtocolStateError extends ProtocolError {
  constructor(message: string, errorCode = "protocol_state_error") {
    super(errorCode, message);
    this.name = "ProtocolStateError";
  }
}
export class ProtocolExpiredError extends ProtocolStateError {
  constructor(message: string) {
    super(message, "protocol_expired");
    this.name = "ProtocolExpiredError";
  }
}
// 请求已持久化但投递失败时保留 pending 状态，调用方可以诊断，而不是假装请求没有发生。
export class ProtocolDeliveryError extends ProtocolError {
  constructor(message: string, options?: ErrorOptions) {
    super("protocol_delivery_error", message, options);
    this.name = "ProtocolDeliveryError";
  }
}

// resolution 记录“哪个 message 在何时完成审批”，也是同 message 重试幂等判定的证据。
export interface ProtocolResolution {
  // 唯一完成本次请求的响应消息；重试必须携带同一 id 才能幂等返回。
  readonly messageId: string;
  // 结构化审批结论，禁止从自然语言正文推断通过或拒绝。
  readonly approved: boolean;
  // 保留审批反馈或关闭确认文本，供后续提示和审计读取。
  readonly content: string;
  // 状态真正迁移到终态的时刻，而不是响应最初创建的时刻。
  readonly resolvedAtUtc: Date;
}
export interface ProtocolRequest {
  // 协议请求持久化审批状态与唯一 resolution，重启后仍可恢复一致的协作结论。
  // 请求 UUID 同时写入请求与响应 Mailbox 消息，作为二者的关联键。
  readonly id: string;
  // 决定合法消息方向、响应类型以及消费后的业务语义。
  readonly kind: ProtocolRequestKind;
  // 发起请求的一方；shutdown 为 Lead，plan_approval 为队友。
  readonly sender: string;
  // 请求接收方；响应只能沿相反方向返回。
  readonly target: string;
  // pending 才能被消费，approved/rejected 都是不可逆终态。
  readonly status: ProtocolRequestStatus;
  // 请求正文必须与请求消息逐字一致，防止持久状态与传输内容漂移。
  readonly content: string;
  // 创建顺序用于判定某队友的“最新计划”，存储层禁止时钟倒退。
  readonly createdAtUtc: Date;
  // 到期后即使消息仍在 Mailbox，也不得再推进协议状态。
  readonly expiresAtUtc: Date;
  // pending 必须为 null，终态必须携带唯一 resolution。
  readonly resolution: ProtocolResolution | null;
}

// store 是协议请求的状态真相；Runtime 负责先登记请求，再把 typed message 投递到 Mailbox。
export interface ProtocolStore {
  // 先持久化 pending 请求；调用方随后才能投递对应 Mailbox 消息。
  createRequest(input: {
    readonly kind: ProtocolRequestKind;
    readonly sender: string;
    readonly target: string;
    readonly content: string;
  }): Promise<ProtocolRequest>;
  // 返回任意状态请求，供诊断和最终结论读取。
  getRequest(id: string): Promise<ProtocolRequest>;
  // 按创建顺序返回完整快照，不向调用方暴露可变内部数组。
  listRequests(): Promise<readonly ProtocolRequest[]>;
  // 只允许取得尚未解决且未过期的请求，用于 Lead 审批入口。
  getPendingRequest(id: string): Promise<ProtocolRequest>;
  // 计划门禁只依据指定队友最后一次提交的计划状态。
  latestPlanRequest(sender: string): Promise<ProtocolRequest | undefined>;
  // 只读验证请求消息与持久请求完全配对，不迁移状态。
  validateRequest(message: ProtocolMailboxMessage): Promise<ProtocolRequest>;
  // 只读验证响应，供事件进入历史前提前隔离无效消息。
  validateResponse(message: ProtocolMailboxMessage): Promise<ProtocolRequest>;
  // 原子写入 resolution；同一响应可重试，另一响应不得覆盖终态。
  consumeResponse(message: ProtocolMailboxMessage): Promise<ProtocolRequest>;
}

// TeamHost 是协议运行时需要的最小协作宿主，避免依赖完整 TeammateRuntime 实现。
export interface ProtocolTeamHost {
  // 协议构造时校验底层 Store 具备 typed protocol message 能力。
  readonly mailboxStore: MailboxStore;
  // 用于拒绝向 failed/shutdown 队友创建新请求。
  state(name: string): { readonly status: TeammateStatus };
  // 收到 shutdown request 后先封闭队友入口，再发送确认响应。
  beginShutdown(name: string): void;
  // 唯一传输出口，复用参与者校验、注册表串行化与 Lead 唤醒逻辑。
  deliverProtocol(
    sender: string,
    recipient: string,
    content: string,
    kind: ProtocolMessageKind,
    options: {
      readonly requestId: string;
      readonly approved: boolean | null;
      readonly signal?: AbortSignal;
    },
  ): Promise<ProtocolMailboxMessage>;
}

const shutdownInput = z.strictObject({ teammate: z.string() });
const reviewPlanInput = z.strictObject({
  request_id: z.string(),
  approve: z.boolean(),
  feedback: z.string().optional(),
});
const submitPlanInput = z.strictObject({ plan: z.string().min(1) });

export class ProtocolRuntime {
  // Runtime 将计划审批和优雅关闭编排为可验证的 mailbox 请求/响应对。
  readonly #store: ProtocolStore;
  readonly #team: ProtocolTeamHost;
  readonly #leadName: string;
  readonly #planGateRule: PermissionRule;

  constructor(options: {
    readonly store: ProtocolStore;
    readonly team: ProtocolTeamHost;
    readonly leadName?: string;
  }) {
    this.#store = options.store;
    this.#team = options.team;
    this.#leadName = canonicalAgentName(options.leadName ?? "lead");
    if (this.#team.mailboxStore === undefined || !isProtocolMailboxStore(this.#team.mailboxStore)) {
      throw new TypeError("team mailboxStore must support protocol messages");
    }
    // plan gate 作为 deny rule 追加到队友权限策略，运行在 handler 与后台提交之前。
    this.#planGateRule = new PermissionRule({
      name: "plan-approval-gate",
      behavior: "deny",
      reason: "Effectful teammate tools require the latest submitted plan to be approved",
      matches: (request) => this.#requiresPlanApproval(request),
    });
  }
  get teamRuntime(): ProtocolTeamHost {
    // 组合根以对象身份确认协议层与队友层共享同一宿主。
    return this.#team;
  }
  get store(): ProtocolStore {
    // 暴露只读协议状态边界，避免组合层另建平行状态源。
    return this.#store;
  }
  get mailboxStore(): MailboxStore {
    // 协议和普通队友消息必须落入同一个 MailboxStore。
    return this.#team.mailboxStore;
  }
  get planGateRule(): PermissionRule {
    // 队友 Runner 构建权限策略时追加该 deny 规则。
    return this.#planGateRule;
  }
  get leadToolDefinitions(): readonly [
    ToolDefinition<z.infer<typeof shutdownInput>>,
    ToolDefinition<z.infer<typeof reviewPlanInput>>,
  ] {
    // Lead 只获得发起关闭和审批计划两个协议工具。
    return Object.freeze([this.#requestShutdownTool(), this.#reviewPlanTool()]);
  }
  get submitPlanToolDefinition(): ToolDefinition<z.infer<typeof submitPlanInput>> {
    // 队友只获得提交计划工具，不能自行审批或关闭其他队友。
    return this.#submitPlanTool();
  }

  async planAllowsEffectful(sender: string): Promise<boolean> {
    // 只有最新计划已批准才允许副作用；没有计划时保留既有协作行为。
    const latest = await this.#store.latestPlanRequest(canonicalAgentName(sender));
    return latest === undefined || latest.status === ProtocolRequestStatus.Approved;
  }
  // shutdown 只登记并发送结构化请求，不直接销毁 Runner。
  async requestShutdown(teammate: string): Promise<ProtocolRequest> {
    return await this.#createAndDeliver(
      ProtocolRequestKind.Shutdown,
      this.#leadName,
      canonicalAgentName(teammate),
      "Graceful shutdown requested.",
    );
  }
  // 计划由队友主动提交，target 固定为 Lead，等待结构化 approve/reject 响应。
  async submitPlan(sender: string, plan: string): Promise<ProtocolRequest> {
    return await this.#createAndDeliver(
      ProtocolRequestKind.PlanApproval,
      canonicalAgentName(sender),
      this.#leadName,
      requireText(plan, "Plan"),
    );
  }
  // 审批只能针对 pending plan request，且响应只能发送给原提交者。
  async reviewPlan(
    requestId: string,
    approve: boolean,
    feedback = "",
  ): Promise<ProtocolMailboxMessage> {
    // 非规范 UUID 统一按“请求不存在”处理，避免把内部 ID 格式差异暴露给模型。
    let normalizedRequestId: string;
    try {
      normalizedRequestId = canonicalMailboxMessageId(requestId);
    } catch {
      throw new ProtocolNotFoundError("Protocol request id must be a canonical UUID");
    }
    const request = await this.#store.getPendingRequest(normalizedRequestId);
    if (request.kind !== ProtocolRequestKind.PlanApproval || request.target !== this.#leadName)
      throw new ProtocolMismatchError("Request is not a lead plan approval request");
    this.#assertAvailable(request.sender);
    return await this.#deliver(
      this.#leadName,
      request.sender,
      feedback.trim() || (approve ? "Approved" : "Rejected"),
      ProtocolMessageKind.PlanApprovalResponse,
      request.id,
      approve,
    );
  }
  // 队友协议消息在模型调用前确定性处理；shutdown 不进入模型，plan response 再复用同一 Runner。
  async routeTeammateMessage(
    teammate: string,
    message: ProtocolMailboxMessage,
    signal?: AbortSignal,
  ): Promise<{ readonly prompt?: string; readonly shutdown: boolean }> {
    const name = canonicalAgentName(teammate);
    if (message.recipient !== name)
      throw new ProtocolMismatchError("Protocol message recipient does not match teammate");
    if (message.kind === ProtocolMessageKind.ShutdownRequest) {
      const request = await this.#store.validateRequest(message);
      this.#team.beginShutdown(name);
      await this.#deliver(
        name,
        this.#leadName,
        "Ready to shut down.",
        ProtocolMessageKind.ShutdownResponse,
        request.id,
        true,
        signal,
      );
      return Object.freeze({ shutdown: true });
    }
    if (message.kind === ProtocolMessageKind.PlanApprovalResponse) {
      const request = await this.#store.consumeResponse(message);
      return Object.freeze({
        shutdown: false,
        prompt:
          request.status === ProtocolRequestStatus.Approved
            ? `Plan approved (${request.id}). Proceed with the approved plan.`
            : `Plan rejected (${request.id}). Feedback: ${message.content}`,
      });
    }
    throw new ProtocolMismatchError("Protocol message type is not routable to a teammate");
  }
  // drain 阶段只读验证 Lead 协议消息，避免无效或过期消息进入 canonical history。
  async validateLeadMessage(message: ProtocolMailboxMessage): Promise<ProtocolRequest> {
    if (message.recipient !== this.#leadName)
      throw new ProtocolMismatchError("Protocol message recipient does not match the lead");
    if (message.kind === ProtocolMessageKind.PlanApprovalRequest)
      return await this.#store.validateRequest(message);
    if (message.kind === ProtocolMessageKind.ShutdownResponse)
      return await this.#store.validateResponse(message);
    throw new ProtocolMismatchError("Protocol message type is not routable to the lead");
  }
  // ack 阶段才原子消费响应；同 message 重试由 store 幂等返回，另一个 message 会被拒绝。
  async acknowledgeLeadMessage(message: ProtocolMailboxMessage): Promise<ProtocolRequest> {
    if (message.recipient !== this.#leadName)
      throw new ProtocolMismatchError("Protocol message recipient does not match the lead");
    if (message.kind === ProtocolMessageKind.PlanApprovalRequest)
      return await this.#store.validateRequest(message);
    if (message.kind === ProtocolMessageKind.ShutdownResponse)
      return await this.#store.consumeResponse(message);
    throw new ProtocolMismatchError("Protocol message type is not acknowledgeable by the lead");
  }

  // 先登记后发送：发送失败时 pending request 仍保留，供诊断和恢复使用。
  async #createAndDeliver(
    kind: ProtocolRequestKind,
    sender: string,
    target: string,
    content: string,
  ): Promise<ProtocolRequest> {
    this.#assertAvailable(sender === this.#leadName ? target : sender);
    const request = await this.#store.createRequest({ kind, sender, target, content });
    await this.#deliver(
      sender,
      target,
      content,
      kind === ProtocolRequestKind.Shutdown
        ? ProtocolMessageKind.ShutdownRequest
        : ProtocolMessageKind.PlanApprovalRequest,
      request.id,
      null,
    );
    return request;
  }
  // 投递失败包装成 ProtocolDeliveryError，但不回滚已经登记的请求状态。
  async #deliver(
    sender: string,
    recipient: string,
    content: string,
    kind: ProtocolMessageKind,
    requestId: string,
    approved: boolean | null,
    signal?: AbortSignal,
  ): Promise<ProtocolMailboxMessage> {
    try {
      if (signal?.aborted) throw abortError();
      return await this.#team.deliverProtocol(sender, recipient, content, kind, {
        requestId,
        approved,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      throw new ProtocolDeliveryError("Protocol message could not be delivered", { cause: error });
    }
  }
  // failed/shutdown 队友不能再接收新协议请求，避免向不可用 worker 继续投递。
  #assertAvailable(name: string): void {
    let status: string;
    try {
      status = this.#team.state(name).status;
    } catch {
      throw new ProtocolStateError(`Unknown or unavailable teammate: ${name}`);
    }
    if (status === "failed" || status === "shutdown")
      throw new ProtocolStateError(`Teammate ${name} is unavailable`);
  }
  // 只拦截 effectful 工具；read、send_message 与 submit_plan 必须保持可用。
  async #requiresPlanApproval(request: PermissionRequest): Promise<boolean> {
    const definition = request.prepared.definition;
    if (definition === undefined)
      throw new ProtocolStateError("Plan gate lost its tool definition");
    if (
      definition.effect === "read" ||
      definition.name === "send_message" ||
      definition.name === "submit_plan"
    )
      return false;
    return !(await this.planAllowsEffectful(request.context.identity));
  }
  #requestShutdownTool(): ToolDefinition<z.infer<typeof shutdownInput>> {
    // 定义最终由 ToolRegistry 固化，handler 只编排协议，不直接释放资源。
    return {
      // 关机工具只负责登记并投递协议请求；真正收束 Runner 的资源由组合根 close() 完成。
      name: "request_shutdown",
      description: "Request a teammate to finish current work and shut down gracefully.",
      inputSchema: shutdownInput,
      effect: "external",
      handler: async (input) => {
        try {
          return toolSuccess(JSON.stringify(await this.requestShutdown(input.teammate)));
        } catch (error) {
          return protocolToolError(error);
        }
      },
    };
  }
  #reviewPlanTool(): ToolDefinition<z.infer<typeof reviewPlanInput>> {
    // request_id 是审批对象的唯一选择器，approve 是唯一决策来源。
    return {
      // 审批工具必须基于 request_id 定位 pending 请求，不能用模型自由文本猜测目标。
      name: "review_plan",
      description: "Approve or reject a pending teammate plan request.",
      inputSchema: reviewPlanInput,
      effect: "external",
      handler: async (input) => {
        try {
          return toolSuccess(
            JSON.stringify(await this.reviewPlan(input.request_id, input.approve, input.feedback)),
          );
        } catch (error) {
          return protocolToolError(error);
        }
      },
    };
  }
  #submitPlanTool(): ToolDefinition<z.infer<typeof submitPlanInput>> {
    // plan gate 显式放行此 external 工具，避免“未审批不能申请审批”的死锁。
    return {
      // 提交计划工具从 ToolContext.identity 取 sender，工具输入不允许伪造发送者。
      name: "submit_plan",
      description: "Submit a plan to the lead and wait for a structured approval response.",
      inputSchema: submitPlanInput,
      effect: "external",
      handler: async (input, context: ToolContext) => {
        try {
          return toolSuccess(JSON.stringify(await this.submitPlan(context.identity, input.plan)));
        } catch (error) {
          return protocolToolError(error);
        }
      },
    };
  }
}
// 工具结果只暴露稳定 errorCode/message，不把内部异常类型泄露给模型。
function protocolToolError(error: unknown): ToolResult {
  return error instanceof ProtocolError
    ? toolError(error.errorCode, error.message)
    : toolError("protocol_error", "Protocol operation failed");
}
function requireText(value: string, label: string): string {
  // 协议正文统一裁剪并拒绝空白，使持久层和传输层共享稳定文本。
  if (typeof value !== "string" || value.trim().length === 0)
    throw new ProtocolStateError(`${label} must not be empty`);
  return value.trim();
}
function abortError(): DOMException {
  // 标准 AbortError 让传输边界可区分取消与真实投递故障。
  return new DOMException("Protocol delivery was aborted", "AbortError");
}
