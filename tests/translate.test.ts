/**
 * 划词翻译测试:离线分词聚合 + 在线端点(默认零网络请求)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emptyOnlineConfig,
  isOnlineConfigured,
  translateOffline,
  translateOnline,
} from '../src/renderer/translate';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('translateOffline — 聚合', () => {
  it('单词查询直接给词条', () => {
    const r = translateOffline('cache');
    expect(r.phraseHits).toHaveLength(1);
    expect(r.words).toHaveLength(0); // 整串已命中,不逐词展开
    expect(r.empty).toBe(false);
  });

  it('短语不再逐词展开', () => {
    const r = translateOffline('thank you');
    expect(r.phraseHits[0]?.key).toBe('thank you');
    expect(r.words).toHaveLength(0);
  });

  it('多词逐词查询', () => {
    const r = translateOffline('very good');
    expect(r.phraseHits).toHaveLength(0);
    expect(r.words.map((w) => w.token)).toEqual(['very', 'good']);
    expect(r.words.every((w) => w.hits.length > 0)).toBe(true);
  });

  it('中英混合分别走查词/反查', () => {
    const r = translateOffline('使用 API');
    expect(r.words).toHaveLength(2);
    expect(r.words[0].cjk).toBe(true);
    expect(r.words[0].reverse.length).toBeGreaterThan(0); // 使用 → used/use
    expect(r.words[1].cjk).toBe(false);
    expect(r.words[1].hits.length).toBeGreaterThan(0); // API
  });

  it('纯中文选区走反查', () => {
    const r = translateOffline('缓存');
    expect(r.words).toHaveLength(1);
    expect(r.words[0].reverse).toContain('cache');
    expect(r.empty).toBe(false);
  });

  it('完全未收录时 empty=true', () => {
    const r = translateOffline('zzqqxx wwuu');
    expect(r.empty).toBe(true);
  });

  it('长选区截断到 24 个词条并给出计数', () => {
    const r = translateOffline(Array.from({ length: 40 }, () => 'cache').join(' '));
    expect(r.words).toHaveLength(24);
    expect(r.tokenCount).toBe(40);
  });

  it('标点不作为词条', () => {
    const r = translateOffline('cache, API!');
    expect(r.words.map((w) => w.token)).toEqual(['cache', 'API']);
  });
});

describe('在线翻译 — 默认不发请求', () => {
  it('未配置时 isOnlineConfigured=false', () => {
    expect(isOnlineConfigured(emptyOnlineConfig)).toBe(false);
  });

  it('未配置时调用直接抛错(而非发请求)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(translateOnline('hi', emptyOnlineConfig)).rejects.toThrow(/未配置/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('只填端点但没启用,同样不发请求', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(
      translateOnline('hi', { ...emptyOnlineConfig, endpoint: 'https://x.com/v1' }),
    ).rejects.toThrow(/未配置/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('在线翻译 — 已配置', () => {
  const cfg = {
    enabled: true,
    endpoint: 'https://api.example.com/v1/',
    model: 'my-model',
    apiKey: 'sk-test',
  };

  it('POST 到 {endpoint}/chat/completions 并解析 content', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '你好' } }] }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    const out = await translateOnline('hello', cfg);
    expect(out).toBe('你好');

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/chat/completions'); // 末尾斜杠归一化
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('my-model');
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'hello' });
  });

  it('无 API Key 时不带 Authorization 头', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '译文' } }] }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    await translateOnline('hello', { ...cfg, apiKey: '' });
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('HTTP 非 2xx 抛可读错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await expect(translateOnline('hello', cfg)).rejects.toThrow('HTTP 401');
  });

  it('返回结构无法识别时抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    await expect(translateOnline('hello', cfg)).rejects.toThrow(/无法识别/);
  });

  it('模型名为空时用默认模型', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'x' } }] }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    await translateOnline('hello', { ...cfg, model: '  ' });
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).model).toBe('gpt-4o-mini');
  });
});
