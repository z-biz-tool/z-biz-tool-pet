/**
 * 交互层的纯逻辑：坐标夹取、错误文案归一、列表 upsert。
 *
 * 放在 shared 下、不引 React / Tauri，`npm test` 可以直接用 node:test 跑
 * （见 tests/interaction.test.ts）。带副作用的调用点只负责 setState 与提示。
 */

export interface Size {
  width: number;
  height: number;
}

/**
 * 把浮层落点夹进视口。宠物窗只有 200×320，右键菜单若按点击点向下/向右展开，
 * 会直接超出窗口（Tauri 的透明窗不会替内容扩窗）。
 */
export function clampMenuPosition(
  x: number,
  y: number,
  viewport: Size,
  menu: Size
): { x: number; y: number } {
  const maxX = Math.max(0, viewport.width - menu.width);
  const maxY = Math.max(0, viewport.height - menu.height);
  return {
    x: Math.min(Math.max(0, x), maxX),
    y: Math.min(Math.max(0, y), maxY),
  };
}

/**
 * 统一错误文案。Tauri invoke 失败时 reject 的是字符串，浏览器/原生异常是 Error；
 * 直接把 `error.message` 拼进提示会得到 `undefined`（合同六.2：不甩 [object Object]）。
 */
export function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

/**
 * 快捷指令保存：按 id 覆盖或追加，返回新数组。
 * 旧实现先 setState 再用闭包里的旧 `commands` 写 localStorage，编辑/新增都会丢。
 */
export function upsertById<T extends { id: string }>(list: readonly T[], item: T): T[] {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index < 0) return [...list, item];
  const next = list.slice();
  next[index] = item;
  return next;
}
