/**
 * 划词翻译气泡:选中正文文本后浮现。
 *
 * 分层设计(规划 2.2.2):
 * - 第一响应 = 离线词典(`renderer/translate.ts` → `dictionary.ts`),
 *   本地完成、零网络请求,未收录时给近似词建议;
 * - 在线翻译为可选项:默认关闭,配置端点后仅在点击「在线翻译」时
 *   向该端点发一次请求(OpenAI 兼容 chat/completions)。
 *
 * 组件整体懒加载(只在真的划词时才下载词典数据),由 Viewer 在
 * 选区非空时挂载;Esc / 点击外部关闭。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Languages, X } from 'lucide-react';
import { useStore } from '../store';
import './translate-bubble.css';
import {
  isOnlineConfigured,
  translateOffline,
  translateOnline,
  type OfflineTranslation,
  type OnlineTranslateConfig,
} from '../renderer/translate';

export interface TranslateBubbleProps {
  text: string;
  /** 选区中心 x(视口坐标) */
  x: number;
  /** 选区底部 y(视口坐标) */
  y: number;
  onClose: () => void;
}

const MAX_TEXT = 160;

export function TranslateBubble({ text, x, y, onClose }: TranslateBubbleProps) {
  const ref = useRef<HTMLDivElement>(null);
  const enabled = useStore((s) => s.translateOnlineEnabled);
  const endpoint = useStore((s) => s.translateEndpoint);
  const model = useStore((s) => s.translateModel);
  const apiKey = useStore((s) => s.translateApiKey);
  const setEnabled = useStore((s) => s.setTranslateOnlineEnabled);
  const setEndpoint = useStore((s) => s.setTranslateEndpoint);
  const setModel = useStore((s) => s.setTranslateModel);
  const setApiKey = useStore((s) => s.setTranslateApiKey);

  const onlineCfg: OnlineTranslateConfig = useMemo(
    () => ({ enabled, endpoint, model, apiKey }),
    [enabled, endpoint, model, apiKey],
  );
  const onlineReady = isOnlineConfigured(onlineCfg);

  const result: OfflineTranslation = useMemo(() => translateOffline(text), [text]);

  const [online, setOnline] = useState<{ state: 'idle' | 'loading' | 'done' | 'error'; text: string }>({
    state: 'idle',
    text: '',
  });
  const [showConfig, setShowConfig] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  /* Esc 关闭;点击外部关闭 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
    };
  }, [onClose]);

  /* 卸载时中止进行中的在线请求 */
  useEffect(() => () => abortRef.current?.abort(), []);

  const runOnline = async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setOnline({ state: 'loading', text: '' });
    try {
      const out = await translateOnline(text, onlineCfg, ac.signal);
      if (!ac.signal.aborted) setOnline({ state: 'done', text: out });
    } catch (e) {
      if (!ac.signal.aborted) {
        setOnline({ state: 'error', text: e instanceof Error ? e.message : String(e) });
      }
    }
  };

  /* 贴边翻转:默认在选区右下,越界则翻到左上 */
  const w = 320;
  const h = 260;
  const left = Math.max(8, Math.min(x - w / 2, window.innerWidth - w - 8));
  const top = y + 10 + h > window.innerHeight ? Math.max(8, y - h - 10) : y + 10;

  return (
    <div
      className="translate-bubble"
      ref={ref}
      role="dialog"
      aria-label="划词翻译"
      style={{ left, top, width: w }}
      onMouseDown={(e) => e.preventDefault()} // 不让点击气泡时消掉选区
    >
      <div className="translate-head">
        <Languages size={14} />
        <span className="translate-title">翻译</span>
        <button className="translate-close" title="关闭 (Esc)" onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      <div className="translate-src">
        {result.text.length > MAX_TEXT ? `${result.text.slice(0, MAX_TEXT)}…` : result.text}
      </div>

      <div className="translate-body">
        {result.phraseHits.map((h) => (
          <div className="translate-entry" key={`p-${h.key}`}>
            <div className="translate-entry-head">
              <b>{h.key}</b>
              {h.key !== result.text && <span className="translate-from">{`← ${result.text}`}</span>}
            </div>
            <div className="translate-entry-defs">{h.defs.join(';')}</div>
          </div>
        ))}

        {result.words.map((wd, i) => (
          <div className="translate-entry" key={`w-${wd.token}-${i}`}>
            <div className="translate-entry-head">
              <b>{wd.token}</b>
              {wd.hits.length > 0 && wd.hits[0].key !== wd.token && (
                <span className="translate-from">{`← ${wd.hits[0].key}`}</span>
              )}
            </div>
            {wd.hits.length > 0 ? (
              <div className="translate-entry-defs">{wd.hits[0].defs.join(';')}</div>
            ) : wd.reverse.length > 0 ? (
              <div className="translate-entry-defs">{wd.reverse.slice(0, 6).join('、')}</div>
            ) : wd.suggestions.length > 0 ? (
              <div className="translate-entry-defs translate-suggest">
                未收录,你是否找:
                {wd.suggestions.map((s) => (
                  <span className="translate-suggest-word" key={s}>
                    {s}
                  </span>
                ))}
              </div>
            ) : (
              <div className="translate-entry-defs translate-miss">未收录</div>
            )}
          </div>
        ))}

        {/* 完全无任何可用输出(无命中/反查/建议)时才显示空横幅;
            有建议时逐词行内的「未收录,你是否找」已经是提示,不再重复 */}
        {result.empty &&
          result.words.every((w) => !w.suggestions.length) && (
            <div className="translate-empty">
              离线词典未收录
              {result.tokenCount > result.words.length && <> (仅查前 {result.words.length} 个词条)</>}
            </div>
          )}
      </div>

      <div className="translate-foot">
        {onlineReady ? (
          <button className="translate-online-btn" disabled={online.state === 'loading'} onClick={() => void runOnline()}>
            {online.state === 'loading' ? '请求中…' : '在线翻译'}
          </button>
        ) : (
          <button className="translate-online-btn ghost" onClick={() => setShowConfig((v) => !v)}>
            {showConfig ? '收起配置' : '配置在线翻译(可选)'}
          </button>
        )}
        <span className="translate-privacy">离线优先 · 默认不发网络请求</span>
      </div>

      {online.state !== 'idle' && (
        <div className={`translate-online-result ${online.state}`}>
          {online.state === 'loading' && '请求中…'}
          {online.state === 'error' && `⚠ ${online.text}`}
          {online.state === 'done' && online.text}
        </div>
      )}

      {showConfig && !onlineReady && (
        <div className="translate-config">
          <label>
            端点(Base URL)
            <input
              value={endpoint}
              placeholder="https://api.openai.com/v1"
              onChange={(e) => setEndpoint(e.target.value)}
              spellCheck={false}
            />
          </label>
          <label>
            模型
            <input
              value={model}
              placeholder="gpt-4o-mini"
              onChange={(e) => setModel(e.target.value)}
              spellCheck={false}
            />
          </label>
          <label>
            API Key(可空)
            <input
              value={apiKey}
              type="password"
              onChange={(e) => setApiKey(e.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="translate-config-switch">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            启用在线翻译(仅点击「在线翻译」时请求该端点)
          </label>
        </div>
      )}
    </div>
  );
}

export default TranslateBubble;
