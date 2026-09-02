import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { JsonBackgroundJobStore } from "../src/adapters/background-json.js";
import { JsonCronStore } from "../src/adapters/cron-json.js";
import { JsonTaskStore } from "../src/adapters/task-json.js";
import { buildAgent } from "../src/bootstrap.js";
import { EventInbox } from "../src/core/events.js";
import { assistantMessage } from "../src/core/messages.js";
import { P13, P14 } from "../src/core/profiles.js";
import { PermissionDecision } from "../src/core/permissions.js";
import type { ApprovalProvider, AuditSink, PermissionRequest } from "../src/core/permissions.js";
import { JobSupervisor } from "../src/features/background.js";
import { CronRuntime } from "../src/features/cron.js";
import { RecoveryConfig } from "../src/features/recovery.js";
import { ScriptedModelClient } from "./fakes.js";

class AllowApproval implements ApprovalProvider {
  async decide(_request: PermissionRequest): Promise<PermissionDecision> {
    return new PermissionDecision("allow", "test", "test");
  }
}
class NoopAudit implements AuditSink {
  async record(_request: PermissionRequest, _decision: PermissionDecision): Promise<void> {}
}

describe("chapter 14 bootstrap", () => {
  test("requires shared cron runtime and appends schedule_cron after P13 tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch14-bootstrap-"));
    try {
      const common = {
        workspace: root,
        recoveryConfig: new RecoveryConfig({ primaryModel: "p", fallbackModel: "f" }),
        taskStore: new JsonTaskStore(root),
        approvalProvider: new AllowApproval(),
        auditSink: new NoopAudit(),
      };
      const supervisor = new JobSupervisor({
        store: new JsonBackgroundJobStore(root),
        inbox: new EventInbox(),
      });
      const model = new ScriptedModelClient([
        { message: assistantMessage("done"), finishReason: "stop" },
      ]);
      expect(() => buildAgent(P14, { ...common, model, backgroundSupervisor: supervisor })).toThrow(
        /cronRuntime/,
      );
      const runtime = new CronRuntime({
        store: new JsonCronStore(root),
        inbox: supervisor.eventInbox,
        supervisor,
        clock: { now: () => new Date() },
      });
      const model14 = new ScriptedModelClient([
        { message: assistantMessage("done"), finishReason: "stop" },
      ]);
      const runner = buildAgent(P14, {
        ...common,
        model: model14,
        backgroundSupervisor: supervisor,
        cronRuntime: runtime,
      });
      await runner.run("inspect");
      expect(model14.requests[0]?.tools.map((tool) => tool.function.name)).toEqual([
        "shell",
        "read_file",
        "write_file",
        "edit_file",
        "glob",
        "todo_write",
        "task",
        "load_skill",
        "create_task",
        "get_task",
        "list_tasks",
        "claim_task",
        "complete_task",
        "query_background_job",
        "cancel_background_job",
        "schedule_cron",
      ]);
      await runner.close();
      expect(P13.capabilities.has("cron")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a cron runtime that does not use the supplied supervisor or inbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tutorial-ch14-bootstrap-"));
    try {
      const common = {
        workspace: root,
        recoveryConfig: new RecoveryConfig({ primaryModel: "p", fallbackModel: "f" }),
        taskStore: new JsonTaskStore(root),
        approvalProvider: new AllowApproval(),
        auditSink: new NoopAudit(),
      };
      const cronSupervisor = new JobSupervisor({
        store: new JsonBackgroundJobStore(root),
        inbox: new EventInbox(),
      });
      const suppliedSupervisor = new JobSupervisor({
        store: new JsonBackgroundJobStore(root),
        inbox: new EventInbox(),
      });
      const runtime = new CronRuntime({
        store: new JsonCronStore(root),
        inbox: cronSupervisor.eventInbox,
        supervisor: cronSupervisor,
        clock: { now: () => new Date() },
      });
      const model = new ScriptedModelClient([
        { message: assistantMessage("done"), finishReason: "stop" },
      ]);
      expect(() =>
        buildAgent(P14, {
          ...common,
          model,
          backgroundSupervisor: suppliedSupervisor,
          cronRuntime: runtime,
        }),
      ).toThrow(/share the background supervisor/);
      await runtime.close();
      await cronSupervisor.close();
      await suppliedSupervisor.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
