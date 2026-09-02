import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  readFile as readFileBytes,
  realpath as realpathAsync,
  stat as statAsync,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { TextDecoder } from "node:util";

import { parse } from "yaml";
import { z } from "zod";

import { isWindowsReservedComponent } from "../core/filesystem.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../core/tools.js";
import { toolError, toolSuccess } from "../core/tools.js";

// 技能目录、工具名与 catalog 上限是 Skill 功能的公共边界。
export const LOAD_SKILL_TOOL_NAME = "load_skill";
export const DEFAULT_SKILLS_DIRECTORY = "skills";
// 目录摘要的条目数上限，防止大量 Skill 占用初始系统提示。
export const DEFAULT_MAX_CATALOG_ENTRIES = 100;
// 目录摘要按 UTF-8 字节计量的上限，和条目数共同约束提示词预算。
export const DEFAULT_MAX_CATALOG_BYTES = 8_000;
// 工具参数和目录名允许的最大长度，过长名称不会进入路径解析。
export const MAX_SKILL_NAME_LENGTH = 64;

// Skill 注册表只公开受限目录中的清单摘要，正文必须通过 load_skill 按需读取。
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const SKILL_NAME_REGEXP = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

// 校验名称为字母数字带连字符的合法标识，并拒绝 Windows 设备名。
const loadSkillInputSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MAX_SKILL_NAME_LENGTH)
      .regex(SKILL_NAME_REGEXP)
      .refine((name) => !isWindowsReservedComponent(name))
      .describe("The exact Skill name from the available catalog."),
  })
  .strict();

// 通过严格 schema 的加载请求，仅携带目录快照中出现的候选名称。
export type LoadSkillInput = Readonly<z.output<typeof loadSkillInputSchema>>;

// Skill 领域错误的公共基类，load_skill handler 据此映射为稳定工具错误码。
export class SkillError extends Error {}

// 路径解析失败或越界，例如 workspace 不存在、目录被符号链接逃逸。
export class SkillPathError extends SkillError {}

// frontmatter 缺失、YAML 格式错误或 name/description 不合规。
export class SkillManifestError extends SkillError {}

// 扫描到多个 Skill 使用同一名称时直接失败，不允许静默覆盖。
export class DuplicateSkillError extends SkillError {}

// 请求名称本身不合法，例如长度超限或包含 Windows 保留组件。
export class SkillNameError extends SkillError {}

// 请求名称格式合法，但当前注册表中不存在。
export class SkillNotFoundError extends SkillError {}

// 目录中唯一向模型公开的元数据：名称和单行路由描述。
export interface SkillSummary {
  // 用于工具路由且必须与 Skill 目录名一致的稳定标识。
  readonly name: string;
  // 供模型选择是否加载正文的单行摘要，不包含私有指令内容。
  readonly description: string;
}

// 内部记录保留逻辑路径，显式加载时再重新解析物理路径。
interface SkillRecord extends SkillSummary {
  readonly directoryName: string;
  readonly directoryPath: string;
  readonly manifestPath: string;
}

// 扫描选项只控制目录摘要的边界，不控制正文内容或文件数量。
export interface SkillScanOptions {
  // workspace 内的相对根目录；绝对路径和父级段会在扫描前拒绝。
  readonly skillsDirectory?: string;
  // 初始 catalog 最多公开的 Skill 数量。
  readonly maxCatalogEntries?: number;
  // 初始 catalog 渲染文本的 UTF-8 字节预算。
  readonly maxCatalogBytes?: number;
}

// 解析后的 Skill 文档：frontmatter 元数据加 SKILL.md 正文。
interface ParsedSkillDocument extends SkillSummary {
  readonly body: string;
}

// 扫描生成不可变元数据快照；加载时重新校验每一层真实路径。
export class SkillRegistry {
  // 扫描时记录入口，加载时再次校验真实路径，以防扫描后链接被替换。
  // 规范化的工作区根，作为所有目录与请求上下文的共同信任边界。
  readonly #workspaceRoot: string;
  // 已校验的 skills 根；loadSkill 每次使用前仍会重新解析其真实路径。
  readonly #skillsRoot: string;
  // 完整注册记录只保留在内部，模型只能通过 names/catalogEntries 发现可用 Skill。
  readonly #records: ReadonlyMap<string, SkillRecord>;
  // 已注册名称的稳定排序快照，供组合根和测试枚举能力。
  readonly names: readonly string[];
  // 已受条目和字节预算限制的公开摘要快照。
  readonly catalogEntries: readonly SkillSummary[];
  // 绑定此注册表工作区的只读工具，handler 会核验 ToolContext 归属。
  readonly toolDefinition: ToolDefinition<LoadSkillInput>;

