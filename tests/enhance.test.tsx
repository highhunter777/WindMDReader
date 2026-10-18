/**
 * T4.1:mountRendered 异步装载行为。
 * DOMPurify 改动态 import 后,挂载从「同步 innerHTML」变为
 * 「await 清洗 → 写入 → 同步接线」,以下用例锁住三个关键性质:
 *   ① 装载最终完成(onMounted 在 innerHTML 之后同步触发);
 *   ② 取消语义:cleanup 先于清洗完成时,旧内容不得写入、不得覆盖新内容;
 *   ③ 清洗失败时宁可显示错误态,也不挂未清洗内容。
 */
import { describe, expect, it, vi } from 'vitest';
import { mountRendered } from '../src/renderer/enhance';

/** 等动态 import 的 microtask 链走完(模块缓存后每次调用仍是若干微任务) */
const flush = () => new Promise<void>((r) => setTimeout(r, 50));

describe('mountRendered — 异步装载', () => {
  it('写入清洗后的内容并触发 onMounted', async () => {
    const el = document.createElement('div');
    const onMounted = vi.fn();
    mountRendered(el, '<p>正文</p><script>alert(1)</script>', 'github-light', onMounted);
    // 挂载是异步的:此刻尚未写入
    expect(el.innerHTML).toBe('');
    await flush();
    expect(el.innerHTML).toContain('正文');
    expect(el.innerHTML).not.toContain('<script');
    expect(onMounted).toHaveBeenCalledTimes(1);
  });

  it('onMounted 触发时内容已在 DOM 中(调用方可读几何)', async () => {
    const el = document.createElement('div');
    let innerAtCallback = '';
    mountRendered(el, '<p>x</p>', 'github-light', () => {
      innerAtCallback = el.innerHTML;
    });
    await flush();
    expect(innerAtCallback).toContain('<p>x</p>');
  });

  it('cleanup 先于清洗完成:旧内容不写入', async () => {
    const el = document.createElement('div');
    el.innerHTML = '<p>先前内容</p>';
    const onMounted = vi.fn();
    const cleanup = mountRendered(el, '<p>新内容</p>', 'github-light', onMounted);
    cleanup(); // 清洗尚未 resolve
    await flush();
    expect(el.innerHTML).toBe('<p>先前内容</p>');
    expect(onMounted).not.toHaveBeenCalled();
  });

  it('快速切换:后到的内容覆盖先到的,先到的 cleanup 不回写', async () => {
    const el = document.createElement('div');
    const c1 = mountRendered(el, '<p>文档一</p>', 'github-light');
    const c2 = mountRendered(el, '<p>文档二</p>', 'github-light');
    c1(); // 文档一已切走:它的 cleanup 必须先于其写入生效
    await flush();
    expect(el.innerHTML).toContain('文档二');
    expect(el.innerHTML).not.toContain('文档一');
    c2();
  });

  it('cleanup 后调用不会抛错(幂等)', async () => {
    const el = document.createElement('div');
    const cleanup = mountRendered(el, '<p>x</p>', 'github-light');
    cleanup();
    await flush();
    expect(() => cleanup()).not.toThrow();
  });
});

describe('mountRendered — 清洗失败回退', () => {
  it('DOMPurify 加载失败时显示错误态而非未清洗内容', async () => {
    vi.resetModules();
    vi.doMock('dompurify', () => {
      throw new Error('chunk load failed');
    });
    try {
      const { mountRendered: mount } = await import('../src/renderer/enhance');
      const el = document.createElement('div');
      mount(el, '<p>未清洗</p><script>alert(1)</script>', 'github-light');
      await flush();
      expect(el.textContent).toContain('安全清洗失败');
      expect(el.innerHTML).not.toContain('未清洗');
      expect(el.classList.contains('mount-error')).toBe(true);
    } finally {
      vi.doUnmock('dompurify');
      vi.resetModules();
    }
  });
});
