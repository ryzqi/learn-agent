#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import { NodeWorkspaceFileSystem } from "./adapters/filesystem.js";
import { OpenAIChatModel } from "./adapters/openai-chat.js";
import { buildAgent } from "./bootstrap.js";
import { ConfigurationError, settingsFromEnvFile, settingsFromMapping } from "./config.js";
import type { HookContext } from "./core/hooks.js";
import { HookRegistry, HookResult } from "./core/hooks.js";
import type { ApprovalProvider, AuditSink } from "./core/permissions.js";
import { PermissionDecision } from "./core/permissions.js";
import type { PermissionRequest } from "./core/permissions.js";
import type { ChapterProfile } from "./core/profiles.js";
import { profileForChapter } from "./core/profiles.js";

// 终端示例 Hook 只提供可观察性，不改变模型或工具决策。
class TerminalApprovalProvider implements ApprovalProvider {
  // 在终端收敛 ask 决策；无 TTY、异常或非肯定回答一律 deny。
  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    const definition = request.prepared.definition;
    const proposed = request.proposedDecision;
    if (definition === undefined || proposed === undefined) {
      throw new Error("approval request is incomplete");
    }
    stderr.write(`\n工具调用需要批准: ${definition.name}\n`);
    stderr.write(`原因: ${proposed.reason}\n`);
    stderr.write(`参数: ${JSON.stringify(request.prepared.arguments)}\n`);
    if (!stdin.isTTY) {
      stderr.write("无交互输入，默认拒绝。\n");
      return new PermissionDecision(
        "deny",
        "No interactive approval input was available",
        "terminal-approval",
      );
    }

    const terminal = createInterface({ input: stdin, output: stderr });
    try {
      const answer = await terminal.question("允许本次调用? [y/N] ");
      const normalized = answer.trim().toLowerCase();
      const allowed = normalized === "y" || normalized === "yes";
      return new PermissionDecision(
        allowed ? "allow" : "deny",
        allowed ? "User approved this tool call" : "User denied this tool call",
        "terminal-approval",
      );
    } finally {
      terminal.close();
    }
  }
}

class TerminalAuditSink implements AuditSink {
  // 将最终权限结论写入 stderr，避免混入最终回答 stdout。
  async record(request: PermissionRequest, decision: PermissionDecision): Promise<void> {
    const definition = request.prepared.definition;
    if (definition === undefined) {
      throw new Error("audit request is incomplete");
    }
    stderr.write(
      `[Permission] ${definition.name}: ${decision.behavior} (${decision.source}) - ${decision.reason}\n`,
    );
  }
}

interface RunArguments {
  // 映射为固定 profile 的章节号。
  readonly chapter: number;
  // 传给 AgentRunner 的用户任务。
  readonly prompt: string;
}

function parseRunArguments(argv: readonly string[], fixedChapter?: number): RunArguments {
  // 固定章节入口复用同一解析器，并由此禁止传入另一个 --chapter。
  const args = fixedChapter === undefined ? argv : ["--chapter", String(fixedChapter), ...argv];
  let chapter: number | undefined;
  let prompt: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--chapter") {
      const value = args[index + 1];
      if (value === undefined || !/^(?:[1-9]|1[0-9]|20)$/.test(value)) {
        throw new Error("--chapter must be an integer from 1 to 20");
      }
      chapter = Number(value);
      index += 1;
      continue;
    }
    if (arg === "--prompt") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error("--prompt must not be empty");
      }
      prompt = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${String(arg)}`);
  }
  if (chapter === undefined || prompt === undefined) {
    throw new Error("Both --chapter and --prompt are required");
  }
  return { chapter, prompt };
}

// 真实启动路径：加载配置、模型、文件边界、审批/审计，并在 P04+ 注入可观察 Hook。
async function execute(profile: ChapterProfile, prompt: string): Promise<number> {
  // 从当前目录读取 .env，注入终端审批与审计；只有 P04+ 才注册 Hook。
  // 当前目录是文件与命令的唯一工作区边界。
  const workspace = resolve(process.cwd());
  const envPath = resolve(workspace, ".env");
  const settings = existsSync(envPath) ? settingsFromEnvFile(envPath) : settingsFromMapping({});
  const model = new OpenAIChatModel(settings);
  const fileSystem = new NodeWorkspaceFileSystem();
  const runner = buildAgent(profile, {
    model,
    workspace,
    fileSystem,
    approvalProvider: new TerminalApprovalProvider(),
    auditSink: new TerminalAuditSink(),
    ...(profile.capabilities.has("hooks") ? { hooks: liveHooks() } : {}),
  });
  const result = await runner.run(prompt);
  stdout.write(`${result.finalText}\n`);
  return 0;
}

// 创建仅记录生命周期的默认 Hook；它们不改变权限、参数、结果或停止决定。
function liveHooks(): HookRegistry {
  // 默认 Hook 只观察生命周期，不改参数、结果或权限；stdout 留给最终答案。
  const hooks = new HookRegistry();
  hooks.register("UserPromptSubmit", () => {
    stderr.write("[Hook] UserPromptSubmit\n");
    return new HookResult();
  });
  hooks.register("PreToolUse", (context: HookContext) => {
    stderr.write(`[Hook] PreToolUse: ${hookToolName(context)}\n`);
    return new HookResult();
  });
  hooks.register("PostToolUse", (context: HookContext) => {
    if (context.result === undefined) {
      throw new Error("PostToolUse context is incomplete");
    }
    const outcome = context.result.isError ? "error" : "ok";
    stderr.write(`[Hook] PostToolUse: ${hookToolName(context)} -> ${outcome}\n`);
    return new HookResult();
  });
  hooks.register("Stop", () => {
    stderr.write("[Hook] Stop\n");
    return new HookResult();
  });
  return hooks;
}

// 从工具事件上下文提取可显示名称；缺失 prepared 表示 Hook 契约已被破坏。
function hookToolName(context: HookContext): string {
  const definition = context.prepared?.definition;
  if (definition === undefined) {
    throw new Error(`${context.event} context is incomplete`);
  }
  return definition.name;
}

export async function runCli(argv: readonly string[]): Promise<number> {
  return runWithErrorHandling(async () => {
    if (argv[0] !== "run") {
      throw new Error("Expected command: run");
    }
    const parsed = parseRunArguments(argv.slice(1));
    return await execute(profileForChapter(parsed.chapter), parsed.prompt);
  });
}

export async function runProfile(
  profile: ChapterProfile,
  argv: readonly string[],
): Promise<number> {
  return runWithErrorHandling(async () => {
    const parsed = parseRunArguments(argv, profile.chapter);
    return await execute(profile, parsed.prompt);
  });
}

async function runWithErrorHandling(run: () => Promise<number>): Promise<number> {
  // 进程边界将预期配置错误与运行错误映射为稳定退出码。
  try {
    return await run();
  } catch (error) {
    const label = error instanceof ConfigurationError ? "配置错误" : "运行失败";
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${label}: ${message}\n`);
    return error instanceof ConfigurationError ? 2 : 1;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && fileURLToPath(import.meta.url) === resolve(entryPath)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
