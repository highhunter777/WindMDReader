/**
 * 设置页(T3.4):快捷键改键 + 外观 + 排版 + 在线翻译配置。
 * 模态浮层;由工具栏「更多」或 Ctrl+, 打开,Esc / 点背景关闭。
 * 整体懒加载(用户主动触发才用),不进首屏。
 */
import { useEffect, useRef, useState } from 'react';
import { Keyboard, RotateCcw, X } from 'lucide-react';
import { useStore, type ThemeMode } from '../store';
import './settings.css';
import {
  ACTION_META,
  ACTION_ORDER,
  comboOf,
  comboOwner,
  formatCombo,
  hasModifier,
  type ShortcutAction,
} from '../renderer/shortcuts';

export interface SettingsPageProps {
  onClose: () => void;
}

export function SettingsPage({ onClose }: SettingsPageProps) {
  const ref = useRef<HTMLDivElement>(null);
  const bindings = useStore((s) => s.bindings);
  const setBinding = useStore((s) => s.setBinding);
  const resetBindings = useStore((s) => s.resetBindings);

  /* 改键捕获态:等待用户按下新组合 */
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null);
  const [conflict, setConflict] = useState('');

  /* Esc 关闭(捕获态下先退出捕获) */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (capturing) setCapturing(null);
      else onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [capturing, onClose]);

  /* 捕获新按键:只在捕获态挂监听 */
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const combo = comboOf(e);
      if (!combo || combo === 'escape') {
        setCapturing(null);
        return;
      }
      const owner = comboOwner(bindings, combo, capturing);
      if (owner) {
        setConflict(`「${formatCombo(combo)}」已被「${ACTION_META[owner].name}」占用`);
        return;
      }
      setConflict('');
      setBinding(capturing, combo);
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, bindings, setBinding]);

  const groups: Record<string, ShortcutAction[]> = {};
  for (const a of ACTION_ORDER) {
    const g = ACTION_META[a].group;
    (groups[g] ??= []).push(a);
  }

  return (
    <div className="settings-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings-page" ref={ref} role="dialog" aria-label="设置">
        <header className="settings-head">
          <h2>设置</h2>
          <button className="settings-close" title="关闭 (Esc)" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <section className="settings-section">
          <div className="settings-section-head">
            <h3>
              <Keyboard size={14} /> 快捷键
            </h3>
            <button className="settings-reset" onClick={() => { resetBindings(); setConflict(''); }}>
              <RotateCcw size={12} /> 恢复默认
            </button>
          </div>
          <p className="settings-hint">点击按键后按新的组合完成改键;Esc 取消。序列键(如「G 然后 G」)需在 0.6 秒内按完。</p>
          {conflict && <p className="settings-conflict">{conflict}</p>}
          {Object.entries(groups).map(([g, actions]) => (
            <div className="settings-group" key={g}>
              <h4>{g}</h4>
              {actions.map((a) => (
                <div className="settings-row" key={a}>
                  <span className="settings-row-name">
                    {ACTION_META[a].name}
                    {ACTION_META[a].hint && <em>{ACTION_META[a].hint}</em>}
                  </span>
                  <button
                    className={`settings-key ${capturing === a ? 'capturing' : ''}`}
                    onClick={() => {
                      setConflict('');
                      setCapturing(capturing === a ? null : a);
                    }}
                  >
                    {capturing === a ? '按下新按键…' : formatCombo(bindings[a])}
                    {hasModifier(bindings[a]) ? '' : <span className="settings-key-plain" title="纯键:仅非输入态生效">·</span>}
                  </button>
                </div>
              ))}
            </div>
          ))}
        </section>

        <AppearanceSection />

        <TypographySection />

        <TranslateSection />

        <footer className="settings-foot">
          <span>所有配置仅存本机(localStorage),不发送任何数据</span>
        </footer>
      </div>
    </div>
  );
}

