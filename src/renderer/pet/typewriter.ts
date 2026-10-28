// 气泡打字机：台词一个字一个字长出来，状态提示（在听…/思考中）瞬间出现。
//
// 设计约束（和 physics.ts 同款）：
//   1. 纯函数 —— 「出到第几个字」只由 text + elapsedMs 决定，注入时间就能在
//      node --test 里逐帧断言，不需要 fake timers 也不需要 DOM。
//   2. 按码点（code point）切，不按 UTF-16 code unit 切 —— 直接 slice(i) 会在
//      emoji 的代理对中间下刀，打到一半吐出一个 �，很难看也很难查。
//   3. 分段语速：≤6 字瞬间出全（「思考中」这类状态词打字只会显得卡），
//      常规 28ms/字，>120 字的长回复 14ms/字 —— 否则 300 字的回答要打 8 秒，
//      用户会以为死了去点她，一点击气泡就换了，反而读不完。

/** 少于等于这个字数瞬间出全：状态词、短问候不该有打字过程 */
export const INSTANT_CHARS = 6;
/** 常规语速：约 36 字/秒 —— 读得过来，又不至于拖沓 */
export const TYPE_MS_PER_CHAR = 28;
/** 超过这个长度算长回复，切换到加速档 */
export const LONG_TEXT_CHARS = 120;
/** 长回复语速：约 71 字/秒，300 字约 4.2 秒出完 */
export const FAST_MS_PER_CHAR = 14;

/**
 * 每个字停留多久。0 表示不出打字机（直接出全）。
 * 按码点长度分段，不按字符数：一个 emoji 占两个 code unit 但只算一个「字」。
 */
export function msPerChar(text: string): number {
  const len = codePointLength(text);
  if (len <= INSTANT_CHARS) return 0;
  return len > LONG_TEXT_CHARS ? FAST_MS_PER_CHAR : TYPE_MS_PER_CHAR;
}

/** 码点长度：emoji、生僻汉字都算 1 个字，和用户「字数」的直觉一致 */
export function codePointLength(text: string): number {
  return [...text].length;
}

/** 这段文字打完总共要多久（ms）。瞬间出全的短句返回 0。 */
export function totalTypeMs(text: string): number {
  return codePointLength(text) * msPerChar(text);
}

/**
 * elapsedMs 时刻应当露出几个字。
 * 防御性处理：elapsedMs ≤ 0 视为还没开始（0 个字），短句永远出全。
 */
export function revealCount(text: string, elapsedMs: number): number {
  const perChar = msPerChar(text);
  if (perChar === 0) return codePointLength(text);
  if (elapsedMs <= 0) return 0;
  return Math.min(codePointLength(text), Math.floor(elapsedMs / perChar));
}

/**
 * elapsedMs 时刻露出的文本。
 * [...text] 按码点展开后再 slice —— 永远不会在代理对中间下刀。
 */
export function revealText(text: string, elapsedMs: number): string {
  return [...text].slice(0, revealCount(text, elapsedMs)).join('');
}
