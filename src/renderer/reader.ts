/**
 * 朗读器:把正文切成「块 → 句」,逐句交给后端播报,并标记当前位置。
 *
 * 为什么逐句而不是整篇丢给引擎:
 * - 后端的 `say` 以句为粒度阻塞返回,于是暂停/继续/停止都落在句边界上,
 *   不会出现"长文本播到一半被砍断";
 * - 前端因此天然知道当前句,可以高亮并让视口跟随。
 *
 * 并发控制用一个自增代号:切文档/停止都会让代号前进,
 * 仍在 await 的旧循环醒来后据此自行退出,不会和新一轮抢引擎。
 */
import { getBackend } from '../ipc';
import { errMsg } from '../ipc/errors';
import type { SpeechApi, VoiceInfo } from '../types';
import {
  collectBlocks,
  markSentence,
  normalizeForSpeech,
  splitSentences,
  type ReadableBlock,
  type SentenceMark,
} from './speak-mark';

export type ReaderStatus = 'idle' | 'playing' | 'paused' | 'unsupported';
/** 引擎来源:系统音色(桌面)/ 浏览器 Web Speech / 无 */
export type ReaderEngine = 'system' | 'web' | 'none';

export interface ReaderState {
  status: ReaderStatus;
  /** 当前句序号(从 0 起) */
  index: number;
  total: number;
  /** 当前朗读的句子 */
  text: string;
  engine: ReaderEngine;
  /** 引擎不可用/出错时的说明 */
  error?: string;
}

interface Sentence {
  text: string;
  block: ReadableBlock;
}

export interface ReaderOptions {
  rate: number;
  voice?: string;
}

export interface Reader {
  state(): ReaderState;
  subscribe(cb: (s: ReaderState) => void): () => void;
  /** 切换正文容器(切文档时调用,会停止正在进行的朗读) */
  attach(container: HTMLElement | null): void;
  /** 正文重新渲染后重建句表 */
  refresh(): void;
  /** 开始朗读;已在播放时视为继续。返回的是"已启动",不是"读完" */
  play(opts?: { from?: number; selection?: boolean }): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
  /** 播放/停止 的切换按钮行为 */
  toggle(): void;
  setOptions(o: Partial<ReaderOptions>): void;
  options(): ReaderOptions;
  voices(): Promise<VoiceInfo[]>;
  /** 引擎是否支持暂停(不支持时 UI 应隐藏该按钮) */
  supportsPause(): Promise<boolean>;
  dispose(): void;
}

const MIN_SENTENCE = 2; // 太碎的片段直接丢弃

class ReaderImpl implements Reader {
  private container: HTMLElement | null = null;
  private sentences: Sentence[] = [];
  private blocks: ReadableBlock[] = [];
  private listeners = new Set<(s: ReaderState) => void>();
  private mark: SentenceMark | null = null;
  /** 自增代号:换代即让旧的 await 循环退出 */
  private gen = 0;
  private opts: ReaderOptions = { rate: 0 };
  /** 当前状态快照(字段名避开同名的 state() 访问器) */
  private current: ReaderState = {
    status: 'idle',
    index: -1,
    total: 0,
    text: '',
    engine: 'none',
  };

  /* ---------------- 状态 ---------------- */

  state(): ReaderState {
    return this.current;
  }

  subscribe(cb: (s: ReaderState) => void): () => void {
    this.listeners.add(cb);
    cb(this.current);
    return () => this.listeners.delete(cb);
  }

  private publish(patch: Partial<ReaderState>) {
    this.current = { ...this.current, ...patch };
    this.listeners.forEach((l) => l(this.current));
  }

  /* ---------------- 正文 ---------------- */

  attach(container: HTMLElement | null) {
    if (this.container === container) return;
    this.stop();
    this.container = container;
    this.refresh();
  }

  refresh() {
    this.clearMark();
    this.blocks = this.container ? collectBlocks(this.container) : [];
    const sentences: Sentence[] = [];
    for (const block of this.blocks) {
      for (const text of splitSentences(block.text)) {
        if (text.trim().length < MIN_SENTENCE) continue;
        sentences.push({ text, block });
      }
    }
    this.sentences = sentences;
    if (this.current.status === 'idle') {
      this.publish({ index: -1, total: sentences.length, text: '' });
    } else {
      this.publish({ total: sentences.length });
    }
  }

  private clearMark() {
    this.mark?.cleanup();
    this.mark = null;
  }

  /* ---------------- 播放 ---------------- */

