#!/usr/bin/env node
// 向后传导注释：把 source 文件里的整行 // 注释按「锚点逻辑行」插入 target。
// 规则：
//   1. 只插入整行 // 注释——target 剥掉注释后的逻辑行序列逐字节不变；
//   2. 注释挂在它后面第一条逻辑行上；锚点在 target 中找不到（源章独有的代码）则跳过并记录；
//   3. 幂等：注释文本已存在于 target 任意位置则跳过；
//   4. 输出保持 target 原行尾风格（CRLF/LF）。
// usage: node propagate-comments.mjs <source.ts> <target.ts> [more targets...]
import { readFileSync, writeFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length < 2) {
  console.error("usage: node propagate-comments.mjs <source> <target>...");
  process.exit(1);
}

const readLines = (p) => {
  const raw = readFileSync(p, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return { lines, eol };
};

const isComment = (line) => /^\s*\/\//.test(line);
const isBlank = (line) => line.trim() === "";

// 解析出逻辑行序列与挂在各逻辑行索引上的注释组。
function parse(lines) {
  const logical = [];
  const rawIndexOf = [];
  const commentGroups = new Map();
  let pending = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isComment(line)) {
      pending.push(line);
      continue;
    }
    if (isBlank(line)) continue;
    const idx = logical.length;
    if (pending.length > 0) {
      commentGroups.set(idx, pending);
      pending = [];
    }
    logical.push(line);
    rawIndexOf.push(i);
  }
  return { logical, rawIndexOf, commentGroups };
}

// LCS 对齐：返回 Map<sourceIdx, targetIdx>。
// 对齐键剥掉行首 export 前缀，使 `function f` 与 `export function f` 视为同一逻辑行。
function alignLcs(a, b) {
  const key = (line) => line.replace(/^(\s*)export (?=(function|class|const|interface|type|enum)\s)/, "$1");
  const ka = a.map(key);
  const kb = b.map(key);
  const n = ka.length;
  const m = kb.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = ka[i] === kb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const map = new Map();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) {
      map.set(i, j);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return map;
}

function propagate(sourcePath, targetPath) {
  const src = readLines(sourcePath);
  const tgt = readLines(targetPath);
  const s = parse(src.lines);
  const t = parse(tgt.lines);

  const before = t.logical.join("\n");

  const targetCommentTexts = new Set(
    tgt.lines.filter(isComment).map((line) => line.trim()),
  );

  const alignment = alignLcs(s.logical, t.logical);

  // targetIdx -> 待插入注释组（保持源顺序）
  const insertions = new Map();
  let inserted = 0;
  let skippedDup = 0;
  const skippedNoAnchor = [];
  for (const [srcIdx, group] of s.commentGroups) {
    const targetIdx = alignment.get(srcIdx);
    if (targetIdx === undefined) {
      skippedNoAnchor.push(...group);
      continue;
    }
    const fresh = group.filter((line) => !targetCommentTexts.has(line.trim()));
    if (fresh.length === 0) {
      skippedDup += group.length;
      continue;
    }
    skippedDup += group.length - fresh.length;
    const merged = [...(insertions.get(targetIdx) ?? []), ...fresh];
    insertions.set(targetIdx, merged);
    inserted += fresh.length;
  }

  // 从后往前插入，避免 raw 索引位移。
  let out = [...tgt.lines];
  for (const targetIdx of [...insertions.keys()].sort((x, y) => y - x)) {
    const rawIdx = t.rawIndexOf[targetIdx];
    out.splice(rawIdx, 0, ...insertions.get(targetIdx));
  }

  // 验证：剥注释后逻辑行不变。
  const afterLogical = out.filter((line) => !isComment(line) && !isBlank(line));
  if (afterLogical.join("\n") !== before) {
    console.error(`[${targetPath}] 逻辑行发生变化，拒绝写出`);
    process.exitCode = 1;
    return;
  }

  writeFileSync(targetPath, out.join(tgt.eol) + tgt.eol);
  console.log(
    `[${targetPath}] 插入 ${inserted} 行注释；跳过已存在 ${skippedDup} 行；无锚点跳过 ${skippedNoAnchor.length} 行` +
      (skippedNoAnchor.length > 0
        ? `（如: ${skippedNoAnchor[0].trim().slice(0, 40)}…）`
        : ""),
  );
}

const [sourcePath, ...targets] = paths;
for (const target of targets) {
  propagate(sourcePath, target);
}
