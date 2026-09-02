import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  isChatMessage,
  systemMessage,
  toolMessage,
  validateToolPairing,
} from "../core/messages.js";
import type { ChatMessage } from "../core/messages.js";
import type { ModelClient } from "../core/model.js";
import { copyToolResult, isToolResult, toolSuccess } from "../core/tools.js";
import type { ToolResult } from "../core/tools.js";

// 默认预算均按 UTF-8 byte 计算；集中为常量便于测试注入小预算。
// 单个工具结果超过此 UTF-8 字节数时优先落盘并只回填引用预览。
export const DEFAULT_PERSIST_THRESHOLD_BYTES = 30_000;
// 同一轮结果允许留在上下文中的总预算，超出部分按大小优先持久化。
export const DEFAULT_BATCH_BUDGET_BYTES = 200_000;
// 工具结果引用保留的头部预览字节数。
export const DEFAULT_PREVIEW_HEAD_BYTES = 2_000;
// 工具结果引用保留的尾部预览字节数。
export const DEFAULT_PREVIEW_TAIL_BYTES = 2_000;
// 微压缩时保留的最近完整工具交换组数量。
export const DEFAULT_KEEP_RECENT_TOOL_GROUPS = 3;
// prompt-too-long 响应式压缩后保留的最近消息组数量。
export const DEFAULT_REACTIVE_TAIL_GROUPS = 5;
// 请求历史超过此预算时，在模型调用前主动生成摘要。
export const DEFAULT_PROACTIVE_THRESHOLD_BYTES = 50_000;
// snip 压缩允许保留的最大消息组数。
export const DEFAULT_SNIP_MAX_GROUPS = 50;
// snip 压缩保留的最早消息组数，用于保留任务开端上下文。
export const DEFAULT_SNIP_KEEP_HEAD_GROUPS = 3;
export const COMPACTED_TOOL_RESULT = "[Earlier tool result compacted. Re-run if needed.]";

// 默认阈值均按 UTF-8 byte 计算；集中为常量便于测试注入小预算。
// 默认预算统一放在模块顶部：字节阈值按 UTF-8 byte，组数按完整消息组；测试可注入小值。
const SUMMARY_SYSTEM_PROMPT = `请将当前 Agent 历史压缩为一个 JSON object。
只能返回 JSON，不得调用工具。JSON 必须且只能包含：
current_goal: 非空字符串；
key_findings: 字符串数组；
files_read_or_changed: 字符串数组；
remaining_work: 字符串数组；
user_constraints: 字符串数组。`;
const ARTIFACT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ARTIFACT_ID_LENGTH = 96;

// 压缩层把超长结果移出模型上下文，但保留可追溯的 workspace artifact 引用。
// 压缩领域错误的公共基类，调用方按子类决定是拒绝、清理还是重试。
export class CompactionError extends Error {
  override readonly name: string = "CompactionError";
}

// artifact 路径或目录不满足安全边界，例如 ID 非法、符号链接逃逸。
export class ArtifactPathError extends CompactionError {
  override readonly name: string = "ArtifactPathError";
}

// 目标 artifact 已存在；独占发布失败时不覆盖旧文件。
export class ArtifactConflictError extends CompactionError {
  override readonly name: string = "ArtifactConflictError";
}

// 同一恢复窗口内已经尝试过 prompt-too-long 压缩，禁止再次压缩。
export class PromptTooLongRetryError extends CompactionError {
  override readonly name: string = "PromptTooLongRetryError";
}

export interface CompactionSummaryOptions {
  // 当前目标、事实、文件、剩余工作和约束共同构成可恢复的最小摘要。
  readonly currentGoal: string;
  readonly keyFindings: readonly string[];
  readonly filesReadOrChanged: readonly string[];
  readonly remainingWork: readonly string[];
  readonly userConstraints: readonly string[];
}

// 摘要对象是模型输出的强类型边界，字段必须在构造时校验。
export class CompactionSummary {
  readonly currentGoal: string;
  readonly keyFindings: readonly string[];
  readonly filesReadOrChanged: readonly string[];
  readonly remainingWork: readonly string[];
  readonly userConstraints: readonly string[];

  constructor(options: CompactionSummaryOptions) {
    this.currentGoal = requireNonEmptyText("currentGoal", options.currentGoal);
    this.keyFindings = requireTextArray("keyFindings", options.keyFindings);
    this.filesReadOrChanged = requireTextArray("filesReadOrChanged", options.filesReadOrChanged);
    this.remainingWork = requireTextArray("remainingWork", options.remainingWork);
    this.userConstraints = requireTextArray("userConstraints", options.userConstraints);
    Object.freeze(this);
  }
}

