/**
 * 视口增强:DOMPurify 清洗 + IntersectionObserver 懒渲染
 * (Shiki 代码高亮 / KaTeX 公式 / Mermaid 图表)。
 */
import { highlightCode, preloadHighlight, type ThemeName } from './highlight';
import { preloadMath, renderMath } from './math';
import { renderMermaid } from './mermaid';
import { scrollContainer } from './scroll';

declare global {
  interface Window {
    __windmdMermaid?: Record<number, string>;
  }
}

/**
 * DOMPurify 按需加载(约 28KB):唯一使用点是挂载前的清洗,静态引入会把
 * 整包压进 entry chunk。改为 `import()` + 模块级缓存,启动时
 * `preloadSanitizer()` 即并行下载,首篇文档渲染时通常已命中缓存。
 */
let sanitizerPromise: Promise<typeof import('dompurify')> | null = null;

function loadSanitizer(): Promise<typeof import('dompurify')> {
  if (!sanitizerPromise) {
    sanitizerPromise = import('dompurify').catch((e) => {
      sanitizerPromise = null; // 失败不缓存,保留重试机会
      throw e;
    });
  }
  return sanitizerPromise;
}

/** 启动预热:与 preloadHighlight / preloadMath 并列,尽早并行下载 */
export function preloadSanitizer(): void {
  void loadSanitizer().catch(() => {});
}

export const sanitizeHtml = async (html: string): Promise<string> => {
  const mod = await loadSanitizer();
  return mod.default.sanitize(html, {
    ADD_ATTR: ['data-tex', 'data-mid', 'data-lang', 'target'],
    ADD_TAGS: ['math-inline'], // 自定义标签仅作为定位符,内部无用户内容
  });
};

/**
 * 挂载渲染结果到容器,并启动懒渲染。
 * 返回清理函数(供组件卸载/切换时调用)。
 *
 * 清洗异步化后挂载分两步,竞态由 `cancelled` 保证:
 * ① `await sanitizeHtml` —— 期间若 cleanup 已执行(快速切文档/切主题),
 *    直接放弃,**旧内容绝不会覆盖新内容**;await 按调用顺序 FIFO 唤醒,
 *    因此写入顺序即挂载顺序,两个方向都安全;
 * ② innerHTML 写入 + 同步接线(IntersectionObserver / 图片 / 锚点),
 *    全部同步完成,最后调 `onMounted`(供调用方在读 DOM 几何前挂载)。
 */
export function mountRendered(
  container: HTMLElement,
  html: string,
  theme: ThemeName,
  onMounted?: () => void,
): () => void {
  let cancelled = false;
  let io: IntersectionObserver | null = null;

  void (async () => {
    let clean: string;
    try {
      clean = await sanitizeHtml(html);
    } catch {
      // 清洗闸门失效时宁可显示错误也不挂未清洗内容(XSS 底线)
      if (!cancelled) {
        container.textContent = '安全清洗失败,已阻止本次渲染';
        container.classList.add('mount-error');
      }
      return;
    }
    if (cancelled) return;
    container.innerHTML = clean;
    container.classList.remove('mount-error');
    onMounted?.();

    // 空闲时预取体积较大的高亮/公式依赖,避免首次滚动到时才加载
    const idle =
      typeof requestIdleCallback === 'function'
        ? requestIdleCallback
        : (cb: () => void) => window.setTimeout(cb, 200);
    idle(() => {
      preloadHighlight();
      preloadMath();
      preloadSanitizer();
    });

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          observer.unobserve(el);
          void enhance(el, theme);
        }
      },
      { rootMargin: '300px 0px' },
    );
    io = observer;

    container.querySelectorAll<HTMLElement>('.code-block, .math-inline, .math-block, .mermaid-block').forEach((el) => {
      observer.observe(el);
    });

    // 图片:加载失败占位 + 点击打开灯箱
    container.querySelectorAll('img').forEach((img) => {
      img.addEventListener('error', () => {
        img.classList.add('img-error');
        img.alt = img.alt || '图片加载失败';
      });
      // 加载失败后已转为占位块,不再响应点击
      img.addEventListener('click', () => {
        if (img.classList.contains('img-error')) return;
        document.dispatchEvent(
          new CustomEvent('windmd:lightbox-open', {
            detail: { src: img.getAttribute('src') ?? '', alt: img.alt },
          }),
        );
      });
    });

    // 内部链接锚点偏移(吸顶工具栏)
    container.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((a) => {
      a.addEventListener('click', (e) => {
        const id = decodeURIComponent(a.getAttribute('href')!.slice(1));
        const target = container.querySelector(`#${CSS.escape(id)}`) as HTMLElement | null;
        if (target) {
          e.preventDefault();
          scrollToHeading(target);
        }
      });
    });

    void highlightVisibleOnly(container, theme);
  })();

  return () => {
    cancelled = true;
    io?.disconnect();
  };
}

