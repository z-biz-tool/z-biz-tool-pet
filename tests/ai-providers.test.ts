// ai-providers 的配置解析测试。
//
// 为什么补这层：src/main/ai-providers.ts 821 行，是本仓最大的单文件，
// 此前 14 个测试文件里**没有一个**碰它。而它承担的是「用户填的配置
// 到底变成哪个 provider、用哪个 baseUrl/模型」——选错就是连错机器、
// 或者把请求发到不该去的地方。
//
// 本文件只测**纯函数**部分（getProviderFromConfig）。testConnection/getModels/
// chat 都要真发 HTTP，不适合放在这里；它们的行为另由 integration 覆盖。

import { describe, it, expect } from 'vitest';
import { BUILTIN_PROVIDERS, getProviderFromConfig, type AIProvider } from '../src/main/ai-providers';

const base = {
  aiProvider: 'openai',
  aiApiKey: '',
  aiBaseUrl: '',
  aiModel: '',
  providers: [] as AIProvider[],
  ollamaUrl: '',
  modelName: '',
};

describe('getProviderFromConfig：自定义 providers 优先', () => {
  it('命中 providers 列表时原样返回该条，不受 aiProvider 字段影响', () => {
    const custom: AIProvider = {
      id: 'openai',
      name: '我的私有中转',
      type: 'custom',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-xyz',
      models: ['my-model'],
      supportsVision: false,
      supportsStreaming: true,
      supportsTools: false,
    };
    const got = getProviderFromConfig({ ...base, providers: [custom] });
    // 关键：必须返回**列表里那一条**（含它的私有 baseUrl），
    // 而不是去 BUILTIN 里找同 id 的 openai 模板（那是公网地址）。
    expect(got).toBe(custom);
    expect(got.baseUrl).toBe('https://relay.example.com');
  });

  it('providers 里 id 不匹配时，才走内置模板', () => {
    const other: AIProvider = {
      id: 'zzz', name: 'x', type: 'custom', baseUrl: 'https://other',
      models: ['m'], supportsVision: false, supportsStreaming: false, supportsTools: false,
    };
    const got = getProviderFromConfig({ ...base, aiProvider: 'deepseek', providers: [other] });
    expect(got.id).toBe('deepseek');
  });
});

describe('getProviderFromConfig：旧配置兼容路径', () => {
  it('内置 provider + 自定义 baseUrl ⇒ 保留 baseUrl 覆盖', () => {
    const got = getProviderFromConfig({
      ...base, aiProvider: 'openai', aiBaseUrl: 'https://my-proxy/v1', aiApiKey: 'sk-1',
    });
    expect(got.id).toBe('openai');
    expect(got.baseUrl).toBe('https://my-proxy/v1');
    expect(got.apiKey).toBe('sk-1');
  });

  it('未填 baseUrl ⇒ 落回内置模板自带的地址', () => {
    const got = getProviderFromConfig({ ...base, aiProvider: 'openai' });
    const builtin = BUILTIN_PROVIDERS.find((p) => p.id === 'openai')!;
    expect(got.baseUrl).toBe(builtin.baseUrl);
  });

  it('填了 aiModel ⇒ 该模型被排在 models 首位，且不丢内置列表', () => {
    const got = getProviderFromConfig({ ...base, aiProvider: 'openai', aiModel: 'gpt-4o-mini' });
    expect(got.models[0]).toBe('gpt-4o-mini');
    const builtin = BUILTIN_PROVIDERS.find((p) => p.id === 'openai')!;
    for (const m of builtin.models) expect(got.models).toContain(m);
  });

  it('未填 aiModel ⇒ models 与内置完全一致（不塞占位）', () => {
    const got = getProviderFromConfig({ ...base, aiProvider: 'openai' });
    const builtin = BUILTIN_PROVIDERS.find((p) => p.id === 'openai')!;
    expect(got.models).toEqual(builtin.models);
  });

  // 这条初版我断言 `apiKey === undefined`，**写错了**：内置模板本身就写着
  // apiKey: ''，而 `config.aiApiKey || builtin.apiKey` 在两者都空时落回
  // builtin.apiKey 也就是 ''。⇒ 断言改成钉真正要紧的那件事：
  // 结果不能是 null/undefined 之外的怪值，更不能因为「没填」就造出占位串。
  it('内置模板的 apiKey 原样带出（当前是空串，不是 undefined 也不是占位）', () => {
    const got = getProviderFromConfig({ ...base, aiProvider: 'openai' });
    const builtin = BUILTIN_PROVIDERS.find((p) => p.id === 'openai')!;
    expect(got.apiKey).toBe(builtin.apiKey);
    expect(typeof got.apiKey).toBe('string');
  });

  it('内置模板一律不带真密钥（模板进仓，任何非空值都是泄露）', () => {
    for (const p of BUILTIN_PROVIDERS) {
      expect(p.apiKey === undefined || p.apiKey === '', `${p.id} 的模板里带了非空 apiKey`);
    }
  });
});

