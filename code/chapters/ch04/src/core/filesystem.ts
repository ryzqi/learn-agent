// 文件 adapter 将不同平台错误归一为这些可由工具层稳定处理的领域错误。
// 文件系统抽象边界：WorkspaceFileSystem 仅暴露工作区内的文件操作，禁止越界。
export class WorkspacePathError extends Error {}

// target 文本未在文件中找到，edit_file 的特有错误。
export class TextNotFoundError extends Error {}

// 文件内容不是有效 UTF-8，读操作的特有错误。
export class InvalidUtf8Error extends Error {}

// ENOENT 归一为此错误，不泄漏具体文件系统路径。
export class FileNotFoundError extends Error {}

// EISDIR / ENOTDIR 或路径类型与预期不符时使用此错误。
export class InvalidFilePathError extends Error {}

// 其他不可归类的文件系统故障使用此错误。
export class FileSystemOperationError extends Error {}

export interface WorkspaceWriteBoundary {
  // 权限层仅依赖此窄接口检查写入边界，避免反向依赖具体文件实现。
  isPathWithinWorkspace(workspace: string, relativePath: string): Promise<boolean>;
}

export interface WorkspaceFileSystem extends WorkspaceWriteBoundary {
  // 仅声明 Agent 工具需要的工作区文件能力。
  // 读取严格 UTF-8 文本；limit 存在时按规范化行数截断。
  readFile(workspace: string, relativePath: string, limit?: number): Promise<string>;
  // 写入完整 UTF-8 内容并返回字节数。
  writeFile(workspace: string, relativePath: string, content: string): Promise<number>;
  // 仅替换第一次精确匹配，找不到时不写入变更。
  editFile(
    workspace: string,
    relativePath: string,
    oldText: string,
    newText: string,
  ): Promise<void>;
  // 按受限 glob 子集返回稳定排序的工作区相对路径。
  globFiles(workspace: string, pattern: string): Promise<readonly string[]>;
}
