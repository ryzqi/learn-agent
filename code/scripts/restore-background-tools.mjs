// 把 ch13 的 query_background_job / cancel_background_job 两个工具（连同 JobSupervisor.getJob、
// zod schema、payload 序列化）前移到 ch14–ch20，修复累积快照的能力回退。
// 幂等：已含目标文本的章节直接跳过。任何锚点未命中或命中多次都抛错，绝不静默漂移。
import { readFile, writeFile } from "node:fs/promises";

const CHAPTERS = ["ch14", "ch15", "ch16", "ch17", "ch18", "ch19", "ch20"];
const ROOT = new URL("../chapters/", import.meta.url);

function replaceOnce(body, from, to, label) {
  const hits = body.split(from).length - 1;
  if (hits !== 1) {
    throw new Error(`${label}: 锚点命中 ${hits} 次，期望 1 次`);
  }
  return body.replace(from, to);
}

const ZOD_IMPORT = 'import { randomUUID } from "node:crypto";\n';
const ZOD_IMPORT_TO = 'import { randomUUID } from "node:crypto";\n\nimport { z } from "zod";\n';

const TYPE_IMPORT =
  'import type { PreparedToolCall, ToolContext, ToolRegistry, ToolResult } from "../core/tools.js";';
const TYPE_IMPORT_TO = `import type {
  PreparedToolCall,
  ToolContext,
  ToolDefinition,
  ToolRegistry,
  ToolResult,
} from "../core/tools.js";`;

const GET_JOB_ANCHOR = "  async cancel(jobId: string): Promise<void> {";
const GET_JOB_TO = `  // 查询只读持久化状态，不启动 worker；未知 ID 由 store 转为稳定领域错误。
  async getJob(jobId: string): Promise<BackgroundJob> {
    await this.#ready;
    return await this.#store.getJob(canonicalBackgroundId(jobId));
  }

${GET_JOB_ANCHOR}`;

const TOOL_BLOCK = `
const backgroundJobIdSchema = z.string().regex(CANONICAL_UUID, "job_id must be a canonical UUID");
const backgroundJobIdInputSchema = z.object({ job_id: backgroundJobIdSchema }).strict();

// 后台工具与任务工具共用同一风格：schema 严格、领域错误转稳定 ToolResult、payload 使用磁盘字段名。
export function registerBackgroundJobTools(
  registry: ToolRegistry,
  supervisor: JobSupervisor,
): void {
  // 后台只暴露查询与取消两个工具；创建和运行由 shell Dispatcher 自动完成。
  registry.register(queryBackgroundJobDefinition(supervisor));
  registry.register(cancelBackgroundJobDefinition(supervisor));
}

// 查询工具定义：读取持久化状态与终态结果，不产生副作用。
function queryBackgroundJobDefinition(
  supervisor: JobSupervisor,
): ToolDefinition<z.infer<typeof backgroundJobIdInputSchema>> {
  return {
    name: "query_background_job",
    description: "Read the persisted status and result of one background job.",
    inputSchema: backgroundJobIdInputSchema,
    effect: "read",
    handler: async (input) => {
      try {
        const job = await supervisor.getJob(input.job_id);
        return toolSuccess(JSON.stringify(backgroundJobPayload(job)));
      } catch (error) {
        return backgroundJobToolError(error);
      }
    },
  };
}

// 取消工具定义：取消运行中作业并返回取消后的持久化状态。
function cancelBackgroundJobDefinition(
  supervisor: JobSupervisor,
): ToolDefinition<z.infer<typeof backgroundJobIdInputSchema>> {
  return {
    name: "cancel_background_job",
    description: "Cancel a running background job and persist its cancelled status.",
    inputSchema: backgroundJobIdInputSchema,
    effect: "write",
    handler: async (input) => {
      try {
        await supervisor.cancel(input.job_id);
        const job = await supervisor.getJob(input.job_id);
        return toolSuccess(JSON.stringify(backgroundJobPayload(job)));
      } catch (error) {
        return backgroundJobToolError(error);
      }
    },
  };
}

function backgroundJobToolError(error: unknown) {
  // 已知后台领域错误保留稳定错误码；未知异常继续向上抛，避免吞掉程序缺陷。
  if (error instanceof BackgroundError) {
    return toolError(error.errorCode, error.message);
  }
  throw error;
}

function backgroundJobPayload(job: BackgroundJob): Readonly<Record<string, unknown>> {
  // 模型可见字段与事件 payload 保持一致，result 统一为 content/error_code/is_error 三字段。
  return Object.freeze({
    job_id: job.id,
    status: job.status,
    tool_name: job.toolName,
    source_tool_call_id: job.sourceToolCallId,
    result:
      job.result === null
        ? null
        : {
            content: job.result.content,
            error_code: job.result.errorCode ?? null,
            is_error: job.result.isError,
          },
  });
}
`;

