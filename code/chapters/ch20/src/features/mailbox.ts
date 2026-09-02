// mailbox 领域模型：定义持久消息、状态目录与 Store 协议，供 teammate 运行时和文件适配器共用；P16 在其上扩展结构化协议消息。
import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { RuntimeEvent } from "../core/events.js";
import { isWindowsReservedComponent } from "../core/filesystem.js";

// 消息类型决定消费者如何解释 content，但不能改变 mailbox 的持久化协议。
export const MailboxMessageKind = Object.freeze({
  Task: "task",
  Message: "message",
  Result: "result",
});
export type MailboxMessageKind = (typeof MailboxMessageKind)[keyof typeof MailboxMessageKind];

// 协议消息在普通 mailbox 上新增 typed 扩展；request 与 response 的 kind 决定 approved 的取值。
export const ProtocolMessageKind = Object.freeze({
  ShutdownRequest: "shutdown_request",
  ShutdownResponse: "shutdown_response",
  PlanApprovalRequest: "plan_approval_request",
  PlanApprovalResponse: "plan_approval_response",
});
export type ProtocolMessageKind = (typeof ProtocolMessageKind)[keyof typeof ProtocolMessageKind];

// 每个目录名对应一个持久状态；同一条消息只允许在 ready/processing/done/quarantine 之一。
export const MailboxState = Object.freeze({
  Ready: "ready",
  Processing: "processing",
  Done: "done",
  Quarantine: "quarantine",
});
export type MailboxState = (typeof MailboxState)[keyof typeof MailboxState];

// 协议或持久化错误携带稳定 errorCode，工具边界可把它转成结构化 ToolResult。
export class MailboxError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MailboxError";
    this.errorCode = errorCode;
  }
}

// 文件损坏、锁失败和状态迁移冲突统一映射到同一错误族，调用方无需猜测底层异常。
export class MailboxStorageError extends MailboxError {
  constructor(message: string, options?: ErrorOptions) {
    super("mailbox_storage_error", message, options);
    this.name = "MailboxStorageError";
  }
}

// 邮箱消息以稳定 id、发送者和接收者建模，持久层据此保证投递与确认可追踪。
export interface MailboxMessage extends RuntimeEvent {
  readonly id: string;
  readonly sender: string;
  readonly recipient: string;
  readonly kind: MailboxMessageKind;
  readonly content: string;
  readonly createdAtUtc: Date;
  readonly eventId: string;
  readonly idempotencyKey: string;
}

// 协议消息额外携带 requestId 和 approved；request 只接受 null，response 必须携带布尔决策。
export interface ProtocolMailboxMessage extends RuntimeEvent {
  // 传输消息 UUID，同时作为 RuntimeEvent.eventId 和幂等键。
  readonly id: string;
  // 请求方向为原发起者，响应方向为原目标方。
  readonly sender: string;
  // 必须与关联请求的相反方向严格匹配。
  readonly recipient: string;
  // typed kind 决定该消息是请求还是响应，以及对应协议种类。
  readonly kind: ProtocolMessageKind;
  // 请求正文需与已登记 request 一致；响应正文承载反馈或确认。
  readonly content: string;
  // 消息创建时间属于传输记录，不替代请求的状态迁移时间。
  readonly createdAtUtc: Date;
  // 关联 ProtocolStore 中的请求 UUID，而不是当前消息自身 id。
  readonly requestId: string;
  // 请求固定为 null，响应必须为明确 boolean 决策。
  readonly approved: boolean | null;
  // Agent Loop 用该值去重事件发布和 ack 重试。
  readonly eventId: string;
  // 工具执行沿用消息 id，支持协议响应恢复同一 Runner 时去重副作用。
  readonly idempotencyKey: string;
}

// MailboxItem 让普通协作消息与 typed 协议消息共享同一租约状态机。
export type MailboxItem = MailboxMessage | ProtocolMailboxMessage;

// Store 暴露发送、认领和确认的协议操作，具体文件持久化留在适配器。
export interface MailboxStore {
  // 普通消息与协议消息共用同一套四态迁移，Store 不关心 content 的业务含义。
  send(
    sender: string,
    recipient: string,
    content: string,
    kind: MailboxMessageKind,
  ): Promise<MailboxMessage>;
  // claim 将最早 ready 消息原子迁移到 processing，并返回其租约快照。
  claim(recipient: string): Promise<MailboxItem | undefined>;
  // ack 仅接受当前 processing 消息并迁移到 done。
  ack(message: MailboxItem): Promise<boolean>;
  // release 把取消或可重试失败的 processing 消息退回 ready。
  release(message: MailboxItem): Promise<boolean>;
  // quarantine 隔离不可重试的畸形或业务失败消息。
  quarantine(message: MailboxItem): Promise<boolean>;
  // 启动时恢复进程崩溃遗留的 processing 租约，并返回恢复数量。
  recoverProcessing(recipient: string): Promise<number>;
}