export interface HistorySummarizer {
  // 摘要器只读消息快照；不得修改 canonical history 或调用工具。
  summarize(history: readonly ChatMessage[], signal?: AbortSignal): Promise<CompactionSummary>;
}

// 摘要请求没有工具，且只接受 stop + 严格 JSON，避免压缩流程引入新的副作用。
// 使用主模型完成摘要：请求不含工具，输出必须是严格 JSON，避免摘要层产生副作用。
export class ModelHistorySummarizer implements HistorySummarizer {
  readonly #model: ModelClient;

  constructor(model: ModelClient) {
    if (typeof model?.complete !== "function") {
      throw new TypeError("model must implement ModelClient");
    }
    this.#model = model;
  }

  async summarize(
    history: readonly ChatMessage[],
    signal?: AbortSignal,
  ): Promise<CompactionSummary> {
    const { snapshot } = validatedGroups(history);
    // 摘要请求没有工具且必须 stop；任何工具调用或截断都会让压缩失败。
    // 摘要请求把历史附加在固定 system prompt 之后，且不携带工具定义。
    // 模型输出工具调用、被截断或返回空内容都视为压缩失败，不能让坏摘要进入请求历史。
    const reply = await this.#model.complete(
      Object.freeze({
        messages: Object.freeze([systemMessage(SUMMARY_SYSTEM_PROMPT), ...snapshot]),
        tools: Object.freeze([]),
      }),
      signal,
    );
    if (reply.message.toolCalls.length > 0) {
      throw new CompactionError("summary model must not call tools");
    }
    if (reply.finishReason !== "stop") {
      throw new CompactionError(
        `summary model finishReason must be stop, got ${reply.finishReason}`,
      );
    }
    const content = reply.message.content;
    if (content === null || content.trim().length === 0) {
      throw new CompactionError("summary model must return non-empty JSON text");
    }
    return parseCompactionSummary(content);
  }
}

export interface ArtifactReference {
  // 工件的绝对路径，仅供本地清理；模型使用 relativePath。
  readonly path: string;
  // 相对工作区路径，可安全写入工具结果和摘要。
  readonly relativePath: string;
  // 落盘前正文的 UTF-8 字节数，帮助模型判断是否需要重新读取。
  readonly originalBytes: number;
}

export interface ToolResultArtifact {
  readonly resultIndex: number;
  readonly reference: ArtifactReference;
}

export interface ToolResultBudgetOutcome {
  // 与输入结果一一对应的替换快照，保证 tool_call 配对关系不变。
  readonly results: readonly ToolResult[];
  readonly artifacts: readonly ToolResultArtifact[];
}

export interface HistoryCompactionOutcome {
  // 下一次模型请求使用的摘要加尾部消息快照。
  readonly history: readonly ChatMessage[];
  // canonical transcript 的持久化引用，失败恢复时仍可定位完整历史。
  readonly transcript: ArtifactReference;
}

// 消息组是压缩的最小单位：普通消息单独成组，assistant 工具调用与其全部结果成一组。
interface MessageGroup {
  readonly messages: readonly ChatMessage[];
  readonly isToolExchange: boolean;
}

export interface CompactionManagerOptions {
  // 所有 artifact 必须落在此工作区下，路径边界在构造时解析。
  readonly workspace: string;
  // 生成结构化摘要的模型边界；摘要请求禁用工具。
  readonly summarizer: HistorySummarizer;
  readonly idGenerator?: () => string;
  readonly persistThresholdBytes?: number;
  readonly batchBudgetBytes?: number;
  readonly previewHeadBytes?: number;
  readonly previewTailBytes?: number;
  readonly reactiveTailGroups?: number;
  readonly proactiveThresholdBytes?: number;
  readonly snipMaxGroups?: number;
  readonly snipKeepHeadGroups?: number;
  readonly keepRecentToolGroups?: number;
}

// 管理器按字节预算决定持久化、摘要、微压缩或 snip 压缩，原始历史不在此改写。
export class CompactionManager {
  readonly #workspace: string;
  readonly #summarizer: HistorySummarizer;
  readonly #idGenerator: () => string;
  readonly #persistThresholdBytes: number;
  readonly #batchBudgetBytes: number;
  readonly #previewHeadBytes: number;
  readonly #previewTailBytes: number;
  readonly #reactiveTailGroups: number;
  readonly #proactiveThresholdBytes: number;
  readonly #snipMaxGroups: number;
  readonly #snipKeepHeadGroups: number;
  readonly #keepRecentToolGroups: number;
  // prepare 的缓存仅针对最近 canonical 快照；canonical history 始终由调用方持有。
  #preparedSource: readonly ChatMessage[] | undefined;
  // 与 #preparedSource 对应的请求级压缩结果，可在纯追加时增量复用。
  #preparedHistory: readonly ChatMessage[] | undefined;

