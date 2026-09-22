import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// meeting-transcriber 顶层 import 了 electron（广播用），node 环境下要打桩
vi.mock('electron', () => ({
  app: { getPath: (k: string) => k },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

const mt = await import('../src/main/meeting-transcriber');

const RATE = 16000;
const FRAME_BYTES = 2; // 16bit 单声道

function wavHeader(pcmLength: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcmLength, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * FRAME_BYTES, 28);
  h.writeUInt16LE(FRAME_BYTES, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcmLength, 40);
  return h;
}

/** 模拟 ffmpeg 边录边写：同一个文件不断增长 */
function growTo(file: string, totalFrames: number) {
  const pcm = Buffer.alloc(totalFrames * FRAME_BYTES);
  for (let i = 0; i < totalFrames; i++) pcm.writeInt16LE((i % 1000) - 500, i * 2);
  fs.writeFileSync(file, Buffer.concat([wavHeader(pcm.length), pcm]));
}

let dir: string;
let src: string;
let dst: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbot-chunk-'));
  src = path.join(dir, 'meeting.wav');
  dst = path.join(dir, 'chunk.wav');
});

describe('parseWavHeader', () => {
  it('解析标准 44 字节头', () => {
    const info = mt.parseWavHeader(wavHeader(3200)) as any;
    // 头部只有 44 字节时 data 块紧跟其后
    expect(info).toBeTruthy();
    expect(info.dataOffset).toBe(44);
    expect(info.sampleRate).toBe(RATE);
    expect(info.channels).toBe(1);
    expect(info.bitsPerSample).toBe(16);
    expect(info.byteRate).toBe(RATE * FRAME_BYTES);
  });

  it('容忍 fmt 与 data 之间的额外块（LIST 等）', () => {
    const extra = Buffer.alloc(12);
    extra.write('LIST', 0);
    extra.writeUInt32LE(4, 4);
    extra.write('info', 8);
    const buf = Buffer.concat([
      wavHeader(64).subarray(0, 12),
      wavHeader(64).subarray(12, 36), // fmt 块
      extra,
      Buffer.from('data'),
      (() => {
        const l = Buffer.alloc(4);
        l.writeUInt32LE(64, 0);
        return l;
      })(),
      Buffer.alloc(64),
    ]);
    const info = mt.parseWavHeader(buf) as any;
    expect(info).toBeTruthy();
    expect(info.dataOffset).toBe(12 + 24 + 12 + 8);
  });

  it('非 wav / 空 buffer 返回 null', () => {
    expect(mt.parseWavHeader(Buffer.from('not a wav file at all'))).toBeNull();
    expect(mt.parseWavHeader(Buffer.alloc(0))).toBeNull();
  });
});

describe('增量切块（D19：不再整份复制）', () => {
  it('每次只产出新增音频，拼起来恰好等于整段录音', async () => {
    mt.resetChunkOffset();
    growTo(src, 1000); // 0.0625s
    const first = await mt.extractAudioChunk(src, dst);
    expect(first).not.toBeNull();
    expect(first!.bytes).toBe(1000 * FRAME_BYTES);
    expect(first!.startMs).toBe(0);
    const firstPcm = fs.readFileSync(dst).subarray(44);

    // 录音继续增长
    growTo(src, 2500);
    const second = await mt.extractAudioChunk(src, dst);
    expect(second!.bytes).toBe(1500 * FRAME_BYTES); // 只拿增量，而不是整份 2500
    // startMs 取整为毫秒，允许 1ms 舍入误差
    expect(Math.abs(second!.startMs - (1000 / RATE) * 1000)).toBeLessThanOrEqual(1);
    const secondPcm = fs.readFileSync(dst).subarray(44);

    // 没有新音频时不该产出 chunk
    const third = await mt.extractAudioChunk(src, dst);
    expect(third).toBeNull();

    // 两段拼接 == 完整录音，既无重复也无丢失
    const full = fs.readFileSync(src).subarray(44);
    expect(Buffer.concat([firstPcm, secondPcm]).equals(full)).toBe(true);

    // chunk 自身是合法 wav：时长 = 增量时长
    const info = mt.parseWavHeader(fs.readFileSync(dst).subarray(0, 44));
    expect(info!.dataOffset).toBe(44);
  });

  it('resetChunkOffset 后从头重切（新会议不能沿用上次偏移）', async () => {
    mt.resetChunkOffset();
    growTo(src, 800);
    const again = await mt.extractAudioChunk(src, dst);
    expect(again!.bytes).toBe(800 * FRAME_BYTES);
  });

  it('半个采样点的新数据不会切出错误边界', async () => {
    mt.resetChunkOffset();
    growTo(src, 500);
    // 追加 1 个奇数字节，凑不满一帧
    const cur = fs.readFileSync(src);
    const odd = Buffer.concat([cur, Buffer.from([0x11])]);
    // 修正 RIFF 与 data 长度字段
    odd.writeUInt32LE(36 + odd.length - 44, 4);
    odd.writeUInt32LE(odd.length - 44, 40);
    fs.writeFileSync(src, odd);
    const cut = await mt.extractAudioChunk(src, dst);
    expect(cut!.bytes % FRAME_BYTES).toBe(0);
    expect(cut!.bytes).toBe(500 * FRAME_BYTES);
  });

  it('源文件不存在时安全返回 null', async () => {
    mt.resetChunkOffset();
    expect(await mt.extractAudioChunk(path.join(dir, 'nope.wav'), dst)).toBeNull();
  });
});
