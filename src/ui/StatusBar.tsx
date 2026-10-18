/**
 * 底部状态栏:字数、渲染耗时、滚动位置。
 */
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { containerProgress, scrollContainer } from '../renderer/scroll';

export function StatusBar() {
  const zen = useStore((s) => s.zen);
  const renderMs = useStore((s) => s.renderMs);
  const content = useStore((s) => s.content);
  const activePath = useStore((s) => s.activePath);
  const [percent, setPercent] = useState(0);
  const [chars, setChars] = useState(0);

  useEffect(() => setChars(content.length), [content]);

  useEffect(() => {
    // 滚动容器是 `.main`(窗口本身不滚动),必须监听该元素
    const scroller = scrollContainer();
    if (!scroller) return;
    const onScroll = () => setPercent(Math.round(containerProgress(scroller) * 100));
    scroller.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [content]);

  if (zen) return null;
  if (!activePath) return null;

  return (
    <footer className="statusbar">
      <span>{chars.toLocaleString()} 字符</span>
      <span>渲染 {renderMs}ms</span>
      <span className="statusbar-spacer" />
      <span>{activePath}</span>
      <span>{percent}%</span>
    </footer>
  );
}
