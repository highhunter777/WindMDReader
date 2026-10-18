/**
 * 阅读进度换算测试(T2.5)。
 * 进度以可滚动距离的比例存储,恢复时按当前窗口高度反算,
 * 因此缩放字号、换窗口大小都不破坏「回到上次位置」的语义。
 */
import { describe, expect, it } from 'vitest';
import { computeProgress, restoreTopFor, scrollTopForProgress } from '../src/renderer/scroll';

describe('阅读进度换算', () => {
  it('滚动位置换算为比例', () => {
    // 视口 800,内容 1800 → 可滚动 1000
    expect(computeProgress(0, 1800, 800)).toBe(0);
    expect(computeProgress(500, 1800, 800)).toBeCloseTo(0.5);
    expect(computeProgress(1000, 1800, 800)).toBe(1);
  });

  it('超出底部的滚动被钳制在 1', () => {
    expect(computeProgress(5000, 1800, 800)).toBe(1);
  });

  it('内容短于视口时进度为 0', () => {
    expect(computeProgress(0, 500, 800)).toBe(0);
  });

  it('比例反算滚动位置', () => {
    expect(scrollTopForProgress(0.5, 1800, 800)).toBeCloseTo(500);
    expect(scrollTopForProgress(1, 1800, 800)).toBeCloseTo(1000);
  });

  it('窗口变大后同一比例仍指向同一阅读处', () => {
    // 在 800 高的窗口读到 50%,换到 1000 高的窗口恢复:
    // 可滚动距离从 1000 变为 800,目标位置应同比变为 400
    expect(scrollTopForProgress(0.5, 1800, 1000)).toBeCloseTo(400);
  });

  it('异常进度值被钳制', () => {
    expect(scrollTopForProgress(-1, 1800, 800)).toBe(0);
    expect(scrollTopForProgress(2, 1800, 800)).toBe(1000);
    expect(scrollTopForProgress(Number.NaN, 1800, 800)).toBe(0);
  });

  it('往返换算保持一致', () => {
    const top = 375;
    const p = computeProgress(top, 1800, 800);
    expect(scrollTopForProgress(p, 1800, 800)).toBeCloseTo(top);
  });
});

describe('每篇文档各自的位置记忆', () => {
  it('会话内切回:恢复该篇记下的像素位置', () => {
    // A 滚到 3750 后离开,回来必须还是 3750(与新文档当前高度无关)
    const remembered = { y: 3750, p: 0.75 };
    expect(restoreTopFor(remembered, 0, 10000, 800)).toBe(3750);
  });

  it('不同文档的位置互不干扰', () => {
    const a = { y: 3750, p: 0.75 };
    const b = { y: 600, p: 0.12 };
    expect(restoreTopFor(a, 0, 10000, 800)).toBe(3750);
    expect(restoreTopFor(b, 0, 5000, 800)).toBe(600);
  });

  it('首次打开:按库里保存的进度百分比换算', () => {
    expect(restoreTopFor(undefined, 0.5, 1800, 800)).toBeCloseTo(500);
    expect(restoreTopFor(undefined, 0, 1800, 800)).toBe(0);
  });

  it('像素位置优先于库里的旧进度', () => {
    // 会话内已滚到新位置,即使库里还是旧百分比,也以像素为准
    const remembered = { y: 900, p: 0.18 };
    expect(restoreTopFor(remembered, 0.9, 10000, 800)).toBe(900);
  });
});
