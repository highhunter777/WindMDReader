/**
 * 导出菜单:单文件 HTML / PDF(打印流)/ 长图 PNG。
 * 导出来自当前正文 DOM(高亮与公式已渲染),与屏幕所见一致。
 */
import { useEffect, useRef, useState } from 'react';
import { FileDown } from 'lucide-react';
import { useStore } from '../store';
import { errMsg } from '../ipc/errors';
import {
  exportHtmlFile,
  exportLongImage,
  exportPdf,
  type ExportDocInfo,
} from '../renderer/export';

type ExportKind = 'html' | 'pdf' | 'png';

const LABELS: Record<ExportKind, { title: string; hint: string }> = {
  html: { title: '导出 HTML', hint: '单文件,图片/样式内联,可直接分享' },
  pdf: { title: '导出 PDF', hint: '打印流排版,可另存为 PDF' },
  png: { title: '导出长图', hint: '整页截图,适合发博客/社交平台' },
};

export function ExportMenu() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportKind | null>(null);
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const meta = useStore((s) => s.meta);
  const activePath = useStore((s) => s.activePath);
  const theme = useStore((s) => s.theme);
  const fontSize = useStore((s) => s.fontSize);
  const readingWidth = useStore((s) => s.readingWidth);
  const fontFamily = useStore((s) => s.fontFamily);

  /* 点击菜单外关闭 */
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  /* 快捷键(Ctrl+P)打开:菜单本身懒加载,事件常驻无成本 */
  useEffect(() => {
    const onOpen = () => setOpen(true);
    document.addEventListener('windmd:open-export', onOpen);
    return () => document.removeEventListener('windmd:open-export', onOpen);
  }, []);

  const docInfo = (): ExportDocInfo | null => {
    if (!activePath) return null;
    return {
      title: meta?.title ?? activePath.split('/').pop() ?? activePath,
      sourcePath: activePath,
      theme,
      fontSize,
      fontFamily,
    };
  };

  const run = async (kind: ExportKind) => {
    const article = document.querySelector<HTMLElement>('.prose');
    const info = docInfo();
    if (!article || !info) return;
    setBusy(kind);
    setError('');
    try {
      if (kind === 'html') await exportHtmlFile(article, info);
      else if (kind === 'pdf') await exportPdf(article, info);
      else await exportLongImage(article, info, Math.min(860, Math.max(360, readingWidth)));
      setOpen(false);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const item = (kind: ExportKind) => (
    <button
      key={kind}
      className="export-item"
      disabled={busy !== null}
      onClick={() => void run(kind)}
    >
      <span className="export-item-title">{busy === kind ? '导出中…' : LABELS[kind].title}</span>
      <span className="export-item-hint">{LABELS[kind].hint}</span>
    </button>
  );

  return (
    <div className="export-menu" ref={ref}>
      <button
        className="icon-btn"
        title="导出"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          setError('');
        }}
      >
        <FileDown size={16} />
      </button>
      {open && (
        <div className="popover export-popover" role="menu">
          {!activePath && <p className="export-empty">请先打开一篇文档</p>}
          {activePath && (
            <>
              {item('html')}
              {item('pdf')}
              {item('png')}
            </>
          )}
          {error && <p className="export-error">{error}</p>}
        </div>
      )}
    </div>
  );
}

/** 默认导出供 Toolbar 的 React.lazy 使用(导出为按需能力,不进首屏) */
export default ExportMenu;