  constructor(options: CompactionManagerOptions) {
    // 构造期统一解析默认值和校验参数，后续 prepare/compact 不再重复解释配置。
    const persistThresholdBytes = optionValue(
      options.persistThresholdBytes,
      DEFAULT_PERSIST_THRESHOLD_BYTES,
    );
    const batchBudgetBytes = optionValue(options.batchBudgetBytes, DEFAULT_BATCH_BUDGET_BYTES);
    const previewHeadBytes = optionValue(options.previewHeadBytes, DEFAULT_PREVIEW_HEAD_BYTES);
    const previewTailBytes = optionValue(options.previewTailBytes, DEFAULT_PREVIEW_TAIL_BYTES);
    const reactiveTailGroups = optionValue(
      options.reactiveTailGroups,
      DEFAULT_REACTIVE_TAIL_GROUPS,
    );
    const proactiveThresholdBytes = optionValue(
      options.proactiveThresholdBytes,
      DEFAULT_PROACTIVE_THRESHOLD_BYTES,
    );
    const snipMaxGroups = optionValue(options.snipMaxGroups, DEFAULT_SNIP_MAX_GROUPS);
    const snipKeepHeadGroups = optionValue(
      options.snipKeepHeadGroups,
      DEFAULT_SNIP_KEEP_HEAD_GROUPS,
    );
    const keepRecentToolGroups = optionValue(
      options.keepRecentToolGroups,
      DEFAULT_KEEP_RECENT_TOOL_GROUPS,
    );

    requirePositiveInteger("persistThresholdBytes", persistThresholdBytes);
    requirePositiveInteger("batchBudgetBytes", batchBudgetBytes);
    requireNonNegativeInteger("previewHeadBytes", previewHeadBytes);
    requireNonNegativeInteger("previewTailBytes", previewTailBytes);
    requirePositiveInteger("reactiveTailGroups", reactiveTailGroups);
    requirePositiveInteger("proactiveThresholdBytes", proactiveThresholdBytes);
    validateSnipConfiguration(snipMaxGroups, snipKeepHeadGroups);
    requireNonNegativeInteger("keepRecentToolGroups", keepRecentToolGroups);
    if (previewHeadBytes === 0 && previewTailBytes === 0) {
      throw new RangeError("at least one preview byte limit must be positive");
    }
    if (typeof options.summarizer?.summarize !== "function") {
      throw new TypeError("summarizer must implement HistorySummarizer");
    }
    if (options.idGenerator !== undefined && typeof options.idGenerator !== "function") {
      throw new TypeError("idGenerator must be a function");
    }

    this.#workspace = resolveWorkspace(options.workspace);
    this.#summarizer = options.summarizer;
    this.#idGenerator =
      options.idGenerator === undefined
        ? () => randomUUID().replaceAll("-", "")
        : options.idGenerator;
    this.#persistThresholdBytes = persistThresholdBytes;
    this.#batchBudgetBytes = batchBudgetBytes;
    this.#previewHeadBytes = previewHeadBytes;
    this.#previewTailBytes = previewTailBytes;
    this.#reactiveTailGroups = reactiveTailGroups;
    this.#proactiveThresholdBytes = proactiveThresholdBytes;
    this.#snipMaxGroups = snipMaxGroups;
    this.#snipKeepHeadGroups = snipKeepHeadGroups;
    this.#keepRecentToolGroups = keepRecentToolGroups;
  }

  async prepare(history: readonly ChatMessage[]): Promise<readonly ChatMessage[]> {
    const { snapshot } = validatedGroups(history);
    // 相同 canonical 快照直接复用上次请求历史；纯追加时只压缩新增后缀。
    // 请求级压缩入口：先从 canonical history 取不可变快照，再按 snip -> micro -> summary
    // 顺序准备下一次模型输入。canonical history 本身永远不会被这个函数改写。
    const cachedSource = this.#preparedSource;
    const cachedHistory = this.#preparedHistory;
    if (
      cachedSource !== undefined &&
      cachedHistory !== undefined &&
      historiesEqual(snapshot, cachedSource)
    ) {
      return cachedHistory;
    }

    let prepared: readonly ChatMessage[] = snapshot;
    if (
      cachedSource !== undefined &&
      cachedHistory !== undefined &&
      snapshot.length > cachedSource.length &&
      historyStartsWith(snapshot, cachedSource)
    ) {
      prepared = Object.freeze([...cachedHistory, ...snapshot.slice(cachedSource.length)]);
    }

    prepared = snipCompactHistory(prepared, {
      maxGroups: this.#snipMaxGroups,
      keepHeadGroups: this.#snipKeepHeadGroups,
    });
    prepared = microCompactHistory(prepared, {
      keepRecentToolGroups: this.#keepRecentToolGroups,
    });
    if (historyUtf8Bytes(prepared) > this.#proactiveThresholdBytes) {
      // transcript 永远来自 canonical；摘要只读取便宜层处理后的 request history。
      const outcome = await this.#compactValidated(snapshot, prepared, 0, undefined, false);
      prepared = outcome.history;
    }

    this.#preparedSource = snapshot;
    this.#preparedHistory = prepared;
    return prepared;
  }

