/**
 * 划词翻译:离线词典(第一响应)+ 在线端点(可选兜底)。
 *
 * 隐私立场(规划 2.2.2 / 3.3):离线词典本地完成、零网络请求;
 * 在线翻译必须由用户显式配置端点,仅在你点击「在线翻译」时发起一次请求,
 * 默认关闭。词典数据在 `dictionary.ts`,随本模块动态 import,不进首屏。
 */
import { lookupOffline, type DictHit } from './dictionary';

export interface OfflineWordResult {
  /** 原文片段 */
  token: string;
  hits: DictHit[];
  reverse: string[];
  suggestions: string[];
  cjk: boolean;
}

export interface OfflineTranslation {
  /** 归一化后的选区文本 */
  text: string;
  /** 整串作为短语的命中(如 "thank you");单词查询时即该词结果 */
  phraseHits: DictHit[];
  /** 分词后的逐词结果(英文逐词 / 中文反查) */
  words: OfflineWordResult[];
  /** 是否完全未收录(离线无任何可用结果) */
  empty: boolean;
  /** 选区分出的词条总数(超过展示上限时 UI 给出提示) */
  tokenCount: number;
}

/** 分词:英文单词(含连字符/撇号)或连续中文 */
const TOKEN_RE = /[A-Za-z][A-Za-z'-]*|[\u4e00-\u9fff]+/g;
const MAX_TOKENS = 24;

/** 离线翻译:先试整串短语,再逐词查(中文走反查) */
export function translateOffline(rawText: string): OfflineTranslation {
  const text = rawText.trim().replace(/\s+/g, ' ');
  const whole = lookupOffline(text);
  const phraseHits = whole.hits;

  const words: OfflineWordResult[] = [];
  // 整串已命中短语(或单词本身)时不再逐词展开,避免 "thank you" 被拆成两遍
  if (!phraseHits.length) {
    const tokens = text.match(TOKEN_RE) ?? [];
    for (const token of tokens.slice(0, MAX_TOKENS)) {
      const r = lookupOffline(token);
      words.push({
        token,
        hits: r.hits,
        reverse: r.reverse,
        suggestions: r.suggestions,
        cjk: r.cjk,
      });
    }
    return {
      text,
      phraseHits,
      words,
      empty: words.every((w) => !w.hits.length && !w.reverse.length),
      tokenCount: tokens.length,
    };
  }
  return { text, phraseHits, words, empty: false, tokenCount: 0 };
}

/* --- 在线翻译(可选,OpenAI 兼容 chat/completions) --- */

export interface OnlineTranslateConfig {
  /** 是否启用(显式开关,默认 false) */
  enabled: boolean;
  /** 端点 base URL,如 https://api.openai.com/v1(勿带 /chat/completions) */
  endpoint: string;
  /** 模型名 */
  model: string;
  /** API Key(本地/自托管服务通常留空) */
  apiKey: string;
}

export const emptyOnlineConfig: OnlineTranslateConfig = {
  enabled: false,
  endpoint: '',
  model: '',
  apiKey: '',
};

/** 是否具备在线翻译条件(显式启用且配了端点) */
export function isOnlineConfigured(cfg: OnlineTranslateConfig): boolean {
  return cfg.enabled && cfg.endpoint.trim().length > 0;
}

/**
 * 在线翻译:POST {endpoint}/chat/completions。
 * 仅由用户点击触发;失败抛出可读错误(由 errMsg 展示)。
 */
export async function translateOnline(
  text: string,
  cfg: OnlineTranslateConfig,
  signal?: AbortSignal,
): Promise<string> {
  if (!isOnlineConfigured(cfg)) {
    throw new Error('在线翻译未配置:请在面板中填写端点并启用');
  }
  const url = `${cfg.endpoint.trim().replace(/\/+$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey.trim() ? { Authorization: `Bearer ${cfg.apiKey.trim()}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model.trim() || 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: '你是翻译引擎。把用户文本译成简体中文;若原文已是中文,则译成英文。只输出译文,不要解释。',
        },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`在线翻译失败:HTTP ${res.status}`);
  }
  const data: unknown = await res.json();
  const out = (data as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message
    ?.content;
  if (typeof out !== 'string' || !out.trim()) {
    throw new Error('在线翻译返回格式无法识别');
  }
  return out.trim();
}
