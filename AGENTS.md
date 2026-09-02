# Repository Guidelines

## Project Structure & Module Organization

This repository contains a 20-part, Chinese-language series about building AI agents. Each numbered Markdown file at the repository root is one article; the numeric prefix defines the reading order. Keep an article's prose, diagrams, tables, and code samples together in that file. Images are currently referenced by remote Markdown URLs rather than stored locally.

Runnable companion code lives in `code/`. Each chapter owns a complete runnable TypeScript snapshot under `code/chapters/chNN/src/`, with its cumulative behavioral tests under `code/chapters/chNN/tests/`; do not reintroduce shared root `code/src/` or `code/tests/` copies. Treat each chapter's own `src/` snapshot plus its `tests/` suite as the implementation and acceptance sources of truth; `code/package.json` scripts (`test:chNN`, `lint`, `format:check`, `verify:snapshot-drift`) are the gates.

## Build, Test, and Development Commands

The migrated TypeScript project uses npm, Vitest, Biome, and strict TypeScript. Run project commands from `code/`:

```powershell
rtk npm ci
rtk npm run typecheck
rtk npm test
rtk npm run lint
rtk npm run format:check
rtk npm run build
```

Run a migrated chapter from `code/` with either entry form:

```powershell
rtk npm run ch01 -- --prompt "列出当前目录"
rtk npm run ch02 -- --prompt "读取 package.json"
rtk npm run ch03 -- --prompt "读取 README.md，然后写入 chapter3-note.txt"
rtk npm run ch04 -- --prompt "读取 README.md 并概括运行方式"
rtk npm run ch05 -- --prompt "先建立完整 TODO，再读取 README.md 并总结运行和验证步骤"
rtk npm run ch06 -- --prompt "调用 task 独立检查本项目使用的测试框架，只返回有文件证据的结论"
rtk npm run ch07 -- --prompt "先调用 load_skill 加载 typescript-style，再总结其中两条约定"
rtk npm run ch08 -- --prompt "读取一个大文件并总结，观察完整结果落盘后的路径与预览"
rtk npm run ch09 -- --prompt "记住：本项目的示例只使用 PowerShell"
rtk npm run ch10 -- --prompt "列出当前 Agent 的可用工具"
rtk npm run ch11 -- --prompt "检查当前工作区并给出结论"
rtk npm run ch12 -- --prompt "建立 schema、endpoints、tests 和 docs 的任务依赖"
rtk npm run ch13 -- --prompt "后台运行 npm install，同时读取 README.md；拿到结果后再总结"
rtk npm run ch14 -- --prompt "每天上海时间 9 点检查 CI，周期执行并持久化"
rtk npm run ch15 -- --prompt "创建一名 writer 队友，让她阅读 README 并汇报缺口"
rtk npm run ch16 -- --prompt "创建一名 writer 队友，让她先提交计划，批准后执行并优雅关闭"
rtk npm run ch17 -- --prompt "调用 task 独立检查本项目使用的测试框架，只返回有文件证据的结论"
rtk npm run ch18 -- --prompt "创建两个任务并绑定独立 Worktree，再启动 alice 和 bob 分别认领"
rtk npm run ch19 -- --prompt "先连接 demo_alpha 和 demo_beta，下一轮分别调用 lookup 查询 needle，再断开 demo_alpha"
rtk npm run ch20 -- --prompt "验证完整 Harness 的动态上下文、MCP 边界和资源关闭"
rtk npm run agent-tutorial -- run --chapter 1 --prompt "列出当前目录"
rtk npm run agent-tutorial -- run --chapter 2 --prompt "读取 package.json"
rtk npm run agent-tutorial -- run --chapter 3 --prompt "读取 README.md，然后写入 chapter3-note.txt"
rtk npm run agent-tutorial -- run --chapter 4 --prompt "读取 README.md 并概括运行方式"
rtk npm run agent-tutorial -- run --chapter 5 --prompt "先建立完整 TODO，再读取 README.md 并总结运行和验证步骤"
rtk npm run agent-tutorial -- run --chapter 6 --prompt "调用 task 总结 chapters/ch06/src/core 目录职责，再由父 Agent 给出结论"
rtk npm run agent-tutorial -- run --chapter 7 --prompt "调用 load_skill 加载 typescript-style，再概括关键约定"
rtk npm run agent-tutorial -- run --chapter 8 --prompt "读取一个大文件并总结，观察完整结果落盘后的路径与预览"
rtk npm run agent-tutorial -- run --chapter 9 --prompt "这个项目的命令示例有什么约束？"
rtk npm run agent-tutorial -- run --chapter 10 --prompt "列出当前 Agent 的可用工具"
rtk npm run agent-tutorial -- run --chapter 11 --prompt "检查当前工作区并给出结论"
rtk npm run agent-tutorial -- run --chapter 12 --prompt "列出当前项目任务并认领一个 ready 任务"
rtk npm run agent-tutorial -- run --chapter 13 --prompt "后台运行 npm install，同时读取 README.md；拿到结果后再总结"
rtk npm run agent-tutorial -- run --chapter 14 --prompt "每天上海时间 9 点检查 CI，周期执行并持久化"
rtk npm run agent-tutorial -- run --chapter 15 --prompt "创建一名 writer 队友，让她阅读 README 并汇报缺口"
rtk npm run agent-tutorial -- run --chapter 16 --prompt "创建一名 writer 队友，让她先提交计划，批准后执行并优雅关闭"
rtk npm run agent-tutorial -- run --chapter 17 --prompt "调用 task 独立检查本项目使用的测试框架，只返回有文件证据的结论"
rtk npm run agent-tutorial -- run --chapter 18 --prompt "创建两个任务并绑定独立 Worktree，再启动 alice 和 bob 分别认领"
rtk npm run agent-tutorial -- run --chapter 19 --prompt "先连接 demo_alpha 和 demo_beta，下一轮分别调用 lookup 查询 needle，再断开 demo_alpha"
rtk npm run agent-tutorial -- run --chapter 20 --prompt "验证完整 Harness 的动态上下文、MCP 边界和资源关闭"
```

