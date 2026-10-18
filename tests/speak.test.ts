/**
 * 朗读(TTS)测试。
 *
 * 分两层:
 * - `speak-mark` 的纯逻辑(分句 / 块收集 / 句级高亮与可撤销)直接对 DOM 断言;
 * - `reader` 用假 SpeechApi 驱动,验证逐句推进、取消、换代退出等时序,
 *   不依赖真实语音引擎(真实往返由 Rust 侧 `cargo test` 覆盖)。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  collectBlocks,
  markSentence,
  normalizeForSpeech,
  readableText,
  splitSentences,
} from '../src/renderer/speak-mark';
import { getReader, resetReader } from '../src/renderer/reader';
import { webRate } from '../src/ipc/mock';
import type { SpeechApi, SayOutcome, SpeakOptions } from '../src/types';

/* ================================================================
 * 假引擎
 * ================================================================ */

interface PendingSay {
  text: string;
  options?: SpeakOptions;
  resolve: (r: SayOutcome) => void;
}

const calls = {
  voices: 0,
  ready: 0,
  pause: 0,
  resume: 0,
  cancel: 0,
  reset() {
    this.voices = 0;
    this.ready = 0;
    this.pause = 0;
    this.resume = 0;
    this.cancel = 0;
  },
};

/** 可手动推进的假 SpeechApi */
let readyResult = true;

function fakeApi() {
  const pending: PendingSay[] = [];
  const spoken: string[] = [];
  const api: SpeechApi = {
    async ready() {
      calls.ready++;
      return readyResult;
    },
    async voices() {
      calls.voices++;
      return [{ name: 'Test Voice', culture: 'zh-CN', gender: 'Female' }];
    },
    say(text: string, options?: SpeakOptions) {
      spoken.push(text);
      return new Promise<SayOutcome>((resolve) => pending.push({ text, options, resolve }));
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
      pending.splice(0).forEach((p) => p.resolve('cancelled'));
    },
    async supportsPause() {
      return true;
    },
  };
  return {
    api,
    spoken,
    pending,
    /** 让当前待播的 n 句以指定结果结束 */
    settle(n = 1, result: SayOutcome = 'finished') {
      pending.splice(0, n).forEach((p) => p.resolve(result));
    },
  };
}

const fake = fakeApi();

vi.mock('../src/ipc', () => ({
  getBackend: async () => ({ mode: 'mock', speech: fake.api }),
}));

/* ================================================================
 * 测试脚手架
 * ================================================================ */

/** 建一棵正文 DOM,并挂到 document 上(滚动/选区相关 API 需要真实 document) */
function mountBody(html: string): HTMLElement {
  document.body.innerHTML = `<article class="prose">${html}</article>`;
  return document.querySelector('article') as HTMLElement;
}

/** 让微任务队列排空若干轮(播放循环是 await 链) */
async function settleMicrotasks(times = 6) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

beforeEach(() => {
  calls.reset();
  readyResult = true;
  fake.spoken.length = 0;
  fake.pending.length = 0;
  document.body.innerHTML = '';
  resetReader();
  // jsdom 未实现 scrollIntoView
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  resetReader();
});

/* ================================================================
 * splitSentences
 * ================================================================ */

describe('splitSentences', () => {
  it('按中文句末切分', () => {
    expect(splitSentences('第一句。第二句！第三句？')).toEqual(['第一句。', '第二句！', '第三句？']);
  });

  it('按英文句末切分', () => {
    expect(splitSentences('Hello there. How are you? Fine!')).toEqual([
      'Hello there.',
      'How are you?',
      'Fine!',
    ]);
  });

  it('不把小数点与版本号当句末', () => {
    expect(splitSentences('取值为 3.14 即可。')).toEqual(['取值为 3.14 即可。']);
    expect(splitSentences('升级到 v1.0 就好。')).toEqual(['升级到 v1.0 就好。']);
  });

  it('英文句点后无空格不切', () => {
    // "e.g" 这类缩写点后紧跟字母
    expect(splitSentences('see e.g. this file.')).toEqual(['see e.g. this file.']);
  });

  it('吞掉连续的收尾符号', () => {
    expect(splitSentences('真的吗？！当然。')).toEqual(['真的吗？！', '当然。']);
  });

  it('压掉多余空白', () => {
    expect(splitSentences('  多  余\n空白   在这里。 ')).toEqual(['多 余 空白 在这里。']);
  });

  it('超长无标点片段按长度兜底切开', () => {
    const long = 'a'.repeat(400);
    const out = splitSentences(long, 100);
    expect(out.length).toBe(4);
    expect(out.every((s) => s.length <= 100)).toBe(true);
    expect(out.join('')).toBe(long);
  });

  it('超长片段优先在逗号处断', () => {
    const long = `${'a'.repeat(60)},${'b'.repeat(60)},${'c'.repeat(60)}`;
    const out = splitSentences(long, 100);
    expect(out[0].endsWith(',')).toBe(true);
    expect(out.length).toBe(3);
  });

  it('空文本与纯空白返回空数组', () => {
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences('   \n  ')).toEqual([]);
  });
});