  private constructor(
    workspaceRoot: string,
    skillsRoot: string,
    records: ReadonlyMap<string, SkillRecord>,
    catalogEntries: readonly SkillSummary[],
  ) {
    this.#workspaceRoot = workspaceRoot;
    this.#skillsRoot = skillsRoot;
    this.#records = new Map(records);
    this.names = Object.freeze([...records.keys()].sort());
    this.catalogEntries = Object.freeze(catalogEntries.map((entry) => Object.freeze({ ...entry })));
    this.toolDefinition = Object.freeze({
      name: LOAD_SKILL_TOOL_NAME,
      description: "Load the full instructions for one Skill listed in the workspace catalog.",
      inputSchema: loadSkillInputSchema,
      effect: "read",
      handler: (input: LoadSkillInput, context: ToolContext) => this.#handleLoad(input, context),
    });
  }

  // 扫描阶段只建立不可变快照：先固定 workspace 与 skills 根的真实路径，
  // 再逐项读取 frontmatter；正文和动态重查都留给 loadSkill。
  static scan(workspace: string, options: SkillScanOptions = {}): SkillRegistry {
    // Catalog 有条目和字节上限，避免 workspace 文件把系统提示词无限扩张。
    const workspaceRoot = resolveWorkspace(workspace);
    const skillsDirectory =
      options.skillsDirectory === undefined ? DEFAULT_SKILLS_DIRECTORY : options.skillsDirectory;
    const maxCatalogEntries = positiveInteger(
      options.maxCatalogEntries,
      DEFAULT_MAX_CATALOG_ENTRIES,
      "maxCatalogEntries",
    );
    const maxCatalogBytes = positiveInteger(
      options.maxCatalogBytes,
      DEFAULT_MAX_CATALOG_BYTES,
      "maxCatalogBytes",
    );
    const skillsPath = resolveSkillRoot(workspaceRoot, skillsDirectory);
    if (!existsSync(skillsPath)) {
      return new SkillRegistry(workspaceRoot, skillsPath, new Map(), []);
    }

    const skillsRoot = checkedRealDirectory(
      skillsPath,
      workspaceRoot,
      `Skills directory escapes workspace: ${skillsDirectory}`,
    );
    const discovered: SkillRecord[] = [];
    const byName = new Map<string, SkillRecord>();

    for (const entry of readdirSync(skillsRoot, { withFileTypes: true }).sort((left, right) =>
      compareSkillNames(left.name, right.name),
    )) {
      const lexicalDirectory = resolve(skillsRoot, entry.name);
      const information = lstatSync(lexicalDirectory);
      if (!information.isDirectory() && !information.isSymbolicLink()) {
        continue;
      }
      const directoryPath = checkedRealDirectory(
        lexicalDirectory,
        skillsRoot,
        `Skill directory escapes Skills root: ${entry.name}`,
      );
      const lexicalManifest = resolve(directoryPath, "SKILL.md");
      if (!existsSync(lexicalManifest)) {
        continue;
      }
      const manifestPath = checkedRealFile(
        lexicalManifest,
        directoryPath,
        `Skill manifest escapes its directory: ${entry.name}`,
      );
      const parsed = parseSkillDocument(readFrontmatter(manifestPath), manifestPath);
      // 保存逻辑入口；显式加载时重新解析，才能发现扫描后的链接替换。
      const record: SkillRecord = Object.freeze({
        name: parsed.name,
        description: parsed.description,
        directoryName: entry.name,
        directoryPath: lexicalDirectory,
        manifestPath: resolve(lexicalDirectory, "SKILL.md"),
      });
      if (byName.has(record.name)) {
        throw new DuplicateSkillError(`Duplicate Skill name: ${record.name}`);
      }
      byName.set(record.name, record);
      discovered.push(record);
    }

    for (const record of discovered) {
      if (record.name !== record.directoryName) {
        throw new SkillManifestError(
          `Skill name must match its directory: ${record.directoryName}`,
        );
      }
    }

    const ordered = [...byName.values()].sort((left, right) =>
      compareSkillNames(left.name, right.name),
    );
    const catalog = boundedCatalog(ordered, maxCatalogEntries, maxCatalogBytes);
    return new SkillRegistry(
      workspaceRoot,
      skillsRoot,
      new Map(ordered.map((record) => [record.name, record])),
      catalog,
    );
  }

