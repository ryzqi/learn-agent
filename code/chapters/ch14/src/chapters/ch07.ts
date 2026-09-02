import { runProfile } from "../cli.js";
import { P07 } from "../core/profiles.js";

// 固定入口启用 P07 的 Skill catalog 与 load_skill 工具。
// 固定入口选择 P07：组合根会扫描工作区 skills/，把目录快照加入 System Prompt，
// 并注册 load_skill；正文只有模型显式调用后才会进入历史。
process.exitCode = await runProfile(P07, process.argv.slice(2));
