# Agent 架构实操

一套从零搭建生产级 AI Agent Harness 的 20 章中文教程。

本教程不把 Agent 简化成“调用一次模型 API”。它从最小的 Agent Loop 开始，逐章补齐工具、文件、权限、Hook、计划、上下文、记忆、可靠性、任务调度、多 Agent 协作、Worktree 隔离和 MCP，最后把全部能力接回同一个完整 Harness。每章都有一篇文章和一份可运行的 TypeScript 快照，读者可以边读边运行、边测试边理解设计边界。

## 这套教程解决什么问题

模型负责推理和决定下一步；Harness 负责把决定安全地落到真实环境。教程围绕四个问题递进：

1. **Agent 如何行动？** 用一个稳定的循环读取模型回复、执行工具、追加结果。
2. **Agent 如何被约束？** 用文件边界、权限策略、Hook 和结构化协议控制副作用。
3. **Agent 如何处理长任务？** 用 TODO、子 Agent、Skill、上下文压缩、记忆、恢复、后台任务和 Cron 延长有效工作时间。
4. **多个 Agent 如何协作并接入外部能力？** 用任务认领、Mailbox、协议审批、SQLite、Worktree 和 MCP 形成可恢复、可审计的协作运行时。

核心原则：**每章只增加一个主要能力，前章行为继续保留；P20 不另造一套循环，而是验证前 19 章能力能否在同一个 AgentRunner 中协同工作。**

## 教程脉络

```text
Agent Loop
  -> 工具与文件边界
  -> 权限与 Hook
  -> 计划、子 Agent、Skill
  -> 产物落盘、上下文压缩、跨会话记忆
  -> 动态 Prompt、API 恢复、任务 DAG
  -> 后台任务、Cron
  -> Teammate、Mailbox、协议与计划审批
  -> SQLite 认领、Worktree 隔离
  -> MCP 动态工具池
  -> 完整 Harness
```

可以按五个阶段阅读：

| 阶段 | 章节 | 解决的问题 |
| --- | --- | --- |
| 执行基础 | 1–4 | 从循环、工具、文件边界走到权限和 Hook 生命周期 |
| 上下文与知识 | 5–10 | 让 Agent 能规划、委派、按需加载知识、压缩上下文、持久化记忆，并把运行态组装解耦 |
| 可靠执行与任务系统 | 11–14 | 处理截断、超长输入、限流、重试、任务依赖、后台作业和定时触发 |
| 多 Agent 协作与隔离 | 15–18 | 从消息投递走到协议闭环、去中心化认领和 Git Worktree 并行开发 |
| 动态扩展与总装 | 19–20 | 把外部 MCP 工具安全接入动态工具池，再验证完整 Harness 的统一边界 |

## 20 章地图