  // 目录是给模型的纯文本摘要；只包含名称和描述，正文绝不进入该结果。
  // 将已截断快照渲染为系统提示片段；不触发额外文件读取。
  renderCatalog(): string {
    return this.catalogEntries
      .map((entry) => `- **${entry.name}**: ${entry.description}`)
      .join("\n");
  }

  // 显式加载：重新解析 workspace、Skill 目录和 manifest 的真实路径，
  // 防止扫描之后发生链接替换或文件内容变化。
  // 按名称取回正文；成功前必须再次确认记录仍在原受信任路径下。
  async loadSkill(name: string): Promise<string> {
    // 读取请求边界重新解析 workspace、Skill 目录和 manifest 的物理位置。
    validateSkillName(name);
    const record = this.#records.get(name);
    if (record === undefined) {
      throw new SkillNotFoundError(`Skill not found: ${name}`);
    }

    // load_skill 位于请求路径，使用异步 I/O，并重新检查每一层真实路径。
    const currentSkillsRoot = await checkedRealDirectoryAsync(
      this.#skillsRoot,
      this.#workspaceRoot,
      "Skills directory escapes workspace",
    );
    const currentDirectory = await checkedRealDirectoryAsync(
      record.directoryPath,
      currentSkillsRoot,
      `Skill directory escapes Skills root: ${name}`,
    );
    const currentManifest = await checkedRealFileAsync(
      record.manifestPath,
      currentDirectory,
      `Skill manifest escapes its directory: ${name}`,
    );
    const document = parseSkillDocument(
      decodeUtf8(await readFileBytes(currentManifest), currentManifest),
      currentManifest,
    );
    if (document.name !== record.name || document.name !== record.directoryName) {
      throw new SkillManifestError(`Skill name must match its directory: ${name}`);
    }
    return document.body;
  }

  // handler 先验证 workspace 一致性，再通过 loadSkill 读取并返回正文。
  // handler 先验证工具上下文与注册表属于同一个 workspace，再通过 loadSkill
  // 读取正文；错误码按领域错误分类，避免向模型泄漏内部文件路径。
  async #handleLoad(input: LoadSkillInput, context: ToolContext): Promise<ToolResult> {
    let contextWorkspace: string;
    try {
      contextWorkspace = await resolveWorkspaceAsync(context.workspace);
    } catch (error) {
      if (error instanceof SkillPathError) {
        return toolError("skill_workspace_error", "Current workspace could not be resolved");
      }
      throw error;
    }
    if (contextWorkspace !== this.#workspaceRoot) {
      return toolError(
        "skill_workspace_mismatch",
        "Skill registry belongs to a different workspace",
      );
    }
    try {
      return toolSuccess(await this.loadSkill(input.name));
    } catch (error) {
      // 将领域异常映射为稳定 errorCode；模型不需要也不应看到内部路径细节。
      if (error instanceof SkillNotFoundError) {
        return toolError("skill_not_found", "Requested Skill is not registered");
      }
      if (error instanceof SkillPathError) {
        return toolError("skill_path_escape", "Registered Skill path is no longer safe");
      }
      if (error instanceof SkillManifestError) {
        return toolError("invalid_skill", "Registered Skill manifest is invalid");
      }
      return toolError("skill_load_error", "Skill could not be loaded");
    }
  }
}

// 扫描选项的预算必须是正整数；undefined 时使用章节默认值。
function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const selected = value === undefined ? fallback : value;
  if (!Number.isInteger(selected) || selected <= 0) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return selected;
}

// 同步阶段用 realpath 得到规范绝对路径，避免相对路径和链接造成歧义。
function resolveWorkspace(workspace: string): string {
  let root: string;
  try {
    root = realpathSync.native(workspace);
  } catch {
    throw new SkillPathError(`Workspace does not exist: ${workspace}`);
  }
  if (!statSync(root).isDirectory()) {
    throw new SkillPathError(`Workspace is not a directory: ${workspace}`);
  }
  return root;
}

// 异步阶段复用同一套 workspace 校验，供工具请求路径重新解析。
async function resolveWorkspaceAsync(workspace: string): Promise<string> {
  let root: string;
  try {
    root = await realpathAsync(workspace);
  } catch {
    throw new SkillPathError(`Workspace does not exist: ${workspace}`);
  }
  if (!(await statAsync(root)).isDirectory()) {
    throw new SkillPathError(`Workspace is not a directory: ${workspace}`);
  }
  return root;
}

