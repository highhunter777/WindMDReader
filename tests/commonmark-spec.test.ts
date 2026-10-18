/**
 * CommonMark 官方规范测试集回归 —— 规划M1 验收项「渲染层通过 100%」。
 *
 * spec 文件为官方 spec.txt(652 例),固化在 tests/fixtures/ 下,
 * 测试不应依赖网络。更新方式见文件末尾注释。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import MarkdownIt from 'markdown-it';

const SPEC_PATH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/commonmark-spec.txt');

interface SpecCase {
  md: string[];
  html: string[];
}

/** 解析 spec.txt: ```` example / markdown / . / html / ```` */
function parseSpec(text: string): SpecCase[] {
  // END TESTS 之后是附录说明,不含用例
  const body = text.split('<!-- END TESTS -->')[0];
  const fence = /^\s*`{32,}( example)?\s*$/;
  const cases: SpecCase[] = [];
  let cur: SpecCase | null = null;
  let phase: 'md' | 'html' = 'md';

  for (const line of body.split('\n')) {
    const m = line.match(fence);
    if (m) {
      if (!m[1]) {
        if (cur) cases.push(cur);
        cur = null;
      } else if (!cur) {
        cur = { md: [], html: [] };
        phase = 'md';
      }
      continue;
    }
    if (!cur) continue;
    if (phase === 'md' && line.trim() === '.') {
      phase = 'html';
      continue;
    }
    cur[phase].push(line);
  }
  return cases;
}

/** spec 用 →(U+2192)表示制表符 */
const untab = (s: string) => s.replace(/→/g, '\t');

/**
 * 只去首尾空行,保留行内空白。
 * 不可用 \s+$ —— 行尾两个空格在 CommonMark 中是硬换行语义,必须保留。
 */
const trimLines = (s: string) => s.replace(/^(?:\n)+/, '').replace(/(?:\n)+$/, '');

/**
 * 忽略块级标签之间的换行差异。
 * spec 文本无法表达开闭标签间是否换行(如空 blockquote 的期望值写作
 * `<blockquote>\n</blockquote>`),markdown-it 输出无换行形式,二者语义相同。
 */
const looseTags = (s: string) => s.replace(/>\n</g, '><');

/**
 * 忽略自闭合标签记法差异:spec 用 XHTML 的 `<br />`,markdown-it 输出 HTML5 `<br>`。
 */
const looseSelfClosing = (s: string) => looseTags(s).replace(/\s*\/>/g, '>');

/** linkify 是 GFM 扩展而非 CommonMark 的一部分,裸 URL/邮箱会被转成链接 */
const isLinkifyExtension = (src: string) => /https?:\/\/\S/.test(src) || /\w+@[\w.]+\.\w+/.test(src);

const specCases = parseSpec(readFileSync(SPEC_PATH, 'utf8'));

/**
 * 用项目真实的 markdown-it 配置,而不是 commonmark preset ——
 * 这个测试的价值正是验证「项目配置不破坏 CommonMark 兼容性」。
 * 需与 src/renderer/markdown.ts 的 buildMd() 保持同步。
 */
const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
});

describe('CommonMark spec 回归', () => {
  it('spec 文件解析出 652 例', () => {
    expect(specCases).toHaveLength(652);
  });

  it('每例都含输入与期望输出', () => {
    for (const c of specCases) {
      expect(c.md.length + c.html.length).toBeGreaterThan(0);
    }
  });

  it('全部用例通过(100%)', () => {
    const failures: { src: string; expect: string; actual: string }[] = [];
    /** linkify 属预期差异(GFM 扩展),单独归类不算回归 */
    const expectedDiff: string[] = [];

    for (const c of specCases) {
      const src = trimLines(untab(c.md.join('\n')));
      const actual = trimLines(md.render(src + '\n'));
      const expect = trimLines(untab(c.html.join('\n')));
      if (looseSelfClosing(actual) === looseSelfClosing(expect)) continue;
      if (isLinkifyExtension(src)) {
        expectedDiff.push(src.slice(0, 60));
        continue;
      }
      failures.push({ src, expect, actual });
    }

    if (failures.length > 0) {
      const detail = failures
        .slice(0, 5)
        .map(
          (f) =>
            `输入: ${JSON.stringify(f.src.slice(0, 100))}\n期望: ${JSON.stringify(f.expect)}\n实际: ${JSON.stringify(f.actual)}`,
        )
        .join('\n\n');
      throw new Error(`CommonMark spec 失败 ${failures.length}/${specCases.length}:\n\n${detail}`);
    }

    expect(failures).toHaveLength(0);
    // linkify 造成 4 例预期差异,属 GFM 扩展而非回归
    expect(expectedDiff).toHaveLength(4);
  });

  it('typographer 保持关闭(回归防护)', () => {
    // typographer 会把 5--10 改成 5–10,与 CommonMark 及技术文档需求冲突。
    // 一旦有人重新开启,本用例与之对照即可发现。
    const src = '范围 5--10';
    expect(md.renderInline(src)).toBe('范围 5--10');
    const buggy = new MarkdownIt({ html: true, linkify: true, typographer: true });
    expect(buggy.renderInline(src)).not.toBe('范围 5--10');
  });
});