| 章 | 主题 | 本章新增的关键能力 |
| ---: | --- | --- |
| [1](<./1. Agent Loop：一个循环，就是模型与真实世界之间的全部距离（Agent架构实操一）.md>) | Agent Loop | `loop`、`powershell`：模型请求、工具结果、继续/结束的最小循环 |
| [2](<./2. 给 Agent 加一个工具，只需要加一行（Agent架构实操二）.md>) | 工具与文件 | `tool_registry`、`files`：注册表、Zod 输入、workspace 安全路径、读写文件 |
| [3](<./3. 深度拆解复刻 Claude Code 权限系统：如何实现生产级的 Agent 安全策略？（Agent架构实操三）.md>) | 权限系统 | `policy`：审批、审计、四态权限决定和统一工具错误边界 |
| [4](<./4. 深度解析复刻 Claude Code ：顶级 AI Agent 是如何利用 Hook 解耦的？（Agent架构实操四）.md>) | Hook 解耦 | `hooks`：UserPromptSubmit、PreToolUse、PostToolUse、Stop 四个生命周期点 |
| [5](<./5. 为什么上下文越长，系统提示词越没用？深度揭秘 Transformer 机制下的“Agent 失忆症”（Agent架构实操五）.md>) | 会话计划 | `todo`：完整快照、状态校验、陈旧计划提醒，避免长任务漂移 |
| [6](<./6. 从“单兵死磕”到“分身协作”：复杂任务下 AI Agent 的工程化突围（Agent架构实操六）.md>) | 子 Agent | `subagent`：隔离历史、共享运行边界、禁止递归委派、限制轮数 |
| [7](<./7. 别再硬塞 Prompt 了！手把手教你搭建一套工业级的 Agent Skill 技能系统（Agent架构实操七）.md>) | Skill 系统 | `skills`：先扫描摘要，再按名称加载正文，知识按需进入上下文 |
| [8](<./8. 拆解复刻Claude Code 核心设计：如何用“四级压缩法”干掉 Agent 上下文膨胀？（Agent架构实操八）.md>) | 上下文压缩 | `artifacts`、`compaction`：结果落盘、分层裁剪、摘要恢复上下文预算 |
| [9](<./9. 从上下文压缩到文件级持久化：彻底解决 AI Agent 的健忘症（全流程解析）（Agent架构实操九）.md>) | 文件记忆 | `memory`：从 canonical history 提取、整理并跨会话检索持久记忆 |
| [10](<./10. 从“一锅炖”到“模块化”：重塑 AI Agent 的逻辑骨架（Agent架构实操十）.md>) | 动态上下文 | `dynamic_prompt`：Provider 按固定顺序生成运行态系统提示，避免复制 Loop |
| [11](<./11. API 韧性即生命：决定 AI Agent 商业化成败的隐藏细节（Agent架构实操十一）.md>) | API 恢复 | `recovery`：截断、超长、429/529、Retry-After、fallback、取消与总时限 |
| [12](<./12. 实战干货：5 个工具、3 个状态，带你撸出一个生产级 Agent 任务引擎（Agent架构实操十二）.md>) | 任务 DAG | `task_dag_json`：任务依赖、原子 JSON 持久化、DAG 校验、owner 防伪造 |
| [13](<./13. 从串行到异步：AI Agent 架构演进中的“慢操作”填坑指南（Agent架构实操十三）.md>) | 后台任务 | `background`：先落盘再启动 worker，以占位结果和完成事件连接异步作业 |
| [14](<./14. 让 Agent 学会看表：Cron 调度器的设计与实现（Agent架构实操十四）.md>) | Cron 调度 | `cron`：时区计算、UTC 持久化、durable/session-only 生命周期和 outbox 触发 |
| [15](<./15. 解密 Claude Code 协作机制：如何通过 Inbox 注入让 AI 队友真正实现“异步通信”？（Agent架构实操十五）.md>) | Teammate 与 Mailbox | `teammate`、`mailbox`：持久队友、FIFO 消息、恢复、坏消息隔离和 Inbox 注入 |
| [16](<./16. 从“单兵作战”到“自组织团队”，多 Agent 协同的必经之路是什么？（Agent架构实操十六）.md>) | 协作协议 | `protocol`、`plan_gate`：先登记再发送、完整匹配响应、计划审批和确定性 shutdown |
| [17](<./17. 从“人肉派发”到“自驱轮询”：多智能体（Agent Team）去中心化协作实战（Agent架构实操十七）.md>) | SQLite 认领 | `task_dag_sqlite`、`work_stealing`：事务内原子认领、租约、token 历史和角色工具裁剪 |
| [18](<./18. AI Agent也会“抢地盘”？多Agent并行开发时的文件冲突，到底该怎么解？（Agent架构实操十八）.md>) | Worktree 隔离 | `worktree`：预留、绑定、执行上下文、claim 路由和 `needs_review` 清理边界 |
| [19](<./19. 从静态工具到动态工具池：一次 MCP 接入让我重构了 Agent 架构（Agent架构实操十九）.md>) | MCP 工具池 | `mcp`：allowlist、连接、发布工具、命名隔离、策略分类和下一轮 Registry Snapshot |
| [20](<./20. Agent 架构设计：工具调用、权限控制、记忆机制、上下文压缩与 MCP 集成（Agent架构实操二十）.md>) | 完整 Harness | `full_harness`：统一组合根、单一 AgentRunner、动态上下文、MCP 边界和资源关闭 |

## 配套代码如何组织

代码位于 [`code/`](./code/)。每章都有独立快照：

```text
code/
├─ chapters/
│  ├─ ch01/
│  │  ├─ src/       # 本章及之前能力的 TypeScript 实现
│  │  └─ tests/     # 本章累计行为测试
│  ├─ ...
│  └─ ch20/
│     ├─ src/       # 完整 Harness
│     └─ tests/
├─ skills/          # 示例 Skill 内容
├─ scripts/         # 构建与快照漂移检查
├─ package.json
└─ .env.example
```

各章不是互相独立的玩具项目：后续快照保留前章行为，并在组合根根据 `P01`–`P20` profile 累加能力。实现细节以当前源码和测试为准；不要把“文件存在”或“能导入”当作章节完成证明。

