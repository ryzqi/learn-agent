// 把 ch12 的五个任务工具描述前移到 ch13–ch20。
//
// 背景：ch12 的 tasks.ts 带的是「给模型足够上下文」的长描述（写明 owner 由 runtime 决定、
// blocked_by 必须是 list_tasks/get_task 返回的 canonical UUID），ch13 起被换回了一版短描述。
// 累积快照的不变量是「第 N 章 = 第 N-1 章 + 恰好一个新能力」，描述退化违反它。
//
// 这不是「某一章修了没往后传」，两个版本在初始提交 f9794e6 里就已经分叉。
// 但方向明确：ch12 教程第 1270 行原文引用了 `Owner is set by the runtime identity;
// do not pass an owner argument.`，读者翻到 ch13 的代码会搜不到这句话。
//
// 已确认改动安全：全仓没有任何测试断言这些描述，也没有别的教程引用任何一版。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "chapters");

const REPLACEMENTS = [
  {
    label: "get_task",
    from: `    taskIdDefinition("get_task", "Read one persistent project task by ID.", "read", store),`,
    to: `    taskIdDefinition(
      "get_task",
      "Read one persistent project task by canonical UUID. Read-only; it does not change status or owner.",
      "read",
      store,
    ),`,
  },
  {
    label: "list_tasks",
    from: `    description: "List the complete persistent project task graph.",`,
    to: `    description:
      "List the complete persistent project task graph sorted by ID. Use it before create_task to find canonical UUIDs or before claim_task to find ready tasks.",`,
  },
  {
    label: "claim_task",
    from: `      "Atomically claim a ready pending task as the current identity.",`,
    to: `      "Atomically claim a ready pending task as the current identity. Owner is set by the runtime identity; do not pass an owner argument.",`,
  },
  {
    label: "complete_task",
    from: `    description: "Complete a claimed task owned by the current identity.",`,
    to: `    description:
      "Complete a claimed task owned by the current identity. Returns the completed task and any pending tasks directly unblocked by this completion.",`,
  },
  {
    label: "create_task",
    from: `    description: "Create a persistent project task with explicit dependencies.",`,
    to: `    description:
      "Create a persistent project task after planning. blocked_by must contain canonical task UUIDs returned by list_tasks or get_task.",`,
  },
];

const CHAPTERS = ["ch13", "ch14", "ch15", "ch16", "ch17", "ch18", "ch19", "ch20"];

for (const chapter of CHAPTERS) {
  const file = join(ROOT, chapter, "src", "features", "tasks.ts");
  let body = readFileSync(file, "utf8");
  const applied = [];
  for (const { label, from, to } of REPLACEMENTS) {
    if (body.includes(to)) {
      continue; // 已是长描述，幂等跳过
    }
    const hits = body.split(from).length - 1;
    if (hits !== 1) {
      throw new Error(`${chapter} 的 ${label}：期望命中 1 次，实际 ${hits} 次`);
    }
    body = body.replace(from, to);
    applied.push(label);
  }
  if (applied.length === 0) {
    console.log(`${chapter} 已是长描述，跳过`);
    continue;
  }
  writeFileSync(file, body, { encoding: "utf8" });
  console.log(`${chapter} 已改：${applied.join(", ")}`);
}
