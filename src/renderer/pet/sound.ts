// ---------- 音效（WebAudio 合成，零二进制资产） ----------
//
// 仓里到现在一个 .wav/.mp3 都没有，也不打算加：桌宠要的那几个音都很短、
// 都能用振荡器现捏，合成有几个硬好处 ——
//   1. 不用往 dmg 里塞音频文件，包体积不变；
//   2. 音量/音高可以按物理量实时调（落地速度越快声音越闷越响）；
//   3. 不需要解码，第一个音到发声的延迟比 AudioBuffer 短。
//
// 全部走一个懒创建的 AudioContext + 一个 master gain，方便一键静音。
// 注意：WebView 里 AudioContext 必须在用户手势之后才允许出声，
// 所以第一次点击时调一次 resumeUnlock()（App.tsx 在 pointerdown 里已经接上）。

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;

const MASTER_GAIN = 0.35;

function ensure(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch {
      return null;
    }
    master = ctx.createGain();
    master.gain.value = muted ? 0 : MASTER_GAIN;
    master.connect(ctx.destination);
  }
  return ctx;
}

/**
 * 在用户手势里调一次，把 AudioContext 从 suspended 拉起来。
 * 不在手势里调也没关系 —— 失败静默，下次手势再试。
 */
export function resumeUnlock(): void {
  const c = ensure();
  if (c && c.state === 'suspended') void c.resume().catch(() => {});
}

export function setMuted(next: boolean): void {
  muted = next;
  if (master && ctx) {
    // 30ms ramp，避免音量跳变时出现「咔」的一声
    master.gain.setTargetAtTime(next ? 0 : MASTER_GAIN, ctx.currentTime, 0.03);
  }
}

export function isMuted(): boolean {
  return muted;
}

/** 有没有可用的音频设备/上下文。false 时所有 playXxx 直接 no-op */
export function audioAvailable(): boolean {
  return ensure() !== null;
}

// ---------- 底层小工具 ----------

interface ToneOpts {
  /** 起始频率 Hz */
  from: number;
  /** 结束频率 Hz（滑音终点）；不给就不滑 */
  to?: number;
  /** 秒 */
  dur: number;
  type?: OscillatorType;
  /** 0..1，相对 master 再衰减一层 */
  gain?: number;
  /** 起音秒数，默认很短 */
  attack?: number;
  /** 延迟起播秒数 */
  delay?: number;
}

/** 一个带包络的滑音。所有音效都由它拼出来 */
function tone(o: ToneOpts): void {
  const c = ensure();
  if (!c || !master) return;
  const t0 = c.currentTime + (o.delay ?? 0);
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.from, t0);
  if (o.to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), t0 + o.dur);

  const peak = o.gain ?? 0.6;
  const attack = o.attack ?? 0.006;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);

  osc.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + o.dur + 0.02);
}

/** 噪声缓冲：落地的「噗」和抛掷的「唰」都需要它，正弦波做不出气流感 */
let noiseBuf: AudioBuffer | null = null;
function noise(o: { dur: number; gain?: number; delay?: number; freq?: number; q?: number }): void {
  const c = ensure();
  if (!c || !master) return;
  if (!noiseBuf) {
    const len = Math.floor(c.sampleRate * 0.5);
    noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }
  const t0 = c.currentTime + (o.delay ?? 0);
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  // 带通：不滤的话白噪声太刺耳，像电视雪花而不像东西落地
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = o.freq ?? 900;
  bp.Q.value = o.q ?? 1.2;
  const g = c.createGain();
  const peak = o.gain ?? 0.4;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
  src.connect(bp);
  bp.connect(g);
  g.connect(master);
  src.start(t0);
  src.stop(t0 + o.dur + 0.02);
}

// ---------- 对外的几个音 ----------

/**
 * 落地。impact 归一到 0..1（物理层给的是 px/s，调用方自己除）。
 * 慢慢放下 = 一声很轻的「啵」；从屏幕顶甩下来 = 闷响 + 一点噪声。
 */
export function playLand(impact = 0.4): void {
  const k = Math.max(0, Math.min(1, impact));
  // 频率随力度下沉：轻放高一点、闷响低一点，符合「重的东西落地音更低」的直觉
  tone({ from: 220 - 120 * k, to: 70 - 20 * k, dur: 0.14 + 0.1 * k, type: 'sine', gain: 0.25 + 0.5 * k });
  if (k > 0.25) noise({ dur: 0.08 + 0.06 * k, gain: 0.1 + 0.25 * k, freq: 500 + 300 * (1 - k) });
}

/** 撞墙/撞天花板：比落地短促，带一点「啵」的空心感 */
export function playBump(impact = 0.5): void {
  const k = Math.max(0, Math.min(1, impact));
  tone({ from: 320 - 140 * k, to: 150, dur: 0.09, type: 'triangle', gain: 0.2 + 0.35 * k });
}

/** 摸头。连击层级 1/2/3+ 递进，音调往上走，第 6 下（傲娇拒绝）换成下沉 */
export function playPet(comboTier: 1 | 2 | 3 | 'reject' = 1): void {
  if (comboTier === 'reject') {
    // 傲娇：一个下滑的短音，像「哼」
    tone({ from: 520, to: 220, dur: 0.18, type: 'triangle', gain: 0.32 });
    return;
  }
  const base = [660, 784, 880][comboTier - 1];
  tone({ from: base, to: base * 1.12, dur: 0.09, type: 'sine', gain: 0.3 });
  tone({ from: base * 2, to: base * 2.2, dur: 0.05, type: 'sine', gain: 0.12, delay: 0.01 });
}

/** 抛出/拎起：一声向上的气流，暗示「她离手了」 */
export function playThrow(power = 0.6): void {
  const k = Math.max(0, Math.min(1, power));
  tone({ from: 180, to: 700 + 400 * k, dur: 0.16 + 0.08 * k, type: 'sine', gain: 0.18 + 0.22 * k });
  noise({ dur: 0.14 + 0.1 * k, gain: 0.08 + 0.14 * k, freq: 1400 + 900 * k, q: 0.8 });
}

/** 升级/达成：两个叠起来的纯音，亮但不吵 */
export function playLevelUp(): void {
  tone({ from: 523.25, dur: 0.16, type: 'sine', gain: 0.28 });
  tone({ from: 783.99, dur: 0.28, type: 'sine', gain: 0.26, delay: 0.09 });
  tone({ from: 1046.5, dur: 0.34, type: 'sine', gain: 0.14, delay: 0.18 });
}

/** 短促的「叮」，用于成就/提醒这类不该抢注意力的反馈 */
export function playPing(): void {
  tone({ from: 1174.66, dur: 0.12, type: 'sine', gain: 0.22 });
}

/** 测试/调试用：把内部状态吐出来，避免测试去摸私有变量 */
export function _debugState(): { hasContext: boolean; muted: boolean; state: string | null } {
  return { hasContext: ctx !== null, muted, state: ctx?.state ?? null };
}
