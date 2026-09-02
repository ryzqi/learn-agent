// Node.js 文件系统 adapter：把工作区读写、编辑与 glob 归一为 core 接口。
// 路径始终从工作区相对路径进入，平台错误统一翻译成领域错误。
// Node.js 文件系统 adapter：将平台能力归一为 WorkspaceFileSystem 接口。
// 路径安全通过 safePath 校验，拒绝绝对路径、盘符、上级目录和符号链接越界。
import {
  lstat,
  mkdir,
  readdir,
  readFile as readFileBytes,
  realpath,
  stat,
  writeFile as writeFileBytes,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { TextDecoder } from "node:util";

import {
  FileNotFoundError,
  FileSystemOperationError,
  InvalidFilePathError,
  InvalidUtf8Error,
  TextNotFoundError,
  WorkspacePathError,
} from "../core/filesystem.js";
import type { WorkspaceFileSystem } from "../core/filesystem.js";

// Windows 设备名不能作为普通路径组件，即使其带有扩展名。
const WINDOWS_DEVICE_NAMES = new Set(["AUX", "CLOCK$", "CON", "CONIN$", "CONOUT$", "NUL", "PRN"]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

// 平台 errno 统一收敛成 core 可稳定映射给模型的领域错误。
// Node.js 文件系统 adapter：将平台能力归一为 WorkspaceFileSystem 接口。
// 路径一律从工作区相对路径进入；错误统一归一为 core 可映射的领域错误。
function translateFileSystemError(error: unknown): Error {
  // Adapter 将平台 errno 收敛成 core 可稳定映射给模型的领域错误。
  if (
    error instanceof WorkspacePathError ||
    error instanceof TextNotFoundError ||
    error instanceof InvalidUtf8Error ||
    error instanceof FileNotFoundError ||
    error instanceof InvalidFilePathError ||
    error instanceof FileSystemOperationError ||
    error instanceof RangeError
  ) {
    return error;
  }
  const code = errorCode(error);
  if (code === "ENOENT") {
    return new FileNotFoundError("File or directory was not found");
  }
  if (code === "EISDIR" || code === "ENOTDIR") {
    return new InvalidFilePathError("Path has the wrong file type");
  }
  if (code === undefined) {
    return error instanceof Error ? error : new Error("Non-error value thrown by file system code");
  }
  return new FileSystemOperationError("File system operation failed");
}

// 所有路径以相对路径进入，先在词法层拒绝盘符、绝对路径和上级目录。
function isInside(root: string, candidate: string): boolean {
  // 相对路径为空表示 candidate 就是 root；其余必须以 .. 之外的非绝对子路径开头。
  const child = relative(root, candidate);
  return (
    child.length === 0 || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

function isWindowsReservedComponent(component: string): boolean {
  // 尾部空格/点、控制字符和 Windows 路径特殊字符都不允许出现在普通文件组件中。
  if (component.endsWith(" ") || component.endsWith(".")) {
    return true;
  }
  if (
    [...component].some((character) => {
      const code = character.codePointAt(0);
      return (code !== undefined && code < 32) || '<>:"|*?'.includes(character);
    })
  ) {
    return true;
  }
  const stem = component.split(".", 1)[0]?.replace(/ +$/u, "").toUpperCase();
  if (stem === undefined) {
    return false;
  }
  if (WINDOWS_DEVICE_NAMES.has(stem)) {
    return true;
  }
  return (
    stem.length === 4 &&
    (stem.startsWith("COM") || stem.startsWith("LPT")) &&
    "123456789¹²³".includes(stem[3] ?? "")
  );
}

function relativeParts(value: string, label: string, allowWildcards: boolean): string[] {
  // 所有路径以相对路径进入，先在词法层拒绝盘符、绝对路径和上级目录。
  if (value.length === 0) {
    throw new WorkspacePathError(`${label} must not be empty`);
  }
  if (value.includes("\0")) {
    throw new WorkspacePathError(`${label} contains a null byte`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    normalized.startsWith("/")
  ) {
    throw new WorkspacePathError(
      `${label} must be relative; absolute paths are rejected: ${value}`,
    );
  }
  const parts = normalized.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.includes("..")) {
    throw new WorkspacePathError(`${label} must not contain parent segments: ${value}`);
  }
  for (const part of parts) {
    if (!allowWildcards && isWindowsReservedComponent(part)) {
      throw new WorkspacePathError(`${label} contains a reserved Windows path component: ${part}`);
    }
    if (
      [...part].some((character) => {
        const code = character.codePointAt(0);
        return (code !== undefined && code < 32) || '<>:"|'.includes(character);
      })
    ) {
      throw new WorkspacePathError(`${label} contains a reserved Windows path component: ${part}`);
    }
  }
  return parts;
}

async function workspaceRoot(workspace: string): Promise<string> {
  // realpath 先解析工作区自身，后续 safePath 都基于真实根目录计算边界。
  const root = await realpath(workspace);
  const information = await stat(root);
  if (!information.isDirectory()) {
    throw new InvalidFilePathError(`Workspace is not a directory: ${workspace}`);
  }
  return root;
}

async function resolvedExistingParent(
  root: string,
  target: string,
): Promise<{ physical: string; lexical: string }> {
  // 从目标逐级向上找已存在父路径，真实解析后再拼接不存在的尾部，防止符号链接逃逸。
  let current = target;
  while (true) {
    try {
      return { physical: await realpath(current), lexical: current };
    } catch (error) {
      if (errorCode(error) !== "ENOENT" || current === root) {
        throw error;
      }
      current = dirname(current);
    }
  }
}

export async function safePath(workspace: string, relativePath: string): Promise<string> {
  try {
    const root = await workspaceRoot(workspace);
    // 先做词法检查，拒绝绝对路径、..、Windows 保留名和非法字符。
    const parts = relativeParts(relativePath, "path", false);
    const target = resolve(root, ...parts);
    if (!isInside(root, target)) {
      throw new WorkspacePathError(`Path escapes workspace: ${relativePath}`);
    }
    // 现有父路径必须解析真实位置，防止 junction 或符号链接把目标带出工作区。
    const existing = await resolvedExistingParent(root, target);
    const resolved = resolve(existing.physical, relative(existing.lexical, target));
    if (!isInside(root, resolved)) {
      throw new WorkspacePathError(`Path escapes workspace: ${relativePath}`);
    }
    return resolved;
  } catch (error) {
    throw translateFileSystemError(error);
  }
}

function decodeUtf8(bytes: Uint8Array, relativePath: string): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new InvalidUtf8Error(`File is not valid UTF-8: ${relativePath}`);
  }
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split(/\r\n|\r|\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

// 仅实现工具契约需要的 *, **, ? 和字符类，不将未验证模式交给 Shell。
function globRegex(pattern: string): RegExp {
  // 仅实现工具契约需要的 *, **, ? 和字符类，不将未验证模式交给 Shell。
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === undefined) {
      continue;
    }
    if (character === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end === -1) {
        source += "\\[";
      } else {
        const content = pattern.slice(index + 1, end);
        source += content.startsWith("!") ? `[^${content.slice(1)}]` : `[${content}]`;
        index = end;
      }
    } else {
      source += character === "/" ? "/" : character.replace(/[\\^$+?.()|{}]/gu, "\\$&");
    }
  }
  return new RegExp(`${source}$`, "u");
}

async function literalPrefix(root: string, parts: readonly string[]): Promise<readonly string[]> {
  const literal: string[] = [];
  for (const part of parts) {
    if (/[?*[\]]/u.test(part)) {
      break;
    }
    literal.push(part);
  }
  if (literal.length > 0) {
    await safePath(root, literal.join(sep));
  }
  return literal;
}

export class NodeWorkspaceFileSystem implements WorkspaceFileSystem {
  async isPathWithinWorkspace(workspace: string, relativePath: string): Promise<boolean> {
    try {
      await safePath(workspace, relativePath);
      return true;
    } catch (error) {
      if (error instanceof WorkspacePathError) {
        return false;
      }
      throw error;
    }
  }

  async readFile(workspace: string, relativePath: string, limit?: number): Promise<string> {
    try {
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        throw new RangeError("limit must be a positive integer");
      }
      const target = await safePath(workspace, relativePath);
      const text = decodeUtf8(await readFileBytes(target), relativePath);
      const lines = splitLines(text);
      if (limit !== undefined && limit < lines.length) {
        // 截断提示保留总行数，调用方可决定是否继续读取。
        return [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`].join("\n");
      }
      return lines.join("\n");
    } catch (error) {
      throw translateFileSystemError(error);
    }
  }

  async writeFile(workspace: string, relativePath: string, content: string): Promise<number> {
    try {
      const target = await safePath(workspace, relativePath);
      const bytes = Buffer.from(content, "utf8");
      await mkdir(dirname(target), { recursive: true });
      await writeFileBytes(target, bytes);
      return bytes.byteLength;
    } catch (error) {
      throw translateFileSystemError(error);
    }
  }

  async editFile(
    workspace: string,
    relativePath: string,
    oldText: string,
    newText: string,
  ): Promise<void> {
    try {
      if (oldText.length === 0) {
        throw new RangeError("old_text must not be empty");
      }
      const target = await safePath(workspace, relativePath);
      const currentBytes = await readFileBytes(target);
      const current = decodeUtf8(currentBytes, relativePath);
      const index = current.indexOf(oldText);
      if (index === -1) {
        throw new TextNotFoundError(`Exact text not found in ${relativePath}`);
      }
      // 只替换首次精确匹配，避免模型提出的编辑意外影响多个位置。
      const updated = `${current.slice(0, index)}${newText}${current.slice(index + oldText.length)}`;
      await writeFileBytes(target, Buffer.from(updated, "utf8"));
    } catch (error) {
      throw translateFileSystemError(error);
    }
  }

  async globFiles(workspace: string, pattern: string): Promise<readonly string[]> {
    try {
      const root = await workspaceRoot(workspace);
      const parts = relativeParts(pattern, "glob pattern", true);
      const prefix = await literalPrefix(root, parts);
      const normalizedPattern = parts.length === 0 ? "." : parts.join("/");
      const matcher = globRegex(normalizedPattern);
      const start = resolve(root, ...prefix);
      let startInformation: Stats;
      try {
        startInformation = await lstat(start);
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          return Object.freeze([]);
        }
        throw error;
      }
      if (prefix.length === parts.length) {
        return Object.freeze(matcher.test(normalizedPattern) ? [normalizedPattern] : []);
      }
      if (!startInformation.isDirectory() || startInformation.isSymbolicLink()) {
        return Object.freeze([]);
      }
      const results: string[] = [];
      const pending = [start];
      // Dirent.isDirectory() 不会跟随符号链接目录，避免递归越界和链接环。
      while (pending.length > 0) {
        const directory = pending.pop();
        if (directory === undefined) {
          continue;
        }
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const target = join(directory, entry.name);
          const relativePath = relative(root, target).split(sep).join("/");
          if (matcher.test(relativePath)) {
            const resolved = await safePath(root, relativePath);
            if (!isInside(root, resolved)) {
              throw new WorkspacePathError(`Glob match escapes workspace: ${relativePath}`);
            }
            results.push(relativePath);
          }
          if (entry.isDirectory()) {
            pending.push(target);
          }
        }
      }
      return Object.freeze([...new Set(results)].sort());
    } catch (error) {
      throw translateFileSystemError(error);
    }
  }
}
