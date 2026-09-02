// 运行配置：从 .env 或显式映射读取 OpenAI 参数，并在创建网络客户端前集中完成缺失字段、URL 协议和 fallback 校验。
import { readFileSync } from "node:fs";

import { parse } from "dotenv";

// 三个字段是网络客户端创建前的硬性前置条件，缺失时不会生成半成品客户端。
// 文件职责：集中加载和校验 OpenAI 兼容设置。任何缺失、空白或非法 URL 都必须在创建网络客户端前
// 失败，不能把未经验证的配置传递给 SDK、恢复层或后续调用方。
// 基础模型配置；后续章节可显式要求备用模型。
const requiredFields = ["OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL"] as const;

// 配置错误保留全部缺失字段，便于调用方一次性修复，而不是逐个字段报错。
export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
  readonly missingFields: readonly string[];

  constructor(missingFields: readonly string[], options?: ErrorOptions) {
    super(`Missing required settings: ${missingFields.join(", ")}`, options);
    this.missingFields = Object.freeze([...missingFields]);
  }
}

// 校验后的配置快照：baseUrl 已确认可解析且为 http/https，字段都已 trim，对象不可改写。
export interface OpenAISettings {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fallbackModel?: string;
}

// 从任意 mapping 构造配置。mapping 允许值是 string | undefined，因此这里必须显式验证空白、
// URL 协议和冻结结果，不能假设调用方已经清洗过环境变量。
export function settingsFromMapping(
  mapping: Readonly<Record<string, string | undefined>>,
  requireFallback = false,
): OpenAISettings {
  const fields = requireFallback ? [...requiredFields, "OPENAI_FALLBACK_MODEL"] : requiredFields;
  // 先收集全部缺失字段，避免用户修复一个字段后才发现下一个字段。
  const missing = fields.filter((field) => {
    const value = mapping[field];
    return value === undefined || value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new ConfigurationError(missing);
  }

  const baseUrl = mapping.OPENAI_BASE_URL;
  const apiKey = mapping.OPENAI_API_KEY;
  const model = mapping.OPENAI_MODEL;
  if (baseUrl === undefined || apiKey === undefined || model === undefined) {
    throw new Error("validated OpenAI settings are incomplete");
  }
  let parsedBaseUrl: URL;
  try {
    // 先用 URL 解析，再单独检查协议；SDK 可能接受部分非 HTTP URL，但 Agent 配置不允许 file/data 等协议。
    parsedBaseUrl = new URL(baseUrl.trim());
  } catch (error) {
    throw new ConfigurationError(["OPENAI_BASE_URL"], { cause: error });
  }
  if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
    throw new ConfigurationError(["OPENAI_BASE_URL"]);
  }
  const fallbackModel = mapping.OPENAI_FALLBACK_MODEL;
  // 返回冻结快照，防止配置在运行中被调用方重写。
  // 返回冻结快照，防止配置在运行中被调用方重写；所有值都 trim，避免首尾空白进入网络请求。
  return Object.freeze({
    baseUrl: baseUrl.trim(),
    apiKey: apiKey.trim(),
    model: model.trim(),
    ...(fallbackModel === undefined || fallbackModel.trim().length === 0
      ? {}
      : { fallbackModel: fallbackModel.trim() }),
  });
}

export function settingsFromEnvFile(path: string, requireFallback = false): OpenAISettings {
  return settingsFromMapping(parse(readFileSync(path)), requireFallback);
}