/**
 * 导出前调用:把容器内**全部**待增强元素渲染完(不止视口内)。
 * 与 mountRendered 的懒渲染不同,这里不挂 IntersectionObserver,
 * 顺序处理保证导出内容完整;单块失败不影响其余。
 */
export async function enhanceAll(container: HTMLElement, theme: ThemeName): Promise<void> {
  const pending = container.querySelectorAll<HTMLElement>(
    '.code-block:not(.code-highlighted), .math-inline:not(.math-done), .math-block:not(.math-done), .mermaid-block:not(.mermaid-done)',
  );
  for (const el of Array.from(pending)) {
    await enhance(el, theme);
  }
}

/** 让某个标题平滑滚动到视野(导航用),考虑吸顶偏移 */
export function scrollToHeading(target: HTMLElement): void {
  const offset = 72; // 顶部工具栏高度
  const scroller = scrollContainer();
  if (!scroller) return;
  // 滚动容器是 `.main`(窗口本身不滚动),按容器内坐标换算
  const y = target.getBoundingClientRect().top + scroller.scrollTop - offset;
  scroller.scrollTo({ top: y, behavior: 'smooth' });
}

async function enhance(el: HTMLElement, theme: ThemeName): Promise<void> {
  if (el.classList.contains('code-block')) {
    const codeEl = el.querySelector('code');
    const lang = el.getAttribute('data-lang') ?? 'text';
    if (!codeEl) return;
    try {
      const html = await highlightCode(codeEl.textContent ?? '', lang, theme);
      el.innerHTML = html;
      el.classList.add('code-highlighted');
      addCopyButton(el, codeEl.textContent ?? '');
    } catch {
      /* 高亮失败保留原文本 */
    }
  } else if (el.classList.contains('math-inline')) {
    const tex = el.getAttribute('data-tex') ?? '';
    await renderMathInto(el, tex, false);
  } else if (el.classList.contains('math-block')) {
    const tex = el.getAttribute('data-tex') ?? '';
    await renderMathInto(el, tex, true);
  } else if (el.classList.contains('mermaid-block')) {
    const mid = Number(el.getAttribute('data-mid') ?? -1);
    el.innerHTML = await renderMermaid(mid, theme === 'github-dark');
    el.classList.add('mermaid-done');
  }
}

/** 渲染公式;katex 不可用时回退为原始 TeX 文本 */
async function renderMathInto(el: HTMLElement, tex: string, displayMode: boolean): Promise<void> {
  const html = await renderMath(tex, displayMode);
  if (html === null) {
    el.textContent = displayMode ? `$$${tex}$$` : `$${tex}$`;
  } else {
    el.innerHTML = html;
  }
  el.classList.add('math-done');
}

function addCopyButton(pre: HTMLElement, code: string): void {
  const btn = document.createElement('button');
  btn.className = 'code-copy';
  btn.textContent = '复制';
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      btn.textContent = '已复制 ✓';
      setTimeout(() => (btn.textContent = '复制'), 1500);
    } catch {
      btn.textContent = '失败';
    }
  });
  pre.appendChild(btn);
}

/** 首屏已可见的高亮元素立即处理(不等 IntersectionObserver 首帧回调) */
async function highlightVisibleOnly(container: HTMLElement, theme: ThemeName): Promise<void> {
  const pending = container.querySelectorAll<HTMLElement>('.code-block:not(.code-highlighted), .math-inline:not(.math-done), .math-block:not(.math-done), .mermaid-block:not(.mermaid-done)');
  for (const el of Array.from(pending).slice(0, 4)) {
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight && r.bottom > 0) {
      await enhance(el, theme);
    }
  }
}
