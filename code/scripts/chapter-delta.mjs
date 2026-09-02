// 计算相邻章节快照之间的文件差异，用于核对“每章只新增一个能力”。
// 用法: node scripts/chapter-delta.mjs [起始章] [结束章]
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const from = Number(process.argv[2] ?? 1);
const to = Number(process.argv[3] ?? 20);

function chapterDir(n) {
  return join(projectRoot, "chapters", `ch${String(n).padStart(2, "0")}`);
}

async function walk(root) {
  const out = new Map();
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        const text = await readFile(full, "utf8");
        out.set(relative(root, full).split("\\").join("/"), text);
      }
    }
  }
  await visit(root);
  return out;
}

let previous = null;
for (let n = from; n <= to; n += 1) {
  const dir = chapterDir(n);
  try {
    await stat(dir);
  } catch {
    continue;
  }
  const current = await walk(dir);
  if (previous) {
    const added = [];
    const changed = [];
    const removed = [];
    for (const [path, text] of current) {
      if (!previous.has(path)) added.push(path);
      else if (previous.get(path) !== text) changed.push(path);
    }
    for (const path of previous.keys()) {
      if (!current.has(path)) removed.push(path);
    }
    console.log(`\n=== ch${String(n).padStart(2, "0")} vs ch${String(n - 1).padStart(2, "0")} ===`);
    console.log(`added(${added.length}):`);
    for (const p of added.sort()) console.log(`  + ${p}`);
    console.log(`changed(${changed.length}):`);
    for (const p of changed.sort()) console.log(`  ~ ${p}`);
    if (removed.length > 0) {
      console.log(`removed(${removed.length}):`);
      for (const p of removed.sort()) console.log(`  - ${p}`);
    }
  } else {
    console.log(`=== ch${String(n).padStart(2, "0")} baseline (${current.size} files) ===`);
    for (const p of [...current.keys()].sort()) console.log(`  . ${p}`);
  }
  previous = current;
}
