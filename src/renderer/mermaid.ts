/**
 * Mermaid 懒加载(仅在图表进入视口时动态 import 渲染)。
 */

import { errMsg } from '../ipc/errors';

type MermaidApi = typeof import('mermaid').default;

// markdown.ts 渲染时把 mermaid 源码挂到 window.__windmdMermaid,按 data-mid 取用
declare global {
  interface Window {
    __windmdMermaid?: Record<number, string>;
  }
}

/** 主题切换需重新 initialize,故按主题各缓存一个实例 */
const instances = new Map<string, Promise<MermaidApi>>();

function loadMermaid(theme: 'default' | 'dark'): Promise<MermaidApi> {
  let p = instances.get(theme);
  if (!p) {
    p = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        theme,
        securityLevel: 'strict',
      });
      return mermaid;
    });
    instances.set(theme, p);
  }
  return p;
}

export async function renderMermaid(mid: number, dark: boolean): Promise<string> {
  const source = window.__windmdMermaid?.[mid];
  if (!source) return `<p class="mermaid-error">图表源码缺失(#${mid})</p>`;
  try {
    const mermaid = await loadMermaid(dark ? 'dark' : 'default');
    const { svg } = await mermaid.render(`mmd-${mid}-${Math.random().toString(36).slice(2, 8)}`, source);
    return svg;
  } catch (e) {
    return `<pre class="mermaid-error">图表渲染失败:\n${errMsg(e)}</pre>`;
  }
}