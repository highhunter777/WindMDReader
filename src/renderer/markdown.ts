/**
 * 渲染核心:markdown-it 配置 + 自定义插件(数学公式、容器、任务列表、脚注、锚点)。
 * 输出 HTML 与标题大纲(TOC 数据源)。
 */
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import anchor from 'markdown-it-anchor';
import container from 'markdown-it-container';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import { slugify, createSlugDeduplicator } from './slugify';

export interface Heading {
  level: number;
  id: string;
  text: string;
}

export interface RenderedDoc {
  html: string;
  headings: Heading[];
}

interface RenderEnv {
  /** Mermaid 源码收集表:data-mid → 源码 */
  mermaidSources: Record<number, string>;
  mermaidCount: number;
  /** 本次渲染的标题 slug 去重器,惰性创建 */
  slugDeduplicator?: (input: string) => string;
}

/**
 * 取本次渲染的 slug 去重器。
 * markdown-it-anchor 自带的去重在标题大量重名时是 O(n²),
 * 这里改用 createSlugDeduplicator 的线性实现(见 slugify.ts)。
 */
function getSlugDedup(env: RenderEnv): (input: string) => string {
  env.slugDeduplicator ??= createSlugDeduplicator();
  return env.slugDeduplicator;
}

/* ---------------- 数学公式插件(轻量自实现,避免额外依赖) ---------------- */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mathPlugin(md: MarkdownIt): void {
  // 行内 $...$
  md.inline.ruler.before('escape', 'math_inline', (state, silent) => {
    const src = state.src;
    const pos = state.pos;
    if (src[pos] !== '$' || src[pos + 1] === '$') return false;
    let i = pos + 1;
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '$' && src[i - 1] !== '\\') {
        const content = src.slice(pos + 1, i);
        if (!content.trim() || /\s/.test(content[0]) || /\s/.test(content[content.length - 1])) return false;
        if (!silent) {
          const token = state.push('math_inline', '', 0);
          token.content = content;
        }
        state.pos = i + 1;
        return true;
      }
      i++;
    }
    return false;
  });

  // 块级 $$...$$
  md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const line = state.src.slice(start, state.eMarks[startLine]).trim();
    if (line !== '$$') return false;
    if (silent) return true;
    let nextLine = startLine + 1;
    const lines: string[] = [];
    while (nextLine < endLine) {
      const b = state.bMarks[nextLine] + state.tShift[nextLine];
      const l = state.src.slice(b, state.eMarks[nextLine]).trim();
      if (l === '$$') break;
      lines.push(l);
      nextLine++;
    }
    if (nextLine >= endLine) return false; // 未闭合,交给默认解析
    const token = state.push('math_block', '', 0);
    token.content = lines.join('\n');
    token.map = [startLine, nextLine + 1];
    state.line = nextLine + 1;
    return true;
  });

  md.renderer.rules.math_inline = (tokens, idx) => {
    const tex = escapeHtml(tokens[idx].content);
    return `<span class="math-inline" data-tex="${tex}"></span>`;
  };
  md.renderer.rules.math_block = (tokens, idx) => {
    const tex = escapeHtml(tokens[idx].content);
    return `<div class="math-block" data-tex="${tex}"></div>\n`;
  };
}

/* ---------------- Wiki 链接与标签插件 ---------------- */

/** `[[目标|显示名]]` → <a class="wiki-link" data-wiki="目标">;点击由 Viewer 分发 */
function wikiLinkPlugin(md: MarkdownIt): void {
  md.inline.ruler.before('link', 'wiki_link', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x5b /* [ */) return false;
    if (state.src.charCodeAt(state.pos + 1) !== 0x5b) return false;
    const match = /^\[\[([^[\]\n]+)\]\]/.exec(state.src.slice(state.pos));
    if (!match) return false;
    if (!silent) {
      const token = state.push('wiki_link', 'a', 0);
      const [target, alias] = match[1].split('|');
      token.attrSet('data-wiki', target.trim());
      token.content = (alias ?? target).trim();
    }
    state.pos += match[0].length;
    return true;
  });

  md.renderer.rules.wiki_link = (tokens, idx) => {
    const token = tokens[idx];
    const target = token.attrGet('data-wiki') ?? '';
    const label = escapeHtml(token.content || target);
    return `<a class="wiki-link" data-wiki="${escapeHtml(target)}" href="javascript:void(0)" title="${label}">${label}</a>`;
  };

  /** `#tag` → <span class="hash-tag" data-tag="tag">;行首标题由块级规则先行消费 */
  md.inline.ruler.before('text', 'hashtag', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x23 /* # */) return false;
    const prev = state.pos > 0 ? state.src[state.pos - 1] : '';
    if (state.pos > 0 && !/\s/.test(prev)) return false;
    // \p{L} 覆盖中文等字母,避免 \w 只含 ASCII 导致中文标签被截断
    const match = /^#(\p{L}[\p{L}\p{N}_\-/]*)/u.exec(state.src.slice(state.pos));
    if (!match) return false;
    if (!silent) {
      const token = state.push('hashtag', 'span', 0);
      token.content = match[1];
    }
    state.pos += match[0].length;
    return true;
  });

  md.renderer.rules.hashtag = (tokens, idx) => {
    const tag = tokens[idx].content;
    return `<span class="hash-tag" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</span>`;
  };
}

