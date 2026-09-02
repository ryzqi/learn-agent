import { runProfile } from "../cli.js";
import { P08 } from "../core/profiles.js";

// 固定入口启用 P08 的 artifact 与上下文压缩能力。
// 固定入口选择 P08：组合根会创建 CompactionManager，并把它接入请求历史处理器
// 与工具结果处理器；大结果落盘和请求级压缩都由公共 Loop 驱动，入口不复制 Agent Loop。
process.exitCode = await runProfile(P08, process.argv.slice(2));
