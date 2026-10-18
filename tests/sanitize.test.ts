/**
 * 安全测试:DOMPurify 清洗。
 * 规划 3.3「渲染的 HTML 一律经 sanitize(DOMPurify),防止 .md 内嵌脚本(XSS)」——
 * 这是不可省的安全底线,必须有回归测试守住。
 *
 * T4.1 起 DOMPurify 改为动态 import(回收首屏约 28KB),sanitizeHtml 随之异步化。
 */
import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from '../src/renderer/enhance';

describe('sanitizeHtml — 脚本注入', () => {
  it('移除 script 标签及其内容', async () => {
    const out = await sanitizeHtml('<p>正常</p><script>alert(1)</script>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('正常');
  });

  it('移除事件处理器属性', async () => {
    const out = await sanitizeHtml('<img src="x" onerror="alert(1)">');
    expect(out).not.toContain('onerror');
  });

  it('移除 javascript: 伪协议', async () => {
    const out = await sanitizeHtml('<a href="javascript:alert(1)">点我</a>');
    expect(out).not.toContain('javascript:');
  });

  it('移除 iframe / object / embed', async () => {
    const out = await sanitizeHtml('<iframe src="evil.com"></iframe><object data="x"></object><embed src="y">');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('<object');
    expect(out).not.toContain('<embed');
  });

  it('移除 svg 内联事件', async () => {
    const out = await sanitizeHtml('<svg><animate onbegin="alert(1)" attributeName="x"></animate></svg>');
    expect(out).not.toContain('onbegin');
  });
});

describe('sanitizeHtml — 合法内容必须保留', () => {
  it('保留常规排版标签', async () => {
    const html = '<h1>标题</h1><p><strong>粗</strong><em>斜</em></p><ul><li>项</li></ul>';
    const out = await sanitizeHtml(html);
    expect(out).toContain('<h1>');
    expect(out).toContain('<strong>');
    expect(out).toContain('<em>');
    expect(out).toContain('<li>');
  });

  it('保留表格与引用', async () => {
    expect(await sanitizeHtml('<table><tr><td>单元格</td></tr></table>')).toContain('<td>');
    expect(await sanitizeHtml('<blockquote>引用</blockquote>')).toContain('<blockquote>');
  });

  it('保留图片及其 src', async () => {
    const out = await sanitizeHtml('<img src="https://a.com/b.png" alt="图">');
    expect(out).toContain('src="https://a.com/b.png"');
    expect(out).toContain('alt="图"');
  });

  it('保留 https 链接', async () => {
    expect(await sanitizeHtml('<a href="https://a.com">链接</a>')).toContain('href="https://a.com"');
  });

  it('保留代码内容中的尖括号(转义形式)', async () => {
    const out = await sanitizeHtml('<pre><code>&lt;div&gt;</code></pre>');
    expect(out).toContain('&lt;div&gt;');
  });
});

describe('sanitizeHtml — 渲染管线依赖的属性', () => {
  it('保留公式占位所需的 data-tex', async () => {
    const out = await sanitizeHtml('<span class="math-inline" data-tex="E = mc^2"></span>');
    expect(out).toContain('data-tex="E = mc^2"');
  });

  it('保留图表占位所需的 data-mid', async () => {
    const out = await sanitizeHtml('<div class="mermaid-block" data-mid="0"></div>');
    expect(out).toContain('data-mid="0"');
  });

  it('保留代码块占位所需的 data-lang', async () => {
    const out = await sanitizeHtml('<pre class="code-block" data-lang="ts"><code>x</code></pre>');
    expect(out).toContain('data-lang="ts"');
  });

  it('保留 anchor 生成的标题 id(目录跳转依赖)', async () => {
    expect(await sanitizeHtml('<h2 id="安装说明">安装</h2>')).toContain('id="安装说明"');
  });

  it('保留 task-list 的 checkbox', async () => {
    const out = await sanitizeHtml('<input type="checkbox" checked>');
    expect(out).toContain('type="checkbox"');
  });
});