/* ---------------- 渲染器配置 ---------------- */

function buildMd(): MarkdownIt {
  const md = new MarkdownIt({
    html: true, // 输出前统一 DOMPurify 清洗
    linkify: true,
    // typographer 会把 -- 改成 –、--- 改成 —,(c) 改成 ©,
    // 这会破坏 CommonMark 兼容性(实测 652 例中 83 例不通过),
    // 且技术文档里的 5--10 会被误当成范围改写。排版优化改由 CSS 承担。
    typographer: false,
  });

  md.use(mathPlugin);
  md.use(wikiLinkPlugin);
  // 去重状态存放在每篇文档的 env 上,保证多文档渲染互不干扰
  md.use(anchor, {
    slugifyWithState: (text: string, state: { env: unknown }) => getSlugDedup(state.env as RenderEnv)(text),
    permalink: false,
  });
  md.use(footnote);
  md.use(taskLists, { enabled: true, label: true, labelAfter: true });
  md.use(container, 'warning', {
    render(tokens: Token[], idx: number) {
      if (tokens[idx].nesting === 1) return '<div class="callout callout-warning"><div class="callout-title">⚠ 警告</div>\n';
      return '</div>\n';
    },
  });
  md.use(container, 'tip', {
    render(tokens: Token[], idx: number) {
      if (tokens[idx].nesting === 1) return '<div class="callout callout-tip"><div class="callout-title">💡 技巧</div>\n';
      return '</div>\n';
    },
  });

  // 代码围栏 → 占位,交由视口增强(Shiki 懒高亮)
  md.renderer.rules.fence = (tokens, idx, _options, env) => {
    const token = tokens[idx];
    const lang = (token.info || '').trim().split(/\s+/)[0] || 'text';
    if (lang === 'mermaid' || lang === 'mmd') {
      const e = env as RenderEnv;
      const mid = e.mermaidCount++;
      e.mermaidSources[mid] = token.content;
      return `<div class="mermaid-block" data-mid="${mid}"></div>\n`;
    }
    return `<pre class="code-block" data-lang="${escapeHtml(lang)}"><code>${escapeHtml(token.content)}</code></pre>\n`;
  };

  return md;
}

const md = buildMd();

/* ---------------- 渲染入口 ---------------- */

export function renderMarkdown(source: string): RenderedDoc {
  const env: RenderEnv = { mermaidSources: {}, mermaidCount: 0 };
  const tokens = md.parse(source, env);
  const html = md.renderer.render(tokens, md.options, env);

  // 挂到全局供 mermaid.ts 懒加载取用
  window.__windmdMermaid = env.mermaidSources;

  // 从token 流收集标题大纲(与 markdown-it-anchor 生成的 id 一致)
  const headings: Heading[] = [];
  let current: { level: number; id: string } | null = null;
  let textBuf: string[] = [];
  const flush = () => {
    if (current) {
      headings.push({ level: current.level, id: current.id, text: textBuf.join('').trim() });
      textBuf = [];
      current = null;
    }
  };
  for (const t of tokens) {
    if (t.type === 'heading_open') {
      flush();
      current = { level: Number(t.tag.slice(1)), id: (t.attrGet('id') as string) ?? '' };
    } else if (t.type === 'heading_close') {
      flush();
    } else if (current && t.type === 'inline') {
      // inline.content 是 Markdown 源码,直接用会让目录显示 `**加粗**`;
      // 取子 token 的纯文本,图片等无文本节点由 alt 补充。
      if (t.children) {
        for (const child of t.children) {
          if (child.type === 'text' || child.type === 'code_inline') {
            textBuf.push(child.content);
          } else if (child.type === 'image') {
            textBuf.push(child.attrGet('alt') ?? '');
          } else if (child.type === 'math_inline') {
            textBuf.push(child.content);
          } else if (child.type === 'wiki_link') {
            textBuf.push(child.content);
          }
        }
      } else {
        textBuf.push(t.content);
      }
    }
  }
  flush();

  return { html, headings };
}

export { slugify };
