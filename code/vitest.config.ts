import { defineConfig } from "vitest/config";

// 本仓库的测试大量使用真实文件系统、proper-lockfile 目录锁（100 次 × 10ms 重试）、
// sql.js 落盘和 git 子进程；65 个测试文件并行时单个用例的墙钟时间会远超 vitest 默认的 5s。
// 这些超时是「防止用例永久挂住」的兜底，不是性能断言，因此统一放宽而不是逐个用例加参数。
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
