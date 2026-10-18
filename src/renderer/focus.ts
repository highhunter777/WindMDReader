/**
 * 焦点行(打字机)模式:
 * - 焦点行:除当前段落外全部淡出,视线只跟着一段走;
 * - 打字机:当前段落始终停在视口锚点行,像打字机一样逐段推着走。
 *
 * 两个纯函数(pickActiveBlock / typewriterTarget)承担全部判断逻辑,
 * 便于单测;DOM 副作用集中在 mountFocus。
 *
 * 注意滚动容器是 `.main`(窗口本身不滚动),所有读写都经过它;
 * 段落位置按「滚动内容坐标」缓存,滚动时二分查找,O(log n),
 * 图片到位导致 scrollHeight 变化时自动重算。
 */
import { scrollContainer } from './scroll';

/** 一个块在滚动内容坐标系里的范围 */
export interface BlockRect {
  top: number;
  bottom: number;
}

/** 视口锚点行比例(0=视口顶,1=视口底)。略偏上:读一段时视线在锚点下方 */
export const ANCHOR_RATIO = 0.38;

/** 段落比视口还高时,对齐到视口 20% 处(顶天立地的段落无法居中对齐) */
const TALL_BLOCK_RATIO = 0.2;

/** 小于该偏差不校正,避免平滑滚动过程中来回抖动 */
export const TYPEWRITER_EPSILON = 24;

/**
 * 选出锚点所在的块(锚点落在块间空隙时取中心最近的那个)。
 * blocks 须按 top 升序。返回 -1 表示没有块。
 */
export function pickActiveBlock(blocks: BlockRect[], anchorY: number): number {
  if (blocks.length === 0) return -1;
  // 二分:最后一个 top <= anchorY 的块
  let lo = 0;
  let hi = blocks.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].top <= anchorY) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (ans === -1) return 0; // 锚点在第一块之前(内容从视口中部开始)
  if (blocks[ans].bottom >= anchorY) return ans; // 锚点落在块内
  // 块间空隙:比较 ans 与后一块哪个中心更近(锚点必在两者中心之间)
  const next = ans + 1;
  if (next >= blocks.length) return ans;
  const distPrev = anchorY - (blocks[ans].top + blocks[ans].bottom) / 2;
  const distNext = (blocks[next].top + blocks[next].bottom) / 2 - anchorY;
  return distPrev <= distNext ? ans : next;
}

/**
 * 打字机模式:当前块应对齐到的滚动位置(滚动内容坐标系)。
 *
 * 对齐目标与选块用的是**同一条锚点线**(块中心 → 视口 anchorRatio 处):
 * 校正后锚点恰好落在块中心,同一块仍是活跃块,目标不再变化 ——
 * 任何块高下都收敛,不会在两块之间来回振荡。
 * 比视口还高的块退化为顶边对齐到视口 20% 处;结果钳制在可滚动范围内。
 */
export function typewriterTarget(
  block: BlockRect,
  viewportH: number,
  scrollHeight: number,
  anchorRatio: number = ANCHOR_RATIO,
): number {
  const height = block.bottom - block.top;
  const target =
    height < viewportH
      ? (block.top + block.bottom) / 2 - viewportH * anchorRatio
      : block.top - viewportH * TALL_BLOCK_RATIO;
  const max = Math.max(0, scrollHeight - viewportH);
  return Math.min(max, Math.max(0, target));
}

export interface FocusMode {
  /** 焦点行:淡出非当前块 */
  focus: boolean;
  /** 打字机:当前块对齐视口锚点行 */
  typewriter: boolean;
}

export interface MountFocusOptions {
  /** 正文容器(挂载了渲染结果的元素,.prose) */
  container: HTMLElement;
  /** 读取当前模式 —— 用 getter 而非快照,切换模式不必重挂 */
  getMode: () => FocusMode;
  /** 滚动容器(.main);默认现找 */
  scroller?: HTMLElement | null;
  /** 锚点比例,默认 ANCHOR_RATIO */
  anchorRatio?: number;
  /** 模式全关时是否保留监听(默认 true:随时可以再开) */
  keepListening?: boolean;
}