Real runs require a local `.env` copied from `code/.env.example`; chapter 11 and later also require `OPENAI_FALLBACK_MODEL`. Offline tests must inject the model and other external boundaries; do not require secrets or network access. Use the fixed script for each migrated chapter, currently `ch01` through `ch20`; do not claim a later TypeScript chapter is runnable until its script, profile, implementation, tests, and tutorial have all passed review.

## Coding Style & Naming Conventions

Write article prose in Simplified Chinese and preserve the established conversational, technical tone. Name new installments as `<sequence>. <descriptive title>（<series label>）.md`; do not renumber unrelated files. Separate major passages with blank lines and `---` where the surrounding article does so. Give fenced code blocks a language tag. User-facing commands must be PowerShell. TypeScript uses ESM, strict checking, explicit exported contracts, `unknown` at untrusted boundaries, and must pass the configured TypeScript, Biome, Vitest, and build checks. Keep identifiers, API fields, commands, and error text in their original language. Code comments and documentation comments use Simplified Chinese unless an external protocol term is clearer in English.

## Testing Guidelines

For TypeScript behavior changes, add focused Vitest tests that assert concrete results, state, side effects, or failure branches. Run `typecheck` plus the focused test before each chapter review; run the full suite when shared runtime code changes. Run Biome and build before claiming a chapter is verified. Real OpenAI smoke tests are additional evidence only when all required credentials are available; otherwise report `Blocked, not run`.

For every article edit, read back the complete changed article, confirm fenced blocks are paired, verify tables and local code paths, and open every added or changed link or image URL. Trace technical examples from input through expected output and keep snippets consistent with the runnable companion code.

## Commit & Pull Request Guidelines

This directory is a Git repository. Its history uses Conventional Commit types with a chapter scope and a Simplified Chinese subject, for example `docs(ch20): 重写 Full Harness 整合教程`. Follow that convention. Keep each commit focused on one article or one shared correction. Pull requests should identify affected article numbers, summarize substantive changes, explain technical corrections, and link the relevant issue when one exists. Include a rendered screenshot only when formatting, tables, or image placement changed.