const BOOTSTRAP_IMPORT =
  'import { BackgroundDispatcher, type JobSupervisor } from "./features/background.js";';
const BOOTSTRAP_IMPORT_TO = `import {
  BackgroundDispatcher,
  registerBackgroundJobTools,
  type JobSupervisor,
} from "./features/background.js";`;

const REGISTER_ANCHOR = `  if (dependencies.taskStore !== undefined) {
    // 主 Agent 直接注册持久任务工具，与子 Agent 使用同一个 TaskStore。
    registerTaskTools(tools, dependencies.taskStore);
  }
`;
const REGISTER_ANCHOR_BARE = `  if (dependencies.taskStore !== undefined) {
    registerTaskTools(tools, dependencies.taskStore);
  }
`;
const REGISTER_BLOCK = `  if (dependencies.backgroundSupervisor !== undefined) {
    // 主 Agent 注册后台查询与取消工具；子 Agent 不接收后台 Supervisor，因此不暴露这些能力。
    registerBackgroundJobTools(tools, dependencies.backgroundSupervisor);
  }
`;

for (const chapter of CHAPTERS) {
  const backgroundPath = new URL(`${chapter}/src/features/background.ts`, ROOT);
  let background = await readFile(backgroundPath, "utf8");
  if (background.includes("registerBackgroundJobTools")) {
    console.log(`${chapter} background.ts 已含工具，跳过`);
  } else {
    background = replaceOnce(background, ZOD_IMPORT, ZOD_IMPORT_TO, `${chapter} zod import`);
    background = replaceOnce(background, TYPE_IMPORT, TYPE_IMPORT_TO, `${chapter} type import`);
    background = replaceOnce(background, GET_JOB_ANCHOR, GET_JOB_TO, `${chapter} getJob`);
    if (!background.endsWith("\n")) {
      throw new Error(`${chapter} background.ts 结尾缺换行`);
    }
    background += TOOL_BLOCK;
    await writeFile(backgroundPath, background, "utf8");
    console.log(`${chapter} background.ts 已补回两个工具与 getJob`);
  }

  const bootstrapPath = new URL(`${chapter}/src/bootstrap.ts`, ROOT);
  let bootstrap = await readFile(bootstrapPath, "utf8");
  if (bootstrap.includes("registerBackgroundJobTools")) {
    console.log(`${chapter} bootstrap.ts 已注册，跳过`);
    continue;
  }
  bootstrap = replaceOnce(
    bootstrap,
    BOOTSTRAP_IMPORT,
    BOOTSTRAP_IMPORT_TO,
    `${chapter} bootstrap import`,
  );
  const anchor = bootstrap.includes(REGISTER_ANCHOR) ? REGISTER_ANCHOR : REGISTER_ANCHOR_BARE;
  bootstrap = replaceOnce(bootstrap, anchor, `${anchor}${REGISTER_BLOCK}`, `${chapter} register`);
  await writeFile(bootstrapPath, bootstrap, "utf8");
  console.log(`${chapter} bootstrap.ts 已注册后台工具`);
}
