/**
 * 文档内查找测试。
 * 重点验证 cleanup 能完整还原 DOM —— 查找会向正文插入 mark,
 * 若撤销不彻底会污染已渲染的内容(代码块尤其敏感)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyFind } from '../src/renderer/find';

let el: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  el = document.createElement('article');
  el.className = 'prose';
  document.body.appendChild(el);
});

describe('applyFind — 高亮', () => {
  it('找到所有命中', () => {
    el.innerHTML = '<p>apple banana apple</p>';
    const s = applyFind(el, 'apple');
    expect(s?.hits).toHaveLength(2);
  });

  it('大小写不敏感', () => {
    el.innerHTML = '<p>Apple APPLE apple</p>';
    expect(applyFind(el, 'apple')?.hits).toHaveLength(3);
  });

  it('命中保留原始大小写', () => {
    el.innerHTML = '<p>Hello World</p>';
    const s = applyFind(el, 'hello');
    expect(s?.hits[0].textContent).toBe('Hello');
  });

  it('跨多个元素查找', () => {
    el.innerHTML = '<p>目标</p><ul><li>目标</li></ul>';
    expect(applyFind(el, '目标')?.hits).toHaveLength(2);
  });

  it('无命中返回空数组', () => {
    el.innerHTML = '<p>内容</p>';
    expect(applyFind(el, '不存在')?.hits).toHaveLength(0);
  });

  it('空查询不执行查找', () => {
    el.innerHTML = '<p>内容</p>';
    expect(applyFind(el, '')).toBeNull();
    expect(applyFind(el, '   ')).toBeNull();
  });

  it('忽略首尾空白并去重两边', () => {
    el.innerHTML = '<p>alpha beta</p>';
    expect(applyFind(el, '  beta  ')?.hits).toHaveLength(1);
  });
});

describe('applyFind — 跳过区域', () => {
  it('不搜索代码块(保护 Shiki 输出的 token 结构)', () => {
    el.innerHTML = '<pre><code>const 关键词 = 1;</code></pre>';
    expect(applyFind(el, '关键词')?.hits).toHaveLength(0);
  });

  it('不搜索行内代码', () => {
    el.innerHTML = '<p>看<code>这里</code>那里</p>';
    expect(applyFind(el, '这里')?.hits).toHaveLength(0);
  });

  it('不搜索公式与图表占位', () => {
    el.innerHTML = '<span class="math-inline">x</span><div class="mermaid-block">graph</div>';
    expect(applyFind(el, 'graph')?.hits).toHaveLength(0);
  });

  it('代码块外的同名文本仍能命中', () => {
    el.innerHTML = '<pre><code>abc</code></pre><p>abc</p>';
    expect(applyFind(el, 'abc')?.hits).toHaveLength(1);
  });
});

describe('applyFind — DOM 可逆性', () => {
  it('cleanup 后完全还原原始 HTML', () => {
    el.innerHTML = '<p>apple banana apple</p>';
    const before = el.innerHTML;
    applyFind(el, 'apple')?.cleanup();
    expect(el.innerHTML).toBe(before);
  });

  it('cleanup 后不残留 mark', () => {
    el.innerHTML = '<p>目标目标</p>';
    applyFind(el, '目标')?.cleanup();
    expect(el.querySelectorAll('mark').length).toBe(0);
  });

  it('反复查找与撤销不会累积 DOM', () => {
    el.innerHTML = '<p>apple banana apple</p>';
    const before = el.innerHTML;
    for (let i = 0; i < 5; i++) {
      applyFind(el, 'apple')?.cleanup();
    }
    expect(el.innerHTML).toBe(before);
  });

  it('撤销后不改变元素结构(节点数一致)', () => {
    el.innerHTML = '<p><strong>粗体</strong>与普通文本目标</p>';
    const beforeCount = el.querySelectorAll('*').length;
    applyFind(el, '目标')?.cleanup();
    expect(el.querySelectorAll('*').length).toBe(beforeCount);
  });

  it('连续多次 cleanup 幂等', () => {
    el.innerHTML = '<p>apple</p>';
    const s = applyFind(el, 'apple');
    s?.cleanup();
    s?.cleanup();
    expect(el.querySelectorAll('mark').length).toBe(0);
  });

  it('多个文本节点同时命中时正确还原', () => {
    el.innerHTML = '<p>目标一</p><p>目标二</p><p>目标三</p>';
    const before = el.innerHTML;
    const s = applyFind(el, '目标');
    expect(s?.hits).toHaveLength(3);
    s?.cleanup();
    expect(el.innerHTML).toBe(before);
  });

  it('命中段落首尾时不丢字符', () => {
    el.innerHTML = '<p>target开始</p>';
    const s = applyFind(el, 'target');
    s?.cleanup();
    expect(el.textContent).toBe('target开始');
  });
});

describe('applyFind — 返回值契约', () => {
  it('hits 按文档顺序排列', () => {
    el.innerHTML = '<p>第一</p><p>第二</p><p>第三</p>';
    const s = applyFind(el, '第');
    expect(s?.hits.map((m) => m.textContent)).toEqual(['第', '第', '第']);
  });

  it('cleanup 后 hits 数组被清空', () => {
    el.innerHTML = '<p>abc</p>';
    const s = applyFind(el, 'abc');
    s?.cleanup();
    expect(s?.hits).toHaveLength(0);
  });

  it('每个命中带 find-hit 类名供样式使用', () => {
    el.innerHTML = '<p>abc</p>';
    const s = applyFind(el, 'abc');
    expect(s?.hits[0].className).toBe('find-hit');
  });
});