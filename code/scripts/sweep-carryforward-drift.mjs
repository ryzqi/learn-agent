// 一次性排查：累积快照里「本章没有引入新能力的文件」是否被后一章悄悄改了实现。
// 判据只看非注释、非空白行——注释密度在各章之间本来就有差异（已知现象，不算漂移）。
// 目的是找出还有没有别的 42c0e6f 式「只修了某一章、没往后传」。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..", "chapters");

function listFiles(directory) {
  const out = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

// 去掉整行注释与空行；行内尾随注释保留，避免误判字符串里的 //。
function meaningful(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"))
    .join("\n");
}

const chapters = Array.from({ length: 20 }, (_v, index) => `ch${String(index + 1).padStart(2, "0")}`);
let drifted = 0;

for (let index = 1; index < chapters.length; index += 1) {
  const previous = chapters[index - 1];
  const current = chapters[index];
  const previousRoot = join(ROOT, previous);
  const currentRoot = join(ROOT, current);

  const previousFiles = new Map(
    listFiles(previousRoot).map((file) => [relative(previousRoot, file), file]),
  );

  for (const [key, previousFile] of previousFiles) {
    const currentFile = join(currentRoot, key);
    let currentBody;
    try {
      currentBody = meaningful(currentFile);
    } catch {
      // 后一章删掉了该文件：属于结构变化，交给章节差异工具，不在本次判据内。
      console.log(`[缺失] ${current} 没有 ${key}`);
      continue;
    }
    if (meaningful(previousFile) !== currentBody) {
      drifted += 1;
      console.log(`[漂移] ${previous} -> ${current}: ${key}`);
    }
  }
}

console.log(`\n共 ${drifted} 处非注释差异（含正当的能力新增改动，需人工判读）。`);