  async compactToolResults(results: readonly ToolResult[]): Promise<ToolResultBudgetOutcome> {
    // 工具结果处理器：在整轮 ToolResult 回填 canonical history 前完成落盘。
    // 接收的是同一轮全部结果，因此可以按总预算做“最大优先”批次选择，而不是逐条独立判断。
    if (!Array.isArray(results) || !results.every((result: unknown) => isToolResult(result))) {
      throw new TypeError("results must contain only ToolResult values");
    }
    const snapshot = Object.freeze(results.map((result) => copyToolResult(result)));
    const encoded = snapshot.map((result) => Buffer.from(result.content, "utf8"));
    const sizes = encoded.map((content) => content.byteLength);
    // 超出 batch 预算时按大小优先落盘，直到剩余结果进入预算。
    const ranked = sizes
      .map((_size, index) => index)
      .sort((left, right) => {
        const leftSize = sizes[left];
        const rightSize = sizes[right];
        if (leftSize === undefined || rightSize === undefined) {
          throw new CompactionError("tool result size index was lost");
        }
        return rightSize - leftSize || left - right;
      });
    const selected = new Set(
      sizes.flatMap((size, index) => (size > this.#persistThresholdBytes ? [index] : [])),
    );
    let retainedBytes = sizes.reduce(
      (total, size, index) => total + (selected.has(index) ? 0 : size),
      0,
    );
    for (const index of ranked) {
      if (retainedBytes <= this.#batchBudgetBytes) {
        break;
      }
      if (selected.has(index)) {
        continue;
      }
      selected.add(index);
      const selectedSize = sizes[index];
      if (selectedSize === undefined) {
        throw new CompactionError("selected tool result size index was lost");
      }
      retainedBytes -= selectedSize;
    }

    const transformed = [...snapshot];
    const artifacts: ToolResultArtifact[] = [];
    try {
      // 先完成整批落盘，任一失败都由下面的 cleanup 撤销本次已发布文件。
      // 整批先落盘，任一失败都由 cleanup 撤销本次已发布文件。
      for (const index of ranked) {
        if (!selected.has(index)) {
          continue;
        }
        const content = encoded[index];
        const original = snapshot[index];
        if (content === undefined || original === undefined) {
          throw new CompactionError("tool result batch index was lost");
        }
        const reference = await this.#writeArtifact("tool-result", ".txt", content);
        artifacts.push(Object.freeze({ resultIndex: index, reference }));
        const rendered = this.#renderToolResultReference(reference, content);
        if (original.isError) {
          const errorCode = original.errorCode;
          if (errorCode === undefined) {
            throw new CompactionError("error tool result lost its errorCode");
          }
          transformed[index] = Object.freeze({ content: rendered, isError: true, errorCode });
        } else {
          transformed[index] = toolSuccess(rendered);
        }
      }
    } catch (error) {
      await removeCreatedArtifacts(
        artifacts.map((artifact) => artifact.reference),
        error,
      );
    }

    return Object.freeze({
      results: Object.freeze(transformed),
      artifacts: Object.freeze(artifacts),
    });
  }

  async compactProactively(
    history: readonly ChatMessage[],
    signal?: AbortSignal,
  ): Promise<HistoryCompactionOutcome> {
    // 显式压缩 API 不经过 snip/micro，直接保存完整 transcript 并生成结构化摘要。
    const { snapshot } = validatedGroups(history);
    return this.#compactValidated(snapshot, snapshot, 0, signal, false);
  }

  async compactOnPromptTooLong(
    history: readonly ChatMessage[],
    options: { readonly retryCount: number },
    signal?: AbortSignal,
  ): Promise<HistoryCompactionOutcome> {
    // 响应式压缩只在同一逻辑请求中允许一次；retryCount 形成递归保护。
    // 响应式恢复原语：调用者已经确认输入上下文过长，本方法只允许当前窗口压缩一次。
    // 摘要后保留最近完整组，让模型仍有最新进展可看，而不是只剩一条压缩摘要。
    requireNonNegativeInteger("retryCount", options.retryCount);
    if (options.retryCount > 0) {
      throw new PromptTooLongRetryError("prompt-too-long compaction was already attempted");
    }
    const { snapshot } = validatedGroups(history);
    return this.#compactValidated(snapshot, snapshot, this.#reactiveTailGroups, signal, true);
  }

  async #compactValidated(
    transcriptHistory: readonly ChatMessage[],
    summaryHistory: readonly ChatMessage[],
    keepTailGroups: number,
    signal: AbortSignal | undefined,
    cleanupOnFailure: boolean,
  ): Promise<HistoryCompactionOutcome> {
    // transcript 先落盘；响应式模式在取消或摘要失败时清理已发布 artifact。
    // 先保存完整 transcript；摘要失败时也不丢失进入压缩前的会话快照。
    // transcript 与摘要使用不同历史来源：transcript 永远来自完整 canonical 快照，
    // 摘要只读便宜层处理后的 request history。先保存 transcript，摘要失败时也能保留现场。
    const transcript = await this.#writeArtifact(
      "transcript",
      ".jsonl",
      serializeTranscript(transcriptHistory),
    );
    try {
      throwIfAborted(signal);
      const compactedSummary: unknown = await this.#summarizer.summarize(summaryHistory, signal);
      throwIfAborted(signal);
      if (!(compactedSummary instanceof CompactionSummary)) {
        throw new TypeError("summarizer must return CompactionSummary");
      }
      const summary = summaryMessage(compactedSummary, transcript.relativePath);
      const tail =
        keepTailGroups === 0
          ? []
          : flattenGroups(validatedGroups(summaryHistory).groups.slice(-keepTailGroups));
      const history = Object.freeze([summary, ...tail]);
      validateToolPairing(history);
      return Object.freeze({ history, transcript });
    } catch (error) {
      if (!cleanupOnFailure) {
        throw error;
      }
      return await removeCreatedArtifacts([transcript], error);
    }
  }

