/**
 * 正文阅读区:
 * - 挂载渲染结果并启动视口懒增强
 * - TOC 滚动高亮(当前活跃标题)
 * - 阅读进度上报(节流)
 * - 滚动位置记忆 / 恢复
 */
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { renderMarkdown } from '../renderer/markdown';
import { mountRendered, scrollToHeading } from '../renderer/enhance';
import { mountFocus } from '../renderer/focus';
import { applyFind } from '../renderer/find';
import { containerProgress, restoreTopFor, scrollContainer, setScrollTop } from '../renderer/scroll';
import type { DocScrollPos } from '../renderer/scroll';
import { getBackend } from '../ipc';
import type { ThemeName } from '../renderer/highlight';
import { Welcome } from './Welcome';

/**
 * 划词翻译气泡懒加载:它连带词典数据(约 1500 条)与翻译引擎,
 * 只在真的划词时才用得上 —— 静态引入会把词典压进首屏。
 */
const TranslateBubble = lazy(() => import('./TranslateBubble'));

export function Viewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const content = useStore((s) => s.content);
  const activePath = useStore((s) => s.activePath);
  const theme = useStore((s) => s.theme);
  const zen = useStore((s) => s.zen);
  const fontSize = useStore((s) => s.fontSize);
  const readingWidth = useStore((s) => s.readingWidth);
  const fontFamily = useStore((s) => s.fontFamily);
  const findOpen = useStore((s) => s.findOpen);
  const findQuery = useStore((s) => s.findQuery);
  const focusLine = useStore((s) => s.focusLine);
  const typewriter = useStore((s) => s.typewriter);
  const setHeadings = useStore((s) => s.setHeadings);
  const setRenderMs = useStore((s) => s.setRenderMs);

  /* --- 渲染 --- */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const t0 = performance.now();
    const { html, headings } = renderMarkdown(content);
    setRenderMs(Math.round(performance.now() - t0));
    setHeadings(headings);
    // 恢复滚动位置:会话内切回的文档用它自己记下的像素位置(精确);
    // 首次打开(含重启后)用库里保存的进度百分比。
    // 注意滚动容器是 `.main`(窗口本身不滚动),必须读写该元素。
    const scroller = scrollContainer();
    const remembered = activePath ? positions.current.get(activePath) : undefined;
    const dbProgress = useStore.getState().meta?.readProgress ?? 0;
    const target = () => {
      if (!scroller) return 0;
      return restoreTopFor(remembered, dbProgress, scroller.scrollHeight, scroller.clientHeight);
    };
    // 清洗是异步的(DOMPurify 动态加载):滚动恢复必须放进 onMounted,
    // 早于 innerHTML 读 scrollHeight 会拿到旧文档的高度,恢复位置全错。
    let timer = 0;
    const cleanup = mountRendered(el, html, themeToShiki(theme), () => {
      if (scroller) setScrollTop(scroller, target());
      if (scroller && target() > 0) {
        // 图片等懒加载内容到位后文档变高,恢复点会偏移,短暂窗口内再校正一次
        // (切回的记忆位置是固定像素;首次打开则按新高重新百分比换算)
        let lastSet = scroller.scrollTop;
        const apply = () => {
          // 已有其他滚动发生(如文档内查找跳转)则不再纠正,避免把用户拽走
          if (Math.abs(scroller.scrollTop - lastSet) > 2) return;
          setScrollTop(scroller, target());
          lastSet = scroller.scrollTop;
        };
        requestAnimationFrame(apply);
        timer = window.setTimeout(apply, 300);
      }
    });
    return () => {
      cleanup();
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, activePath]);

  /* --- 主题切换时重挂载(代码高亮/公式需按主题重渲染) --- */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const { html } = renderMarkdown(content);
    const cleanup = mountRendered(el, html, themeToShiki(theme));
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  /* --- 焦点行 / 打字机模式 ---
     常驻监听;开关变化时重挂一次,让新模式立刻定位当前块
     (仅靠滚动事件的话,开启的瞬间没有事件,焦点块会缺一帧)。 */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    return mountFocus({
      container: el,
      getMode: () => {
        const s = useStore.getState();
        return { focus: s.focusLine, typewriter: s.typewriter };
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, activePath, focusLine, typewriter]);

  /* --- TOC 滚动高亮 --- */
  const activeId = useRef<string | null>(null);
  /** 每篇文档各自的滚动位置(会话内精确恢复;百分比同步落库供重启后用) */
  const positions = useRef<Map<string, DocScrollPos>>(new Map());
  useEffect(() => {
    const headings = useStore.getState().headings;
    if (!headings.length) return;
    const els = headings
      .map((h) => document.getElementById(h.id))
      .filter((e): e is HTMLElement => !!e);
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            activeId.current = e.target.id;
            document.dispatchEvent(new CustomEvent('windmd:active-heading', { detail: e.target.id }));
          }
        }
      },
      { rootMargin: '-10% 0px -80% 0px' },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [content, activePath]);

  /* --- 滚动位置记录 + 进度落库(节流) ---
     独立于 TOC effect:无标题的文档同样要记位置。 */
  const lastReport = useRef(0);
  useEffect(() => {
    const scroller = scrollContainer();
    if (!scroller || !activePath) return;
    const onScroll = () => {
      // 滚动时就地记下该篇的位置:像素(会话内恢复)+ 百分比(落库)。
      // 不能在切文档的 cleanup 里补算 —— 那时 DOM 已是新文档,高度不对。
      positions.current.set(activePath, {
        y: scroller.scrollTop,
        p: containerProgress(scroller),
      });
      const now = Date.now();
      if (now - lastReport.current > 1500) {
        lastReport.current = now;
        void getBackend()
          .then((b) => b.setMeta(activePath, { readProgress: containerProgress(scroller) }))
          .catch(() => {});
      }
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [activePath]);

  /* --- 切换文档/卸载时把最后位置落库 --- */
  useEffect(() => {
    const path = activePath;
    return () => {
      if (!path) return;
      // 用滚动时记下的百分比:cleanup 运行时 DOM 已换成新文档,
      // 此时读 scrollHeight 会按新文档的高度算出错误进度。
      const pos = positions.current.get(path);
      if (!pos || pos.p <= 0) return;
      void getBackend()
        .then((b) => b.setMeta(path, { readProgress: pos.p }))
        .catch(() => {});
    };
  }, [activePath]);

  /* --- 文档内查找:高亮 + 跳转 --- */
  const setFindState = useStore((s) => s.setFindState);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const q = findOpen ? findQuery : '';
    const session = q ? applyFind(el, q) : null;
    if (!session || session.hits.length === 0) {
      setFindState(0, 0);
      return () => session?.cleanup();
    }

    const focus = (index: number) => {
      el.querySelector('.find-current')?.classList.remove('find-current');
      const target = session.hits[index];
      if (!target) return;
      target.classList.add('find-current');
      scrollToHeading(target);
      setFindState(session.hits.length, index);
    };

    focus(0);

    const onGoto = (e: Event) => {
      const { index } = (e as CustomEvent<{ index: number }>).detail;
      focus(index);
    };
    document.addEventListener('windmd:find-goto', onGoto);

    return () => {
      document.removeEventListener('windmd:find-goto', onGoto);
      session.cleanup();
    };
  }, [findOpen, findQuery, content, setFindState]);

  /* --- 双链点击:分发目标名(解析/创建由下方 effect 处理)--- */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest('.wiki-link');
      if (!a) return;
      e.preventDefault();
      const target = a.getAttribute('data-wiki');
      if (target) {
        document.dispatchEvent(new CustomEvent('windmd:wiki-open', { detail: target }));
      }
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [content, activePath]);

  /* --- 朗读:把正文容器交给朗读器 ---
     正文重渲染(切文档/重新挂载)后句表需要重建,期间正在进行的朗读会停止。
     动态引入:朗读器只在用户真的要读时才用得上,不必进首屏。 */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let reader: { attach(c: HTMLElement | null): void } | null = null;
    let disposed = false;
    void import('../renderer/reader').then((m) => {
      if (disposed) return;
      reader = m.getReader();
      reader.attach(el);
    });
    return () => {
      disposed = true;
      reader?.attach(null);
    };
  }, [content, activePath]);

  /* --- 打开双链目标:已存在则跳转,未创建则在库根新建 --- */
  useEffect(() => {
    const onOpen = async (e: Event) => {
      const target = (e as CustomEvent<string>).detail;
      const activePath = useStore.getState().activePath;
      if (!activePath) return;
      try {
        const b = await getBackend();
        const links = await b.getLinks(activePath);
        const hit = links.outgoing.find((o) => o.target === target);
        if (hit?.resolvedPath) {
          const f = await b.readFile(hit.resolvedPath);
          const meta = await b.getMeta(hit.resolvedPath);
          useStore.getState().openDoc(f.path, f.content, meta);
          return;
        }
        const path = /\.(md|markdown|txt)$/i.test(target) ? target : `${target}.md`;
        await b.createFile(path);
        const f = await b.readFile(path);
        const meta = await b.getMeta(path);
        useStore.getState().openDoc(f.path, f.content, meta);
      } catch (err) {
        console.error(err);
      }
    };
    document.addEventListener('windmd:wiki-open', onOpen);
    return () => document.removeEventListener('windmd:wiki-open', onOpen);
  }, []);

  /* --- 划词翻译:正文内选出非空文本 → 浮现翻译气泡 --- */
  const [selection, setSelection] = useState<{ text: string; x: number; y: number } | null>(null);
  useEffect(() => {
    /** 读当前选区并决定是否弹气泡(mouseup / keyup 共用) */
    const updateFromSelection = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setSelection(null);
        return;
      }
      const text = sel.toString().trim();
      const node = sel.anchorNode;
      const el = node?.nodeType === 1 ? (node as HTMLElement) : node?.parentElement;
      // 仅正文内、非代码块、长度受限的选区才触发
      if (!text || text.length > 500 || !el?.closest('.prose') || el.closest('pre, code')) {
        setSelection(null);
        return;
      }
      const r = sel.getRangeAt(0).getBoundingClientRect();
      setSelection({ text, x: r.left + r.width / 2, y: r.bottom });
    };
    const onUp = (e: MouseEvent) => {
      // 点在气泡内部不处理(气泡自己拦截 mousedown 防默认)
      if ((e.target as HTMLElement | null)?.closest?.('.translate-bubble')) return;
      updateFromSelection();
    };
    document.addEventListener('mouseup', onUp);
    // 键盘选区(Shift+方向键 / Ctrl+A 等)同样触发:选择变化即求值
    document.addEventListener('keyup', updateFromSelection);
    // 滚动即选区离位,气泡失去参照(捕获阶段监听:scroll 不冒泡)
    const onScroll = () => setSelection(null);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('keyup', updateFromSelection);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, []);

  /* 空闲时预取翻译气泡 chunk(含词典),首次划词即刻可用 */
  useEffect(() => {
    const idle =
      typeof requestIdleCallback === 'function'
        ? requestIdleCallback
        : (cb: () => void) => window.setTimeout(cb, 200);
    idle(() => void import('./TranslateBubble'));
    return () => undefined;
  }, []);

  /* 无文档打开(未开库 / 空库 / 删掉了当前篇):展示欢迎页引导下一步 */
  if (!activePath) {
    return (
      <div className={`viewer ${zen ? 'zen' : ''}`}>
        <Welcome />
      </div>
    );
  }

  return (
    <div className={`viewer ${zen ? 'zen' : ''}`} data-font={fontFamily}>
      <article
        ref={containerRef}
        className="prose"
        data-focus={focusLine ? 'on' : undefined}
        data-typewriter={typewriter ? 'on' : undefined}
        style={{
          fontSize: `${fontSize}px`,
          maxWidth: `${readingWidth}px`,
        }}
      />
      {selection && (
        <Suspense fallback={null}>
          <TranslateBubble
            text={selection.text}
            x={selection.x}
            y={selection.y}
            onClose={() => setSelection(null)}
          />
        </Suspense>
      )}
    </div>
  );
}

function themeToShiki(theme: 'light' | 'dark'): ThemeName {
  return theme === 'dark' ? 'github-dark' : 'github-light';
}
