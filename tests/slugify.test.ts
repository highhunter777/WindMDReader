/**
 * slugify 测试。
 * 该函数决定标题锚点 id,一旦与 markdown-it-anchor 行为不一致,
 * 会导致目录点击无法跳转、大纲高亮错位,因此需精确覆盖。
 */
import { describe, expect, it } from 'vitest';
import { slugify, createSlugDeduplicator } from '../src/renderer/slugify';

describe('slugify', () => {
  it('保留中文', () => {
    expect(slugify('安装说明')).toBe('安装说明');
  });

  it('转小写', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('空格转连字符', () => {
    expect(slugify('a b c')).toBe('a-b-c');
  });

  it('去除标点', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
  });

  it('保留连字符与下划线', () => {
    expect(slugify('foo-bar_baz')).toBe('foo-bar_baz');
  });

  it('去除首尾空白', () => {
    expect(slugify('  标题  ')).toBe('标题');
  });

  it('折叠连续空白为单个连字符', () => {
    expect(slugify('a    b')).toBe('a-b');
  });

  it('折叠连续连字符', () => {
    expect(slugify('a---b')).toBe('a-b');
  });

  it('去除首尾连字符', () => {
    expect(slugify('-标题-')).toBe('标题');
  });

  it('全符号输入回退为 section', () => {
    expect(slugify('!!!')).toBe('section');
    expect(slugify('   ')).toBe('section');
    expect(slugify('')).toBe('section');
  });

  it('混合中英文与数字', () => {
    expect(slugify('第 1 章 Introduction')).toBe('第-1-章-introduction');
  });

  it('emoji 被视为标点去除', () => {
    expect(slugify('🎉 庆祝')).toBe('庆祝');
  });

  it('数字保留', () => {
    expect(slugify('version 2 release')).toBe('version-2-release');
  });

  it('不会把下划线与连字符解析成字符类范围', () => {
    // 回归用例:正则写成 [\s-_] 时,TS 会判定为非法字符类范围且行为不符预期
    expect(slugify('a_b-c')).toBe('a_b-c');
    expect(slugify('a b-c')).toBe('a-b-c');
  });

  it('幂等:对已生成的 id 再次 slugify 不再变化', () => {
    const once = slugify('Hello, World! 你好');
    expect(slugify(once)).toBe(once);
  });
});

describe('createSlugDeduplicator', () => {
  it('首次出现返回原名', () => {
    expect(createSlugDeduplicator()('标题')).toBe('标题');
  });

  it('重复标题依次追加 -2、-3', () => {
    const d = createSlugDeduplicator();
    expect(d('概述')).toBe('概述');
    expect(d('概述')).toBe('概述-2');
    expect(d('概述')).toBe('概述-3');
  });

  it('不同标题互不影响', () => {
    const d = createSlugDeduplicator();
    expect(d('Alpha')).toBe('alpha');
    expect(d('Beta')).toBe('beta');
    expect(d('Alpha')).toBe('alpha-2');
  });

  it('跳过已被自然占用的后缀', () => {
    const d = createSlugDeduplicator();
    d('概述'); // → 概述
    d('概述'); // → 概述-2
    expect(d('概述-2')).toBe('概述-2-2'); // 概述-2 已被占,不能退回原始值
  });

  it('生成结果无重复(线性实现的正确性保证)', () => {
    const d = createSlugDeduplicator();
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const id = d('重复标题');
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect(seen.size).toBe(500);
  });

  it('空输入回退为 section 并同样参与去重', () => {
    const d = createSlugDeduplicator();
    expect(d('!!!')).toBe('section');
    expect(d('!!!')).toBe('section-2');
  });
});