/* ================================================================
 * 块收集
 * ================================================================ */

describe('collectBlocks', () => {
  it('收集段落与标题', () => {
    const root = mountBody('<h1>标题</h1><p>第一段。</p><p>第二段。</p>');
    const blocks = collectBlocks(root);
    expect(blocks.map((b) => b.el.tagName)).toEqual(['H1', 'P', 'P']);
    expect(blocks[1].text).toBe('第一段。');
  });

  it('嵌套块只保留最内层,避免重复朗读', () => {
    const root = mountBody('<blockquote><p>引用里的一句话。</p></blockquote>');
    const blocks = collectBlocks(root);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].el.tagName).toBe('P');
  });

  it('松散列表里的段落被单独收集', () => {
    const root = mountBody('<ul><li><p>项内段落。</p></li><li>紧凑项。</li></ul>');
    const blocks = collectBlocks(root);
    expect(blocks.map((b) => b.el.tagName)).toEqual(['P', 'LI']);
  });

  it('表格按单元格收集', () => {
    const root = mountBody('<table><tr><td>甲</td><td>乙</td></tr></table>');
    expect(collectBlocks(root).map((b) => b.el.tagName)).toEqual(['TD', 'TD']);
  });

  it('跳过围栏代码块与公式块', () => {
    const root = mountBody(
      '<p>正文一句。</p><pre><code>const a = 1;</code></pre><div class="math-block"><p>E=mc2</p></div>',
    );
    const blocks = collectBlocks(root);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('正文一句。');
  });

  it('跳过空块', () => {
    const root = mountBody('<p>  </p><p><br></p><p>有的</p>');
    expect(collectBlocks(root)).toHaveLength(1);
  });

  it('块内跳过行内代码与行内公式的文本', () => {
    const root = mountBody('<p>见 <code>x</code> 与公式 <span class="katex">x^2</span> 结束</p>');
    const block = collectBlocks(root)[0];
    expect(block.text).not.toContain('x^2');
    // 被跳过的节点两侧各留一个空格,原文的空白不做合并(定位要用它做索引)
    expect(block.text).toBe('见  与公式  结束');
    expect(normalizeForSpeech(block.text)).toBe('见 与公式 结束');
  });

  it('块已被文档内查找高亮时,朗读文本不含高亮片段', () => {
    const root = mountBody('<p>高亮<mark class="find-hit">这个词</mark>也要读</p>');
    expect(readableText(collectBlocks(root)[0].el)).toBe('高亮也要读');
  });
});

/* ================================================================
 * 句级高亮
 * ================================================================ */

