// MCP JSON Schema 适配器：选择对应 Ajv dialect，并禁止远程 schema 通过外部引用加载额外资源。
import { Ajv, type AnySchema } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";

import { McpContractError } from "../features/mcp-tools.js";
import type { McpSchemaValidator } from "../features/mcp-tools.js";

// JSON Schema 引用关键字集：用于检查 schema 中的引用是否指向文档内 # 片段。
const SCHEMA_REFERENCE_KEYS = new Set(["$ref", "$dynamicRef", "$recursiveRef"]);

// Ajv schema 校验器：在发布阶段编译远端 JSON Schema，拒绝外部引用和不可序列化的 schema。
export class AjvMcpSchemaValidator implements McpSchemaValidator {
  compile(
    exposedName: string,
    inputSchema: Readonly<Record<string, unknown>>,
  ): (value: unknown) => boolean {
    // 编译发生在工具发布阶段；返回谓词只报告通过/失败，Ajv 细节不进入模型上下文。
    try {
      if (inputSchema.type !== "object") {
        throw new McpContractError(`MCP tool input schema must have type object: ${exposedName}`);
      }
      // 先 JSON 往返一次，排除循环引用、函数和不可序列化对象后再交给 Ajv。
      const serialized = JSON.stringify(inputSchema);
      if (serialized === undefined) {
        throw new McpContractError(
          `MCP tool input schema is not JSON serializable: ${exposedName}`,
        );
      }
      const parsed: unknown = JSON.parse(serialized);
      if (!isRecord(parsed)) {
        throw new McpContractError(`MCP tool input schema must be an object: ${exposedName}`);
      }
      requireLocalReferences(parsed, exposedName);
      const validator = selectAjv(parsed).compile(parsed as AnySchema);
      return (value: unknown) => validator(value) === true;
    } catch (error) {
      if (error instanceof McpContractError) throw error;
      throw new McpContractError(`MCP tool input schema is invalid: ${exposedName}`);
    }
  }
}

// 根据 $schema 版本标记选择对应的 Ajv 编译器（draft-07 / 2019-09 / 2020-12）。
function selectAjv(schema: Record<string, unknown>): Ajv | Ajv2019 | Ajv2020 {
  const dialect = schema.$schema;
  if (typeof dialect === "string" && dialect.includes("2020-12")) {
    return new Ajv2020({ strict: true });
  }
  if (typeof dialect === "string" && dialect.includes("2019-09")) {
    return new Ajv2019({ strict: true });
  }
  return new Ajv({ strict: true });
}

// 递归检查 schema 中 $ref/$dynamicRef/$recursiveRef 是否以 # 开头，拒绝外部引用。
function requireLocalReferences(value: unknown, exposedName: string): void {
  if (Array.isArray(value)) {
    for (const item of value) requireLocalReferences(item, exposedName);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (SCHEMA_REFERENCE_KEYS.has(key) && (typeof nested !== "string" || !nested.startsWith("#"))) {
      throw new McpContractError(
        `MCP tool input schema contains an external reference: ${exposedName}`,
      );
    }
    requireLocalReferences(nested, exposedName);
  }
}

// 类型守卫：判断未知值是否为非 null、非数组的普通对象。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
