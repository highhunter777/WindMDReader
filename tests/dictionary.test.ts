/**
 * 离线词典引擎测试(划词翻译的第一响应)。
 * 覆盖:精确命中、词形还原、短语、中文反查、近似建议、归一化。
 */
import { describe, expect, it } from 'vitest';
import { dictionarySize, lookupOffline, normalizeQuery } from '../src/renderer/dictionary';

describe('lookupOffline — 精确命中', () => {
  it('常用单词直接命中', () => {
    const r = lookupOffline('cache');
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].key).toBe('cache');
    expect(r.hits[0].defs.join(';')).toContain('缓存');
  });

  it('大小写不敏感', () => {
    expect(lookupOffline('Cache').hits[0]?.key).toBe('cache');
    expect(lookupOffline('CACHE').hits[0]?.key).toBe('cache');
  });

  it('带包裹符号的选区先归一化', () => {
    expect(lookupOffline('"cache"').hits).toHaveLength(1);
    expect(lookupOffline('（cache）').hits).toHaveLength(1);
    expect(lookupOffline('  cache  ').hits).toHaveLength(1);
  });

  it('技术术语命中', () => {
    expect(lookupOffline('middleware').hits[0]?.defs.join('')).toContain('中间件');
    expect(lookupOffline('refactor').hits[0]?.defs.join('')).toContain('重构');
  });
});

describe('lookupOffline — 词形还原', () => {
  it('复数:caches → cache', () => {
    expect(lookupOffline('caches').hits[0]?.key).toBe('cache');
  });

  it('三单 -es:crashes → crash', () => {
    expect(lookupOffline('crashes').hits[0]?.key).toBe('crash');
  });

  it('-ies → -y:queries → query', () => {
    expect(lookupOffline('queries').hits[0]?.key).toBe('query');
  });

  it('进行时:running → run', () => {
    expect(lookupOffline('running').hits[0]?.key).toBe('run');
  });

  it('进行时(落 e):caching → cache', () => {
    expect(lookupOffline('caching').hits[0]?.key).toBe('cache');
  });

  it('过去式双写辅音:stopped → stop', () => {
    expect(lookupOffline('stopped').hits[0]?.key).toBe('stop');
  });

  it('副词 -ly:typically → typical', () => {
    expect(lookupOffline('typically').hits[0]?.key).toBe('typical');
  });

  it('比较级:faster → fast', () => {
    expect(lookupOffline('faster').hits[0]?.key).toBe('fast');
  });

  it('还原结果与原词不同时标注来源键', () => {
    const r = lookupOffline('queries');
    expect(r.hits[0]?.key).not.toBe('queries');
  });
});

describe('lookupOffline — 短语', () => {
  it('整串短语命中', () => {
    const r = lookupOffline('thank you');
    expect(r.hits[0]?.key).toBe('thank you');
    expect(r.hits[0]?.defs).toContain('谢谢');
  });

  it('多词短语 best practice', () => {
    expect(lookupOffline('best practice').hits[0]?.defs).toContain('最佳实践');
  });
});

describe('lookupOffline — 中文反查', () => {
  it('中文释义反查到英文词', () => {
    const r = lookupOffline('缓存');
    expect(r.cjk).toBe(true);
    expect(r.reverse).toContain('cache');
  });

  it('反查结果限量(<=8)且去重', () => {
    const r = lookupOffline('的');
    expect(r.reverse.length).toBeLessThanOrEqual(8);
    expect(new Set(r.reverse).size).toBe(r.reverse.length);
  });

  it('无释义的中文不炸', () => {
    const r = lookupOffline('齉');
    expect(r.cjk).toBe(true);
    expect(r.reverse).toEqual([]);
  });
});

describe('lookupOffline — 未命中与建议', () => {
  it('生造词无命中、无建议崩溃', () => {
    const r = lookupOffline('zzqqxx');
    expect(r.hits).toHaveLength(0);
    expect(r.suggestions).toEqual([]);
  });

  it('给前缀近似建议', () => {
    const r = lookupOffline('cach');
    expect(r.hits).toHaveLength(0);
    expect(r.suggestions).toContain('cache');
  });

  it('建议不含查询词本身', () => {
    const r = lookupOffline('cach');
    expect(r.suggestions).not.toContain('cach');
  });

  it('极短查询不炸', () => {
    expect(() => lookupOffline('a')).not.toThrow();
    expect(() => lookupOffline('')).not.toThrow();
  });

  it('空查询返回空结果', () => {
    const r = lookupOffline('   ');
    expect(r.hits).toHaveLength(0);
    expect(r.reverse).toEqual([]);
  });
});

describe('normalizeQuery', () => {
  it('去首尾空白与包裹符号', () => {
    expect(normalizeQuery('  “cache”  ')).toBe('cache');
    expect(normalizeQuery('【测试】')).toBe('测试');
  });

  it('压缩内部连续空白', () => {
    expect(normalizeQuery('thank   you')).toBe('thank you');
  });

  it('英文统一小写', () => {
    expect(normalizeQuery('API')).toBe('api');
  });
});

describe('词典规模', () => {
  it('条目数在合理区间(精选而非全量)', () => {
    const n = dictionarySize();
    expect(n).toBeGreaterThan(1000);
    expect(n).toBeLessThan(3000);
  });
});
