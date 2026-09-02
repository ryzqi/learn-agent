// 后台两工具补回 ch14–ch20 之后，同步 8 处精确工具表断言。
// 幂等；锚点未命中或命中多次即抛错。
import { readFile, writeFile } from "node:fs/promises";

const ROOT = new URL("../chapters/", import.meta.url);
const CHAPTERS = ["ch14", "ch15", "ch16", "ch17", "ch18", "ch19", "ch20"];
const INSERT = '        "query_background_job",\n        "cancel_background_job",\n';
const ANCHOR = '        "complete_task",\n';

for (const chapter of CHAPTERS) {
  const path = new URL(`${chapter}/tests/ch14-bootstrap.test.ts`, ROOT);
  let body = await readFile(path, "utf8");
  if (body.includes("query_background_job")) {
    console.log(`${chapter} ch14-bootstrap 已含断言，跳过`);
    continue;
  }
  const hits = body.split(ANCHOR).length - 1;
  if (hits !== 1) {
    throw new Error(`${chapter} ch14-bootstrap: complete_task 锚点命中 ${hits} 次，期望 1 次`);
  }
  body = body.replace(ANCHOR, `${ANCHOR}${INSERT}`);
  await writeFile(path, body, "utf8");
  console.log(`${chapter} ch14-bootstrap 断言已补两个工具`);
}

// ch20 全链路 harness 的 LEAD_TOOLS 数组缩进两格，且 complete_task 在文件里出现两次，
// 因此锚定 LEAD_TOOLS 块内的 "complete_task",\n  "create_worktree", 这个相邻对。
const harnessPath = new URL("ch20/tests/ch20-full-harness.test.ts", ROOT);
let harness = await readFile(harnessPath, "utf8");
if (harness.includes("query_background_job")) {
  console.log("ch20 harness 已含断言，跳过");
} else {
  const anchor = '  "complete_task",\n  "create_worktree",\n';
  const hits = harness.split(anchor).length - 1;
  if (hits !== 1) {
    throw new Error(`ch20 harness: LEAD_TOOLS 锚点命中 ${hits} 次，期望 1 次`);
  }
  harness = harness.replace(
    anchor,
    '  "complete_task",\n  "query_background_job",\n  "cancel_background_job",\n  "create_worktree",\n',
  );
  await writeFile(harnessPath, harness, "utf8");
  console.log("ch20 harness LEAD_TOOLS 已补两个工具");
}
