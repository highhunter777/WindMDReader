/**
 * 代码高亮 Worker。
 *
 * 为什么单独跑在 Worker 里:
 * Shiki 首次对某种语言做 tokenize 要编译 TextMate 语法,实测 cpp 约 900ms。
 * 这一步是**同步**的,放在主线程上就是整段界面卡住 ——
 * 表现为"滚到某个代码块就没响应,过了几秒又好"。
 * 移到 Worker 后主线程全程可响应,只是该代码块晚一点着色。
 *
 * 语言为什么用显式映射而不是 `import('shiki/langs')` 动态索引:
 * 后者会把**全部 332 种语言**的注册表拉进产物(实测 dist 从 15MB 涨到 24MB、
 * 安装包多 1MB,且每个语言 chunk 出现两份)。这里只声明界面支持的 24 种,
 * 每种是一个独立 chunk,真正用到哪个才下载哪个。
 */
import type { HighlighterCore, ThemeInput, LanguageInput } from 'shiki/core';
import type { ThemeName } from './highlight.types';

/** 主题与主线程共用同一份定义(见 highlight.types.ts) */
export type WorkerTheme = ThemeName;

/**
 * 支持的语言 → 加载器。
 * 键必须与 `highlight.ts` 的 LANGS 一致;不在此表内的语言退化为纯文本。
 */
const LANG_LOADERS: Record<string, () => Promise<{ default: LanguageInput }>> = {
  ts: () => import('@shikijs/langs/ts'),
  tsx: () => import('@shikijs/langs/tsx'),
  js: () => import('@shikijs/langs/js'),
  jsx: () => import('@shikijs/langs/jsx'),
  python: () => import('@shikijs/langs/python'),
  rust: () => import('@shikijs/langs/rust'),
  bash: () => import('@shikijs/langs/bash'),
  shell: () => import('@shikijs/langs/shell'),
  json: () => import('@shikijs/langs/json'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  sql: () => import('@shikijs/langs/sql'),
  html: () => import('@shikijs/langs/html'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  md: () => import('@shikijs/langs/md'),
  markdown: () => import('@shikijs/langs/markdown'),
  go: () => import('@shikijs/langs/go'),
  java: () => import('@shikijs/langs/java'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  diff: () => import('@shikijs/langs/diff'),
};

interface Req {
  id: number;
  code: string;
  lang: string;
  theme: WorkerTheme;
}

interface Res {
  id: number;
  html?: string;
  error?: string;
}

let corePromise: Promise<HighlighterCore> | null = null;
/** 已加载的语言,避免重复 loadLanguage */
const loaded = new Set<string>();
/** 串行化语言加载,防止并发请求重复编译同一份语法 */
let queue: Promise<void> = Promise.resolve();

async function getCore(): Promise<HighlighterCore> {
  corePromise ??= (async () => {
    const [core, engine, themes] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('@shikijs/themes/github-light'),
    ]);
    // 深色主题单独取,避免把整套主题集合拉进产物
    const dark = await import('@shikijs/themes/github-dark');
    const themeList = [themes.default, dark.default] as ThemeInput[];
    return core.createHighlighterCore({
      themes: themeList,
      langs: [],
      engine: engine.createJavaScriptRegexEngine(),
    });
  })();
  return corePromise;
}

/** 确保某语言已加载;不支持的语言返回 false(调用方退化为纯文本) */
async function ensureLang(lang: string): Promise<boolean> {
  if (loaded.has(lang)) return true;
  const loader = LANG_LOADERS[lang];
  if (!loader) return false;
  const h = await getCore();
  // 同一语言被并发请求时只编译一次
  queue = queue.then(async () => {
    if (loaded.has(lang)) return;
    const mod = await loader();
    await h.loadLanguage(mod.default);
    loaded.add(lang);
  });
  await queue;
  return true;
}

/**
 * 渲染一段代码为高亮 HTML。
 *
 * 独立导出而非内联在 onmessage 里:Worker 无法在测试环境(jsdom)中运行,
 * 把逻辑抽出来后测试可以直接调用它,覆盖真实的着色/退化行为。
 */
export async function renderHighlight(
  code: string,
  lang: string,
  theme: WorkerTheme,
): Promise<string> {
  const h = await getCore();
  // text 与不支持的语言都走纯文本分支,与主线程规则一致
  const ok = lang === 'text' || (await ensureLang(lang));
  const target = ok ? lang : 'text';
  return h.codeToHtml(code, { lang: target, theme });
}

/** Worker 消息入口(仅在真实 Worker 环境注册) */
if (typeof self !== 'undefined' && typeof (self as unknown as Worker).postMessage === 'function') {
  self.onmessage = async (e: MessageEvent<Req>) => {
    const { id, code, lang, theme } = e.data;
    const reply = (r: Omit<Res, 'id'>) =>
      (self as unknown as Worker).postMessage({ id, ...r });
    try {
      reply({ html: await renderHighlight(code, lang, theme) });
    } catch (err) {
      reply({ error: err instanceof Error ? err.message : String(err) });
    }
  };
}
