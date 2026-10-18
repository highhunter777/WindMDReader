/**
 * 朗读菜单交互测试。
 *
 * 重点锁一个曾经踩过的坑:主按钮在"播放中"显示的是「暂停」,
 * 早期实现却笼统走了 `toggle()`(那是"播放/停止"的语义),
 * 于是点「暂停」实际把朗读停了。这里逐状态断言调用的是哪个方法。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import SpeakMenu from '../src/ui/SpeakMenu';
import { getReader, resetReader } from '../src/renderer/reader';
import type { SayOutcome } from '../src/types';

const h = vi.hoisted(() => {
  const calls = { say: 0, pause: 0, resume: 0, cancel: 0, voices: 0 };
  const speech = {
    async ready() {
      return true;
    },
    async voices() {
      calls.voices++;
      return [{ name: 'Microsoft Huihui Desktop', culture: 'zh-CN', gender: 'Female' }];
    },
    // 永不结束:让朗读停在"播放中",便于观察按钮状态
    say(): Promise<SayOutcome> {
      calls.say++;
      return new Promise<SayOutcome>(() => {});
    },
    async pause() {
      calls.pause++;
      return true;
    },
    async resume() {
      calls.resume++;
      return true;
    },
    async cancel() {
      calls.cancel++;
    },
    async supportsPause() {
      return true;
    },
  };
  return { calls, speech };
});

vi.mock('../src/ipc', () => ({
  getBackend: async () => ({ mode: 'mock', speech: h.speech }),
}));

/** 让组件内的异步后端调用与朗读循环推进若干轮。
 *  只 `await Promise.resolve()` 不够:play 内部串了 getBackend / ready 两层 await,
 *  走宏任务才能保证整条链都跑完。 */
const flush = async (times = 4) => {
  await act(async () => {
    for (let i = 0; i < times; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
  });
};

const btn = (label: string): HTMLButtonElement =>
  [...document.querySelectorAll('.speak-btn')].find((b) => b.textContent?.includes(label)) as HTMLButtonElement;

/** 打开朗读菜单(按钮与懒加载 chunk 都要就绪) */
async function openMenu() {
  document.body.innerHTML = '<article class="prose"><p>第一句话。第二句话。</p></article>';
  const reader = getReader();
  reader.attach(document.querySelector('article') as HTMLElement);
  render(<SpeakMenu />);
  fireEvent.click(document.querySelector('.speak-menu button') as HTMLButtonElement);
  await flush();
}

beforeEach(() => {
  h.calls.say = 0;
  h.calls.pause = 0;
  h.calls.resume = 0;
  h.calls.cancel = 0;
  h.calls.voices = 0;
  resetReader();
  // jsdom 未实现 scrollIntoView
  Element.prototype.scrollIntoView = vi.fn();
});

// 必须显式清理:本工程未开 vitest globals,testing-library 的自动 cleanup 不生效,
// 否则上个用例的 SpeakMenu 会留在 DOM 里,选择器命中的是它的按钮
afterEach(() => {
  cleanup();
  resetReader();
});

describe('SpeakMenu — 朗读控制', () => {
  it('空闲时主按钮是「朗读全文」,点它才开始朗读', async () => {
    await openMenu();
    expect(btn('朗读全文')).toBeInTheDocument();
    expect(h.calls.say).toBe(0);

    fireEvent.click(btn('朗读全文'));
    await flush();
    expect(h.calls.say).toBe(1);
    expect(btn('暂停')).toBeInTheDocument();
    expect(document.querySelector('mark.speaking-sentence')).not.toBeNull();
  });

  it('播放中点「暂停」调用的是暂停,而不是停止', async () => {
    await openMenu();
    fireEvent.click(btn('朗读全文'));
    await flush();

    fireEvent.click(btn('暂停'));
    await flush();
    expect(h.calls.pause).toBe(1);
    expect(h.calls.cancel).toBe(0);
    expect(btn('继续')).toBeInTheDocument();
    expect(getReader().state().status).toBe('paused');
  });

  it('暂停后点「继续」恢复播放', async () => {
    await openMenu();
    fireEvent.click(btn('朗读全文'));
    await flush();
    fireEvent.click(btn('暂停'));
    await flush();

    fireEvent.click(btn('继续'));
    await flush();
    expect(h.calls.resume).toBe(1);
    expect(btn('暂停')).toBeInTheDocument();
    expect(getReader().state().status).toBe('playing');
  });

  it('停止按钮才调用停止,并清掉朗读高亮', async () => {
    await openMenu();
    fireEvent.click(btn('朗读全文'));
    await flush();

    fireEvent.click(btn('停止'));
    await flush();
    expect(h.calls.cancel).toBe(1);
    expect(document.querySelector('mark.speaking-sentence')).toBeNull();
    expect(document.querySelector('.speaking-block')).toBeNull();
    expect(btn('朗读全文')).toBeInTheDocument();
  });

  it('空闲时「停止」不可点', async () => {
    await openMenu();
    expect(btn('停止').disabled).toBe(true);
  });

  it('无选区时「从选区开始」不可点', async () => {
    await openMenu();
    expect(btn('从选区开始').disabled).toBe(true);
  });

  it('展开菜单时才去拉音色列表', async () => {
    await openMenu();
    expect(h.calls.voices).toBe(1);
    const select = document.querySelector('.speak-row select') as HTMLSelectElement | null;
    expect([...(select?.options ?? [])].map((o) => o.textContent)).toEqual([
      '系统默认',
      'Microsoft Huihui Desktop(zh-CN)',
    ]);
  });

  it('语速滑块改变会同步给朗读器', async () => {
    await openMenu();
    const range = document.querySelector('.speak-row input[type=range]') as HTMLInputElement;
    fireEvent.change(range, { target: { value: '4' } });
    await flush();
    expect(getReader().options().rate).toBe(4);
  });
});