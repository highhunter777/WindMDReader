/**
 * 顶部工具栏:左侧仅剩侧栏开关与文档标题(大纲按钮已移至右侧设置旁),
 * 右侧依次为全库搜索、排版、阅读菜单、导出、朗读、主题、专注模式、大纲、设置。
 */
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import {
  Focus,
  Moon,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Search,
  Star,
  Sun,
  Type,
} from 'lucide-react';
import { useStore } from '../store';
import { getBackend } from '../ipc';
import { FocusMenu } from './FocusMenu';

/**
 * 导出菜单懒加载:它连带 `renderer/export.ts`(导出三件套,约 600 行),
 * 而导出只在用户主动触发时才用得上 —— 静态引入会把整包压进 entry。
 * 空闲时预取,首次点击即可直接弹出。
 */
const ExportMenu = lazy(() => import('./ExportMenu'));

/**
 * 朗读菜单懒加载:它连带 `renderer/reader.ts` + `speak-mark.ts`,
 * 而首屏并不需要朗读能力 —— 放进 entry 会无谓抬高首屏体积(红线 350KB)。
 * 空闲时预取,首次点击即可直接弹出。
 */
const SpeakMenu = lazy(() => import('./SpeakMenu'));

function preload(idleCb: () => void) {
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: object) => void })
    .requestIdleCallback;
  if (typeof idle === 'function') idle(idleCb, { timeout: 3000 });
  else window.setTimeout(idleCb, 2000);
}

function preloadExportMenu() {
  preload(() => void import('./ExportMenu'));
}

function preloadSpeakMenu() {
  preload(() => void import('./SpeakMenu'));
}

function preloadSettingsPage() {
  preload(() => void import('./SettingsPage'));
}

export function Toolbar() {
  const meta = useStore((s) => s.meta);
  const activePath = useStore((s) => s.activePath);
  const theme = useStore((s) => s.theme);
  const themeMode = useStore((s) => s.themeMode);
  const zen = useStore((s) => s.zen);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const tocVisible = useStore((s) => s.tocVisible);
  const panelTab = useStore((s) => s.panelTab);
  const setPanelTab = useStore((s) => s.setPanelTab);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const setTocVisible = useStore((s) => s.setTocVisible);

  /* 空闲时预取导出/朗读/设置 chunk */
  useEffect(() => {
    preloadExportMenu();
    preloadSpeakMenu();
    preloadSettingsPage();
  }, []);

  const toggleStar = async () => {
    const s = useStore.getState();
    if (!s.activePath || !s.meta) return;
    const next = !s.meta.starred;
    try {
      await (await getBackend()).setMeta(s.activePath, { starred: next });
      s.setMeta({ ...s.meta, starred: next });
    } catch (e) {
      console.error(e);
    }
  };

  if (zen) return null;

  return (
    <header className="toolbar">
      <div className="toolbar-left">
        <button
          className="icon-btn"
          title="侧栏 (Ctrl+B)"
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          <PanelLeft size={16} />
        </button>
        <div className="doc-title">
          <span className="doc-name">{meta?.title ?? 'WindMD'}</span>
          {activePath && <span className="doc-path">{activePath}</span>}
          {activePath && (
            <button
              className={`icon-btn star-btn ${meta?.starred ? 'starred' : ''}`}
              title={meta?.starred ? '取消收藏' : '收藏本文档'}
              onClick={() => void toggleStar()}
            >
              <Star size={14} fill={meta?.starred ? 'currentColor' : 'none'} />
            </button>
          )}
        </div>
      </div>

      <div className="toolbar-right">
        <button
          className="icon-btn"
          title="全库搜索 (Ctrl+Shift+F)"
          onClick={() => {
            // 搜索面板的可见条件 = 侧栏展开 && 页签为 search,两者缺一都看不到东西:
            // 已在搜索面板时再点一次收起,否则展开侧栏并切到搜索页签
            if (sidebarOpen && panelTab === 'search') {
              setSidebarOpen(false);
            } else {
              setSidebarOpen(true);
              setPanelTab('search');
            }
          }}
        >
          <Search size={16} />
        </button>
        <FontSizePicker />
        <FocusMenu />
        <Suspense fallback={null}>
          <ExportMenu />
        </Suspense>
        <Suspense fallback={null}>
          <SpeakMenu />
        </Suspense>
        <button
          className="icon-btn"
          title={`主题:${themeMode === 'system' ? '跟随系统' : themeMode === 'dark' ? '深色' : '浅色'}`}
          onClick={() => useStore.getState().toggleTheme()}
        >
          {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
        </button>
        <button className="icon-btn zen-btn" title="专注模式 (z z)" onClick={() => useStore.getState().toggleZen()}>
          <Focus size={16} />
        </button>
        <button className="icon-btn" title="大纲 (Ctrl+Shift+B)" onClick={() => setTocVisible(!tocVisible)}>
          <PanelRight size={16} />
        </button>
        <button
          className="icon-btn"
          title="设置 (Ctrl+,)"
          onClick={() => document.dispatchEvent(new CustomEvent('windmd:open-settings'))}
        >
          <MoreHorizontal size={16} />
        </button>
      </div>
    </header>
  );
}

function FontSizePicker() {
  const fontSize = useStore((s) => s.fontSize);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="font-picker" ref={ref}>
      <button className="icon-btn" title="排版" onClick={() => setOpen(!open)}>
        <Type size={16} />
      </button>
      {open && (
        <div className="popover">
          <label>
            字号 <b>{fontSize}px</b>
            <input
              type="range"
              min={14}
              max={22}
              step={1}
              value={fontSize}
              onChange={(e) => useStore.getState().setFontSize(Number(e.target.value))}
            />
          </label>
          <label>
            阅读宽度 <b>{useStore.getState().readingWidth}px</b>
            <input
              type="range"
              min={560}
              max={1000}
              step={20}
              value={useStore.getState().readingWidth}
              onChange={(e) => useStore.getState().setReadingWidth(Number(e.target.value))}
            />
          </label>
          <div className="font-family-row">
            <button onClick={() => useStore.getState().setFontFamily('sans')}>无衬线</button>
            <button onClick={() => useStore.getState().setFontFamily('serif')}>衬线</button>
          </div>
        </div>
      )}
    </div>
  );
}