// 只有支持协议消息的 store 才实现 sendProtocol；Runtime 在构造边界做类型判定。
export interface ProtocolMailboxStore extends MailboxStore {
  // sendProtocol 在发送时就把 request_id/approved 变成 typed payload，不让模型手工拼 JSON。
  sendProtocol(
    sender: string,
    recipient: string,
    content: string,
    kind: ProtocolMessageKind,
    options: { readonly requestId: string; readonly approved: boolean | null },
  ): Promise<ProtocolMailboxMessage>;
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const AGENT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const spawnTeammateInputSchema = z
  .object({
    name: z.string(),
    role: z.string(),
    prompt: z.string(),
  })
  .strict();
export type SpawnTeammateInput = z.infer<typeof spawnTeammateInputSchema>;

export const sendMessageInputSchema = z
  .object({
    to: z.string(),
    content: z.string(),
  })
  .strict();
export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;

// Agent 名会被用作文件目录名，因此同时校验 slug 规则和 Windows 保留组件。
export function canonicalAgentName(value: string): string {
  if (typeof value !== "string" || !AGENT_NAME.test(value) || isWindowsReservedComponent(value)) {
    throw new Error("Invalid or unsafe Agent name; expected a safe lowercase slug");
  }
  return value;
}

export function canonicalMailboxMessageId(value: string): string {
  // UUID 既是消息主键也是事件 idempotency key，必须使用规范格式。
  if (typeof value !== "string" || !CANONICAL_UUID.test(value)) {
    throw new Error("Mailbox message id must be a canonical UUID");
  }
  return value;
}

// 构造边界统一校验 id、sender、recipient、kind、content 和时钟，返回不可变消息。
export function createMailboxMessage(input: {
  id: string;
  sender: string;
  recipient: string;
  kind: MailboxMessageKind;
  content: string;
  createdAtUtc: Date;
}): MailboxMessage {
  const id = canonicalMailboxMessageId(input.id);
  const sender = canonicalAgentName(input.sender);
  const recipient = canonicalAgentName(input.recipient);
  if (!Object.values(MailboxMessageKind).includes(input.kind)) {
    throw new TypeError("Mailbox message kind must be task, message, or result");
  }
  if (typeof input.content !== "string" || input.content.trim().length === 0) {
    throw new Error("Mailbox message content must not be empty");
  }
  if (!(input.createdAtUtc instanceof Date) || !Number.isFinite(input.createdAtUtc.valueOf())) {
    throw new Error("Mailbox clock value must be a valid UTC Date");
  }
  const createdAtUtc = new Date(input.createdAtUtc.valueOf());
  return Object.freeze({
    id,
    sender,
    recipient,
    kind: input.kind,
    content: input.content,
    createdAtUtc,
    eventId: id,
    idempotencyKey: id,
    toPayload: mailboxPayload,
  });
}

// 协议消息构造边界额外校验 requestId 与 approved 的匹配关系，request 和 response 不能互相伪装。
export function createProtocolMailboxMessage(input: {
  id: string;
  sender: string;
  recipient: string;
  kind: ProtocolMessageKind;
  content: string;
  createdAtUtc: Date;
  requestId: string;
  approved: boolean | null;
}): ProtocolMailboxMessage {
  const id = canonicalMailboxMessageId(input.id);
  const sender = canonicalAgentName(input.sender);
  const recipient = canonicalAgentName(input.recipient);
  const requestId = canonicalMailboxMessageId(input.requestId);
  if (!Object.values(ProtocolMessageKind).includes(input.kind)) {
    throw new TypeError("ProtocolMailboxMessage kind must be a protocol kind");
  }
  if (typeof input.content !== "string" || input.content.trim().length === 0) {
    throw new Error("Mailbox message content must not be empty");
  }
  if (!(input.createdAtUtc instanceof Date) || !Number.isFinite(input.createdAtUtc.valueOf())) {
    throw new Error("Mailbox clock value must be a valid UTC Date");
  }
  const isResponse =
    input.kind === ProtocolMessageKind.ShutdownResponse ||
    input.kind === ProtocolMessageKind.PlanApprovalResponse;
  if (
    (isResponse && typeof input.approved !== "boolean") ||
    (!isResponse && input.approved !== null)
  ) {
    throw new TypeError(
      "Protocol response approved must be a boolean and request approved must be null",
    );
  }
  const createdAtUtc = new Date(input.createdAtUtc.valueOf());
  return Object.freeze({
    id,
    sender,
    recipient,
    kind: input.kind,
    content: input.content,
    createdAtUtc,
    requestId,
    approved: input.approved,
    eventId: id,
    idempotencyKey: id,
    toPayload: protocolMailboxPayload,
  });
}

// 磁盘 JSON 是外部输入，必须拒绝未知字段和非法值，避免坏消息污染运行态。
export function mailboxMessageFromJson(value: unknown): MailboxMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MailboxStorageError("Mailbox message payload is invalid");
  }
  const record = value as Record<string, unknown>;
  const expected = ["content", "created_at_utc", "id", "kind", "recipient", "sender"];
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new MailboxStorageError("Mailbox message payload contains unsupported fields");
  }
  if (
    typeof record.id !== "string" ||
    typeof record.sender !== "string" ||
    typeof record.recipient !== "string" ||
    typeof record.kind !== "string" ||
    typeof record.content !== "string" ||
    typeof record.created_at_utc !== "string"
  ) {
    throw new MailboxStorageError("Mailbox message payload is invalid");
  }
  if (!Object.values(MailboxMessageKind).includes(record.kind as MailboxMessageKind)) {
    throw new MailboxStorageError("Mailbox message kind is invalid");
  }
  const createdAtUtc = new Date(record.created_at_utc);
  if (
    !record.created_at_utc.endsWith("Z") ||
    !Number.isFinite(createdAtUtc.valueOf()) ||
    createdAtUtc.toISOString() !== record.created_at_utc
  ) {
    throw new MailboxStorageError("Mailbox message timestamp is invalid");
  }
  try {
    return createMailboxMessage({
      id: record.id,
      sender: record.sender,
      recipient: record.recipient,
      kind: record.kind as MailboxMessageKind,
      content: record.content,
      createdAtUtc,
    });
  } catch (error) {
    throw new MailboxStorageError("Mailbox message fields failed validation", { cause: error });
  }
}

