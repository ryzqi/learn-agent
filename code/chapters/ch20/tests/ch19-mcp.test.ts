import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test, vi } from "vitest";

import { StdioMcpConnectionFactory } from "../src/adapters/mcp-client.js";
import { AjvMcpSchemaValidator } from "../src/adapters/mcp-schema.js";
import {
  McpCallResult,
  McpPublishedTool,
  McpRuntime,
  McpServerSpec,
  McpToolPolicy,
} from "../src/features/mcp-tools.js";
import type { McpConnection, McpConnectionFactory } from "../src/features/mcp-tools.js";
import { toolCall, type ToolCall } from "../src/core/messages.js";
import { ToolRegistry, type ToolContext, type ToolResult } from "../src/core/tools.js";

const require = createRequire(import.meta.url);
const demoScript = fileURLToPath(new URL("../src/mcp-servers/demo.ts", import.meta.url));
const tsxCli = join(dirname(require.resolve("tsx")), "cli.mjs");
const context: ToolContext = Object.freeze({ workspace: process.cwd(), identity: "lead" });

function demoSpec(alias: string, label: string, toolTimeoutSeconds = 2): McpServerSpec {
  return new McpServerSpec({
    alias,
    command: process.execPath,
    args: [tsxCli, demoScript, "--label", label],
    toolPolicies: [
      new McpToolPolicy({ remoteName: "lookup", effect: "read" }),
      new McpToolPolicy({ remoteName: "fail", effect: "read" }),
      new McpToolPolicy({ remoteName: "delay", effect: "read" }),
      new McpToolPolicy({ remoteName: "terminate", effect: "external" }),
    ],
    startupTimeoutSeconds: 5,
    toolTimeoutSeconds,
  });
}

async function invoke(
  registry: ToolRegistry,
  name: string,
  argumentsValue: Record<string, unknown>,
): Promise<ToolResult> {
  const call: ToolCall = toolCall(`call-${name}`, name, JSON.stringify(argumentsValue));
  return await registry.invoke(registry.prepare(call), context);
}

