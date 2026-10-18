/**
 * 朗读菜单:播放/暂停/继续/停止、从选区开始、语速与音色。
 *
 * 状态全部来自 `renderer/reader.ts` 的单例(朗读是跨组件的会话,
 * 不适合塞进 Zustand —— 它要在正文 DOM 上做高亮与滚动)。
 */
import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Square, Volume2 } from 'lucide-react';
import { useStore } from '../store';
import { getReader } from '../renderer/reader';
import type { ReaderState } from '../renderer/reader';
import type { VoiceInfo } from '../types';

export default function SpeakMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const reader = getReader();
  const [st, setSt] = useState<ReaderState>(reader.state());
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [pauseOk, setPauseOk] = useState(true);
  const rate = useStore((s) => s.speakRate);
  const voice = useStore((s) => s.speakVoice);
  const setRate = useStore((s) => s.setSpeakRate);
  const setVoice = useStore((s) => s.setSpeakVoice);

  useEffect(() => reader.subscribe(setSt), [reader]);

  /* 语速/音色变化要立刻同步给朗读器,正在朗读时也生效 */
  useEffect(() => {
    reader.setOptions({ rate, voice: voice || undefined });
  }, [reader, rate, voice]);

  /* 菜单打开时才去问引擎要音色列表(系统侧可能要拉起 PowerShell) */
  useEffect(() => {
    if (!open) return;
    void reader.voices().then(setVoices);
    void reader.supportsPause().then(setPauseOk);
  }, [open, reader]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const playing = st.status === 'playing';
  const paused = st.status === 'paused';
  const on = playing || paused;

  /** 「从选区开始」仅在正文里确有选区时可点 */
  const hasSelection = () => {
    const sel = window.getSelection();
    return !!sel && !sel.isCollapsed && !!sel.toString().trim();
  };

  /** 主按钮:按当前状态分派,不能笼统走 toggle(那是"播放/停止"的语义) */
  const onPrimary = () => {
    if (playing) reader.pause();
    else if (paused) reader.resume();
    else void reader.play();
  };

  return (
    <div className="speak-menu" ref={ref}>
      <button
        className={`icon-btn ${on ? 'speak-btn-on' : ''}`}
        title={on ? '朗读控制' : '朗读本文 (s)'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Volume2 size={16} />
      </button>
      {open && (
        <div className="popover speak-popover" role="menu">
          <div className="speak-actions">
            <button
              className="speak-btn"
              onClick={onPrimary}
              disabled={st.status === 'unsupported'}
            >
              {playing || paused ? <Pause size={14} /> : <Play size={14} />}
              {playing ? '暂停' : paused ? '继续' : '朗读全文'}
            </button>
            <button
              className="speak-btn"
              onClick={() => void reader.play({ selection: true })}
              disabled={!on && !hasSelection()}
              title={hasSelection() ? '从当前选中的段落开始' : '先在正文里选中一段文字'}
            >
              从选区开始
            </button>
            <button className="speak-btn" onClick={() => reader.stop()} disabled={!on}>
              <Square size={12} />
              停止
            </button>
          </div>

          {st.total > 0 && (
            <div className="speak-status">
              {on ? (
                <>
                  第 {st.index + 1} / {st.total} 句
                </>
              ) : (
                <>共 {st.total} 句可朗读</>
              )}
            </div>
          )}
          {st.error && <div className="speak-error">{st.error}</div>}

          <label className="speak-row">
            语速 <b>{rate > 0 ? `+${rate}` : rate}</b>
            <input
              type="range"
              min={-10}
              max={10}
              step={1}
              value={rate}
              onChange={(e) => setRate(Number(e.target.value))}
            />
          </label>

          {voices.length > 0 && (
            <label className="speak-row">
              音色
              <select value={voice} onChange={(e) => setVoice(e.target.value)}>
                <option value="">系统默认</option>
                {voices.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name}
                    {v.culture ? `(${v.culture})` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="speak-hint">
            {st.engine === 'web' && '当前由浏览器语音引擎朗读'}{' '}
            {pauseOk ? '' : '该引擎不支持暂停'}
          </div>
        </div>
      )}
    </div>
  );
}