// 普通与协议消息共用反序列化入口；先按 kind 分流，再走严格字段校验。
export function mailboxItemFromJson(value: unknown): MailboxItem {
  // 联合反序列化先按 kind 分流：普通消息走原 schema，协议消息才允许 request_id/approved。
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MailboxStorageError("Mailbox message payload is invalid");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== "string")
    throw new MailboxStorageError("Mailbox message kind is invalid");
  if (Object.values(MailboxMessageKind).includes(record.kind as MailboxMessageKind)) {
    return mailboxMessageFromJson(record);
  }
  const expected = [
    "approved",
    "content",
    "created_at_utc",
    "id",
    "kind",
    "recipient",
    "request_id",
    "sender",
  ];
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new MailboxStorageError("Protocol mailbox payload contains unsupported fields");
  }
  if (
    typeof record.id !== "string" ||
    typeof record.sender !== "string" ||
    typeof record.recipient !== "string" ||
    typeof record.content !== "string" ||
    typeof record.created_at_utc !== "string" ||
    typeof record.request_id !== "string" ||
    (record.approved !== null && typeof record.approved !== "boolean")
  ) {
    throw new MailboxStorageError("Protocol mailbox payload is invalid");
  }
  const createdAtUtc = new Date(record.created_at_utc);
  if (
    !record.created_at_utc.endsWith("Z") ||
    !Number.isFinite(createdAtUtc.valueOf()) ||
    createdAtUtc.toISOString() !== record.created_at_utc
  ) {
    throw new MailboxStorageError("Mailbox message timestamp is invalid");
  }
  try {
    return createProtocolMailboxMessage({
      id: record.id,
      sender: record.sender,
      recipient: record.recipient,
      kind: record.kind as ProtocolMessageKind,
      content: record.content,
      createdAtUtc,
      requestId: record.request_id,
      approved: record.approved,
    });
  } catch (error) {
    throw new MailboxStorageError("Protocol mailbox fields failed validation", { cause: error });
  }
}