// Skill 根必须是 workspace 内的相对目录；拒绝绝对路径、父级、NUL 和保留组件。
function resolveSkillRoot(workspaceRoot: string, skillsDirectory: string): string {
  if (skillsDirectory.length === 0 || skillsDirectory.includes("\0")) {
    throw new SkillPathError("Skills directory must be a non-empty relative path");
  }
  const normalized = skillsDirectory.replaceAll("\\", "/");
  if (
    isAbsolute(skillsDirectory) ||
    win32.isAbsolute(skillsDirectory) ||
    /^[A-Za-z]:/u.test(skillsDirectory) ||
    normalized.startsWith("/")
  ) {
    throw new SkillPathError("Skills directory must be relative to the workspace");
  }
  const parts = normalized.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0 || parts.includes("..")) {
    throw new SkillPathError("Skills directory must not contain parent segments");
  }
  for (const part of parts) {
    if (isWindowsReservedComponent(part)) {
      throw new SkillPathError(`Skills directory contains a reserved path component: ${part}`);
    }
  }
  const target = resolve(workspaceRoot, ...parts);
  if (!isInside(workspaceRoot, target)) {
    throw new SkillPathError("Skills directory escapes workspace");
  }
  return target;
}

// 同步路径复查：realpath 后必须仍位于 root 内，且目标确实是目录。
function checkedRealDirectory(path: string, root: string, message: string): string {
  let physical: string;
  try {
    physical = realpathSync.native(path);
  } catch {
    throw new SkillPathError(message);
  }
  if (!isInside(root, physical) || !statSync(physical).isDirectory()) {
    throw new SkillPathError(message);
  }
  return physical;
}

// 同步路径复查：manifest 必须是 root 内真实存在的文件。
function checkedRealFile(path: string, root: string, message: string): string {
  let physical: string;
  try {
    physical = realpathSync.native(path);
  } catch {
    throw new SkillPathError(message);
  }
  if (!isInside(root, physical) || !statSync(physical).isFile()) {
    throw new SkillPathError(message);
  }
  return physical;
}

// 异步路径复查：加载时重查目录，阻止扫描后的链接被替换成逃逸目标。
async function checkedRealDirectoryAsync(
  path: string,
  root: string,
  message: string,
): Promise<string> {
  let physical: string;
  try {
    physical = await realpathAsync(path);
  } catch {
    throw new SkillPathError(message);
  }
  if (!isInside(root, physical) || !(await statAsync(physical)).isDirectory()) {
    throw new SkillPathError(message);
  }
  return physical;
}

// 异步路径复查：加载时重查 manifest，阻止扫描后的文件被链接替换。
async function checkedRealFileAsync(path: string, root: string, message: string): Promise<string> {
  let physical: string;
  try {
    physical = await realpathAsync(path);
  } catch {
    throw new SkillPathError(message);
  }
  if (!isInside(root, physical) || !(await statAsync(physical)).isFile()) {
    throw new SkillPathError(message);
  }
  return physical;
}

// 用相对路径判断包含关系，避免字符串前缀误判 C:\a 与 C:\ab。
function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child.length === 0 || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

// 只读取 frontmatter 结束分隔符之前的字节，避免扫描时解码全量正文。
function readFrontmatter(path: string): string {
  const descriptor = openSync(path, "r");
  const completeLines: Buffer[] = [];
  let pending = Buffer.alloc(0);
  // 分块读取按行切分；跨 chunk 的行先留在 pending，遇到结束分隔符即可返回。
  const chunk = Buffer.allocUnsafe(4_096);
  try {
    while (true) {
      const count = readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (count === 0) {
        break;
      }
      let offset = 0;
      while (offset < count) {
        const newline = chunk.indexOf(0x0a, offset);
        if (newline === -1 || newline >= count) {
          pending = Buffer.concat([pending, chunk.subarray(offset, count)]);
          break;
        }
        const line = Buffer.concat([pending, chunk.subarray(offset, newline + 1)]);
        pending = Buffer.alloc(0);
        completeLines.push(line);
        if (completeLines.length > 1 && isFrontmatterSeparator(line)) {
          // catalog 只解码 frontmatter；正文留到 load_skill 被显式调用之后。
          return decodeUtf8(Buffer.concat(completeLines), path);
        }
        offset = newline + 1;
      }
    }
    if (pending.byteLength > 0) {
      completeLines.push(pending);
    }
    // 没有第二个分隔符时仍返回已读内容，由 parseSkillDocument 报告缺分隔符。
    return decodeUtf8(Buffer.concat(completeLines), path);
  } finally {
    closeSync(descriptor);
  }
}