从第 15 章开始，CLI 同时接入 Teammate 和 Cron 两类 wakeup，并把它们交给同一个 `AgentRunner` 的 `runEvents()` 入口。这样队友消息、定时任务和后台事件都能在明确的 event turn 中进入 Lead 上下文；对应的入口回归测试会防止接线退化。

## 开始阅读与运行

### 1. 准备环境

- Windows 11 示例命令统一使用 PowerShell。
- Node.js `>=20.12`。
- 在 `code/` 中安装依赖：

```powershell
Set-Location '.\code'
npm ci
```

真实模型运行需要配置 `.env`。先复制模板，再填写四个变量：

```powershell
if (-not (Test-Path '.env')) {
  Copy-Item '.env.example' '.env'
}
```

```text
OPENAI_BASE_URL=
OPENAI_API_KEY=
OPENAI_MODEL=
OPENAI_FALLBACK_MODEL=
```

离线测试会注入模型和其他外部边界，不要求密钥或网络。没有凭据时，优先运行测试、类型检查和构建，不要把真实 OpenAI smoke test 当作必需门禁。

### 2. 运行单章

每章都有固定 npm script。下面从第 1 章和第 20 章举例：

```powershell
npm run ch01 -- --prompt "列出当前目录"
npm run ch20 -- --prompt "验证完整 Harness 的动态上下文、MCP 边界和资源关闭"
```

也可以通过统一入口选择章节：

```powershell
npm run agent-tutorial -- run --chapter 12 --prompt "建立 schema、endpoints、tests 和 docs 的任务依赖"
```

### 3. 验证实现

从 `code/` 执行：

```powershell
npm run typecheck
npm run test:ch01
npm run test:ch20
npm test
npm run lint
npm run format:check
npm run build
npm run verify:snapshot-drift
```

逐章 review 至少运行对应的 `test:chNN` 和 `typecheck`；共享运行时变化后再运行全量测试、lint、format、build 与快照漂移检查。只有直接验证通过，才能把章节标记为“通过”。

当前代码基线已串行验证通过：`npm test` 为 65 个测试文件、429 个测试；`typecheck`、`lint`、`format:check`、`build` 和 `verify:snapshot-drift` 均通过。真实模型 smoke test 需要用户自行配置 `.env`，不属于离线门禁。

## 推荐阅读方式

1. 先读文章中的“验收结果/问题本质”，明确本章要证明什么。
2. 再看 `code/chapters/chNN/src/` 的组合根、核心类型和工具 handler。
3. 运行该章测试，观察状态、事件、权限、文件和错误分支。
4. 用下一章对比上一章：只找新增能力，以及新增能力为什么不能塞回旧模块。
5. 读到第 20 章时，回看同一个 `AgentRunner` 的执行顺序、Registry Snapshot、tool result 配对、权限边界和资源关闭。

## 参考来源与关系

本教程参考以下公开项目的思想、章节组织和工程讨论；代码、章节编号、TypeScript 实现与验收标准属于本仓库自身，不是它们的官方翻译或逐章复制。

- [`bojieli/ai-agent-book`](https://github.com/bojieli/ai-agent-book)：《深入理解 AI Agent：设计原理与工程实践》。它以“Agent = LLM + 上下文 + 工具”为主线，提供 10 章正文和大量配套实验。本教程借鉴其从原理走向工程实践、先定义评估再落实现制的方式；第 9、10、14、15 章等文章也会明确讨论对应取舍。
- [`shareAI-lab/learn-claude-code`](https://github.com/shareAI-lab/learn-claude-code)：从零构建 Claude Code 风格 agent harness 的累进教程。它把工具、知识、观察、动作接口、权限和单一 Agent Loop 放在同一 Harness 视角下。本教程借鉴其“每课只增加一个机制、最后重新集成”的教学方法，并结合 TypeScript、严格契约和本仓库的测试门禁重新实现。

两份参考项目关注点不同：前者提供更宽的 Agent 原理、上下文、记忆、工具和多 Agent 视野；后者深入 Claude Code 风格 Harness 的内部机制。本教程把两种视角收敛为一条可运行的 20 章工程路线。

## 讨论与反馈

欢迎在 [LINUX DO](https://linux.do/) 讨论阅读疑问、架构取舍、运行问题和改进建议。发帖前请遵守社区规则；本 README 只提供讨论入口，不代替社区规范。

## 许可证与贡献

本仓库的文章与代码以仓库实际文件中的声明为准。改进教程时，建议保持“一章一主题、代码与文章同步、先验证后宣称完成”的节奏，并在提交中说明受影响章节和验证命令。