  async #writeArtifact(
    kind: "tool-result" | "transcript",
    extension: ".txt" | ".jsonl",
    content: Buffer,
  ): Promise<ArtifactReference> {
    // artifact ID 受 slug 约束，最终路径只落在 workspace 的固定 artifacts 目录。
    // 统一写入入口：校验 ID slug，创建安全目录，再用独占发布生成最终文件。
    const artifactId: unknown = this.#idGenerator();
    if (
      typeof artifactId !== "string" ||
      artifactId.length > MAX_ARTIFACT_ID_LENGTH ||
      !ARTIFACT_ID_PATTERN.test(artifactId)
    ) {
      throw new ArtifactPathError("artifact id must be a safe lowercase hyphen-separated slug");
    }
    const root = await ensureArtifactDirectory(this.#workspace);
    const path = join(root, `${kind}-${artifactId}${extension}`);
    const relativePath = relative(this.#workspace, path).split(sep).join("/");
    try {
      await writeExclusiveAtomic(path, content);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new ArtifactConflictError(`artifact already exists: ${relativePath}`, {
          cause: error,
        });
      }
      if (error instanceof CompactionError) {
        throw error;
      }
      throw new CompactionError(`artifact could not be written: ${relativePath}`, {
        cause: error,
      });
    }
    return Object.freeze({ path, relativePath, originalBytes: content.byteLength });
  }

  // 消息只保留相对路径、原始大小和有界 UTF-8 预览，完整正文留在 artifact。
  #renderToolResultReference(reference: ArtifactReference, content: Buffer): string {
    const [head, tail] = boundedUtf8Preview(
      content,
      this.#previewHeadBytes,
      this.#previewTailBytes,
    );
    return [
      "<persisted-tool-result>",
      `path: ${reference.relativePath}`,
      `original_bytes: ${reference.originalBytes}`,
      "head_preview:",
      head,
      "tail_preview:",
      tail,
      "</persisted-tool-result>",
    ].join("\n");
  }
}

