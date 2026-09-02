// 放宽 ch17-runtime.test.ts 中 waitForEventWithin 的挂起守卫默认值。
// 该守卫是「防止测试永久挂住」的兜底，不是性能断言；1s 在 65 文件并发下会误报。
// 15s 明显低于 vitest.config.ts 里的 testTimeout 30s，超时时先命中这里的自定义诊断信息，
// 而不是框架的通用 "Test timed out"。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "chapters");

const HEAD = `async function waitForEventWithin(
  runtime: TeammateRuntime,
  timeoutMs = `;
const TAIL = `,
): Promise<readonly RuntimeEvent[]> {`;

for (const chapter of ["ch17", "ch18", "ch19", "ch20"]) {
  const file = join(ROOT, chapter, "tests", "ch17-runtime.test.ts");
  const original = readFileSync(file, "utf8");
  const start = original.indexOf(HEAD);
  if (start === -1) throw new Error(`${chapter}: 未找到 waitForEventWithin 签名`);
  const valueStart = start + HEAD.length;
  const valueEnd = original.indexOf(TAIL, valueStart);
  if (valueEnd === -1) throw new Error(`${chapter}: 未找到签名结尾`);
  const current = original.slice(valueStart, valueEnd);
  if (current === "15_000") {
    console.log(`${chapter} 已是 15_000，跳过`);
    continue;
  }
  const next = `${original.slice(0, valueStart)}15_000${original.slice(valueEnd)}`;
  writeFileSync(file, next, { encoding: "utf8" });
  console.log(`${chapter}: ${current} -> 15_000`);
}
