// PowerShell 命令适配器：负责子进程启动、超时、输出截断与退出码归一化。
import { spawn } from "node:child_process";
import type { CommandResult, CommandRunner } from "../core/commands.js";

export interface PowerShellRunnerOptions {
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly outputLimit?: number;
}

// PowerShell 命令适配器：负责子进程启动、超时、输出截断与退出码归一化。
// 默认值限制单次工具调用的等待时间与返回内容，避免循环被无限命令拖住。
export class PowerShellRunner implements CommandRunner {
  // 默认值限制单次工具调用的等待时间与返回内容，避免循环被无限命令拖住。
  readonly #executable: string;
  readonly #timeoutMs: number;
  readonly #outputLimit: number;

  constructor(options: PowerShellRunnerOptions = {}) {
    // 默认值限制单次工具调用的等待时间与返回内容，避免循环被无限命令拖住。
    this.#executable = options.executable === undefined ? "powershell.exe" : options.executable;
    // 120 秒超时能覆盖大多数正常命令；长时间阻塞命令应被截断而非持续等待。
    this.#timeoutMs = options.timeoutMs === undefined ? 120_000 : options.timeoutMs;
    // 50 KB 输出上限防止模型上下文被工具输出撑满，超出的部分被截断但不丢失最终退出码。
    this.#outputLimit = options.outputLimit === undefined ? 50_000 : options.outputLimit;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive integer");
    }
    if (!Number.isInteger(this.#outputLimit) || this.#outputLimit <= 0) {
      throw new Error("outputLimit must be a positive integer");
    }
  }

  run(command: string, cwd: string, timeoutOverrideMs?: number): Promise<CommandResult> {
    if (command.length === 0) {
      throw new Error("command must not be empty");
    }
    const timeoutMs = timeoutOverrideMs === undefined ? this.#timeoutMs : timeoutOverrideMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive integer");
    }

    return new Promise((resolve, reject) => {
      // 禁用 Profile 和交互输入，使执行环境可预测；输出统一为 UTF-8。
      const child = spawn(
        this.#executable,
        // -NoLogo 取消启动横幅，-NoProfile 防止用户 Profile 修改命令语义，-NonInteractive 阻止交互提示。
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = $OutputEncoding; ${command}`,
        ],
        { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      const chunks: string[] = [];
      let outputLength = 0;
      // truncated 标记输出是否达到上限，timedOut 标记进程是否被超时杀掉。
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const append = (chunk: Buffer): void => {
        // stdout 与 stderr 共用同一上限，避免错误输出绕过资源控制。
        if (outputLength >= this.#outputLimit) {
          truncated = true;
          return;
        }
        const text = chunk.toString("utf8");
        const remaining = this.#outputLimit - outputLength;
        chunks.push(text.slice(0, remaining));
        outputLength += Math.min(text.length, remaining);
        if (text.length > remaining) {
          truncated = true;
        }
      };

      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(
          Object.freeze({
            output: chunks.join("").trimEnd(),
            exitCode: code === null ? 1 : code,
            timedOut,
            truncated,
          }),
        );
      });

      const timer = setTimeout(() => {
        // close 回调负责结算，避免 timeout 与 close 产生两个结果。
        timedOut = true;
        child.kill();
      }, timeoutMs);
    });
  }
}
