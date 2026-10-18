/**
 * 焦点行 / 打字机模式测试(T3.2)。
 * 判断逻辑是两个纯函数;mountFocus 的 DOM 副作用用假布局验证。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  ANCHOR_RATIO,
  mountFocus,
  pickActiveBlock,
  typewriterTarget,
  type BlockRect,
} from '../src/renderer/focus';

/** 造一串等高块:每块高 h,间隔 gap,从 0 开始 */
function makeBlocks(count: number, h: number, gap = 0): BlockRect[] {
  const blocks: BlockRect[] = [];
  let top = 0;
  for (let i = 0; i < count; i++) {
    blocks.push({ top, bottom: top + h });
    top += h + gap;
  }
  return blocks;
}

describe('pickActiveBlock', () => {
  it('选出包含锚点的块', () => {
    const blocks = makeBlocks(5, 100); // [0,100) [100,200) ...
    expect(pickActiveBlock(blocks, 0)).toBe(0);
    expect(pickActiveBlock(blocks, 50)).toBe(0);
    expect(pickActiveBlock(blocks, 100)).toBe(1);
    expect(pickActiveBlock(blocks, 250)).toBe(2);
    expect(pickActiveBlock(blocks, 499)).toBe(4);
  });

  it('锚点落在块间空隙时取中心最近的块', () => {
    const blocks = makeBlocks(4, 100, 40); // 块高 100,间隔 40
    // 空隙 [100,140):离块 0 中心(50)90,离块 1 中心(240)100 → 块 0
    expect(pickActiveBlock(blocks, 110)).toBe(0);
    // 空隙 [240,280):离块 1 中心(240)10,离块 2 中心(480)200 → 块 1
    expect(pickActiveBlock(blocks, 250)).toBe(1);
    // 空隙靠前 [120):距块 0 中心 70,距块 1 中心 120 → 块 0
    expect(pickActiveBlock(blocks, 120)).toBe(0);
  });

  it('锚点在第一块之前返回首块', () => {
    const blocks = makeBlocks(3, 100);
    // 内容从视口中部开始(锚点在内容顶之上)
    expect(pickActiveBlock(blocks, -50)).toBe(0);
  });

  it('锚点超过最后一块返回末块', () => {
    const blocks = makeBlocks(3, 100);
    expect(pickActiveBlock(blocks, 9999)).toBe(2);
  });

  it('没有块时返回 -1', () => {
    expect(pickActiveBlock([], 100)).toBe(-1);
  });

  it('二分查找与线性参考实现一致(含空隙)', () => {
    const blocks = makeBlocks(500, 30, 7);
    const reference = (y: number): number => {
      for (const b of blocks) if (b.top <= y && b.bottom >= y) return blocks.indexOf(b);
      let best = 0;
      let bestDist = Infinity;
      blocks.forEach((b, i) => {
        const d = Math.abs((b.top + b.bottom) / 2 - y);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      });
      return best;
    };
    for (const y of [-10, 0, 17, 100, 999, 5000, 12345, 30000, 99999]) {
      expect(pickActiveBlock(blocks, y)).toBe(reference(y));
    }
  });

  it('锚点比例常量在合理区间(偏上,视线在锚点下方)', () => {
    expect(ANCHOR_RATIO).toBeGreaterThan(0.2);
    expect(ANCHOR_RATIO).toBeLessThan(0.5);
  });
});

describe('typewriterTarget', () => {
  it('块中心对齐到视口锚点线(与选块同一条线,保证收敛)', () => {
    // 块在 1000~1100,视口 800,锚点线 800*0.38=304 → 目标 1050-304=746
    expect(typewriterTarget({ top: 1000, bottom: 1100 }, 800, 5000)).toBe(746);
  });

  it('校正后锚点落在块中心:同一块保持活跃(不振荡)', () => {
    // 任取一块,按目标滚动后,锚点线应正好穿过块中心
    const block = { top: 1000, bottom: 1100 };
    const viewportH = 800;
    const target = typewriterTarget(block, viewportH, 5000);
    const anchorY = target + viewportH * ANCHOR_RATIO;
    expect(anchorY).toBeCloseTo((block.top + block.bottom) / 2);
    expect(pickActiveBlock([block], anchorY)).toBe(0);
  });

  it('比视口还高的块对齐到视口 20% 处', () => {
    // 块高 2000 > 视口 800 → 目标 top-160
    expect(typewriterTarget({ top: 1000, bottom: 3000 }, 800, 5000)).toBe(840);
  });

  it('结果钳制在可滚动范围内', () => {
    // 顶部:对齐目标为负 → 0
    expect(typewriterTarget({ top: 0, bottom: 100 }, 800, 5000)).toBe(0);
    // 底部:目标超出 max → max
    const max = 5000 - 800;
    expect(typewriterTarget({ top: 4950, bottom: 5050 }, 800, 5000)).toBe(max);
  });

  it('内容短于视口时目标为 0', () => {
    expect(typewriterTarget({ top: 0, bottom: 300 }, 800, 300)).toBe(0);
  });
});

