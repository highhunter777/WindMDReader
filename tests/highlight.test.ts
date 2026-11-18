/**
 * 代码高亮:Shiki 使用 JavaScript 正则引擎(不依赖 WebAssembly)。
 *
 * 打包后的 Tauri 页面带严格 CSP,默认的 Oniguruma WASM 引擎会被 WebView2 拒绝,
 * 所有代码块退化为纯文本。这里锁住「能产出着色标记」与「未知语言可退化」。
 *
 * 分两层测:
 * - `renderHighlight`(Worker 的真实渲染逻辑):直接调用,覆盖着色与退化;
 * - `highlightCode`(主线程入口):jsdom 无 Worker,验证其**不抛错、不阻塞**,
 *   返回 null 时调用方(enhence)保留原始文本。
 */
import { describe, expect, it } from 'vitest';
import { highlightCode } from '../src/renderer/highlight';
import { renderHighlight } from '../src/renderer/highlight.worker';

describe('代码高亮 — 渲染逻辑(Worker 内的真实实现)', () => {
  it('已知语言产出按语法着色的标记', async () => {
    const html = await renderHighlight('const n: number = 1', 'ts', 'github-light');
    expect(html).toContain('class="shiki github-light"');
    expect(html).toMatch(/<span style="color:/);
  }, 60_000);

  it('未知语言退化为纯文本,仍保留代码块结构', async () => {
    const html = await renderHighlight('some plain text', 'not-a-language', 'github-dark');
    expect(html).toContain('class="shiki github-dark"');
    // 退化后只有行容器,没有语法着色 span
    expect(html).not.toMatch(/<span style="color:/);
  }, 60_000);

  it('深色主题同样生效', async () => {
    const html = await renderHighlight('fn main() {}', 'rust', 'github-dark');
    expect(html).toContain('class="shiki github-dark"');
    expect(html).toMatch(/<span style="color:/);
  }, 60_000);

  it('大语言包(cpp)也能正常着色', async () => {
    const html = await renderHighlight('int main() { return 0; }', 'cpp', 'github-light');
    expect(html).toContain('class="shiki github-light"');
    expect(html).toMatch(/<span style="color:/);
  }, 60_000);
});

describe('代码高亮 — 主线程入口的降级契约', () => {
  it('无 Worker 时返回 null 而不抛错(调用方保留原文)', async () => {
    const html = await highlightCode('let x = 1', 'python', 'github-dark');
    // jsdom 无 module worker:约定为 null;有 Worker 的环境则返回真实 HTML
    if (html !== null) {
      expect(html).toContain('class="shiki github-dark"');
    } else {
      expect(html).toBeNull();
    }
  }, 60_000);

  it('连续调用结果稳定且不抛错', async () => {
    const a = await highlightCode('const x = 42', 'js', 'github-light');
    const b = await highlightCode('const x = 42', 'js', 'github-light');
    expect(b).toBe(a);
  }, 60_000);
});
