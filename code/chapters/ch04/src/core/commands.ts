// 命令适配器与工具层之间的最小进程结果契约。
// 命令执行抽象边界：CommandRunner 只接收命令和 cwd，返回输出、退出码和超时状态。
export interface CommandResult {
  // output 是截断后的稳定文本；timedOut 与 truncated 是权限之外的执行边界信息。
  readonly output: string;
  // 子进程退出码；非零值由工具层转为稳定错误码。
  readonly exitCode: number;
  // 是否因调用预算耗尽而终止进程。
  readonly timedOut: boolean;
  // 合并输出是否达到上下文保护上限。
  readonly truncated: boolean;
}

export interface CommandRunner {
  // cwd 必须由 Agent 上下文提供，命令文本不能自行扩大工作目录范围。
  // timeoutMs 只覆盖本次进程调用，省略时由适配器使用默认预算。
  run(command: string, cwd: string, timeoutMs?: number): Promise<CommandResult>;
}
