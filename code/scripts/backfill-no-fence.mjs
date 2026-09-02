// 把 ch09 的 42c0e6f 修复（NO_FENCE_INSTRUCTION + extractor slug 规则）回填到 ch10–ch20 的累积快照。
// 累积快照的不变量：第 N 章 = 第 N-1 章 + 恰好一个新能力，因此 ch09 的提示词修复必须在后续每一章都存在。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "chapters");

const NO_FENCE_BLOCK = `// 三个 side-query 输出都直接进入 JSON.parse()，不做围栏剥离或子串截取；
// 因此系统提示必须明确禁止 Markdown 代码块和解释文字，降低真实模型附加围栏的概率。
const NO_FENCE_INSTRUCTION =
  "直接输出纯 JSON 文本，禁止使用 Markdown 代码块或反引号包裹，禁止输出任何解释文字。";
`;

const SLUG_RULE =
  "name 必须是安全的小写 slug：只能包含小写字母、数字，多个词之间用单个连字符 - 分隔，禁止下划线、空格、大写字母或中文字符。";

// 三处提示词各自的「旧收尾行」→「新收尾行」；顺序无关，每处必须命中恰好一次。
const REPLACEMENTS = [
  {
    from: "只能返回 JSON 字符串数组，不得调用工具；没有相关项时返回 []。`;",
    to: "只能返回 JSON 字符串数组，不得调用工具；没有相关项时返回 []。\n${NO_FENCE_INSTRUCTION}`;",
  },
  {
    from: "type 只能是 user、feedback、project、reference，没有新记忆时返回 []。`;",
    to: `type 只能是 user、feedback、project、reference，没有新记忆时返回 []。\n${SLUG_RULE}\n\${NO_FENCE_INSTRUCTION}\`;`,
  },
  {
    from: "source_names 是被替换的原记忆名称，records 是非空的新记忆数组。`;",
    to: "source_names 是被替换的原记忆名称，records 是非空的新记忆数组。\n${NO_FENCE_INSTRUCTION}`;",
  },
];

const ANCHOR = "const SELECTOR_SYSTEM_PROMPT = `";

for (let n = 10; n <= 20; n += 1) {
  const chapter = `ch${String(n).padStart(2, "0")}`;
  const file = join(ROOT, chapter, "src", "features", "memory.ts");
  const original = readFileSync(file, "utf8");

  if (original.includes("NO_FENCE_INSTRUCTION")) {
    console.log(`${chapter} 已存在，跳过`);
    continue;
  }

  let next = original;
  for (const { from, to } of REPLACEMENTS) {
    const hits = next.split(from).length - 1;
    if (hits !== 1) {
      throw new Error(`${chapter}: 期望命中 1 次，实际 ${hits} 次 → ${from}`);
    }
    next = next.replace(from, to);
  }

  const anchorHits = next.split(ANCHOR).length - 1;
  if (anchorHits !== 1) {
    throw new Error(`${chapter}: SELECTOR 锚点命中 ${anchorHits} 次`);
  }
  next = next.replace(ANCHOR, `${NO_FENCE_BLOCK}${ANCHOR}`);

  writeFileSync(file, next, { encoding: "utf8" });
  console.log(`${chapter} 已回填`);
}
