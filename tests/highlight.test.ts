/**
 * 代码高亮:Shiki 使用 JavaScript 正则引擎(不依赖 WebAssembly)。
 *
 * 打包后的 Tauri 页面带严格 CSP,默认的 Oniguruma WASM 引擎会被 WebView2 拒绝,
 * 所有代码块退化为纯文本。这里锁住「能产出着色标记」与「未知语言可退化」。
 */
import { describe, expect, it } from 'vitest';
import { highlightCode } from '../src/renderer/highlight';

describe('代码高亮', () => {
  it('已知语言产出按语法着色的标记', async () => {
    const html = await highlightCode('const n: number = 1', 'ts', 'github-light');
    expect(html).toContain('class="shiki github-light"');
    expect(html).toMatch(/<span style="color:/);
  }, 30_000);

  it('未知语言退化为纯文本,仍保留代码块结构', async () => {
    const html = await highlightCode('some plain text', 'not-a-language', 'github-dark');
    expect(html).toContain('class="shiki github-dark"');
    // 语言回退为 text:只有行容器,没有语法着色 span
    expect(html).not.toMatch(/<span style="color:/);
  }, 30_000);

  it('同一代码与主题命中缓存,结果一致', async () => {
    const a = await highlightCode('const x = 42', 'js', 'github-light');
    const b = await highlightCode('const x = 42', 'js', 'github-light');
    expect(b).toBe(a);
    expect(a).toContain('42');
  }, 30_000);
});
