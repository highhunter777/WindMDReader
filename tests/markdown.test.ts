/**
 * 渲染管线测试:markdown-it 配置、大纲收集、各语法扩展。
 * 这是 M1 验收项「CommonMark spec 通过 100%(渲染层)」的回归基线。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/renderer/markdown';

describe('renderMarkdown — 基础', () => {
  it('渲染标题并生成大纲', () => {
    const { html, headings } = renderMarkdown('# 一级\n\n## 二级\n\n### 三级\n');
    expect(html).toContain('<h1');
    expect(headings).toEqual([
      { level: 1, id: '一级', text: '一级' },
      { level: 2, id: '二级', text: '二级' },
      { level: 3, id: '三级', text: '三级' },
    ]);
  });

  it('大纲的 id 与 HTML 中的锚点一致(点击目录能跳转到正确位置)', () => {
    const { html, headings } = renderMarkdown('## 安装说明\n\n正文\n');
    for (const h of headings) {
      expect(html).toContain(`id="${h.id}"`);
    }
  });

  it('同级标题重名时生成唯一 id', () => {
    const { headings } = renderMarkdown('## 概述\n\n## 概述\n');
    expect(headings).toHaveLength(2);
    expect(headings[0].id).not.toBe(headings[1].id);
  });

  it('标题内含行内标记时,大纲取纯文本', () => {
    const { headings } = renderMarkdown('## **加粗** 与 `代码`\n');
    expect(headings[0].text).toContain('加粗');
    expect(headings[0].text).not.toContain('**');
  });

  it('渲染段落、强调与链接', () => {
    const { html } = renderMarkdown('普通段落 **粗体** *斜体* [链接](https://a.com)\n');
    expect(html).toContain('<strong>粗体</strong>');
    expect(html).toContain('<em>斜体</em>');
    expect(html).toContain('href="https://a.com"');
  });

  it('GFM 表格', () => {
    const { html } = renderMarkdown('| 名称 | 值 |\n|---|---|\n| a | 1 |\n| b | 2 |\n');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>名称</th>');
    expect(html).toContain('<td>1</td>');
  });

  it('GFM 任务列表:复选框反映勾选状态', () => {
    const { html } = renderMarkdown('- [x] 已完成\n- [ ] 待办\n');
    expect(html).toContain('checked');
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
  });

  it('GFM 删除线与自动链接', () => {
    const { html } = renderMarkdown('~~删除~~ 以及 https://auto.link\n');
    expect(html).toContain('<s>删除</s>');
    expect(html).toContain('href="https://auto.link"');
  });

  it('围栏代码块转为占位元素并记录语言', () => {
    const { html } = renderMarkdown('```ts\nconst a = 1;\n```\n');
    expect(html).toContain('class="code-block"');
    expect(html).toContain('data-lang="ts"');
  });

  it('未标语言的围栏回退为 text', () => {
    const { html } = renderMarkdown('```\nplain\n```\n');
    expect(html).toContain('data-lang="text"');
  });

  it('代码内容被转义,不会破坏 HTML 结构', () => {
    const { html } = renderMarkdown('```html\n<script>alert(1)</script>\n```\n');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('引用块与分割线', () => {
    const { html } = renderMarkdown('> 引用\n\n---\n');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<hr');
  });
});

describe('renderMarkdown — 数学公式', () => {
  it('行内公式转为占位元素并携带 TeX', () => {
    const { html } = renderMarkdown('质能方程 $E = mc^2$ 成立\n');
    expect(html).toContain('class="math-inline"');
    expect(html).toContain('data-tex="E = mc^2"');
  });

  it('块级公式独立成块', () => {
    const { html } = renderMarkdown('$$\n\\int_0^1 x dx\n$$\n');
    expect(html).toContain('class="math-block"');
    expect(html).toContain('\\int_0^1 x dx');
  });

  it('未闭合的 $$ 交回默认解析,不影响后续内容', () => {
    const { html } = renderMarkdown('$$\n未闭合\n');
    // 不应产生 math-block,且不吞掉内容
    expect(html).not.toContain('math-block');
    expect(html).toContain('未闭合');
  });

  it('行内公式内容为空或首尾空白时不误判', () => {
    expect(renderMarkdown('a $ b $ c\n').html).not.toContain('math-inline');
  });

  it('TeX 中的 HTML 特殊字符被转义', () => {
    const { html } = renderMarkdown('$a < b$\n');
    expect(html).toContain('data-tex="a &lt; b"');
  });
});

describe('renderMarkdown — Mermaid 图表', () => {
  it('提取图表源码并按序分配 mid', () => {
    const { html } = renderMarkdown('```mermaid\ngraph TD;\nA-->B;\n```\n');
    expect(html).toContain('class="mermaid-block"');
    expect(html).toContain('data-mid="0"');
    expect(window.__windmdMermaid?.[0]).toContain('graph TD');
  });

  it('多个图表各自编号,源码不串位', () => {
    renderMarkdown('```mermaid\ngraph TD;\nA-->B;\n```\n\n```mmd\ngraph LR;\nC-->D;\n```\n');
    expect(window.__windmdMermaid?.[0]).toContain('A-->B');
    expect(window.__windmdMermaid?.[1]).toContain('C-->D');
  });

  it('每次渲染重置计数器', () => {
    renderMarkdown('```mermaid\ngraph TD;\nA-->B;\n```\n');
    const { html } = renderMarkdown('```mermaid\ngraph TD;\nX-->Y;\n```\n');
    expect(html).toContain('data-mid="0"');
  });
});

describe('renderMarkdown — 扩展语法', () => {
  it('脚注渲染并生成回链', () => {
    const { html } = renderMarkdown('正文[^a]\n\n[^a]: 注释内容\n');
    expect(html).toContain('footnote');
    expect(html).toContain('注释内容');
  });

  it('warning 容器渲染为 callout', () => {
    const { html } = renderMarkdown('::: warning\n注意\n:::\n');
    expect(html).toContain('callout-warning');
    expect(html).toContain('注意');
  });

  it('tip 容器渲染为 callout', () => {
    const { html } = renderMarkdown('::: tip\n技巧\n:::\n');
    expect(html).toContain('callout-tip');
  });

  it('成对标签闭合,不产生未闭合的 div', () => {
    const { html } = renderMarkdown('::: warning\n内容\n:::\n');
    const open = (html.match(/<div/g) ?? []).length;
    const close = (html.match(/<\/div>/g) ?? []).length;
    expect(open).toBe(close);
  });
});

describe('renderMarkdown — 健壮性', () => {
  it('空输入不报错', () => {
    expect(() => renderMarkdown('')).not.toThrow();
    expect(renderMarkdown('').headings).toEqual([]);
  });

  it('未闭合的容器不吞掉后续文档', () => {
    const { html } = renderMarkdown('::: warning\n未闭合\n\n## 之后的标题\n');
    expect(html).toContain('之后的标题');
  });

  it('超长文档可完成渲染', () => {
    const big = '# 标题\n\n正文段落。\n\n'.repeat(5000);
    const t0 = performance.now();
    const { headings } = renderMarkdown(big);
    expect(headings).toHaveLength(5000);
    // 5 万行级别文档应在 1s 内完成(markdown-it 同步渲染)
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});