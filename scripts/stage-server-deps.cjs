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
const queue = [...ROOTS];
while (queue.length) {
  const name = queue.shift();
  if (seen.has(name)) continue;
  seen.add(name);
  const src = path.join(NM, name);
  if (!fs.existsSync(src)) {
    console.warn('[stage] 缺失依赖，跳过:', name);
    continue;
  }
  const dest = path.join(OUT, name);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  for (const d of depsOf(src)) queue.push(d);
}

fs.rmSync(path.join(OUT, '.package-lock.json'), { force: true });
console.log(`[stage] 已暂存 ${seen.size} 个包到 build/server-deps/node_modules`);