/* ---------------- mountFocus(假布局 DOM)- ---------------- */

describe('mountFocus', () => {
  beforeEach(() => {
    // 同步派发 rAF:滚动事件里排的「下一帧」立即执行,便于同步断言
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** 造 .main(滚动容器)+ .prose(正文),并给每个子元素布置假 rect(视口坐标) */
  function setupDoc(childTops: number[], childHeights: number[]) {
    const main = document.createElement('div');
    main.className = 'main';
    const prose = document.createElement('article');
    prose.className = 'prose';
    const children = childTops.map((_, i) => {
      const el = document.createElement('p');
      // top = 块内容坐标 - main.scrollTop( measure 时按当前 scrollTop 反算 )
      el.getBoundingClientRect = () =>
        ({
          top: childTops[i] - main.scrollTop,
          bottom: childTops[i] - main.scrollTop + childHeights[i],
          height: childHeights[i],
        }) as DOMRect;
      prose.appendChild(el);
      return el;
    });
    main.appendChild(prose);
    document.body.appendChild(main);
    // jsdom 无布局:手工补容器度量
    Object.defineProperty(main, 'clientHeight', { value: 800, configurable: true });
    Object.defineProperty(main, 'scrollHeight', { value: 100000, configurable: true });
    main.scrollTo = vi.fn((opts?: ScrollToOptions | number) => {
      const top = typeof opts === 'number' ? opts : (opts?.top ?? 0);
      main.scrollTop = top;
      main.dispatchEvent(new Event('scroll'));
    }) as unknown as typeof main.scrollTo;
    return { main, prose, children };
  }

  it('焦点行:滚动后焦点块跟随锚点,清理时移除类', () => {
    const { main, prose, children } = setupDoc(
      [0, 300, 600, 900],
      [200, 200, 200, 200],
    );
    const cleanup = mountFocus({
      container: prose,
      getMode: () => ({ focus: true, typewriter: false }),
      scroller: main,
    });

    // 初始:锚点 = 0 + 800*0.38 = 304 → 块 1(300~500)
    expect(children[1].classList.contains('focus-active')).toBe(true);
    expect(children[0].classList.contains('focus-active')).toBe(false);

    main.scrollTop = 700; // 锚点 1004 → 块 3(900~1100)
    main.dispatchEvent(new Event('scroll'));

    expect(children[3].classList.contains('focus-active')).toBe(true);
    expect(children[1].classList.contains('focus-active')).toBe(false);

    cleanup();
    expect(children[3].classList.contains('focus-active')).toBe(false);
    main.remove();
  });

  it('模式全关时不加焦点类', () => {
    const { main, prose, children } = setupDoc([0, 300], [200, 200]);
    const cleanup = mountFocus({
      container: prose,
      getMode: () => ({ focus: false, typewriter: false }),
      scroller: main,
    });
    expect(children.some((c) => c.classList.contains('focus-active'))).toBe(false);
    cleanup();
    main.remove();
  });

  it('打字机:把当前块对齐到锚点线,走平滑滚动', () => {
    const { main, prose } = setupDoc([0, 300], [200, 200]);
    const cleanup = mountFocus({
      container: prose,
      getMode: () => ({ focus: true, typewriter: true }),
      scroller: main,
    });
    // 初始锚点 0+800*0.38=304 → 块 1(300~500),中心 400
    // 目标 = 400-304=96;当前 0,偏差 96 > 阈值 → 校正到 96
    expect(main.scrollTo).toHaveBeenCalledWith({ top: 96, behavior: 'smooth' });
    cleanup();
    main.remove();
  });

  it('打字机:已对齐后不再校正(收敛,不振荡)', () => {
    const { main, prose } = setupDoc([0, 300], [200, 200]);
    const cleanup = mountFocus({
      container: prose,
      getMode: () => ({ focus: true, typewriter: true }),
      scroller: main,
    });
    // 挂载时的校正已把 scrollTop 带到 96(桩内同步生效);
    // 等滚动动画结束(scrollend 解除冻结)后再来一次滚动事件,不应再校正
    main.dispatchEvent(new Event('scrollend'));
    (main.scrollTo as unknown as { mockClear: () => void }).mockClear();
    main.dispatchEvent(new Event('scroll'));
    expect(main.scrollTo).not.toHaveBeenCalled();
    cleanup();
    main.remove();
  });

  it('打字机:偏差在阈值内不校正(避免抖动)', () => {
    const { main, prose } = setupDoc([0, 300], [200, 200]);
    const cleanup = mountFocus({
      container: prose,
      getMode: () => ({ focus: true, typewriter: true }),
      scroller: main,
    });
    main.dispatchEvent(new Event('scrollend')); // 解冻
    (main.scrollTo as unknown as { mockClear: () => void }).mockClear();
    main.scrollTop = 76; // 目标 96,偏差 20 ≤ 阈值 → 不动作
    main.dispatchEvent(new Event('scroll'));
    expect(main.scrollTo).not.toHaveBeenCalled();
    cleanup();
    main.remove();
  });
});
