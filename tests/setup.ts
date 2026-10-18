/**
 * 测试环境准备:
 * - jsdom 缺失的浏览器 API 桩(intersectionObserver / matchMedia / scrollTo 等)
 * - fake-indexeddb 供 mock 后端持久化使用
 */
import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

/* jsdom 未实现的浏览器 API —— 渲染管线依赖这些能力 */

/** 元素进入视口即触发一次回调,便于同步断言懒渲染结果 */
class MockIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '';
  readonly thresholds: ReadonlyArray<number> = [];

  constructor(private callback: IntersectionObserverCallback) {}

  observe(target: Element): void {
    // 立即以「已相交」回调一次,nextTick 让 observe 所在逻辑先完成挂载
    queueMicrotask(() => {
      this.callback(
        [{ isIntersecting: true, target } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
    });
  }

  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

window.scrollTo = vi.fn();
window.scrollBy = vi.fn();

/**
 * jsdom 未实现元素级滚动 API(真实 WebView2/WKWebView 均有):
 * 补桩,避免快捷键的滚动路径在测试里炸掉(表现为未捕获 TypeError)。
 */
if (typeof Element.prototype.scrollTo !== 'function') {
  Element.prototype.scrollTo = function (this: HTMLElement, opts?: number | ScrollToOptions) {
    this.scrollTop = typeof opts === 'number' ? opts : (opts?.top ?? 0);
  };
}
if (typeof Element.prototype.scrollBy !== 'function') {
  Element.prototype.scrollBy = function (this: HTMLElement, opts?: number | ScrollToOptions) {
    this.scrollTop += typeof opts === 'number' ? opts : (opts?.top ?? 0);
  };
}

/** jsdom 无布局引擎,getBoundingClientRect 恒返回 0,会让视口判断恒为「不可见」 */
Element.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
  const rect = {
    x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
    toJSON: () => ({}),
  };
  // 视口内:让懒渲染的「首屏可见」判断成立
  const visible = { ...rect, bottom: 100, height: 100, top: 0 };
  return (this.dataset.testVisible === 'false' ? rect : visible) as DOMRect;
};

if (!('requestIdleCallback' in window)) {
  // 同步派发,避免预取逻辑在测试中悬挂
  (window as unknown as { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback =
    (cb: () => void) => {
      cb();
      return 0;
    };
}