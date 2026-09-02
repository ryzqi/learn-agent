// 让 ch19-mcp.test.ts 的三个错误映射用例各自持有工具超时，而不是共用 20ms。
// 实测：共用 0.02s 时，terminate（子进程 process.exit(17)）在高负载下的连接断开检测慢于 20ms，
// 于是 mcp_timeout 先于 mcp_connection_lost 命中，断言失败。
// 只有 delay 用例需要短超时（100ms 延迟必然先撞上 20ms），另两个用默认 2s。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "chapters");

const FROM = `    const cases = [
      ["fail", {}, "mcp_remote_error", true],
      ["delay", { milliseconds: 100 }, "mcp_timeout", false],
      ["terminate", {}, "mcp_connection_lost", false],
    ] as const;
    for (const [tool, argumentsValue, errorCode, survives] of cases) {
      const registry = new ToolRegistry();
      const runtime = new McpRuntime({
        servers: [demoSpec("demo_alpha", "alpha", 0.02)],`;

const TO = `    // 每个用例自带工具超时：只有 delay 需要极短超时来触发 mcp_timeout；
    // fail 和 terminate 依赖远端错误与连接断开先到达，短超时会让 mcp_timeout 抢先命中。
    const cases = [
      ["fail", {}, "mcp_remote_error", true, 2],
      ["delay", { milliseconds: 100 }, "mcp_timeout", false, 0.02],
      ["terminate", {}, "mcp_connection_lost", false, 2],
    ] as const;
    for (const [tool, argumentsValue, errorCode, survives, toolTimeoutSeconds] of cases) {
      const registry = new ToolRegistry();
      const runtime = new McpRuntime({
        servers: [demoSpec("demo_alpha", "alpha", toolTimeoutSeconds)],`;

for (const chapter of ["ch19", "ch20"]) {
  const file = join(ROOT, chapter, "tests", "ch19-mcp.test.ts");
  const original = readFileSync(file, "utf8");
  const hits = original.split(FROM).length - 1;
  if (hits !== 1) {
    throw new Error(`${chapter}: 期望命中 1 次，实际 ${hits} 次`);
  }
  writeFileSync(file, original.replace(FROM, TO), { encoding: "utf8" });
  console.log(`${chapter} 已修`);
}
