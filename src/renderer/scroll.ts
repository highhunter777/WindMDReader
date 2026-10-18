/**
 * 阅读进度 ↔ 滚动位置的换算。
 * 进度按「可滚动距离的比例」存储(0~1),与窗口大小、字号无关,
 * 缩放或换设备后恢复位置依然成立。
 * 抽成纯函数便于单测(Viewer 的 DOM 副作用难以在 jsdom 中断言)。
 */

/** 当前滚动位置 → 进度(0~1)。不可滚动时返回 0。 */
export function computeProgress(scrollY: number, scrollHeight: number, viewportH: number): number {
  const total = scrollHeight - viewportH;
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, scrollY / total));
}

/** 进度(0~1) → 目标滚动位置。内容短于视口时返回 0。 */
export function scrollTopForProgress(progress: number, scrollHeight: number, viewportH: number): number {
  const total = scrollHeight - viewportH;
  if (total <= 0) return 0;
  const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  return p * total;
}

/** 一篇文档的滚动位置记忆:像素位置(会话内精确恢复)+ 进度百分比(落库用) */
export interface DocScrollPos {
  y: number;
  p: number;
}

/**
 * 正文滚动容器。
 * 布局上 `.main` 才是 `overflow-y: auto` 的滚动区,**窗口本身不滚动** ——
 * `window.scrollY` 恒为 0、`window.scrollTo` 是空操作、window 的 scroll
 * 事件永不触发。所有滚动读写都必须经过这个元素。
 */
export function scrollContainer(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.main');
}

/** 立即设置滚动位置(避开 `.main` 的 `scroll-behavior: smooth` 动画) */
export function setScrollTop(el: HTMLElement, top: number): void {
  const prev = el.style.scrollBehavior;
  el.style.scrollBehavior = 'auto';
  el.scrollTop = top;
  el.style.scrollBehavior = prev;
}

/** 滚动容器当前进度(0~1) */
export function containerProgress(el: HTMLElement): number {
  return computeProgress(el.scrollTop, el.scrollHeight, el.clientHeight);
}

/**
 * 决定打开一篇文档时的滚动目标(像素)。
 * - 会话内切回:用该篇自己记下的像素位置,精确回到原处;
 * - 首次打开(含重启后首篇):用库里保存的进度百分比换算。
 *
 * 注意不能在「切文档的 cleanup」里读 DOM 换算进度 —— 那时 DOM 已换成
 * 新文档,scrollHeight 是新文档的,算出的百分比会错(实测表现为
 * "回到原篇却不在原位置")。位置必须在滚动时就算好。
 */
export function restoreTopFor(
  remembered: DocScrollPos | undefined,
  dbProgress: number,
  scrollHeight: number,
  viewportH: number,
): number {
  if (remembered) return remembered.y;
  return scrollTopForProgress(dbProgress, scrollHeight, viewportH);
}
