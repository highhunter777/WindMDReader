/**
 * 阅读模式菜单:焦点行(淡出非当前段落)+ 打字机(当前段对齐视口锚点行)。
 * 两个开关独立,可单独使用;快捷键 f / t。
 */
import { useEffect, useRef, useState } from 'react';
import { Crosshair } from 'lucide-react';
import { useStore } from '../store';

export function FocusMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const focusLine = useStore((s) => s.focusLine);
  const typewriter = useStore((s) => s.typewriter);
  const toggleFocusLine = useStore((s) => s.toggleFocusLine);
  const toggleTypewriter = useStore((s) => s.toggleTypewriter);

  /* 点击菜单外关闭 */
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const row = (
    key: 'focus' | 'typewriter',
    label: string,
    hint: string,
    shortcut: string,
    on: boolean,
    toggle: () => void,
  ) => (
    <button
      key={key}
      className={`focus-row ${on ? 'on' : ''}`}
      role="menuitemcheckbox"
      aria-checked={on}
      onClick={toggle}
    >
      <span className="focus-check" aria-hidden="true">
        {on ? '✓' : ''}
      </span>
      <span className="focus-row-text">
        <span className="focus-row-label">{label}</span>
        <span className="focus-row-hint">{hint}</span>
      </span>
      <kbd className="focus-row-key">{shortcut}</kbd>
    </button>
  );

  const anyOn = focusLine || typewriter;

  return (
    <div className="export-menu" ref={ref}>
      <button
        className={`icon-btn ${anyOn ? 'focus-btn-on' : ''}`}
        title="阅读模式"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Crosshair size={16} />
      </button>
      {open && (
        <div className="popover export-popover focus-popover" role="menu">
          {row('focus', '焦点行', '淡出其余段落,只留当前段', 'f', focusLine, toggleFocusLine)}
          {row('typewriter', '打字机', '当前段始终停在视口锚点行', 't', typewriter, toggleTypewriter)}
        </div>
      )}
    </div>
  );
}