/** 打字机自动滚动进行中的冻结窗口:期间忽略滚动事件,等动画自然结束 */
const FREEZE_MS = 600;

/**
 * 挂载焦点行/打字机监听。返回清理函数。
 * 模式通过 getMode 动态读取,Store 里切换开关即时生效,无需重挂。
 */
export function mountFocus(opts: MountFocusOptions): () => void {
  const { container, getMode } = opts;
  const anchorRatio = opts.anchorRatio ?? ANCHOR_RATIO;
  let scroller: HTMLElement | null = opts.scroller ?? scrollContainer();

  let blocks: BlockRect[] = [];
  let measuredScrollHeight = -1;
  let activeIndex = -1;
  let frame = 0;
  let frozen = false;
  let freezeTimer = 0;

  /** 重新测量所有块的位置(滚动内容坐标系) */
  const measure = () => {
    if (!scroller) return;
    const scrollTop = scroller.scrollTop;
    blocks = Array.from(container.children).map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top + scrollTop, bottom: r.bottom + scrollTop };
    });
    measuredScrollHeight = scroller.scrollHeight;
  };

  const setActive = (idx: number) => {
    if (idx === activeIndex) return;
    if (activeIndex >= 0) container.children[activeIndex]?.classList.remove('focus-active');
    activeIndex = idx;
    if (idx >= 0) container.children[idx]?.classList.add('focus-active');
  };

  const apply = () => {
    frame = 0;
    if (!scroller) return;
    const mode = getMode();
    if (!mode.focus && !mode.typewriter) return;
    // 图片到位 / 代码块展开后 scrollHeight 变化 → 重算(取一次 scrollHeight 很便宜)
    if (scroller.scrollHeight !== measuredScrollHeight) measure();
    const anchorY = scroller.scrollTop + scroller.clientHeight * anchorRatio;
    const idx = pickActiveBlock(blocks, anchorY);
    setActive(idx);
    if (mode.typewriter && idx >= 0 && !frozen) {
      const target = typewriterTarget(blocks[idx], scroller.clientHeight, scroller.scrollHeight, anchorRatio);
      if (Math.abs(target - scroller.scrollTop) > TYPEWRITER_EPSILON) {
        frozen = true;
        window.clearTimeout(freezeTimer);
        freezeTimer = window.setTimeout(() => (frozen = false), FREEZE_MS);
        scroller.scrollTo({ top: target, behavior: 'smooth' });
      }
    }
  };

  const onScroll = () => {
    if (frame) return;
    frame = requestAnimationFrame(apply);
  };

  /** 用户主观意图(滚轮/触摸/按键)解除冻结,让打字机继续跟进 */
  const onUserIntent = () => {
    frozen = false;
  };

  const onResize = () => {
    measuredScrollHeight = -1; // 布局尺寸变了,下次滚动时重算
  };

  if (scroller) {
    scroller.addEventListener('scroll', onScroll, { passive: true });
    scroller.addEventListener('wheel', onUserIntent, { passive: true });
    scroller.addEventListener('touchstart', onUserIntent, { passive: true });
    scroller.addEventListener('keydown', onUserIntent);
    scroller.addEventListener('scrollend', onUserIntent);
  }
  window.addEventListener('resize', onResize);

  // 首帧:打开文档/开启模式时立刻定位当前块
  measure();
  apply();

  return () => {
    if (frame) cancelAnimationFrame(frame);
    window.clearTimeout(freezeTimer);
    if (scroller) {
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('wheel', onUserIntent);
      scroller.removeEventListener('touchstart', onUserIntent);
      scroller.removeEventListener('keydown', onUserIntent);
      scroller.removeEventListener('scrollend', onUserIntent);
    }
    window.removeEventListener('resize', onResize);
    if (activeIndex >= 0) container.children[activeIndex]?.classList.remove('focus-active');
  };
}