describe('markSentence', () => {
  it('在块内定位并高亮当前句', () => {
    const root = mountBody('<p>第一句 hello <strong>world</strong>。第二句 hi。</p>');
    const block = collectBlocks(root)[0];
    const sentences = splitSentences(block.text);
    expect(sentences[0]).toBe('第一句 hello world。');

    const mark = markSentence(block, sentences[0]);
    expect(mark.precise).toBe(true);
    expect(block.el.classList.contains('speaking-block')).toBe(true);
    const marks = [...block.el.querySelectorAll('mark.speaking-sentence')];
    expect(marks.map((m) => m.textContent).join('')).toBe('第一句 hello world。');
  });

  it('高亮可完整撤销,DOM 回到原样', () => {
    const html = '<p>第一句 hello <strong>world</strong>。第二句 hi。</p>';
    const root = mountBody(html);
    const before = root.innerHTML;
    const block = collectBlocks(root)[0];
    const mark = markSentence(block, splitSentences(block.text)[0]);
    expect(root.innerHTML).not.toBe(before);
    mark.cleanup();
    expect(root.innerHTML).toBe(before);
  });

  it('连续标记多句不会残留上一次的节点', () => {
    const root = mountBody('<p>甲句。乙句。丙句。</p>');
    const block = collectBlocks(root)[0];
    const sentences = splitSentences(block.text);
    for (const s of sentences) {
      const m = markSentence(block, s);
      expect(m.precise).toBe(true);
      m.cleanup();
    }
    expect(root.querySelectorAll('mark.speaking-sentence')).toHaveLength(0);
    expect(block.text).toBe('甲句。乙句。丙句。');
  });

  it('空白差异不影响定位', () => {
    // 渲染出的换行/多空格不参与匹配
    const root = mountBody('<p>第一句\n  有换行。第二句。</p>');
    const block = collectBlocks(root)[0];
    const mark = markSentence(block, '第一句 有换行。');
    expect(mark.precise).toBe(true);
  });

  it('句子在块内找不到时降级为仅块级标记', () => {
    const root = mountBody('<p>只有这一句。</p>');
    const block = collectBlocks(root)[0];
    const mark = markSentence(block, '根本不在块里的一句话。');
    expect(mark.precise).toBe(false);
    expect(block.el.classList.contains('speaking-block')).toBe(true);
    expect(block.el.querySelector('mark.speaking-sentence')).toBeNull();
    mark.cleanup();
    expect(block.el.classList.contains('speaking-block')).toBe(false);
  });

  it('重复撤销是安全的', () => {
    const root = mountBody('<p>一句。两句。</p>');
    const block = collectBlocks(root)[0];
    const mark = markSentence(block, '一句。');
    mark.cleanup();
    expect(() => mark.cleanup()).not.toThrow();
  });
});

describe('normalizeForSpeech', () => {
  it('压掉换行与连续空格', () => {
    expect(normalizeForSpeech('  多 余\n\n空白  ')).toBe('多 余 空白');
  });
});

/* ================================================================
 * 语速换算(mock / Web Speech)
 * ================================================================ */

describe('webRate', () => {
  it('未指定时为 1', () => {
    expect(webRate()).toBe(1);
  });

  it('按 0.1 步长换算并限幅', () => {
    expect(webRate(0)).toBe(1);
    expect(webRate(5)).toBeCloseTo(1.5);
    expect(webRate(10)).toBeCloseTo(2);
    // -10 换算为 0,落到 Web Speech 的下限 0.1
    expect(webRate(-10)).toBeCloseTo(0.1);
    expect(webRate(-99)).toBeGreaterThanOrEqual(0.1);
    expect(webRate(99)).toBeLessThanOrEqual(10);
  });
});

/* ================================================================
 * 朗读器时序
 * ================================================================ */

