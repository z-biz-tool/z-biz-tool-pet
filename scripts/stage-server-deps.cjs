#!/usr/bin/env node
// 把 server/*.js 运行需要的依赖（express/cors 及其传递依赖）完整暂存到 build/server-deps，
// 供 electron-builder 的 extraResources 使用。只拷顶层两个包会让 express@5 找不到 body-parser。
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const NM = path.join(root, 'node_modules');
const OUT = path.join(root, 'build', 'server-deps', 'node_modules');
const ROOTS = ['express', 'cors'];

const pkgName = (dir) => path.basename(dir).startsWith('@')
  ? path.basename(path.dirname(dir)) + '/' + path.basename(dir)
  : path.basename(dir);

function depsOf(pkgDir) {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    // optional/peer 不拷：whisper/ffmpeg 都是外部可执行文件，不需要 node 侧可选加速包
    return Object.keys(pj.dependencies || {});
  } catch {
    return [];
  }
}

const seen = new Set();
const missing = [];
const queue = [...ROOTS];
while (queue.length) {
  const name = queue.shift();
  if (seen.has(name)) continue;
  seen.add(name);
  const src = path.join(NM, name);
  if (!fs.existsSync(src)) {
    missing.push(name);
    continue;
  }
  const dest = path.join(OUT, name);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  for (const d of depsOf(src)) queue.push(d);
}

// 缺包必须当场失败：以前只 warn 继续，产物里的 server 会在用户机上 require 不到模块，
// 而 CI 依然全绿。express/cors/multer 现在是 devDependencies（只为 extraResources 服务，
// 不进 app.asar），用 --omit=dev 装依赖就会走到这个分支。
if (missing.length) {
  console.error(`[stage] 缺少 server 依赖 ${missing.length} 个: ${missing.join(', ')}`);
  console.error('  server 侧包在 devDependencies 里，打 Windows 包请用完整安装（npm install，不要 --omit=dev）。');
  process.exit(1);
}

fs.rmSync(path.join(OUT, '.package-lock.json'), { force: true });
console.log(`[stage] 已暂存 ${seen.size} 个包到 build/server-deps/node_modules`);
