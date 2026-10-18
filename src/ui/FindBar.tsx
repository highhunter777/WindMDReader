/**
 * 查找条:`Ctrl+F` 打开,输入关键词高亮正文,支持逐个跳转与循环。
 */
import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useStore } from '../store';

export function FindBar() {
  const findOpen = useStore((s) => s.findOpen);
  const findQuery = useStore((s) => s.findQuery);
  const setFindQuery = useStore((s) => s.setFindQuery);
  const setFindOpen = useStore((s) => s.setFindOpen);
  const inputRef = useRef<HTMLInputElement>(null);

  const { total, current, goto } = useFindNavigation();

  /* 打开时聚焦并选中既有关键词,便于直接改写 */
  useEffect(() => {
    if (findOpen) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [findOpen]);

  /* 关闭时清空查询,避免下次打开残留高亮 */
  useEffect(() => {
    if (!findOpen) setFindQuery('');
  }, [findOpen, setFindQuery]);

  if (!findOpen) return null;

  return (
    <div className="find-bar">
      <input
        ref={inputRef}
        className="find-input"
        placeholder="查找…"
        value={findQuery}
        onChange={(e) => setFindQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            goto(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setFindOpen(false);
          }
        }}
      />
      <span className="find-count">
        {findQuery ? (total === 0 ? '无结果' : `${current + 1}/${total}`) : ''}
      </span>
      <button className="find-btn" title="上一个 (Shift+Enter)" disabled={total === 0} onClick={() => goto(-1)}>
        <ChevronUp size={14} />
      </button>
      <button className="find-btn" title="下一个 (Enter)" disabled={total === 0} onClick={() => goto(1)}>
        <ChevronDown size={14} />
      </button>
      <button className="find-btn" title="关闭 (Esc)" onClick={() => setFindOpen(false)}>
        <X size={14} />
      </button>
    </div>
  );
}

/**
 * 读取当前高亮状态并提供跳转能力。
 * Viewer 负责实际高亮,并把命中数与当前下标同步到 store,这里只做交互。
 */
function useFindNavigation() {
  const total = useStore((s) => s.findTotal);
  const current = useStore((s) => s.findIndex);
  const findQuery = useStore((s) => s.findQuery);

  const goto = (dir: 1 | -1) => {
    if (!total) return;
    // 由 Viewer 监听该事件执行实际滚动,避免此处直接依赖 DOM
    const next = (current + dir + total) % total;
    document.dispatchEvent(
      new CustomEvent('windmd:find-goto', { detail: { index: next, query: findQuery } }),
    );
  };

  return { total, current, goto };
}