// micro 以完整工具组为单位替换旧结果正文，保留 assistant 调用与 tool_call_id 配对。
export function microCompactHistory(
  history: readonly ChatMessage[],
  options: { readonly keepRecentToolGroups?: number } = {},
): readonly ChatMessage[] {
  const keepRecentToolGroups = optionValue(
    options.keepRecentToolGroups,
    DEFAULT_KEEP_RECENT_TOOL_GROUPS,
  );
  requireNonNegativeInteger("keepRecentToolGroups", keepRecentToolGroups);
  const { snapshot, groups } = validatedGroups(history);
  const toolGroupIndices = groups.flatMap((group, index) => (group.isToolExchange ? [index] : []));
  const compactCount = Math.max(0, toolGroupIndices.length - keepRecentToolGroups);
  if (compactCount === 0) {
    return snapshot;
  }
  const compactedIndices = new Set(toolGroupIndices.slice(0, compactCount));
  const updated = groups.map((group, groupIndex) => {
    if (!compactedIndices.has(groupIndex)) {
      return group;
    }
    const assistant = group.messages[0];
    if (assistant?.role !== "assistant") {
      throw new CompactionError("tool message group lost its assistant message");
    }
    const messages = [
      assistant,
      ...group.messages.slice(1).map((message) => {
        if (message.role !== "tool") {
          throw new CompactionError("tool message group contains a non-tool result");
        }
        return toolMessage(COMPACTED_TOOL_RESULT, message.toolCallId);
      }),
    ];
    return createMessageGroup(messages);
  });
  const compacted = flattenGroups(updated);
  validateToolPairing(compacted);
  return compacted;
}

// snip 以消息组为单位保留头尾并插入省略标记，避免拆开多调用原子组。
export function snipCompactHistory(
  history: readonly ChatMessage[],
  options: { readonly maxGroups?: number; readonly keepHeadGroups?: number } = {},
): readonly ChatMessage[] {
  const maxGroups = optionValue(options.maxGroups, DEFAULT_SNIP_MAX_GROUPS);
  const keepHeadGroups = optionValue(options.keepHeadGroups, DEFAULT_SNIP_KEEP_HEAD_GROUPS);
  validateSnipConfiguration(maxGroups, keepHeadGroups);
  const { snapshot, groups } = validatedGroups(history);
  if (groups.length <= maxGroups) {
    return snapshot;
  }
  const keepTailGroups = maxGroups - keepHeadGroups - 1;
  const omitted = groups.length - keepHeadGroups - keepTailGroups;
  const marker = createMessageGroup([
    systemMessage(`[Compacted: ${omitted} message groups omitted]`),
  ]);
  const compacted = flattenGroups([
    ...groups.slice(0, keepHeadGroups),
    marker,
    ...groups.slice(-keepTailGroups),
  ]);
  validateToolPairing(compacted);
  return compacted;
}

export function historyUtf8Bytes(history: readonly ChatMessage[]): number {
  // 预算判断与 transcript 共用同一份规范化 JSONL，避免两种序列化产生不同字节数。
  const { snapshot } = validatedGroups(history);
  return serializeTranscript(snapshot).byteLength;
}

// 先把历史切成普通消息组和完整工具交换组，后续所有边界都基于这些组。
function validatedGroups(history: readonly ChatMessage[]): {
  // assistant 工具调用与其全部 tool result 是不可拆分的 OpenAI 协议组。
  readonly snapshot: readonly ChatMessage[];
  readonly groups: readonly MessageGroup[];
} {
  if (!Array.isArray(history) || !history.every((message: unknown) => isChatMessage(message))) {
    throw new TypeError("history must contain only ChatMessage values");
  }
  const snapshot = Object.freeze([...history]);
  validateToolPairing(snapshot);
  const groups: MessageGroup[] = [];
  let index = 0;
  while (index < snapshot.length) {
    const message = snapshot[index];
    if (message === undefined) {
      throw new CompactionError("history index was lost");
    }
    if (message.role === "assistant" && message.toolCalls.length > 0) {
      const end = index + 1 + message.toolCalls.length;
      groups.push(createMessageGroup(snapshot.slice(index, end)));
      index = end;
      continue;
    }
    groups.push(createMessageGroup([message]));
    index += 1;
  }
  return Object.freeze({ snapshot, groups: Object.freeze(groups) });
}

function createMessageGroup(messages: readonly ChatMessage[]): MessageGroup {
  const snapshot = Object.freeze([...messages]);
  const first = snapshot[0];
  return Object.freeze({
    messages: snapshot,
    isToolExchange: first?.role === "assistant" && first.toolCalls.length > 0,
  });
}

function flattenGroups(groups: readonly MessageGroup[]): readonly ChatMessage[] {
  return Object.freeze(groups.flatMap((group) => group.messages));
}

// transcript 是稳定 JSONL：键排序后序列化，便于后续缓存比较和逐行还原。
function serializeTranscript(history: readonly ChatMessage[]): Buffer {
  if (history.length === 0) {
    return Buffer.alloc(0);
  }
  const lines = history.map((message) => stableStringify(toOpenAIMessage(message)));
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

function toOpenAIMessage(message: ChatMessage): Readonly<Record<string, unknown>> {
  // 内部 ChatMessage 转 OpenAI wire shape；只保留协议需要的字段，并保留 tool_call_id。
  if (message.role === "system" || message.role === "user") {
    return { role: message.role, content: message.content };
  }
  if (message.role === "tool") {
    return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
  }
  if (message.toolCalls.length === 0) {
    return { role: "assistant", content: message.content };
  }
  return {
    role: "assistant",
    content: message.content,
    tool_calls: message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    })),
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJson(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}