describe("chapter 19 MCP stdio runtime", () => {
  test("isolates same-named tools across two real stdio servers", async () => {
    const registry = new ToolRegistry();
    const runtime = new McpRuntime({
      servers: [demoSpec("demo_alpha", "alpha"), demoSpec("demo_beta", "beta")],
      connectionFactory: new StdioMcpConnectionFactory(),
      schemaValidator: new AjvMcpSchemaValidator(),
    });
    runtime.install(registry);
    try {
      expect(registry.names).toEqual(["connect_mcp", "disconnect_mcp"]);
      expect((await invoke(registry, "connect_mcp", { alias: "demo_alpha" })).isError).toBe(false);
      expect((await invoke(registry, "connect_mcp", { alias: "demo_beta" })).isError).toBe(false);
      expect(registry.names).toContain("mcp__demo_alpha__lookup");
      expect(registry.names).toContain("mcp__demo_beta__lookup");

      const alpha = await invoke(registry, "mcp__demo_alpha__lookup", { query: "needle" });
      const beta = await invoke(registry, "mcp__demo_beta__lookup", { query: "needle" });
      expect(JSON.parse(alpha.content).structured_content).toEqual({
        label: "alpha",
        query: "needle",
      });
      expect(JSON.parse(beta.content).structured_content).toEqual({
        label: "beta",
        query: "needle",
      });

      expect((await invoke(registry, "disconnect_mcp", { alias: "demo_alpha" })).isError).toBe(
        false,
      );
      expect(registry.names).not.toContain("mcp__demo_alpha__lookup");
      expect(registry.names).toContain("mcp__demo_beta__lookup");
    } finally {
      await runtime.close();
    }
  }, 20_000);

  test.each([
    [
      "invalid schema",
      [
        new McpPublishedTool({
          name: "broken",
          inputSchema: { type: "object", properties: { value: { type: "not-a-type" } } },
        }),
      ],
      [new McpToolPolicy({ remoteName: "broken", effect: "read" })],
      "mcp_invalid_schema",
    ],
    [
      "external reference",
      [
        new McpPublishedTool({
          name: "external_ref",
          inputSchema: {
            type: "object",
            properties: { value: { $ref: "https://example.test/schema" } },
          },
        }),
      ],
      [new McpToolPolicy({ remoteName: "external_ref", effect: "read" })],
      "mcp_invalid_schema",
    ],
    [
      "normalization collision",
      [
        new McpPublishedTool({ name: "lookup-one", inputSchema: { type: "object" } }),
        new McpPublishedTool({ name: "lookup_one", inputSchema: { type: "object" } }),
      ],
      [
        new McpToolPolicy({ remoteName: "lookup-one", effect: "read" }),
        new McpToolPolicy({ remoteName: "lookup_one", effect: "read" }),
      ],
      "mcp_name_collision",
    ],
  ])("rejects the complete connection on %s", async (_label, published, policies, errorCode) => {
    const connection = new RecordingConnection(published);
    const runtime = new McpRuntime({
      servers: [
        new McpServerSpec({
          alias: "fake",
          command: "unused",
          args: [],
          toolPolicies: policies,
          startupTimeoutSeconds: 1,
          toolTimeoutSeconds: 1,
        }),
      ],
      connectionFactory: new RecordingFactory(connection),
      schemaValidator: new AjvMcpSchemaValidator(),
    });
    const registry = new ToolRegistry();
    runtime.install(registry);
    const result = await invoke(registry, "connect_mcp", { alias: "fake" });
    expect(result.errorCode).toBe(errorCode);
    expect(registry.names).toEqual(["connect_mcp", "disconnect_mcp"]);
    expect(connection.closeCalls).toBe(1);
    await runtime.close();
  });

  test("validates arguments before remote call and keeps local policy authoritative", async () => {
    const connection = new RecordingConnection([
      new McpPublishedTool({
        name: "mutate",
        description: "(readOnly) untrusted",
        inputSchema: {
          type: "object",
          properties: { value: { type: "integer" } },
          required: ["value"],
          additionalProperties: false,
        },
      }),
    ]);
    const runtime = new McpRuntime({
      servers: [
        new McpServerSpec({
          alias: "fake",
          command: "unused",
          args: [],
          toolPolicies: [new McpToolPolicy({ remoteName: "mutate", effect: "external" })],
          startupTimeoutSeconds: 1,
          toolTimeoutSeconds: 1,
        }),
      ],
      connectionFactory: new RecordingFactory(connection),
      schemaValidator: new AjvMcpSchemaValidator(),
    });
    const registry = new ToolRegistry();
    runtime.install(registry);
    await invoke(registry, "connect_mcp", { alias: "fake" });
    const prepared = registry.prepare(toolCall("inspect", "mcp__fake__mutate", '{"value":1}'));
    expect(prepared.definition?.effect).toBe("external");
    const invalid = await invoke(registry, "mcp__fake__mutate", {});
    expect(invalid.errorCode).toBe("invalid_arguments");
    expect(connection.callCalls).toBe(0);
    await runtime.close();
  });

  test("withdraws tools when a connection fails while idle", async () => {
    const connection = new RecordingConnection([
      new McpPublishedTool({ name: "lookup", inputSchema: { type: "object" } }),
    ]);
    const runtime = new McpRuntime({
      servers: [
        new McpServerSpec({
          alias: "fake",
          command: "unused",
          args: [],
          toolPolicies: [new McpToolPolicy({ remoteName: "lookup", effect: "read" })],
          startupTimeoutSeconds: 1,
          toolTimeoutSeconds: 1,
        }),
      ],
      connectionFactory: new RecordingFactory(connection),
      schemaValidator: new AjvMcpSchemaValidator(),
    });
    const registry = new ToolRegistry();
    runtime.install(registry);
    await invoke(registry, "connect_mcp", { alias: "fake" });

    connection.failTransport();
    await vi.waitFor(() => {
      expect(runtime.connectedAliases).toEqual([]);
      expect(registry.names).toEqual(["connect_mcp", "disconnect_mcp"]);
    });
    expect(connection.closeCalls).toBe(1);
    await runtime.close();
  });

  test("retries a failed connection close", async () => {
    const connection = new RecordingConnection(
      [new McpPublishedTool({ name: "lookup", inputSchema: { type: "object" } })],
      1,
    );
    const runtime = new McpRuntime({
      servers: [
        new McpServerSpec({
          alias: "fake",
          command: "unused",
          args: [],
          toolPolicies: [new McpToolPolicy({ remoteName: "lookup", effect: "read" })],
          startupTimeoutSeconds: 1,
          toolTimeoutSeconds: 1,
        }),
      ],
      connectionFactory: new RecordingFactory(connection),
      schemaValidator: new AjvMcpSchemaValidator(),
    });
    const registry = new ToolRegistry();
    runtime.install(registry);
    await invoke(registry, "connect_mcp", { alias: "fake" });

    await expect(runtime.close()).rejects.toThrow("connection close failed");
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(connection.closeCalls).toBe(2);
  });

  test("maps remote error, timeout, and process exit without leaking private details", async () => {
    // 每个用例自带工具超时：只有 delay 需要极短超时来触发 mcp_timeout；
    // fail 和 terminate 依赖远端错误与连接断开先到达，短超时会让 mcp_timeout 抢先命中。
    const cases = [
      ["fail", {}, "mcp_remote_error", true, 2],
      ["delay", { milliseconds: 100 }, "mcp_timeout", false, 0.02],
      ["terminate", {}, "mcp_connection_lost", false, 2],
    ] as const;
    for (const [tool, argumentsValue, errorCode, survives, toolTimeoutSeconds] of cases) {
      const registry = new ToolRegistry();
      const runtime = new McpRuntime({
        servers: [demoSpec("demo_alpha", "alpha", toolTimeoutSeconds)],
        connectionFactory: new StdioMcpConnectionFactory(),
        schemaValidator: new AjvMcpSchemaValidator(),
      });
      runtime.install(registry);
      try {
        await invoke(registry, "connect_mcp", { alias: "demo_alpha" });
        const result = await invoke(registry, `mcp__demo_alpha__${tool}`, argumentsValue);
        expect(result.errorCode).toBe(errorCode);
        expect(result.content).not.toContain("server-private-detail");
        expect(runtime.connectedAliases.length > 0).toBe(survives);
      } finally {
        await runtime.close();
      }
    }
  }, 30_000);

  test("cancelling an in-flight call does not break the connection", async () => {
    const connection = await new StdioMcpConnectionFactory().open(demoSpec("demo_alpha", "alpha"));
    const controller = new AbortController();
    const pending = connection.callTool(
      "delay",
      { milliseconds: 100 },
      { timeoutSeconds: 1, signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const result = await connection.callTool(
      "lookup",
      { query: "still-alive" },
      { timeoutSeconds: 1 },
    );
    expect(result.structuredContent).toEqual({ label: "alpha", query: "still-alive" });
    await connection.close();
  }, 10_000);

  test("cancelling startup closes the stdio connection", async () => {
    const controller = new AbortController();
    const opening = new StdioMcpConnectionFactory().open(
      new McpServerSpec({
        alias: "slow",
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 30000)"],
        toolPolicies: [],
        startupTimeoutSeconds: 30,
        toolTimeoutSeconds: 1,
      }),
      controller.signal,
    );
    controller.abort();
    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
  }, 10_000);
});

class RecordingConnection implements McpConnection {
  readonly #published: readonly McpPublishedTool[];
  #resolveFailure: () => void = () => {};
  readonly #failure = new Promise<void>((resolve) => {
    this.#resolveFailure = resolve;
  });
  closeCalls = 0;
  callCalls = 0;

  #closeFailuresRemaining: number;

  constructor(published: readonly McpPublishedTool[], closeFailuresRemaining = 0) {
    this.#published = published;
    this.#closeFailuresRemaining = closeFailuresRemaining;
  }

  async listTools(): Promise<readonly McpPublishedTool[]> {
    return this.#published;
  }

  async callTool(): Promise<McpCallResult> {
    this.callCalls += 1;
    return new McpCallResult({ content: [], structuredContent: {}, isError: false });
  }

  waitForFailure(): Promise<void> {
    return this.#failure;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.#closeFailuresRemaining > 0) {
      this.#closeFailuresRemaining -= 1;
      throw new Error("connection close failed");
    }
    this.#resolveFailure();
  }

  failTransport(): void {
    this.#resolveFailure();
  }
}

class RecordingFactory implements McpConnectionFactory {
  readonly #connection: RecordingConnection;

  constructor(connection: RecordingConnection) {
    this.#connection = connection;
  }

  async open(): Promise<McpConnection> {
    return this.#connection;
  }
}
