// ch17–ch20 的五个任务工具由 registerLeasedTaskTools 注册（taskStore 那条对 P17+ 不产出五工具），
// 所以后台两工具必须挪到 workStealingRuntime 块之后，才能保持「紧跟在 complete_task 后面」的位置。
// 幂等：已在正确位置的章节跳过。锚点未命中或命中多次即抛错。
import { readFile, writeFile } from "node:fs/promises";

const CHAPTERS = ["ch17", "ch18", "ch19", "ch20"];
const ROOT = new URL("../chapters/", import.meta.url);

const BACKGROUND_BLOCK = `  if (dependencies.backgroundSupervisor !== undefined) {
    // 主 Agent 注册后台查询与取消工具；子 Agent 不接收后台 Supervisor，因此不暴露这些能力。
    registerBackgroundJobTools(tools, dependencies.backgroundSupervisor);
  }
`;

for (const chapter of CHAPTERS) {
  const path = new URL(`${chapter}/src/bootstrap.ts`, ROOT);
  let body = await readFile(path, "utf8");

  const blockHits = body.split(BACKGROUND_BLOCK).length - 1;
  if (blockHits !== 1) {
    throw new Error(`${chapter}: 后台注册块命中 ${blockHits} 次，期望 1 次`);
  }

  // workStealingRuntime 在子 Agent factory 里也出现一次，只认后台块之后那个主注册路径。
  const backgroundAt = body.indexOf(BACKGROUND_BLOCK);
  const stealStart = body.indexOf(
    "  if (dependencies.workStealingRuntime !== undefined) {",
    backgroundAt,
  );
  if (stealStart === -1) {
    throw new Error(`${chapter}: 找不到 workStealingRuntime 块`);
  }
  const stealEnd = body.indexOf("\n  }\n", stealStart);
  if (stealEnd === -1) {
    throw new Error(`${chapter}: workStealingRuntime 块没有结束标记`);
  }
  const insertAt = stealEnd + "\n  }\n".length;

  if (body.slice(insertAt).startsWith(BACKGROUND_BLOCK)) {
    console.log(`${chapter} 已在正确位置，跳过`);
    continue;
  }
  if (backgroundAt > insertAt) {
    throw new Error(`${chapter}: 后台块已在 workStealingRuntime 之后但不紧邻，请人工确认`);
  }

  const removed = body.replace(BACKGROUND_BLOCK, "");
  const shift = body.length - removed.length;
  const target = insertAt - shift;
  body = removed.slice(0, target) + BACKGROUND_BLOCK + removed.slice(target);
  await writeFile(path, body, "utf8");
  console.log(`${chapter} 后台注册块已移到 registerLeasedTaskTools 之后`);
}
