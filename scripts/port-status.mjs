// Electron → Tauri 端点台账（现算，不维护副本）。
// 三处事实源：preload 暴露面（契约）、tauri-bridge（已接）、src-tauri（已实现且已注册）。
// 用法：node scripts/port-status.mjs [--strict]   --strict 时未清零返回退出码 1
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

// 1) 契约：preload 的 api 对象
const preload = read('src/preload/index.ts');
const apiRe = /^\s{2}([A-Za-z]\w*)\s*:\s*(?:async\s*)?\(([\s\S]{0,200}?)\)\s*(?::[^=]{0,80})?=>[\s\S]{0,120}?ipcRenderer\.(invoke|send|on|once)\(\s*'([^']+)'/gm;
const contract = [];
let m;
while ((m = apiRe.exec(preload))) {
  contract.push({ name: m[1], kind: m[3], channel: m[4] });
}

// 2) 已接：bridge 的 PORTED / EVENTS / 特例
const bridge = read('src/renderer/shared/tauri-bridge.ts');
const ported = new Map();
for (const x of bridge.matchAll(/^\s{2}(\w+):\s*\{\s*cmd:\s*'([^']+)'/gm)) ported.set(x[1], x[2]);
const events = new Map();
for (const x of bridge.matchAll(/^\s{2}(\w+):\s*'([^']+)'/gm)) if (!ported.has(x[1])) events.set(x[1], x[2]);
// 特例：不是「一个方法 ↔ 一条通道」的映射，而是手写出来的桥（log 无 invoke 对应物、
// onApplySkin 双通道收敛），只能按名字认账
const special = new Set(['log', 'onApplySkin']);

// 3) 已实现 / 已注册：Rust 侧（src-tauri/src 下所有模块都要扫，命令不止住在 commands.rs）
const rustDir = resolve(root, 'src-tauri/src');
const rustSrc = readdirSync(rustDir)
  .filter((f) => f.endsWith('.rs'))
  .map((f) => readFileSync(resolve(rustDir, f), 'utf8'))
  .join('\n');
const implemented = new Set([...rustSrc.matchAll(/#\[tauri::command\]\s*\n\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g)].map((x) => x[1]));
const registered = new Set(
  (rustSrc.match(/generate_handler!\[([\s\S]*?)\]/)?.[1] ?? '')
    .replace(/\/\/.*$/gm, '')
    .split(',')
    .map((s) => s.trim().split('::').pop())
    .filter(Boolean)
);

const rows = contract.map((c) => {
  let state;
  if (c.kind === 'invoke' && ported.has(c.name)) {
    const cmd = ported.get(c.name);
    state = registered.has(cmd) ? 'OK' : `断链：bridge 指向 ${cmd}，但未注册进 generate_handler`;
  } else if (c.kind !== 'invoke' && (events.has(c.name) || special.has(c.name))) {
    state = 'OK';
  } else {
    state = '未移植';
  }
  return { ...c, state };
});

const ok = rows.filter((r) => r.state === 'OK');
const todo = rows.filter((r) => r.state === '未移植');
const broken = rows.filter((r) => r.state !== 'OK' && r.state !== '未移植');

const byChannel = (a, b) => a.channel.localeCompare(b.channel);
for (const r of [...rows].sort(byChannel)) {
  if (r.state !== 'OK') console.log(`  ${r.state === '未移植' ? '·' : '✗'} ${r.name.padEnd(28)} ${r.channel.padEnd(28)} ${r.state}`);
}
console.log(`\n端点总数 ${rows.length}｜已通 ${ok.length}｜未移植 ${todo.length}｜断链 ${broken.length}`);
console.log(`Rust 已实现命令 ${implemented.size}｜已注册 ${registered.size}`);

const orphanCmds = [...registered].filter((n) => !implemented.has(n) && n !== 'greet');
if (orphanCmds.length) console.log(`⚠ 注册了但源码里找不到实现：${orphanCmds.join(', ')}`);
// 前端引用判定按名字在垫片源码里找：PORTED 表、EVENTS 表，以及 impl.log 这类特例
const unused = [...implemented].filter((n) => !new RegExp(`'${n}'`).test(bridge));
if (unused.length) console.log(`ℹ 已实现但前端还没接上：${unused.join(', ')}`);

if (broken.length) {
  console.error('✗ 存在断链：bridge 映射到了未注册的 Tauri 命令');
  process.exit(1);
}
if (process.argv.includes('--strict') && todo.length) {
  console.error(`✗ 仍有 ${todo.length} 个端点未移植`);
  process.exit(1);
}
console.log(todo.length ? `→ 剩余 ${todo.length} 个端点排队（P3）` : '✓ 端点全部移植完毕，可以删 preload');
