import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";

import { GitExecutionError } from "../features/worktrees.js";
import type { GitCommandResult, GitRunner } from "../features/worktrees.js";

const execFileAsync = promisify(execFile);

// Git 子进程边界统一校验工作目录和超时，调用方只接收结构化命令结果。
export class SubprocessGitRunner implements GitRunner {
  readonly #timeoutMs: number;

  constructor(timeoutMs = 30_000) {
    // 超时策略在适配器构造时固定，领域运行时不处理进程级细节。
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be positive");
    }
    this.#timeoutMs = timeoutMs;
  }

  async run(argumentsValue: readonly string[], cwd: string): Promise<GitCommandResult> {
    // 坚持数组参数 + execFile 避免 shell 注入；工作目录必须真实存在且是目录。
    if (
      !Array.isArray(argumentsValue) ||
      argumentsValue.length === 0 ||
      argumentsValue.some((argument) => typeof argument !== "string" || argument.length === 0)
    ) {
      throw new TypeError("Git arguments must contain non-empty strings");
    }
    let workingDirectory: string;
    try {
      workingDirectory = await realpath(cwd);
      if (!(await stat(workingDirectory)).isDirectory())
        throw new Error("Git cwd is not a directory");
    } catch (error) {
      throw new GitExecutionError("Git cwd could not be resolved", { cause: error });
    }
    try {
      const result = await execFileAsync("git", ["--no-pager", ...argumentsValue], {
        // execFile 不经过 shell，数组元素直接作为 argv 传递，参数含空格或特殊字符也安全。
        cwd: workingDirectory,
        encoding: "utf8",
        timeout: this.#timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
      return Object.freeze({
        returncode: 0,
        stdout: String(result.stdout),
        stderr: String(result.stderr),
      });
    } catch (error) {
      const details = error as {
        code?: unknown;
        stdout?: unknown;
        stderr?: unknown;
        killed?: unknown;
      };
      // 超时与启动失败是不同错误类别：超时明确抛出，普通非零退出码转为结构化结果。
      if (details.killed === true || details.code === "ETIMEDOUT") {
        throw new GitExecutionError("Git command timed out", { cause: error });
      }
      if (typeof details.code === "number") {
        return Object.freeze({
          returncode: details.code,
          stdout: typeof details.stdout === "string" ? details.stdout : "",
          stderr: typeof details.stderr === "string" ? details.stderr : "",
        });
      }
      throw new GitExecutionError("Git command could not be started", { cause: error });
    }
  }
}
