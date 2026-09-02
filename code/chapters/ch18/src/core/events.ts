// 运行时事件协议：后台任务等外部异步结果以 typed RuntimeEvent 进入 EventInbox，再由 Agent Loop 去重后注入历史。
import { userMessage } from "./messages.js";
import type { UserMessage } from "./messages.js";

export interface RuntimeEvent {
  // 事件携带稳定 id 与可选幂等键，供 Loop 去重并将外部结果安全注入下一回合。
  readonly eventId: string;
  readonly contextIdentity?: string;
  readonly idempotencyKey?: string;
  // 把事件转换为模型可见的纯 JSON payload，不能暴露可变运行时对象。
  toPayload(): Readonly<Record<string, unknown>>;
}

// 验证来自共享运行时边界的事件最小契约。
export function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const eventId = Reflect.get(value, "eventId");
  const toPayload = Reflect.get(value, "toPayload");
  const contextIdentity = Reflect.get(value, "contextIdentity");
  const idempotencyKey = Reflect.get(value, "idempotencyKey");
  return (
    typeof eventId === "string" &&
    eventId.trim().length > 0 &&
    typeof toPayload === "function" &&
    (contextIdentity === undefined ||
      (typeof contextIdentity === "string" && contextIdentity.trim().length > 0)) &&
    (idempotencyKey === undefined ||
      (typeof idempotencyKey === "string" && idempotencyKey.trim().length > 0))
  );
}

export class EventInbox {
  // Inbox 是运行时到 Agent Loop 的单向队列；drain 保持 FIFO 并一次移交所有权。
  readonly #events: RuntimeEvent[] = [];
  readonly #waiters: Array<() => void> = [];

  // 发布事件并唤醒所有等待者；事件所有权随后交给 Inbox。
  publish(event: RuntimeEvent): void {
    if (!isRuntimeEvent(event)) {
      throw new TypeError("EventInbox only accepts RuntimeEvent values");
    }
    this.#events.push(event);
    for (const resolve of this.#waiters.splice(0)) {
      resolve();
    }
  }

  // 按 FIFO 非阻塞取走事件；limit 缺省为当前完整批次。
  drain(limit?: number): readonly RuntimeEvent[] {
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      throw new Error("limit must be a positive integer or undefined");
    }
    const count = limit === undefined ? this.#events.length : Math.min(limit, this.#events.length);
    return Object.freeze(this.#events.splice(0, count));
  }

  // 队列为空时阻塞，出现事件后按同一 drain 规则移交所有权。
  async wait(limit?: number): Promise<readonly RuntimeEvent[]> {
    while (this.#events.length === 0) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    return this.drain(limit);
  }
}

// 将外部事件包装成普通 user message；它不伪造 tool_call_id。
export function runtimeEventMessage(event: RuntimeEvent): UserMessage {
  // 事件以普通 user 消息进入历史，但不伪装成 tool result，也不携带 tool_call_id。
  if (!isRuntimeEvent(event)) {
    throw new TypeError("event must be a RuntimeEvent");
  }
  return userMessage(
    JSON.stringify({ runtime_event: event.toPayload() }, (_key, value: unknown) => value),
  );
}
