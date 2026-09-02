// 核对教程正文引用的代码路径、npm 脚本与符号名是否在对应章节快照中真实存在。
// 用法: node scripts/verify-tutorial-refs.mjs [章号...]
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const codeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(codeRoot);

const chapterFilter = process.argv.slice(2).map(Number);

const articles = (await readdir(repoRoot))
  .filter((name) => /^\d+\.\s/.test(name) && name.endsWith(".md"))
  .map((name) => ({ name, chapter: Number(name.split(".")[0]) }))
  .filter((item) => chapterFilter.length === 0 || chapterFilter.includes(item.chapter))
  .sort((a, b) => a.chapter - b.chapter);

function chapterDir(n) {
  return join(codeRoot, "chapters", `ch${String(n).padStart(2, "0")}`);
}

async function walk(root) {
  const out = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) out.push(relative(root, full).split("\\").join("/"));
    }
  }
  await visit(root);
  return out;
}

const pkg = JSON.parse(await readFile(join(codeRoot, "package.json"), "utf8"));
const scriptNames = new Set(Object.keys(pkg.scripts));

let totalProblems = 0;
for (const article of articles) {
  const text = await readFile(join(repoRoot, article.name), "utf8");
  const dir = chapterDir(article.chapter);
  let files;
  try {
    await stat(dir);
    files = await walk(dir);
  } catch {
    console.log(`\n### ch${article.chapter}: 快照目录不存在，跳过`);
    continue;
  }
  const fileSet = new Set(files);
  const basenames = new Set(files.map((f) => f.split("/").pop()));

  const problems = [];

  // 1) 引用的 src/ 或 tests/ 相对路径
  const pathRefs = new Set();
  for (const m of text.matchAll(/`((?:src|tests)\/[A-Za-z0-9_./-]+\.[a-z]+)`/g)) pathRefs.add(m[1]);
  for (const m of text.matchAll(
    /`?(?:code\/)?chapters\/ch(\d{2})\/((?:src|tests)\/[A-Za-z0-9_./-]+\.[a-z]+)`?/g,
  )) {
    if (Number(m[1]) === article.chapter) pathRefs.add(m[2]);
    else pathRefs.add(`ch${m[1]}:${m[2]}`);
  }
  // ESM import 说明符写作 .js，实际文件是 .ts，需要等价折叠。
  const exists = (rel, set) =>
    set.has(rel) || (rel.endsWith(".js") && set.has(`${rel.slice(0, -3)}.ts`));

  for (const ref of [...pathRefs].sort()) {
    if (ref.includes(":")) {
      const [chTag, rel] = ref.split(":");
      const otherFiles = new Set(await walk(chapterDir(Number(chTag.slice(2)))));
      if (!exists(rel, otherFiles)) problems.push(`跨章路径不存在: chapters/${chTag}/${rel}`);
      continue;
    }
    if (!exists(ref, fileSet)) problems.push(`路径不存在于本章快照: ${ref}`);
  }

  // 2) npm 脚本
  for (const m of text.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) {
    if (!scriptNames.has(m[1])) problems.push(`npm script 不存在: ${m[1]}`);
  }

  // 3) 文件名裸引用（形如 `loop.ts`）
  for (const m of text.matchAll(/`([a-z0-9][a-z0-9-]*\.ts)`/g)) {
    if (!basenames.has(m[1]) && !m[1].endsWith(".d.ts")) {
      problems.push(`文件名未在本章快照出现: ${m[1]}`);
    }
  }

  const unique = [...new Set(problems)];
  totalProblems += unique.length;
  console.log(`\n### ch${article.chapter} (${article.name.slice(0, 40)}...) 问题 ${unique.length}`);
  for (const p of unique) console.log(`  - ${p}`);
}

console.log(`\n合计问题: ${totalProblems}`);