  async play(opts?: { from?: number; selection?: boolean }): Promise<void> {
    if (this.current.status === 'playing' || this.current.status === 'paused') {
      this.resume();
      return;
    }
    if (!this.sentences.length) this.refresh();
    if (!this.sentences.length) {
      this.publish({ error: '当前文档没有可朗读的内容', status: 'idle' });
      return;
    }

    let api: SpeechApi;
    try {
      const backend = await getBackend();
      api = backend.speech;
      if (!(await api.ready())) {
        this.publish({
          status: 'unsupported',
          engine: 'none',
          error: '当前环境没有可用的语音引擎',
        });
        return;
      }
    } catch (e) {
      this.publish({ status: 'unsupported', engine: 'none', error: `语音引擎不可用:${msg(e)}` });
      return;
    }

    const from = opts?.from ?? (opts?.selection ? this.selectionStartIndex() : null) ?? 0;
    const start = Math.max(0, Math.min(this.sentences.length - 1, from));
    const gen = ++this.gen;
    this.publish({
      status: 'playing',
      engine: detectEngine(),
      index: start - 1,
      total: this.sentences.length,
      error: undefined,
    });
    // 循环在后台跑:一次朗读会持续很久,play() 只负责"启动"
    void this.run(gen, start, api);
  }

  /** 逐句播报的循环。代号变化即退出,避免与新一轮抢引擎。 */
  private async run(gen: number, start: number, api: SpeechApi) {
    for (let i = start; i < this.sentences.length; i++) {
      if (gen !== this.gen) return;
      const sentence = this.sentences[i];
      this.publish({ index: i, text: sentence.text });
      this.applyMark(sentence);
      let outcome: string;
      try {
        outcome = await api.say(normalizeForSpeech(sentence.text), {
          rate: this.opts.rate,
          voice: this.opts.voice,
        });
      } catch (e) {
        if (gen === this.gen) {
          this.finish('idle');
          this.publish({ error: `朗读失败:${msg(e)}` });
        }
        return;
      }
      if (gen !== this.gen) return;
      if (outcome === 'cancelled') {
        this.finish('idle');
        return;
      }
    }
    // 播完最后一句
    if (gen === this.gen) this.finish('idle');
  }

  /** 收尾:清理高亮并回到空闲 */
  private finish(status: ReaderStatus) {
    this.clearMark();
    this.publish({ status, index: -1, text: '' });
  }

  /** 选区落在第几个块上 —— 用于"从选区开始朗读" */
  private selectionStartIndex(): number | null {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.anchorNode || !this.container) return null;
    const node = sel.anchorNode;
    if (!this.container.contains(node)) return null;
    const blockEl =
      node instanceof Element ? node : (node.parentElement as HTMLElement | null);
    if (!blockEl) return null;
    const hit = this.blocks.find((b) => b.el === blockEl || b.el.contains(blockEl));
    if (!hit) return null;
    const idx = this.sentences.findIndex((s) => s.block === hit);
    return idx === -1 ? null : idx;
  }

  /** 标记当前句并把视口带过去 */
  private applyMark(sentence: Sentence) {
    this.clearMark();
    try {
      this.mark = markSentence(sentence.block, sentence.text);
    } catch {
      // 高亮失败不影响朗读本身
      this.mark = null;
    }
    // 视口跟随单独兜底:滚动 API 不可用(如某些宿主/jsdom)时,
    // 不该连累这一句的朗读
    try {
      sentence.block.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch {
      /* 忽略 */
    }
  }

  pause() {
    if (this.current.status !== 'playing') return;
    void getBackend().then((b) =>
      b.speech.pause().then((ok) => {
        if (ok) this.publish({ status: 'paused' });
      }),
    );
  }

  resume() {
    if (this.current.status !== 'paused') return;
    void getBackend().then((b) =>
      b.speech.resume().then((ok) => {
        if (ok) this.publish({ status: 'playing' });
      }),
    );
  }

  stop() {
    if (this.current.status === 'idle' || this.current.status === 'unsupported') {
      this.gen++;
      this.clearMark();
      return;
    }
    // 先换代:让等待中的循环醒来后直接退出,避免与 cancel 抢跑
    this.gen++;
    this.finish('idle');
    void getBackend()
      .then((b) => b.speech.cancel())
      .catch(() => {});
  }

  toggle() {
    if (this.current.status === 'playing') this.stop();
    else if (this.current.status === 'paused') this.resume();
    else void this.play();
  }

  /* ---------------- 参数 ---------------- */

  setOptions(o: Partial<ReaderOptions>) {
    this.opts = { ...this.opts, ...o };
  }

  options(): ReaderOptions {
    return this.opts;
  }

  async voices(): Promise<VoiceInfo[]> {
    try {
      return await (await getBackend()).speech.voices();
    } catch {
      return [];
    }
  }

  async supportsPause(): Promise<boolean> {
    try {
      return await (await getBackend()).speech.supportsPause();
    } catch {
      return false;
    }
  }

  dispose() {
    this.stop();
    this.listeners.clear();
    this.container = null;
    this.sentences = [];
    this.blocks = [];
  }
}

function msg(e: unknown): string {
  return errMsg(e);
}

/** 引擎来源仅用于界面提示:Tauri 走系统音色,浏览器走 Web Speech */
function detectEngine(): ReaderEngine {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as object) ? 'system' : 'web';
}

/** 全局单例:朗读是一个横跨整个应用的会话,不该随组件挂载销毁 */
let instance: ReaderImpl | null = null;

export function getReader(): Reader {
  if (!instance) instance = new ReaderImpl();
  return instance;
}

/** 仅测试用:丢弃当前单例 */
export function resetReader(): void {
  instance?.dispose();
  instance = null;
}