/**
 * 渲染性能基准:对应规划 3.1 的性能目标。
 * 10MB / 万行文档 ≤ 1s 可交互(这里只断言 markdown-it 同步渲染阶段)。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/renderer/markdown';

/** 构造约 N 行的混合内容文档(标题/正文/代码/表格/公式) */
function makeDoc(lines: number): string {
  const block = [
    '## 小节标题',
    '',
    '这是正文段落,包含 `行内代码` 与 **加粗** 文本,以及[链接](https://example.com)。',
    '',
    '```ts',
    'const value: number = 42;',
    'console.log(value);',
    '```',
    '',
    '| 列 A | 列 B |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '行内公式 $E = mc^2$ 与引用 > 引用内容',
    '',
  ];
  const reps = Math.ceil(lines / block.length);
  return block.join('\n').repeat(reps);
}

describe('渲染性能', () => {
  /** 多次取最小值:抗抖动。单次采样在并发跑测试时会偶发失败 */
  const fastest = (doc: string, times = 3) => {
    let best = Infinity;
    for (let i = 0; i < times; i++) {
      const t0 = performance.now();
      renderMarkdown(doc);
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };

  it('2000 行常见笔记渲染在 300ms 内(M1 目标)', () => {
    expect(fastest(makeDoc(2000))).toBeLessThan(300);
  });

  it('万行文档渲染在 1s 内(M0 目标)', () => {
    expect(fastest(makeDoc(10_000))).toBeLessThan(1000);
  });

  it('万行文档体积在 1MB 量级,接近 10MB 级性能区间', () => {
    const doc = makeDoc(10_000);
    expect(doc.length).toBeGreaterThan(100_000);
  });

  it('大纲收集不产生 O(n²):行数翻倍耗时应线性增长', () => {
    const small = makeDoc(2_500);
    const large = makeDoc(10_000);

    fastest(makeDoc(1_000)); // 预热,排除 JIT 冷启动干扰
    // 采样加倍 + 阈值放宽到 8 倍:20ms 量级下单次 GC 停顿就能把 6 倍
    // 边界顶过头(实测 6.15 倍偶发),而 O(n²) 会是 16 倍,检出力不受影响
    const tSmall = fastest(small, 5);
    const tLarge = fastest(large, 5);

    // 输入 4倍,耗时不应远超 4 倍(留足余量;O(n²) 会是 16 倍)
    expect(tLarge).toBeLessThan(Math.max(tSmall * 8, 120));
  });

  /**
   * 回归用例:标题大量重名时的 slug 去重。
   *
   * markdown-it-anchor 自带的去重逻辑每次都从 `-1` 开始逐个试探后缀,
   * 而试探值往往已被占用 → 5000 个同名标题需 2.9s(O(n²)),
   * 远超万行文档 1s 的性能目标。改用 createSlugDeduplicator 的线性实现。
   */
  it('5000 个同名标题的渲染在 1s 内', () => {
    const doc = '# 标题\n\n正文段落。\n\n'.repeat(5000);
    expect(fastest(doc)).toBeLessThan(1000);
    expect(renderMarkdown(doc).headings).toHaveLength(5000);
  });

  it('同名标题去重后 id 仍唯一且顺序正确', () => {
    const { headings } = renderMarkdown('# 概述\n\n## 概述\n\n### 概述\n');
    const ids = headings.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['概述', '概述-2', '概述-3']);
  });

  it('去重状态不跨文档泄漏', () => {
    // 第一篇文档用过 概述 / 概述-2,第二篇相同标题应重新从 概述 开始
    renderMarkdown('# 概述\n\n## 概述\n');
    const { headings } = renderMarkdown('# 概述\n');
    expect(headings[0].id).toBe('概述');
  });
});