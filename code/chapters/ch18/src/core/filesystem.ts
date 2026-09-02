// 文件 adapter 将不同平台错误归一为这些可由工具层稳定处理的领域错误。
export class WorkspacePathError extends Error {}

export class TextNotFoundError extends Error {}

export class InvalidUtf8Error extends Error {}

export class FileNotFoundError extends Error {}

export class InvalidFilePathError extends Error {}

export class FileSystemOperationError extends Error {}

// Windows 设备名不能作为普通路径组件，即使其带有扩展名。
const WINDOWS_DEVICE_NAMES = new Set(["AUX", "CLOCK$", "CON", "CONIN$", "CONOUT$", "NUL", "PRN"]);

// 该检查同时供文件 adapter 与 Skill 路径边界复用，避免各功能组件分别实现 Windows 设备名规则。
export function isWindowsReservedComponent(component: string): boolean {
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
  const firstPart = component.split(".", 1)[0];
  if (firstPart === undefined) {
    return false;
  }
  const stem = firstPart.replace(/ +$/u, "").toUpperCase();
  if (WINDOWS_DEVICE_NAMES.has(stem)) {
    return true;
  }
  const suffix = stem[3];
  return (
    suffix !== undefined &&
    stem.length === 4 &&
    (stem.startsWith("COM") || stem.startsWith("LPT")) &&
    "123456789¹²³".includes(suffix)
  );
}

// 权限层仅依赖此窄接口检查写入边界，避免反向依赖具体文件实现。
export interface WorkspaceWriteBoundary {
  isPathWithinWorkspace(workspace: string, relativePath: string): Promise<boolean>;
}

// 仅声明 Agent 工具需要的工作区文件能力。
// SkillRegistry 复用本文件的保留组件检查，但 SKILL.md 扫描不走此 adapter：
// 它需要控制 frontmatter 的逐字节读取，并在加载时异步重查真实路径。
export interface WorkspaceFileSystem extends WorkspaceWriteBoundary {
  readFile(workspace: string, relativePath: string, limit?: number): Promise<string>;
  writeFile(workspace: string, relativePath: string, content: string): Promise<number>;
  editFile(
    workspace: string,
    relativePath: string,
    oldText: string,
    newText: string,
  ): Promise<void>;
  globFiles(workspace: string, pattern: string): Promise<readonly string[]>;
}
