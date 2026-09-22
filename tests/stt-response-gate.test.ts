import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'module';

/**
 * server/stt.js 里两个可单测的部件。
 *
 * 之所以拆出来：'error' 与 'close' 双写响应导致进程被打死只在 Windows 上必然复现，
 * 本地 POSIX 机器上 Node 只发 'error' 就没了。把"一次性闸门"做成纯函数在这里锁住，
 * Windows 腿再锁集成行为。
 */
const require = createRequire(import.meta.url);
// stt.js 在模块加载时就 listen，必须先把端口挪开，别和集成用例抢 8084
process.env.PORT = '18098';
process.env.HOST = '127.0.0.1';
const { onceResponder, resolveWhisperBin, server } = require('../server/stt.js') as {
  onceResponder: (res: { status: (c: number) => { json: (b: unknown) => unknown } }) => (code: number, body: unknown) => boolean;
  resolveWhisperBin: (platform?: string, env?: Record<string, string>) => string;
  server: { close: (cb?: () => void) => void };
};

afterAll(() => {
  server.close(() => undefined);
});

function fakeRes(throwOnJson = false) {
  const writes: { code: number; body: unknown }[] = [];
  const res = {
    status(code: number) {
      return {
        json(body: unknown) {
          if (throwOnJson) throw new Error('ERR_HTTP_HEADERS_SENT');
          writes.push({ code, body });
        },
      };
    },
  };
  return { res: res as never, writes };
}

describe('onceResponder：一个请求只写一次响应', () => {
  it('第二次写入被丢弃且返回 false', () => {
    const { res, writes } = fakeRes();
    const send = onceResponder(res);
    expect(send(500, { error: 'whisper 启动失败' })).toBe(true);
    expect(send(500, { error: 'Transcription failed' })).toBe(false);
    expect(writes).toHaveLength(1);
    expect(writes[0].code).toBe(500);
  });

  it('底层 res 抛异常时不得冒泡（那会打死整个服务）', () => {
    const { res } = fakeRes(true);
    const send = onceResponder(res);
    expect(() => send(200, { text: 'x' })).not.toThrow();
    // 已经写过了，后续调用同样安静
    expect(() => send(500, {})).not.toThrow();
  });
});

describe('resolveWhisperBin：Windows 必须找 .exe', () => {
  it('显式 ZBOT_WHISPER_BIN 优先，且各平台一致', () => {
    expect(resolveWhisperBin('win32', { ZBOT_WHISPER_BIN: 'D:/tools/whisper-cli.exe' })).toBe('D:/tools/whisper-cli.exe');
    expect(resolveWhisperBin('darwin', { ZBOT_WHISPER_BIN: '/opt/whisper-cli' })).toBe('/opt/whisper-cli');
  });

  it('win32 上按 whisper-cli.exe 解析，POSIX 上不带后缀', () => {
    expect(resolveWhisperBin('win32', { PATH: '' })).toContain('whisper-cli.exe');
    expect(resolveWhisperBin('darwin', { PATH: '' })).toContain('whisper-cli');
    expect(resolveWhisperBin('linux', { PATH: '' })).not.toContain('whisper-cli.exe');
  });
});
