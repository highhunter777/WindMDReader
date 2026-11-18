/**
 * Shiki 代码高亮(视口内懒渲染 + LRU 缓存)。
 *
 * 使用 JavaScript 正则引擎而非默认的 Oniguruma WASM:打包后的 Tauri 页面带
 * 严格 CSP,WebView2 会拒绝编译 WASM,默认引擎会让所有代码块退化为纯文本。
 *
 * 计算跑在 Web Worker 里(`highlight.worker.ts`):
 * Shiki 首次 tokenize 某种语言要编译 TextMate 语法,实测 cpp 约 900ms。
 * 这一步是**同步**的,放在主线程上就是"滚到某个代码块就卡住几秒"。
 * 移到 Worker 后主线程全程可响应,只是该代码块晚一点着色。
 *
 * 为什么这里不再保留同线程回退实现:
 * Worker 与主线程是两套独立的打包单元,各自 import shiki 会得到**两份**
 * 语言包与 core(实测重复 ~2MB)。回退分支只在 module worker 不可用时才走,
 * 而本项目目标环境是 WebView2/WKWebView/WebKitGTK,均支持 module worker。
 * 因此这里改为:Worker 不可用就让代码块保持已渲染的原始文本
 * (内容完整可读、可复制、可查找),把 2MB 体积省下来。
 */
import type { ThemeName } from './highlight.types';

export type { ThemeName };

/** 界面支持的代码语言,键与 worker 的 LANG_LOADERS 一一对应 */
const LANGS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'python', 'rust', 'bash', 'shell', 'json', 'yaml', 'toml',
  'sql', 'html', 'css', 'scss', 'md', 'markdown', 'go', 'java', 'c', 'cpp', 'csharp', 'diff',
]);

/** 已知语言原样保留,其余一律按纯文本处理 */
const normLang = (lang: string) => (LANGS.has(lang) ? lang : 'text');

/* ---------------- Worker 通道 ---------------- */

interface Pending {
  resolve(html: string): void;
  reject(err: unknown): void;
}

let worker: Worker | null = null;
let workerFailed = false;
let seq = 0;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (worker || workerFailed) return worker;
  try {
    worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    workerFailed = true; // 不支持 module worker:代码块保持原文
    return null;
  }
  worker.onmessage = (e: MessageEvent<{ id: number; html?: string; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.error) p.reject(new Error(e.data.error));
    else p.resolve(e.data.html ?? '');
  };
  worker.onerror = () => {
    // Worker 崩了:让在途请求失败,后续请求直接保留原文(不阻塞渲染)
    workerFailed = true;
    worker?.terminate();
    worker = null;
    for (const [, p] of pending) p.reject(new Error('高亮 Worker 异常'));
    pending.clear();
  };
  return worker;
}

function highlightInWorker(code: string, lang: string, theme: ThemeName): Promise<string> {
  const w = getWorker();
  if (!w) return Promise.reject(new Error('no worker'));
  const id = ++seq;
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, code, lang, theme });
  });
}

/** 空闲时预热 Worker(启动时就把高亮线程拉起,首次滚到代码块无需等待) */
export function preloadHighlight(): void {
  getWorker();
}

/* ---------------- LRU 缓存(上限 200 条) ---------------- */

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

/**
 * 高亮一段代码。
 *
 * 返回 `null` 表示无法高亮(Worker 不可用/出错),调用方保留原始文本即可 ——
 * 内容不丢,只是没有语法着色。
 */
export async function highlightCode(
  code: string,
  lang: string,
  theme: ThemeName,
): Promise<string | null> {
  const target = normLang(lang);
  const key = `${theme}|${target}|${code}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  try {
    const html = await highlightInWorker(code, target, theme);
    cacheSet(key, html);
    return html;
  } catch {
    return null;
  }
}
