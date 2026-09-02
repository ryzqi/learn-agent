// 给 ch17–ch20 的 persistDatabase 补 Windows rename 竞态重试。
// 实测：全量并行下 rename(temp -> tasks.sqlite3) 会返回 EPERM，事务已 COMMIT 但落盘失败，
// 后续 lookupClaim 变成「claim token is known but no longer active」，表现为 tool_context_error。
// 同文件的取锁路径早已用 isWindowsLockRace + LOCK_RETRY_MS + MAX_WINDOWS_LOCK_RACE_RETRIES 处理同类错误，
// 这里复用同一套常量与语义，不新增机制。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "chapters");

const FROM = `    handle = undefined;
    await rename(temporary, path);
  } finally {
    if (handle !== undefined) await handle.close();
    await rm(temporary, { force: true });
  }
}`;

const TO = `    handle = undefined;
    // Windows 下目标库可能被杀毒、索引或并发读句柄短暂持有，rename 返回 EPERM；
    // 事务已经 COMMIT，此处必须重试而不是丢弃已提交的状态。
    let raceRetries = 0;
    for (;;) {
      try {
        await rename(temporary, path);
        return;
      } catch (error) {
        if (isWindowsLockRace(error) && raceRetries < MAX_WINDOWS_LOCK_RACE_RETRIES) {
          raceRetries += 1;
          await delay(LOCK_RETRY_MS);
          continue;
        }
        throw error;
      }
    }
  } finally {
    if (handle !== undefined) await handle.close();
    await rm(temporary, { force: true });
  }
}`;

for (const chapter of ["ch17", "ch18", "ch19", "ch20"]) {
  const file = join(ROOT, chapter, "src", "adapters", "task-sqlite.ts");
  const original = readFileSync(file, "utf8");

  // 依赖的三个助手必须已经在同文件内存在，否则说明章节形状与预期不符。
  for (const helper of ["isWindowsLockRace", "MAX_WINDOWS_LOCK_RACE_RETRIES", "LOCK_RETRY_MS"]) {
    if (!original.includes(helper)) {
      throw new Error(`${chapter}: 缺少 ${helper}`);
    }
  }

  const hits = original.split(FROM).length - 1;
  if (hits !== 1) {
    throw new Error(`${chapter}: 期望命中 1 次，实际 ${hits} 次`);
  }
  writeFileSync(file, original.replace(FROM, TO), { encoding: "utf8" });
  console.log(`${chapter} 已修`);
}