describe('reader', () => {
  it('逐句推进,播完全部后回到空闲', async () => {
    const root = mountBody('<p>甲句。乙句。丙句。</p>');
    const reader = getReader();
    reader.attach(root);
    await reader.play();

    expect(fake.spoken).toEqual(['甲句。']);
    expect(reader.state().status).toBe('playing');
    expect(root.querySelector('mark.speaking-sentence')?.textContent).toBe('甲句。');

    fake.settle(1);
    await settleMicrotasks();
    expect(fake.spoken).toEqual(['甲句。', '乙句。']);
    expect(reader.state().index).toBe(1);

    fake.settle(1);
    await settleMicrotasks();
    expect(fake.spoken).toHaveLength(3);

    fake.settle(1);
    await settleMicrotasks();
    expect(reader.state().status).toBe('idle');
    expect(root.querySelectorAll('mark.speaking-sentence')).toHaveLength(0);
  });

  it('把语速与音色透传给引擎', async () => {
    const root = mountBody('<p>一句。</p>');
    const reader = getReader();
    reader.attach(root);
    reader.setOptions({ rate: 3, voice: 'Test Voice' });
    await reader.play();
    expect(fake.pending[0].options).toEqual({ rate: 3, voice: 'Test Voice' });
  });

  it('被取消时停止推进并回到空闲', async () => {
    const root = mountBody('<p>甲句。乙句。</p>');
    const reader = getReader();
    reader.attach(root);
    await reader.play();
    fake.settle(1, 'cancelled');
    await settleMicrotasks();
    expect(fake.spoken).toEqual(['甲句。']);
    expect(reader.state().status).toBe('idle');
  });

  it('停止会让等待中的循环退出并取消引擎', async () => {
    const root = mountBody('<p>甲句。乙句。</p>');
    const reader = getReader();
    reader.attach(root);
    await reader.play();
    expect(fake.pending).toHaveLength(1);

    reader.stop();
    await settleMicrotasks();
    expect(calls.cancel).toBe(1);
    expect(reader.state().status).toBe('idle');
    expect(fake.spoken).toHaveLength(1);
  });

  it('暂停与继续转发给引擎并更新状态', async () => {
    const root = mountBody('<p>甲句。</p>');
    const reader = getReader();
    reader.attach(root);
    await reader.play();

    reader.pause();
    await settleMicrotasks();
    expect(calls.pause).toBe(1);
    expect(reader.state().status).toBe('paused');

    reader.resume();
    await settleMicrotasks();
    expect(calls.resume).toBe(1);
    expect(reader.state().status).toBe('playing');
  });

  it('暂停后再按播放是继续,不会开第二轮', async () => {
    const root = mountBody('<p>甲句。乙句。</p>');
    const reader = getReader();
    reader.attach(root);
    await reader.play();
    reader.pause();
    await settleMicrotasks();

    await reader.play();
    await settleMicrotasks();
    expect(reader.state().status).toBe('playing');
    expect(fake.spoken).toHaveLength(1);
  });

  it('toggle 在播放与停止之间切换', async () => {
    const root = mountBody('<p>甲句。</p>');
    const reader = getReader();
    reader.attach(root);
    reader.toggle();
    await settleMicrotasks();
    expect(reader.state().status).toBe('playing');
    reader.toggle();
    await settleMicrotasks();
    expect(reader.state().status).toBe('idle');
  });

  it('切文档会重建句表并停止正在进行的朗读', async () => {
    const root = mountBody('<p>甲句。乙句。</p>');
    const reader = getReader();
    reader.attach(root);
    await reader.play();
    expect(reader.state().total).toBe(2);

    const next = mountBody('<p>新文档一句话。</p>');
    reader.attach(next);
    await settleMicrotasks();
    expect(calls.cancel).toBe(1);
    expect(reader.state().total).toBe(1);
  });

  it('重复 attach 同一个容器不会重置状态', async () => {
    const root = mountBody('<p>甲句。乙句。</p>');
    const reader = getReader();
    reader.attach(root);
    reader.attach(root);
    expect(reader.state().total).toBe(2);
  });

  it('从指定句开始朗读', async () => {
    const root = mountBody('<p>甲句。乙句。丙句。</p>');
    const reader = getReader();
    reader.attach(root);
    await reader.play({ from: 2 });
    expect(fake.spoken).toEqual(['丙句。']);
    expect(reader.state().index).toBe(2);
  });

  it('可朗读内容为空时给出提示且不调用引擎', async () => {
    const root = mountBody('<pre><code>const a = 1;</code></pre>');
    const reader = getReader();
    reader.attach(root);
    await reader.play();
    expect(fake.spoken).toHaveLength(0);
    expect(reader.state().status).toBe('idle');
    expect(reader.state().error).toContain('没有可朗读的内容');
  });

  it('订阅者能收到状态变化', async () => {
    const root = mountBody('<p>甲句。</p>');
    const reader = getReader();
    reader.attach(root);
    const seen: string[] = [];
    const off = reader.subscribe((s) => seen.push(s.status));
    await reader.play();
    fake.settle(1);
    await settleMicrotasks();
    off();
    expect(seen[0]).toBe('idle');
    expect(seen).toContain('playing');
    expect(reader.state().status).toBe('idle');
  });

  it('音色列表可透传', async () => {
    const reader = getReader();
    const voices = await reader.voices();
    expect(voices).toHaveLength(1);
    expect(voices[0].name).toBe('Test Voice');
  });

  it('引擎不可用时标记为不支持并给出原因', async () => {
    readyResult = false;
    const root = mountBody('<p>甲句。</p>');
    const reader = getReader();
    reader.attach(root);
    await reader.play();
    expect(reader.state().status).toBe('unsupported');
    expect(reader.state().error).toContain('语音引擎');
    expect(fake.spoken).toHaveLength(0);
  });
});