function summaryMessage(summary: CompactionSummary, transcriptPath: string): ChatMessage {
  // 摘要消息是 system role，包含 kind、transcript_path 和五类继续工作信息；
  // 模型下一轮可以直接读取这些字段，不需要重新翻阅被压缩的历史。
  return systemMessage(
    stableStringify({
      kind: "compacted_history",
      transcript_path: transcriptPath,
      current_goal: summary.currentGoal,
      key_findings: summary.keyFindings,
      files_read_or_changed: summary.filesReadOrChanged,
      remaining_work: summary.remainingWork,
      user_constraints: summary.userConstraints,
    }),
  );
}

// 摘要模型输出属于不可信边界，字段集合、类型和空值必须严格校验。
function parseCompactionSummary(content: string): CompactionSummary {
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch (error) {
    throw new CompactionError("summary model output is not valid JSON", { cause: error });
  }
  const expected = [
    "current_goal",
    "files_read_or_changed",
    "key_findings",
    "remaining_work",
    "user_constraints",
  ];
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    Object.keys(payload).sort().join("\0") !== expected.join("\0")
  ) {
    throw new CompactionError("summary model output must contain the exact fields");
  }
  const currentGoal = Reflect.get(payload, "current_goal");
  if (typeof currentGoal !== "string") {
    throw new CompactionError("summary current_goal must be a string");
  }
  const keyFindings = parseStringArray(payload, "key_findings");
  const filesReadOrChanged = parseStringArray(payload, "files_read_or_changed");
  const remainingWork = parseStringArray(payload, "remaining_work");
  const userConstraints = parseStringArray(payload, "user_constraints");
  try {
    return new CompactionSummary({
      currentGoal,
      keyFindings,
      filesReadOrChanged,
      remainingWork,
      userConstraints,
    });
  } catch (error) {
    throw new CompactionError("summary model output contains invalid values", { cause: error });
  }
}

function parseStringArray(payload: object, field: string): readonly string[] {
  const value: unknown = Reflect.get(payload, field);
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === "string")) {
    throw new CompactionError(`summary ${field} must be a string array`);
  }
  return Object.freeze([...value]);
}

function boundedUtf8Preview(
  content: Buffer,
  headLimit: number,
  tailLimit: number,
): readonly [string, string] {
  // 先按 byte 截取头部和尾部，再用 TextDecoder 丢弃边界上的不完整 UTF-8 字符。
  const headEnd = Math.min(content.byteLength, headLimit);
  const tailStart = Math.max(headEnd, content.byteLength - tailLimit);
  return Object.freeze([
    decodeUtf8Boundary(content.subarray(0, headEnd), "head"),
    decodeUtf8Boundary(content.subarray(tailStart), "tail"),
  ]);
}

function decodeUtf8Boundary(content: Buffer, boundary: "head" | "tail"): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let offset = 0; offset <= Math.min(content.byteLength, 3); offset += 1) {
    const candidate =
      boundary === "head"
        ? content.subarray(0, content.byteLength - offset)
        : content.subarray(offset);
    try {
      return decoder.decode(candidate);
    } catch {
      // UTF-8 code point最多 4 bytes，只丢弃边界上的不完整片段。
    }
  }
  return "";
}

async function ensureArtifactDirectory(workspace: string): Promise<string> {
  // 固定产物根目录，并逐层验证真实路径，避免 .agent_tutorial/artifacts 被链接替换。
  const stateDirectory = join(workspace, ".agent_tutorial");
  await ensureSafeDirectory(stateDirectory, workspace);
  const artifactDirectory = join(stateDirectory, "artifacts");
  await ensureSafeDirectory(artifactDirectory, workspace);
  return artifactDirectory;
}

// 创建后重新检查真实目录，拒绝符号链接和指向 workspace 外的路径。
async function ensureSafeDirectory(path: string, workspace: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw new ArtifactPathError(`artifact directory could not be created: ${path}`, {
        cause: error,
      });
    }
  }
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new ArtifactPathError(`artifact directory is not a real directory: ${path}`);
    }
    const resolvedPath = await realpath(path);
    if (resolve(resolvedPath) !== resolve(path) || !isWithinWorkspace(workspace, resolvedPath)) {
      throw new ArtifactPathError(`artifact directory escapes workspace: ${path}`);
    }
  } catch (error) {
    if (error instanceof ArtifactPathError) {
      throw error;
    }
    throw new ArtifactPathError(`artifact directory could not be verified: ${path}`, {
      cause: error,
    });
  }
}