// 只把恰好三个连字符的一行当作分隔符，并兼容 CRLF 行尾。
function isFrontmatterSeparator(line: Buffer): boolean {
  let end = line.byteLength;
  if (end > 0 && line[end - 1] === 0x0a) {
    end -= 1;
  }
  if (end > 0 && line[end - 1] === 0x0d) {
    end -= 1;
  }
  return end === 3 && line[0] === 0x2d && line[1] === 0x2d && line[2] === 0x2d;
}

// 使用 fatal TextDecoder，非 UTF-8 内容直接映射为 SkillManifestError。
function decodeUtf8(bytes: Uint8Array, source: string): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new SkillManifestError(`Skill manifest is not valid UTF-8: ${source}`);
  }
}

// 按 \n 切分并保留行尾，便于后续区分 frontmatter 与正文边界。
function splitLinesKeepEnds(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      lines.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}

// 统一剥离 \n 和可选的 \r\n，使分隔符判断不依赖换行风格。
function stripLineEnding(line: string): string {
  if (line.endsWith("\r\n")) {
    return line.slice(0, -2);
  }
  return line.endsWith("\n") ? line.slice(0, -1) : line;
}

// 校验 frontmatter 格式与结构，确保 name、description 合规。
function parseSkillDocument(text: string, source: string): ParsedSkillDocument {
  const lines = splitLinesKeepEnds(text);
  if (lines.length === 0 || stripLineEnding(lines[0] as string) !== "---") {
    throw new SkillManifestError(`Skill manifest must begin with YAML frontmatter: ${source}`);
  }
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && stripLineEnding(line) === "---",
  );
  if (closingIndex === -1) {
    throw new SkillManifestError(`Skill manifest has no closing frontmatter delimiter: ${source}`);
  }

  let metadata: unknown;
  try {
    metadata = parse(lines.slice(1, closingIndex).join(""));
  } catch {
    throw new SkillManifestError(`Skill frontmatter is not valid YAML: ${source}`);
  }
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new SkillManifestError(`Skill frontmatter must be a mapping: ${source}`);
  }
  const name = Reflect.get(metadata, "name");
  const description = Reflect.get(metadata, "description");
  if (typeof name !== "string" || typeof description !== "string") {
    throw new SkillManifestError(
      `Skill frontmatter requires string name and description: ${source}`,
    );
  }
  try {
    validateSkillName(name);
  } catch (error) {
    if (error instanceof SkillNameError) {
      throw new SkillManifestError(`Skill frontmatter contains an invalid name: ${source}`);
    }
    throw error;
  }
  const normalizedDescription = description.trim();
  if (
    normalizedDescription.length === 0 ||
    normalizedDescription.includes("\n") ||
    normalizedDescription.includes("\r")
  ) {
    throw new SkillManifestError(`Skill description must be one non-empty line: ${source}`);
  }
  return Object.freeze({
    name,
    description: normalizedDescription,
    // 正文保留原始换行，显式加载后原样进入 tool result。
    body: lines.slice(closingIndex + 1).join(""),
  });
}

function validateSkillName(name: string): void {
  // 名称规则同时约束目录名和工具参数，保证请求名到文件的映射稳定。
  if (
    name.length > MAX_SKILL_NAME_LENGTH ||
    !SKILL_NAME_REGEXP.test(name) ||
    isWindowsReservedComponent(name)
  ) {
    throw new SkillNameError(`Invalid Skill name: ${name}`);
  }
}

// 目录排序使用字典序，使系统提示中的目录可稳定复现。
function compareSkillNames(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

// Catalog 按条目数和 UTF-8 byte 双重上限截断，返回不可变快照。
// separatorBytes 计算条目之间的换行，保证渲染结果不会超过 maxCatalogBytes。
function boundedCatalog(
  records: readonly SkillRecord[],
  maxEntries: number,
  maxBytes: number,
): readonly SkillSummary[] {
  const catalog: SkillSummary[] = [];
  let usedBytes = 0;
  for (const record of records) {
    if (catalog.length >= maxEntries) {
      break;
    }
    const line = `- **${record.name}**: ${record.description}`;
    const separatorBytes = catalog.length === 0 ? 0 : 1;
    const entryBytes = Buffer.byteLength(line, "utf8") + separatorBytes;
    if (usedBytes + entryBytes > maxBytes) {
      break;
    }
    catalog.push(Object.freeze({ name: record.name, description: record.description }));
    usedBytes += entryBytes;
  }
  return Object.freeze(catalog);
}