// 持久化使用 snake_case 的稳定字段名，内存对象保持 camelCase，转换只在边界发生。
export function mailboxMessageToJson(message: MailboxMessage): Readonly<Record<string, string>> {
  return Object.freeze({
    id: message.id,
    sender: message.sender,
    recipient: message.recipient,
    kind: message.kind,
    content: message.content,
    created_at_utc: message.createdAtUtc.toISOString(),
  });
}

// 普通与协议消息共用序列化入口；协议字段只在边界出现，避免污染普通消息。
export function mailboxItemToJson(
  message: MailboxItem,
): Readonly<Record<string, string | boolean | null>> {
  if (isProtocolMailboxMessage(message)) {
    return Object.freeze({
      id: message.id,
      sender: message.sender,
      recipient: message.recipient,
      kind: message.kind,
      content: message.content,
      created_at_utc: message.createdAtUtc.toISOString(),
      request_id: message.requestId,
      approved: message.approved,
    });
  }
  return mailboxMessageToJson(message);
}

export function equalMailboxMessages(left: MailboxMessage, right: MailboxMessage): boolean {
  // 幂等 ack 需要按完整消息内容比较，不能只比较 id，否则可能确认了错误的负载。
  return (
    left.id === right.id &&
    left.sender === right.sender &&
    left.recipient === right.recipient &&
    left.kind === right.kind &&
    left.content === right.content &&
    left.createdAtUtc.valueOf() === right.createdAtUtc.valueOf()
  );
}

export function equalMailboxItems(left: MailboxItem, right: MailboxItem): boolean {
  const leftProtocol = isProtocolMailboxMessage(left);
  const rightProtocol = isProtocolMailboxMessage(right);
  if (leftProtocol !== rightProtocol) return false;
  if (!leftProtocol && !rightProtocol) {
    return equalMailboxMessages(left, right);
  }
  const leftProtocolMessage = left as ProtocolMailboxMessage;
  const rightProtocolMessage = right as ProtocolMailboxMessage;
  return (
    leftProtocolMessage.id === rightProtocolMessage.id &&
    leftProtocolMessage.sender === rightProtocolMessage.sender &&
    leftProtocolMessage.recipient === rightProtocolMessage.recipient &&
    leftProtocolMessage.kind === rightProtocolMessage.kind &&
    leftProtocolMessage.content === rightProtocolMessage.content &&
    leftProtocolMessage.createdAtUtc.valueOf() === rightProtocolMessage.createdAtUtc.valueOf() &&
    leftProtocolMessage.requestId === rightProtocolMessage.requestId &&
    leftProtocolMessage.approved === rightProtocolMessage.approved
  );
}

// 通过 payload 的稳定标记识别协议消息，不依赖字符串前缀或鸭子类型字段。
export function isProtocolMailboxMessage(message: RuntimeEvent): message is ProtocolMailboxMessage {
  const payload = message.toPayload();
  return payload.kind === "protocol" && "request_id" in payload && "protocol_kind" in payload;
}

// 构造期用 sendProtocol 能力区分普通 MailboxStore 与协议扩展 store。
export function isProtocolMailboxStore(store: MailboxStore): store is ProtocolMailboxStore {
  return typeof Reflect.get(store, "sendProtocol") === "function";
}

export function randomMailboxMessageId(): string {
  // 默认 id 生成器只在生产构造时使用；测试可注入确定 UUID。
  return randomUUID();
}

// RuntimeEvent 的 payload 暴露结构化字段，避免调用方通过字符串前缀判断消息类型。
function mailboxPayload(this: MailboxMessage): Readonly<Record<string, unknown>> {
  return Object.freeze({
    kind: "mailbox",
    message_id: this.id,
    sender: this.sender,
    recipient: this.recipient,
    message_kind: this.kind,
    content: this.content,
    created_at_utc: this.createdAtUtc.toISOString(),
  });
}

// 协议 payload 额外携带 request_id 与 approved，供 EventInbox 和协议路由区分消息类型。
function protocolMailboxPayload(this: ProtocolMailboxMessage): Readonly<Record<string, unknown>> {
  return Object.freeze({
    kind: "protocol",
    message_id: this.id,
    sender: this.sender,
    recipient: this.recipient,
    protocol_kind: this.kind,
    content: this.content,
    created_at_utc: this.createdAtUtc.toISOString(),
    request_id: this.requestId,
    approved: this.approved,
  });
}