async function writeExclusiveAtomic(path: string, content: Buffer): Promise<void> {
  // 使用独占发布防止并发压缩覆盖已有 artifact，冲突交给调用方显式处理。
  // 同目录临时文件先同步，再用独占硬链接发布，最终路径从不被覆盖。
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx");
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
      handle = undefined;
    }
    await link(temporary, path);
  } finally {
    if (handle !== undefined) {
      await handle.close();
    }
    await rm(temporary, { force: true });
  }
}

async function removeCreatedArtifacts(
  references: readonly ArtifactReference[],
  originalError: unknown,
): Promise<never> {
  // 批量清理即使中途失败也会继续，最后合并原始错误与清理错误。
  const cleanupErrors: unknown[] = [];
  for (const reference of references) {
    try {
      await rm(reference.path);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [originalError, ...cleanupErrors],
      "tool result persistence and artifact cleanup both failed",
    );
  }
  throw originalError;
}

function resolveWorkspace(workspace: string): string {
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new TypeError("workspace must be a non-empty string");
  }
  try {
    // 组合根创建 manager 时解析一次；请求路径只使用已验证的绝对 workspace。
    const resolvedWorkspace = realpathSync.native(workspace);
    if (!statSync(resolvedWorkspace).isDirectory()) {
      throw new ArtifactPathError(`workspace is not a directory: ${workspace}`);
    }
    return resolvedWorkspace;
  } catch (error) {
    if (error instanceof ArtifactPathError) {
      throw error;
    }
    throw new ArtifactPathError(`workspace could not be resolved: ${workspace}`, { cause: error });
  }
}

function isWithinWorkspace(workspace: string, candidate: string): boolean {
  // 用相对路径判断包含关系，避免字符串前缀误判 C:\a 与 C:\ab。
  const offset = relative(workspace, candidate);
  return (
    offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset))
  );
}

function historiesEqual(left: readonly ChatMessage[], right: readonly ChatMessage[]): boolean {
  return left.length === right.length && historyStartsWith(left, right);
}

// 前缀比较同样使用稳定 JSON，确保跨字段顺序仍可识别纯追加历史。
function historyStartsWith(
  history: readonly ChatMessage[],
  prefix: readonly ChatMessage[],
): boolean {
  if (history.length < prefix.length) {
    return false;
  }
  return prefix.every((message, index) => {
    const candidate = history[index];
    return (
      candidate !== undefined &&
      stableStringify(toOpenAIMessage(candidate)) === stableStringify(toOpenAIMessage(message))
    );
  });
}

function optionValue(value: number | undefined, fallback: number): number {
  // 配置项未显式传入时使用模块默认值；显式传入的非法值继续走 require 校验。
  return value === undefined ? fallback : value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CompactionError("history compaction was cancelled");
  }
}

function requireNonEmptyText(name: string, value: unknown): string {
  // 摘要字段拒绝空字符串，避免模型用占位符掩盖缺失信息。
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireTextArray(name: string, value: readonly string[]): readonly string[] {
  // 字符串数组中的每一项都必须非空，冻结后作为不可变摘要状态。
  if (
    !Array.isArray(value) ||
    !value.every((item: unknown) => typeof item === "string" && item.trim().length > 0)
  ) {
    throw new TypeError(`${name} must be an array of non-empty strings`);
  }
  return Object.freeze([...value]);
}

function requirePositiveInteger(name: string, value: number): void {
  // 预算必须为正整数，防止 0 或小数造成无意义的阈值。
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function requireNonNegativeInteger(name: string, value: number): void {
  // 允许 0 的配置（例如预览字节或保留组数）也必须仍是整数。
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

function validateSnipConfiguration(maxGroups: number, keepHeadGroups: number): void {
  // snip 需要至少容纳 head、marker 和 tail 三部分，避免切出空历史。
  requirePositiveInteger("maxGroups", maxGroups);
  requirePositiveInteger("keepHeadGroups", keepHeadGroups);
  if (maxGroups < 3) {
    throw new RangeError("maxGroups must leave room for head, marker, and tail groups");
  }
  if (keepHeadGroups > maxGroups - 2) {
    throw new RangeError("keepHeadGroups must leave room for marker and tail groups");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  // 只把带 code 字段的 Error 当作 Node 系统错误，用于识别 EEXIST 等写入结果。
  return error instanceof Error && "code" in error;
}
