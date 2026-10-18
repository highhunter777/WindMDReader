/**
 * App 骨架:布局 + 全局快捷键 + 启动流程。
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import { useStore } from './store';
import { getBackend } from './ipc';
import { scrollContainer } from './renderer/scroll';
import { loadVaultContents, openVaultWithPicker } from './open-vault';
import {
  ACTION_ORDER,
  SEQUENCE_WINDOW_MS,
  actionForCombo,
  comboOf,
  hasModifier,
  type ShortcutAction,
} from './renderer/shortcuts';
import { Toolbar } from './ui/Toolbar';
import { FindBar } from './ui/FindBar';
import { Lightbox } from './ui/Lightbox';
import { Sidebar } from './ui/Sidebar';
import { Viewer } from './ui/Viewer';
import { Outliner } from './ui/Outliner';
import { StatusBar } from './ui/StatusBar';
import { ErrorBoundary } from './ui/ErrorBoundary';

/** 设置页懒加载:用户主动触发才用,不进首屏 */
const SettingsPage = lazy(() => import('./ui/SettingsPage'));

export default function App() {
  const theme = useStore((s) => s.theme);
  const activePath = useStore((s) => s.activePath);
  const zen = useStore((s) => s.zen);
  const [settingsOpen, setSettingsOpen] = useState(false);

  /* --- 主题属性 --- */
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  /* --- 启动:打开默认库并加载最近文件 --- */
  useEffect(() => {
    void (async () => {
      // 整体 try 包裹:启动链任何一步失败都不该变成未捕获的
      // Promise rejection(会在控制台刷错误、测试里变成 unhandled error)
      try {
        const b = await getBackend();
        // 优先复用上次的库;路径已失效(库被移动/删除)时回退到系统选择框
        const saved = localStorage.getItem('windmd-vault');
        if (saved) {
          try {
            await loadVaultContents(await b.openVault(saved));
            return;
          } catch {
            /* 路径失效:走选择框 */
          }
        }
        await openVaultWithPicker();
      } catch (e) {
        console.error(e);
      }
    })();
  }, []);

  /* --- 文件监视 --- */
  useEffect(() => {
    let unlistener: (() => void) | undefined;
    void getBackend().then((b) => {
      unlistener = b.onFileChanged((paths) => {
        const active = useStore.getState().activePath;
        if (active && paths.includes(active)) {
          void b.readFile(active).then((f) => {
            if (useStore.getState().activePath === active) {
              useStore.getState().openDoc(f.path, f.content, useStore.getState().meta);
            }
          });
        }
      });
    });
    return () => unlistener?.();
  }, []);

  /* --- 全局快捷键(绑定可在设置页改键) --- */
  useEffect(() => {
    /* 序列键第一段(如 `g g` / `z z`) */
    let seqFirst = '';
    let seqAt = 0;

    const run = (s: ReturnType<typeof useStore.getState>, a: ShortcutAction) => {
      // 滚动容器是 `.main`(窗口本身不滚动),window 的滚动 API 在此是空操作
      const sc = scrollContainer();
      switch (a) {
        case 'open-vault':
          void openVaultWithPicker();
          break;
        case 'find':
          s.setFindOpen(!s.findOpen);
          break;
        case 'global-search':
          // 侧栏可能处于收起状态:只切页签的话侧栏根本不渲染,必须一并展开
          s.setSidebarOpen(true);
          s.setPanelTab('search');
          break;
        case 'toggle-sidebar':
          s.setSidebarOpen(!s.sidebarOpen);
          break;
        case 'toggle-toc':
          s.setTocVisible(!s.tocVisible);
          break;
        case 'toggle-theme':
          s.toggleTheme();
          break;
        case 'zoom-in':
          s.setFontSize(Math.min(22, s.fontSize + 1));
          break;
        case 'zoom-out':
          s.setFontSize(Math.max(14, s.fontSize - 1));
          break;
        case 'zoom-reset':
          s.setFontSize(17);
          break;
        case 'export-menu':
          document.dispatchEvent(new CustomEvent('windmd:open-export'));
          break;
        case 'open-settings':
          setSettingsOpen(true);
          break;
        case 'scroll-down':
          sc?.scrollBy({ top: 48, behavior: 'smooth' });
          break;
        case 'scroll-up':
          sc?.scrollBy({ top: -48, behavior: 'smooth' });
          break;
        case 'scroll-top':
          if (sc) sc.scrollTo({ top: 0, behavior: 'smooth' });
          break;
        case 'scroll-bottom':
          if (sc) sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' });
          break;
        case 'prev-heading':
        case 'next-heading': {
          const dir = a === 'next-heading' ? 1 : -1;
          const headings = s.headings;
          if (!headings.length || !sc) break;
          const current = headings.find((h) => {
            const el = document.getElementById(h.id);
            return el && el.getBoundingClientRect().top > 72;
          });
          let target = headings[0];
          if (current) {
            const idx = headings.indexOf(current);
            target = headings[Math.max(0, Math.min(headings.length - 1, idx + dir))];
          } else if (dir === -1) {
            target = headings[headings.length - 1];
          }
          const el = document.getElementById(target.id);
          if (el) {
            const y = el.getBoundingClientRect().top + sc.scrollTop - 72;
            sc.scrollTo({ top: y, behavior: 'smooth' });
          }
          break;
        }
        case 'zen':
          s.toggleZen();
          break;
        case 'focus-line':
          s.toggleFocusLine();
          break;
        case 'typewriter':
          s.toggleTypewriter();
          break;
        case 'speak':
          // 动态引入以免把朗读器(及其 DOM 高亮逻辑)压进首屏
          void import('./renderer/reader').then((m) => m.getReader().toggle());
          break;
      }
    };

    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();

      // Esc 始终生效(不参与改键):退出专注/关查找与搜索
      if (e.key === 'Escape') {
        if (s.zen) s.toggleZen();
        s.setFindOpen(false);
        return;
      }

      const target = e.target as HTMLElement;
      const inInput = /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable;
      const bindings = s.bindings;
      const combo = comboOf(e);
      if (!combo) return;

      // 序列绑定第二段(窗口期内)
      if (seqFirst && Date.now() - seqAt < SEQUENCE_WINDOW_MS) {
        const seqAction = actionForCombo(bindings, `${seqFirst} ${combo}`);
        if (seqAction) {
          e.preventDefault();
          seqFirst = '';
          run(s, seqAction);
          return;
        }
      }

      const single = actionForCombo(bindings, combo);
      if (single) {
        // 纯键绑定只在非输入态生效,避免与键入抢键
        if (inInput && !hasModifier(combo)) return;
        e.preventDefault();
        seqFirst = '';
        run(s, single);
        return;
      }

      // 记录可能的序列第一段(纯键、非输入态)
      seqFirst =
        !inInput && !e.ctrlKey && !e.metaKey && !e.altKey && ACTION_ORDER.some((a) => bindings[a].startsWith(`${combo} `))
          ? combo
          : '';
      seqAt = Date.now();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* --- 工具栏「更多」→ 打开设置 --- */
  useEffect(() => {
    const onOpen = () => setSettingsOpen(true);
    document.addEventListener('windmd:open-settings', onOpen);
    return () => document.removeEventListener('windmd:open-settings', onOpen);
  }, []);

  return (
    <div className={`app ${zen ? 'app-zen' : ''}`}>
      <Toolbar />
      <FindBar />
      <div className="app-body">
        {/* 三个区域各自兜底:一侧崩溃不会把整个应用拖成白屏 */}
        <ErrorBoundary title="文件树加载出错">
          <Sidebar />
        </ErrorBoundary>
        <main className="main">
          {/* resetKey = 当前文档:渲染管线异常后,切到另一篇即自愈 */}
          <ErrorBoundary resetKey={activePath ?? ''} title="文档加载出错">
            <Viewer />
          </ErrorBoundary>
        </main>
        <ErrorBoundary title="面板加载出错">
          <Outliner />
        </ErrorBoundary>
      </div>
      <StatusBar />
      <Lightbox />
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsPage onClose={() => setSettingsOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}
