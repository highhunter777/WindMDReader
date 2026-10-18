/**
 * 图片灯箱:点击正文图片全屏预览,支持缩放、旋转、左右切换。
 * 由 enhance.ts 在图片点击时派发 `windmd:lightbox-open` 事件触发。
 */
import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, RotateCw, X, ZoomIn, ZoomOut } from 'lucide-react';

interface LightboxState {
  src: string;
  alt: string;
}

export function Lightbox() {
  const [state, setState] = useState<LightboxState | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rotate, setRotate] = useState(0);

  /* 图集直接从 DOM 现取,避免把「收集列表」塞进异步 state
     导致切换时闭包捕获到空数组。
     用 getAttribute 而非 currentSrc/jsdom 未实现 currentSrc,
     且属性值与 enhance 派发的 detail.src 保持同一形态,便于比对 */
  const readGallery = useCallback(
    () =>
      Array.from(document.querySelectorAll<HTMLImageElement>('.prose img'))
        .filter((i) => !i.classList.contains('img-error'))
        .map((i) => i.getAttribute('src') ?? '')
        .filter(Boolean),
    [],
  );

  /* 由 enhance.ts 在图片点击时派发 */
  useEffect(() => {
    const onOpen = (e: Event) => {
      setState((e as CustomEvent<LightboxState>).detail);
      setZoom(1);
      setRotate(0);
    };
    document.addEventListener('windmd:lightbox-open', onOpen);
    return () => document.removeEventListener('windmd:lightbox-open', onOpen);
  }, []);

  const close = useCallback(() => {
    setState(null);
    setZoom(1);
    setRotate(0);
  }, []);

  const step = useCallback(
    (dir: 1 | -1) => {
      setState((cur) => {
        if (!cur) return cur;
        const gallery = readGallery();
        if (gallery.length < 2) return cur;
        const i = gallery.indexOf(cur.src);
        // 当前图不在图集中(理论上不会发生),保守不动
        if (i === -1) return cur;
        const next = (i + dir + gallery.length) % gallery.length;
        return { src: gallery[next], alt: cur.alt };
      });
      setZoom(1);
      setRotate(0);
    },
    [readGallery],
  );

  /* 键盘操作与滚动锁定 */
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          close();
          break;
        case 'ArrowRight':
        case 'j':
          e.preventDefault();
          step(1);
          break;
        case 'ArrowLeft':
        case 'k':
          e.preventDefault();
          step(-1);
          break;
        case '+':
        case '=':
          e.preventDefault();
          setZoom((z) => Math.min(4, z + 0.25));
          break;
        case '-':
          e.preventDefault();
          setZoom((z) => Math.max(0.25, z - 0.25));
          break;
        case '0':
          setZoom(1);
          setRotate(0);
          break;
        case 'r':
          setRotate((r) => (r + 90) % 360);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [state, close, step]);

  if (!state) return null;

  const canSwitch = readGallery().length > 1;

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="图片预览" onClick={close}>
      <button className="lightbox-close icon-btn" title="关闭 (Esc)" onClick={close}>
        <X size={18} />
      </button>

      {canSwitch && (
        <>
          <button
            className="lightbox-nav lightbox-prev icon-btn"
            title="上一张 (←)"
            onClick={(e) => {
              e.stopPropagation();
              step(-1);
            }}
          >
            <ChevronLeft size={22} />
          </button>
          <button
            className="lightbox-nav lightbox-next icon-btn"
            title="下一张 (→)"
            onClick={(e) => {
              e.stopPropagation();
              step(1);
            }}
          >
            <ChevronRight size={22} />
          </button>
        </>
      )}

      <figure className="lightbox-figure" onClick={(e) => e.stopPropagation()}>
        <img
          src={state.src}
          alt={state.alt}
          style={{ transform: `scale(${zoom}) rotate(${rotate}deg)` }}
        />
        {state.alt && <figcaption>{state.alt}</figcaption>}
      </figure>

      <div className="lightbox-toolbar" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" title="缩小 (-)" onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}>
          <ZoomOut size={16} />
        </button>
        <span className="lightbox-zoom">{Math.round(zoom * 100)}%</span>
        <button className="icon-btn" title="放大 (+)" onClick={() => setZoom((z) => Math.min(4, z + 0.25))}>
          <ZoomIn size={16} />
        </button>
        <button className="icon-btn" title="旋转 (r)" onClick={() => setRotate((r) => (r + 90) % 360)}>
          <RotateCw size={16} />
        </button>
        <button className="icon-btn" title="复位 (0)" onClick={() => { setZoom(1); setRotate(0); }}>
          1:1
        </button>
      </div>
    </div>
  );
}