/** 外观:主题三态(浅色 / 深色 / 跟随系统) */
function AppearanceSection() {
  const theme = useStore((s) => s.theme);
  const themeMode = useStore((s) => s.themeMode);
  const setThemeMode = useStore((s) => s.setThemeMode);
  const modes: { m: ThemeMode; label: string }[] = [
    { m: 'light', label: '浅色' },
    { m: 'dark', label: '深色' },
    { m: 'system', label: '跟随系统' },
  ];
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3>外观</h3>
      </div>
      <div className="theme-mode-row" role="radiogroup" aria-label="主题模式">
        {modes.map(({ m, label }) => (
          <button
            key={m}
            role="radio"
            aria-checked={themeMode === m}
            className={`theme-mode-btn ${themeMode === m ? 'active' : ''}`}
            onClick={() => setThemeMode(m)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="settings-hint">
        跟随系统随操作系统明暗自动切换。当前生效:{theme === 'dark' ? '深色' : '浅色'}
        (工具栏按钮 / Ctrl+T 可快速在深浅之间切换)。
      </p>
    </section>
  );
}

/** 排版:当前值一览 + 一键恢复默认 */
function TypographySection() {
  const fontSize = useStore((s) => s.fontSize);
  const readingWidth = useStore((s) => s.readingWidth);
  const fontFamily = useStore((s) => s.fontFamily);
  const setFontSize = useStore((s) => s.setFontSize);
  const setReadingWidth = useStore((s) => s.setReadingWidth);
  const setFontFamily = useStore((s) => s.setFontFamily);
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3>排版</h3>
      </div>
      <p className="settings-hint">
        当前:字号 {fontSize}px · 阅读宽度 {readingWidth}px · {fontFamily === 'sans' ? '无衬线' : '衬线'}。
        也可用工具栏「排版」按钮,或 Ctrl+= / Ctrl+- / Ctrl+0 快捷键调节。
      </p>
      <button
        className="settings-reset"
        onClick={() => {
          setFontSize(17);
          setReadingWidth(720);
          setFontFamily('sans');
        }}
      >
        <RotateCcw size={12} /> 恢复默认排版(17px / 720px / 无衬线)
      </button>
    </section>
  );
}

/** 在线翻译配置(与划词气泡共用同一份 store) */
function TranslateSection() {
  const enabled = useStore((s) => s.translateOnlineEnabled);
  const endpoint = useStore((s) => s.translateEndpoint);
  const model = useStore((s) => s.translateModel);
  const apiKey = useStore((s) => s.translateApiKey);
  const setEnabled = useStore((s) => s.setTranslateOnlineEnabled);
  const setEndpoint = useStore((s) => s.setTranslateEndpoint);
  const setModel = useStore((s) => s.setTranslateModel);
  const setApiKey = useStore((s) => s.setTranslateApiKey);

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3>划词翻译 · 在线端点</h3>
      </div>
      <p className="settings-hint">
        离线词典优先、零网络请求。仅当你启用并填写端点后,划词面板的「在线翻译」才会向该端点请求
        (OpenAI 兼容 chat/completions)。
      </p>
      <label className="settings-field">
        端点(Base URL)
        <input
          value={endpoint}
          placeholder="https://api.openai.com/v1"
          onChange={(e) => setEndpoint(e.target.value)}
          spellCheck={false}
        />
      </label>
      <label className="settings-field">
        模型
        <input
          value={model}
          placeholder="gpt-4o-mini"
          onChange={(e) => setModel(e.target.value)}
          spellCheck={false}
        />
      </label>
      <label className="settings-field">
        API Key(可空)
        <input
          value={apiKey}
          type="password"
          onChange={(e) => setApiKey(e.target.value)}
          spellCheck={false}
        />
      </label>
      <label className="settings-field settings-field-switch">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        启用在线翻译
      </label>
    </section>
  );
}

export default SettingsPage;
