// 章节内置 MCP 测试服务：提供成功、业务失败、超时和进程终止四类确定性行为。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const label = process.argv[process.argv.indexOf("--label") + 1];
// label 区分两个同构 server，测试 alias 隔离时可从结果中确认实际路由目标。
if (label === undefined || label.trim().length === 0) {
  throw new Error("--label must not be empty");
}

// 每个演示进程独立启动一个 MCP server，并通过 stdin/stdout 与客户端通信。
const server = new McpServer({ name: `agent-tutorial-${label}`, version: "0.1.0" });

// lookup 返回结构化结果，用来验证同名远程工具经 alias 隔离后不会串线。
server.registerTool(
  "lookup",
  {
    description: "Look up one value in this demo server.",
    inputSchema: { query: z.string() },
  },
  async ({ query }) => ({
    content: [{ type: "text", text: JSON.stringify({ label, query }) }],
    structuredContent: { label, query },
  }),
);

// fail 返回 isError: true，用来验证远程错误只以固定、脱敏的结果进入 Agent。
server.registerTool(
  "fail",
  { description: "Return a deterministic remote tool error." },
  async () => ({
    content: [{ type: "text", text: "server-private-detail" }],
    isError: true,
  }),
);

// delay 按毫秒阻塞响应，用来验证 tools/call 超时和后续连接撤销。
server.registerTool(
  "delay",
  {
    description: "Delay a response for timeout testing.",
    inputSchema: { milliseconds: z.number().int().nonnegative() },
  },
  async ({ milliseconds }) => {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    return {
      content: [{ type: "text", text: JSON.stringify({ label, milliseconds }) }],
      structuredContent: { label, milliseconds },
    };
  },
);

// terminate 主动退出子进程，用来验证 transport failure 会触发连接级 Watchdog 清理。
server.registerTool(
  "terminate",
  { description: "Terminate this demo server process." },
  async () => {
    process.exit(17);
  },
);

await server.connect(new StdioServerTransport());
