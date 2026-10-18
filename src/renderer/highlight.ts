/**
 * Shiki 代码高亮(视口内懒渲染 + LRU 缓存)。
 * shiki 与其语言/主题包体积较大且只在视口内渲染,故动态 import。
 */
import type { Highlighter } from 'shiki';

const LANGS = [
  'ts', 'tsx', 'js', 'jsx', 'python', 'rust', 'bash', 'shell', 'json', 'yaml', 'toml',
  'sql', 'html', 'css', 'scss', 'md', 'markdown', 'go', 'java', 'c', 'cpp', 'csharp', 'diff', 'text',
];

export type ThemeName = 'github-light' | 'github-dark';

let highlighter: Highlighter | null = null;
let loading: Promise<Highlighter> | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (highlighter) return highlighter;
  if (!loading) {
    loading = import('shiki')
      .then(({ createHighlighter }) =>
        createHighlighter({
          themes: ['github-light', 'github-dark'],
          langs: LANGS,
        }),
      )
      .then((h) => (highlighter = h));
  }
  return loading;
}

/** 空闲时预取 shiki,避免首次滚动到代码块时等待 */
export function preloadHighlight(): void {
  void getHighlighter();
}

/* --- LRU 缓存(上限 200 条) --- */

const CACHE_MAX = 200;
const cache = new Map<string, string>();

function cacheGet(key: string): string | undefined {
  const v = cache.get(key);
  if (v) {
    cache.delete(key);
    cache.set(key, v);
  }
  return v;
}
function cacheSet(key: string, value: string) {
  if (cache.has(key)) return;
  cache.set(key, value);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export async function highlightCode(code: string, lang: string, theme: ThemeName): Promise<string> {
  const normLang = LANGS.includes(lang) ? lang : 'text';
  const key = `${theme}|${normLang}|${code}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const h = await getHighlighter();
  const html = h.codeToHtml(code, { lang: normLang, theme });
  cacheSet(key, html);
  return html;
}
