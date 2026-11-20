/**
 * 编辑功能与 App 的接线:
 * 快捷键迁移、Ctrl+E 进出编辑、切文档前保存、Esc 落盘退出、只读路径不受影响。
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { useStore } from '../src/store';
import { DEFAULT_BINDINGS, migrateBindings } from '../src/renderer/shortcuts';
import { __resetSaver } from '../src/editor/session';
import { startEditing } from '../src/editor/actions';
import { __resetEditingGuards } from '../src/editor/lifecycle';

const NL = String.fromCharCode(10);
const DOC = `# 标题${NL}${NL}正文${NL}`;
const writes: Array<{ path: string; content: string }> = [];

vi.mock('../src/ipc', () => {
  const backend = {
    mode: 'mock' as const,
    speech: {
      ready: async () => false,
      voices: async () => [],
      say: async () => 'cancelled' as const,
      pause: async () => false,
      resume: async () => false,
      cancel: async () => {},
      supportsPause: async () => false,
    },
    // 模拟「用户取消了选择库」:启动流程就此收手,不会用另一篇文档覆盖
    // 用例预设的草稿(App 启动会 openDoc,那会把 draft/baseline 一起换掉)
    openVault: async () => {
      throw { code: 'CANCELLED', message: '用户取消' };
    },
    openPath: async () => {
      throw new Error('unsupported');
    },
    takeOpenFile: async () => null,
    onOpenFile: () => () => {},
    listFiles: async () => [],
    readFile: async (path: string) => ({ path, content: '# 文件', mtime: 0, size: 4 }),
    writeFile: async (path: string, content: string) => {
      writes.push({ path, content });
    },
    createFile: async () => {},
    deleteFile: async () => {},
    renameFile: async () => {},
    search: async () => ({ total: 0, hits: [], tookMs: 0 }),
    getMeta: async () => null,
    setMeta: async () => {},
    recentFiles: async () => [],
    starredFiles: async () => [],
    getLinks: async () => ({ outgoing: [], backlinks: [] }),
    listTags: async () => [],
    docsByTag: async () => [],
    onFileChanged: () => () => {},
  };
  return { getBackend: async () => backend };
});

beforeEach(() => {
  writes.length = 0;
  __resetSaver();
  __resetEditingGuards();
  useStore.setState({
    activePath: 'a.md',
    content: DOC,
    draft: DOC,
    previewSource: DOC,
    baseline: DOC,
    editing: false,
    dirty: false,
    saving: false,
    saveError: '',
    conflict: null,
    autoSave: false,
    zen: false,
    sidebarOpen: true,
    findOpen: false,
    bindings: { ...DEFAULT_BINDINGS },
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('绑定迁移 — Ctrl+E 让位给编辑', () => {
  it('存的是旧默认 ctrl+e → 主题迁移到 ctrl+shift+e,ctrl+e 给编辑', () => {
    const out = migrateBindings({ 'toggle-theme': 'ctrl+e' }, DEFAULT_BINDINGS);
    expect(out['toggle-theme']).toBe('ctrl+shift+e');
    expect(out['toggle-edit']).toBe('ctrl+e');
  });

  it('用户特意改过主题键 → 不动他的选择', () => {
    const out = migrateBindings({ 'toggle-theme': 'alt+t' }, DEFAULT_BINDINGS);
    expect(out['toggle-theme']).toBe('alt+t');
    expect(out['toggle-edit']).toBe('ctrl+e');
  });

  it('旧配置里没有编辑动作 → 自动补上默认绑定(不失效)', () => {
    const out = migrateBindings({ scrollDownX: 'x' }, DEFAULT_BINDINGS);
    expect(out['toggle-edit']).toBe('ctrl+e');
  });

  it('迁移后两个动作不会抢同一个键', () => {
    const out = migrateBindings({ 'toggle-theme': 'ctrl+e', 'toggle-edit': 'ctrl+e' }, DEFAULT_BINDINGS);
    expect(out['toggle-theme']).not.toBe(out['toggle-edit']);
  });

  it('用户手工绑过编辑键 → 保留', () => {
    const out = migrateBindings({ 'toggle-edit': 'alt+m' }, DEFAULT_BINDINGS);
    expect(out['toggle-edit']).toBe('alt+m');
  });
});

describe('App — Ctrl+E 进出编辑', () => {
  it('有文档时进入编辑态', async () => {
    render(<App />);
    fireEvent.keyDown(window, { key: 'e', ctrlKey: true });
    await waitFor(() => expect(useStore.getState().editing).toBe(true));
  });

  it('无文档时按下不进入编辑(避免空草稿)', () => {
    useStore.setState({ activePath: null, content: '', draft: '' });
    render(<App />);
    fireEvent.keyDown(window, { key: 'e', ctrlKey: true });
    expect(useStore.getState().editing).toBe(false);
  });

  it('进入编辑会关掉焦点行/打字机(分栏下会误伤预览)', () => {
    useStore.setState({ focusLine: true, typewriter: true });
    render(<App />);
    act(() => startEditing());
    expect(useStore.getState().focusLine).toBe(false);
    expect(useStore.getState().typewriter).toBe(false);
  });

  it('Esc 在编辑态先落盘再退出', async () => {
    useStore.setState({ editing: true, draft: '# 改过', dirty: true });
    render(<App />);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(writes.at(-1)).toEqual({ path: 'a.md', content: '# 改过' }));
    await waitFor(() => expect(useStore.getState().editing).toBe(false));
  });

  it('Ctrl+E 在编辑态再次按下可退出', async () => {
    useStore.setState({ editing: true });
    render(<App />);
    fireEvent.keyDown(window, { key: 'e', ctrlKey: true });
    await waitFor(() => expect(useStore.getState().editing).toBe(false));
  });
});

describe('App — 切换文档前的草稿保护', () => {
  /* 守卫由 startEditing 安装(只在编辑过之后才需要),所以这里显式进入编辑态,
     不能靠 setState 直接置 editing —— 那会绕过守卫的安装,测出假绿。 */
  const enterEditing = (patch: Record<string, unknown> = {}) => {
    act(() => startEditing());
    act(() => useStore.setState(patch));
  };

  it('有未保存改动时切走 → 写回原路径', async () => {
    enterEditing({ draft: '# 旧文档改过', dirty: true });
    render(<App />);
    act(() => {
      useStore.getState().openDoc('b.md', '# 新文档', null);
    });
    await waitFor(() => expect(writes).toEqual([{ path: 'a.md', content: '# 旧文档改过' }]));
  });

  it('无改动时切走不产生写入', async () => {
    enterEditing({ draft: DOC, dirty: false });
    render(<App />);
    act(() => {
      useStore.getState().openDoc('b.md', '# 新文档', null);
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(writes).toHaveLength(0);
  });

  it('切文档会把草稿与基准重置成新文档内容', () => {
    enterEditing({ draft: 'dirty', dirty: true });
    act(() => {
      useStore.getState().openDoc('c.md', '# c', null);
    });
    const s = useStore.getState();
    expect(s.draft).toBe('# c');
    expect(s.baseline).toBe('# c');
    expect(s.dirty).toBe(false);
    // 编辑态本身保留(继续写下一篇,不打断动线)
    expect(s.editing).toBe(true);
  });
});

describe('阅读态不受影响(回归)', () => {
  it('不进编辑时正文仍走原渲染管线', async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelector('.main .prose')).not.toBeNull());
    expect(document.querySelector('.editor-split')).toBeNull();
  });

  it('编辑态下不渲染阅读用的 .prose 容器(避免两份 DOM)', async () => {
    act(() => startEditing());
    render(<App />);
    await waitFor(() => expect(document.querySelector('.editor-split')).not.toBeNull());
    // 阅读态容器(.main > .viewer > article.prose)不再存在
    expect(document.querySelector('.main .viewer > article.prose')).toBeNull();
  });
});