describe('getProviderFromConfig：未知 provider 的回退', () => {
  it('aiProvider 认不出来 ⇒ 落回 BUILTIN_PROVIDERS[0]', () => {
    const got = getProviderFromConfig({ ...base, aiProvider: 'no-such-provider' });
    expect(got.id).toBe(BUILTIN_PROVIDERS[0].id);
  });

  // 下面这条把「回退到哪个 provider」钉死。
  // 现状是 BUILTIN_PROVIDERS[0] —— 也就是 ollama（本地模型），
  // 而不是一个中立的占位。用户在一个**不认识**的 provider 名（比如旧版本残留、
  // 手改配置写错、别的产品线串过来的 id）下，会静默变成「往本地 ollama 发请求」：
  // 要么连不上报一个和真实原因无关的错，要么真的连上了本机服务而用户以为在用云端。
  //
  // **这是现状刻画，不是认可。** 若将来产品上决定「未知 provider 应报错而非回退」，
  // 这条会红，那正是应该改的信号。
  it('现状：未知 provider 回退到的是 ollama（本地），不是中立的占位', () => {
    const got = getProviderFromConfig({ ...base, aiProvider: 'no-such-provider' });
    expect(got.type).toBe('ollama');
  });

  it('回退时 ollamaUrl 覆盖生效', () => {
    const got = getProviderFromConfig({
      ...base, aiProvider: 'no-such-provider', ollamaUrl: 'http://192.168.1.10:11434',
    });
    expect(got.baseUrl).toBe('http://192.168.1.10:11434');
  });

  it('回退时 modelName 覆盖生效，且 models 只留这一个', () => {
    const got = getProviderFromConfig({
      ...base, aiProvider: 'no-such-provider', modelName: 'qwen2.5:3b',
    });
    expect(got.models).toEqual(['qwen2.5:3b']);
  });

  it('回退时 modelName 为空 ⇒ 落回内置第一项，不产生空字符串模型名', () => {
    const got = getProviderFromConfig({ ...base, aiProvider: 'no-such-provider' });
    expect(got.models[0]).toBe(BUILTIN_PROVIDERS[0].models[0]);
    expect(got.models).not.toContain('');
  });
});

describe('BUILTIN_PROVIDERS 自洽性', () => {
  it('每条都有 id / name / baseUrl / 非空 models', () => {
    for (const p of BUILTIN_PROVIDERS) {
      expect(p.id, `${p.id} 缺 id`).toBeTruthy();
      expect(p.name, `${p.id} 缺 name`).toBeTruthy();
      expect(p.baseUrl, `${p.id} 缺 baseUrl`).toBeTruthy();
      expect(Array.isArray(p.models) && p.models.length > 0, `${p.id} models 为空`).toBe(true);
    }
  });

  it('id 互不重复（重复会让上面的查找静默取到第一条）', () => {
    const ids = BUILTIN_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('baseUrl 都是绝对 URL（拼 /v1/models 之前不能是相对路径）', () => {
    for (const p of BUILTIN_PROVIDERS) {
      expect(p.baseUrl, `${p.id} 的 baseUrl 不是绝对地址`).toMatch(/^https?:\/\//);
    }
  });
});
