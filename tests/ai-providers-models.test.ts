// getModels 的拉取与回退行为。
//
// 为什么单独测：getModels 有 5 条 provider 分支（ollama / openai 系 / claude /
// gemini / default），每条都有「HTTP 成功」「HTTP 失败」「抛异常」三种结局，
// 而**失败时的回退**才是关键：任何一条出错都必须退回 provider.models，
// 否则用户在没网/密钥错时会看到一个空的下拉框，无法再选回原来的模型。
//
// 测法：mock 全局 fetch，不发真请求。断言既看「请求打到了哪个 URL、带没带
// 凭据」，也看「失败时回退成什么」——只看前者会漏掉静默空列表这种最糟的形态。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getModels, type AIProvider } from '../src/main/ai-providers';

const prov = (over: Partial<AIProvider> = {}): AIProvider => ({
  id: 'p', name: 'P', type: 'openai', baseUrl: 'https://api.example.com',
  models: ['fallback-a', 'fallback-b'],
  supportsVision: false, supportsStreaming: true, supportsTools: false,
  ...over,
});

const jsonRes = (body: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 500,
  json: async () => body,
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openai 系：URL 与凭据', () => {
  it('打的是 {baseUrl}/v1/models，并带 Bearer 头', async () => {
    fetchMock.mockResolvedValue(jsonRes({ data: [{ id: 'gpt-4o' }] }));
    const got = await getModels(prov({ apiKey: 'sk-1' }));
    expect(got).toEqual(['gpt-4o']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/models');
    expect(init.headers['Authorization']).toBe('Bearer sk-1');
  });

  it('无 apiKey 时不发 Authorization 头（而不是发 Bearer 空值）', async () => {
    fetchMock.mockResolvedValue(jsonRes({ data: [{ id: 'm' }] }));
    await getModels(prov({ type: 'deepseek' }));
    const init = fetchMock.mock.calls[0][1];
    expect('Authorization' in init.headers).toBe(false);
  });

  // 上一条只查「头在不在」，查不出 `Bearer `（有空格、没有值）这种半吊子。
  // 变异 `if (provider.apiKey)` → `if (true)` 时头**确实出现**了，但值是空的，
  // 头在不在这条照样绿 —— 断言要连值一起查，才咬得住。
  it('无 apiKey 时不得出现任何形式的 Authorization（连空值 Bearer 都算）', async () => {
    fetchMock.mockResolvedValue(jsonRes({ data: [{ id: 'm' }] }));
    await getModels(prov({ type: 'deepseek' }));
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    const authLike = Object.keys(headers).filter((k) => k.toLowerCase() === 'authorization');
    if (authLike.length) {
      const v = String(headers[authLike[0]] ?? '').trim();
      expect(
        ['', 'Bearer', 'Bearer undefined', 'Bearer null'],
        `不该出现空/占位 Authorization，实际 "${v}"`,
      ).not.toContain(v);
    }
  });
});

describe('ollama：解析 name 字段', () => {
  it('打的是 {baseUrl}/api/tags（不是 v1/models）', async () => {
    fetchMock.mockResolvedValue(jsonRes({ models: [{ name: 'qwen2.5:7b' }] }));
    const got = await getModels(prov({ type: 'ollama', baseUrl: 'http://localhost:11434' }));
    expect(got).toEqual(['qwen2.5:7b']);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/api/tags');
  });

  it('没有 name 时退回 model 字段', async () => {
    fetchMock.mockResolvedValue(jsonRes({ models: [{ model: 'llama3.2' }] }));
    expect(await getModels(prov({ type: 'ollama' }))).toEqual(['llama3.2']);
  });
});

describe('gemini：剥掉 models/ 前缀且只留 gemini', () => {
  it('name 里的 models/ 前缀被剥掉', async () => {
    fetchMock.mockResolvedValue(jsonRes({ models: [{ name: 'models/gemini-2.0-flash' }] }));
    expect(await getModels(prov({ type: 'gemini', baseUrl: 'https://g.example' })))
      .toEqual(['gemini-2.0-flash']);
  });

  it('非 gemini 的模型被过滤掉（embed/图片等不该出现在对话下拉里）', async () => {
    fetchMock.mockResolvedValue(jsonRes({
      models: [{ name: 'models/gemini-2.0' }, { name: 'models/text-embedding-004' }],
    }));
    expect(await getModels(prov({ type: 'gemini' }))).toEqual(['gemini-2.0']);
  });

  it('apiKey 走 query 而不是 Authorization 头', async () => {
    fetchMock.mockResolvedValue(jsonRes({ models: [] }));
    await getModels(prov({ type: 'gemini', baseUrl: 'https://g.example', apiKey: 'GK' }));
    expect(fetchMock.mock.calls[0][0]).toBe('https://g.example/v1beta/models?key=GK');
  });
});

describe('claude：不发请求，直接用预设', () => {
  it('返回内置列表且完全不碰网络', async () => {
    const got = await getModels(prov({ type: 'claude' }));
    expect(got).toEqual(['fallback-a', 'fallback-b']);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('失败一律回退到 provider.models（不出现空列表）', () => {
  // 这是本文件最重要的一组：用户断网/密钥过期时，模型下拉不能变成空的，
  // 否则用户连回退到原来模型的办法都没有。
  it('HTTP 500（openai 系）', async () => {
    fetchMock.mockResolvedValue(jsonRes(null, false));
    expect(await getModels(prov())).toEqual(['fallback-a', 'fallback-b']);
  });

  it('HTTP 500（ollama）', async () => {
    fetchMock.mockResolvedValue(jsonRes(null, false));
    expect(await getModels(prov({ type: 'ollama' }))).toEqual(['fallback-a', 'fallback-b']);
  });

  it('HTTP 500（gemini）', async () => {
    fetchMock.mockResolvedValue(jsonRes(null, false));
    expect(await getModels(prov({ type: 'gemini' }))).toEqual(['fallback-a', 'fallback-b']);
  });

  it('网络异常抛错', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await getModels(prov())).toEqual(['fallback-a', 'fallback-b']);
  });

  it('返回体里 data 是空数组 ⇒ 也回退（否则下拉变空，用户连原模型都选不回）', async () => {
    fetchMock.mockResolvedValue(jsonRes({ data: [] }));
    expect(await getModels(prov())).toEqual(['fallback-a', 'fallback-b']);
  });

  it('ollama 侧同样是空数组就回退', async () => {
    fetchMock.mockResolvedValue(jsonRes({ models: [] }));
    expect(await getModels(prov({ type: 'ollama' }))).toEqual(['fallback-a', 'fallback-b']);
  });

  it('gemini 侧过滤后为空也回退（例如只返回 embedding 类模型）', async () => {
    fetchMock.mockResolvedValue(jsonRes({ models: [{ name: 'models/text-embedding-004' }] }));
    expect(await getModels(prov({ type: 'gemini' }))).toEqual(['fallback-a', 'fallback-b']);
  });

  it('条目缺 id / 名字为空串 ⇒ 该条被剔除，不进列表', async () => {
    fetchMock.mockResolvedValue(jsonRes({ data: [{ id: '' }, { id: 'real-model' }] }));
    expect(await getModels(prov())).toEqual(['real-model']);
  });
});
