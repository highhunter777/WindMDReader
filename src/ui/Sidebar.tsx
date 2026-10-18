/**
 * 左侧栏:文件树 + 全文搜索 + 收藏,多 Tab。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  Pencil,
  Search,
  Star,
  Trash2,
  Upload,
} from 'lucide-react';
import { getBackend } from '../ipc';
import { errMsg } from '../ipc/errors';
import { openVaultWithPicker } from '../open-vault';
import type { DocumentMeta, FileEntry } from '../types';
import { useStore } from '../store';

export function Sidebar() {
  const open = useStore((s) => s.sidebarOpen);
  const tab = useStore((s) => s.panelTab);
  const setTab = useStore((s) => s.setPanelTab);
  if (!open) return null;
  return (
    <aside className="sidebar">
      <div className="sidebar-tabs">
        <button className={`tab ${tab === 'files' ? 'active' : ''}`} onClick={() => setTab('files')}>
          文件
        </button>
        <button className={`tab ${tab === 'search' ? 'active' : ''}`} onClick={() => setTab('search')}>
          搜索
        </button>
        <button className={`tab ${tab === 'starred' ? 'active' : ''}`} onClick={() => setTab('starred')}>
          收藏
        </button>
      </div>
      {tab === 'files' ? <FileTree /> : tab === 'search' ? <SearchPanel /> : <StarredPanel />}
    </aside>
  );
}

/* ---------------- 工具 ---------------- */

const parentDir = (path: string) => path.split('/').slice(0, -1).join('/') || '/';

const joinPath = (dir: string, name: string) => (dir === '/' ? name : `${dir}/${name}`);

const hasTextExt = (name: string) => /\.(md|markdown|txt)$/i.test(name);

/** 新建时补全 .md 后缀,与后端 is_markdown 判定保持一致 */
const withDefaultExt = (name: string) => (hasTextExt(name) ? name : `${name}.md`);

/* ---------------- 文件树 ---------------- */

interface TreeOps {
  renaming: string | null;
  setRenaming(p: string | null): void;
  creatingIn: string | null;
  setCreatingIn(dir: string | null): void;
}

function FileTree() {
  const [cache, setCache] = useState<Record<string, FileEntry[]>>({});
  const activePath = useStore((s) => s.activePath);
  const vault = useStore((s) => s.vault);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<FileEntry | null>(null);
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState('');

  /** 拉取(并缓存)某个目录的条目;force 时强制刷新 */
  const loadDir = useCallback(async (dir: string, force = false) => {
    if (!force && cache[dir]) return cache[dir];
    const list = await (await getBackend()).listFiles(dir);
    setCache((c) => ({ ...c, [dir]: list }));
    return list;
  }, [cache]);

  const refresh = useCallback(
    async (dir: string) => {
      const list = await (await getBackend()).listFiles(dir);
      setCache((c) => ({ ...c, [dir]: list }));
      setError('');
    },
    [],
  );

  /* 根目录:等库就绪后再拉。
     库由 App 启动流程异步打开(首次可能还要弹系统选择框),若组件挂载就
     立刻 listFiles,必然撞上 NO_VAULT —— 那时错误条里会出现一行无意义的
     提示,且没有任何重试,树会一直空着。这里改为跟着 vault 走。 */
  useEffect(() => {
    if (!vault) return;
    setCache({});
    void (async () => {
      try {
        const list = await (await getBackend()).listFiles('/');
        setCache({ '/': list });
        setError('');
      } catch (e) {
        setError(errMsg(e));
      }
    })();
    // 不在此处调用 openVault():无路径的 openVault 会弹系统选择框,
    // 组件重挂载时反复弹出会抢焦点、吞掉用户键入(表现为新建/重命名"无效")。
    // 需要换库请点「打开库」。
  }, [vault]);

  const openFile = async (entry: FileEntry) => {
    try {
      const b = await getBackend();
      const f = await b.readFile(entry.path);
      const meta = await b.getMeta(entry.path);
      useStore.getState().openDoc(f.path, f.content, meta);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  /* --- 增删改 --- */

  const createIn = async (dir: string, rawName: string) => {
    const name = rawName.trim();
    if (!name) return;
    const path = joinPath(dir, withDefaultExt(name));
    try {
      const b = await getBackend();
      await b.createFile(path);
      await refresh(dir);
      await openFile({ path, name, isDir: false, kind: 'file' });
      setCreatingIn(null);
      setError('');
    } catch (e) {
      console.error('[WindMD] 新建文件失败', path, e);
      setError(errMsg(e));
    }
  };

  const rename = async (from: string, rawName: string) => {
    const name = rawName.trim();
    if (!name) return;
    const to = joinPath(parentDir(from), withDefaultExt(name));
    if (to === from) {
      setRenaming(null);
      return;
    }
    try {
      const b = await getBackend();
      await b.renameFile(from, to);
      await refresh(parentDir(from));
      // 重命名当前打开的文件:跟随新路径重开,保留阅读位置语义
      if (useStore.getState().activePath === from) {
        const f = await b.readFile(to);
        const meta = await b.getMeta(to);
        useStore.getState().openDoc(f.path, f.content, meta);
      }
      setRenaming(null);
      setError('');
    } catch (e) {
      console.error('[WindMD] 重命名失败', from, '->', to, e);
      setError(errMsg(e));
    }
  };

  const remove = async (entry: FileEntry) => {
    try {
      const b = await getBackend();
      await b.deleteFile(entry.path);
      await refresh(parentDir(entry.path));
      if (useStore.getState().activePath === entry.path) {
        useStore.getState().openDoc('', '', null);
      }
      setConfirmDelete(null);
      setMenu(null);
      setError('');
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const ops: TreeOps = { renaming, setRenaming, creatingIn, setCreatingIn };
  const root = cache['/'] ?? [];

  return (
    <div className="file-tree">
      <div className="file-tree-actions">
        <button title="打开库目录" onClick={() => void openVaultWithPicker()}>
          <Upload size={14} /> 打开库
        </button>
        <button title="在库根新建文件" onClick={() => setCreatingIn(creatingIn ? null : '/')}>
          <FilePlus2 size={14} /> 新建
        </button>
      </div>

      {root.map((entry) => (
        <TreeNode
          key={entry.path}
          entry={entry}
          onOpen={openFile}
          activePath={activePath}
          depth={0}
          ops={ops}
          loadDir={loadDir}
          onCreateIn={setCreatingIn}
          onRenameStart={(e) => setRenaming(e.path)}
          onRename={rename}
          onAskDelete={(e) => {
            setConfirmDelete(e);
            setMenu((m) => (m && m.entry.path === e.path ? m : { x: -1, y: -1, entry: e }));
          }}
          onContextMenu={(x, y, entry) => {
            setMenu({ x, y, entry });
            setConfirmDelete(null);
          }}
        />
      ))}
      {creatingIn === '/' && (
        <NewNameRow
          depth={0}
          onCommit={(name) => void createIn('/', name)}
          onCancel={() => setCreatingIn(null)}
        />
      )}

      {root.length === 0 && !creatingIn && <div className="empty-tip">内置示例文档见「打开库」</div>}
      {error && <div className="tree-error">{error}</div>}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          entry={menu.entry}
          confirmDelete={confirmDelete}
          onClose={() => {
            setMenu(null);
            setConfirmDelete(null);
          }}
          onCreateIn={(dir) => {
            setCreatingIn(dir);
            setMenu(null);
          }}
          onRenameStart={(entry) => {
            setRenaming(entry.path);
            setMenu(null);
          }}
          onAskDelete={setConfirmDelete}
          onConfirmDelete={() => void remove(menu.entry)}
        />
      )}
    </div>
  );
}

function TreeNode({
  entry,
  onOpen,
  activePath,
  depth,
  ops,
  loadDir,
  onCreateIn,
  onRenameStart,
  onRename,
  onAskDelete,
  onContextMenu,
}: {
  entry: FileEntry;
  onOpen: (e: FileEntry) => void;
  activePath: string | null;
  depth: number;
  ops: TreeOps;
  loadDir: (dir: string, force?: boolean) => Promise<FileEntry[]>;
  onCreateIn: (dir: string) => void;
  onRenameStart: (e: FileEntry) => void;
  onRename: (from: string, to: string) => void;
  onAskDelete: (e: FileEntry) => void;
  onContextMenu: (x: number, y: number, e: FileEntry) => void;
}) {
  const [expanded, setExpanded] = useState(depth === 0);
  const [children, setChildren] = useState<FileEntry[]>([]);
  const isMarkdown = hasTextExt(entry.name);

  const createFileIn = async (dir: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const path = joinPath(dir, withDefaultExt(trimmed));
    try {
      const b = await getBackend();
      await b.createFile(path);
      const list = await b.listFiles(dir);
      setChildren(list);
      ops.setCreatingIn(null);
      await onOpen({ path, name, isDir: false, kind: 'file' });
    } catch (e) {
      // 新建失败时保持输入框,交由全局错误提示
      console.error('[WindMD] 新建文件失败', path, e);
    }
  };

  const toggle = async () => {
    if (!entry.isDir) {
      onOpen(entry);
      return;
    }
    const next = !expanded;
    setExpanded(next);
    if (next && !children.length) {
      try {
        setChildren(await loadDir(entry.path));
      } catch {
        /* 读取失败时保留空列表,错误由打开文件路径呈现 */
      }
    }
  };

  return (
    <div>
      {ops.renaming === entry.path ? (
        <RenameRow
          entry={entry}
          depth={depth}
          onCommit={(name) => onRename(entry.path, name)}
          onCancel={() => ops.setRenaming(null)}
        />
      ) : (
        <div
          className={`tree-node ${entry.path === activePath ? 'active' : ''} ${entry.isDir ? 'dir' : ''}`}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
          onClick={() => void toggle()}
          onContextMenu={(e) => {
            e.preventDefault();
            onContextMenu(e.clientX, e.clientY, entry);
          }}
          title={entry.path}
        >
          {entry.isDir ? (
            expanded ? <FolderOpen size={14} className="icon-dim" /> : <Folder size={14} className="icon-dim" />
          ) : (
            <FileText size={14} className={isMarkdown ? 'icon-md' : 'icon-dim'} />
          )}
          <span className="tree-name">{entry.name}</span>
          {entry.isDir && (expanded ? <ChevronDown size={12} className="icon-dim" /> : <ChevronRight size={12} className="icon-dim" />)}
        </div>
      )}
      {entry.isDir &&
        expanded && [
          ...children.map((c) => (
            <TreeNode
              key={c.path}
              entry={c}
              onOpen={onOpen}
              activePath={activePath}
              depth={depth + 1}
              ops={ops}
              loadDir={loadDir}
              onCreateIn={onCreateIn}
              onRenameStart={onRenameStart}
              onRename={onRename}
              onAskDelete={onAskDelete}
              onContextMenu={onContextMenu}
            />
          )),
          ops.creatingIn === entry.path ? (
            <NewNameRow
              key="__new__"
              depth={depth + 1}
              onCommit={(name) => void createFileIn(entry.path, name)}
              onCancel={() => ops.setCreatingIn(null)}
            />
          ) : null,
        ]}
    </div>
  );
}

/* --- 行内输入(新建 / 重命名共用) --- */

function NameInput({
  depth,
  initial,
  onCommit,
  onCancel,
}: {
  depth: number;
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  // 失焦即提交:有内容则生效(点击别处也算确认),空内容则取消。
  // 仅回车才创建太"硬",自然交互下用户常直接点到下一步。
  const settle = () => {
    if (value.trim()) onCommit(value);
    else onCancel();
  };
  return (
    <div className="tree-node tree-editing" style={{ paddingLeft: `${8 + depth * 16}px` }}>
      <input
        ref={ref}
        className="tree-name-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onCommit(value);
          if (e.key === 'Escape') onCancel();
        }}
        onBlur={settle}
      />
    </div>
  );
}

function NewNameRow({
  depth,
  onCommit,
  onCancel,
}: {
  depth: number;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  return <NameInput depth={depth} initial="" onCommit={onCommit} onCancel={onCancel} />;
}

function RenameRow({
  entry,
  depth,
  onCommit,
  onCancel,
}: {
  entry: FileEntry;
  depth: number;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  return <NameInput depth={depth} initial={entry.name} onCommit={onCommit} onCancel={onCancel} />;
}

/* ---------------- 右键菜单 ---------------- */

function ContextMenu({
  x,
  y,
  entry,
  confirmDelete,
  onClose,
  onCreateIn,
  onRenameStart,
  onAskDelete,
  onConfirmDelete,
}: {
  x: number;
  y: number;
  entry: FileEntry;
  confirmDelete: FileEntry | null;
  onClose: () => void;
  onCreateIn: (dir: string) => void;
  onRenameStart: (e: FileEntry) => void;
  onAskDelete: (e: FileEntry | null) => void;
  onConfirmDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // 删除确认态:菜单位置可能已不可用,退回按节点定位
  const style =
    x >= 0 && y >= 0
      ? { left: x, top: y }
      : undefined;

  return (
    <div className="tree-menu" ref={ref} style={style} role="menu">
      {confirmDelete ? (
        <div className="tree-menu-confirm">
          <div className="tree-menu-confirm-text">
            删除「{confirmDelete.name}」?文件将移入系统回收站。
          </div>
          <div className="tree-menu-confirm-actions">
            <button className="danger" onClick={onConfirmDelete}>
              确认删除
            </button>
            <button onClick={() => onAskDelete(null)}>取消</button>
          </div>
        </div>
      ) : (
        <>
          <button
            onClick={() => onCreateIn(entry.isDir ? entry.path : parentDir(entry.path))}
            role="menuitem"
          >
            <FilePlus2 size={13} /> 新建文件
          </button>
          <button onClick={() => onRenameStart(entry)} role="menuitem">
            <Pencil size={13} /> 重命名
          </button>
          <button
            className="danger"
            onClick={() => onAskDelete(entry)}
            role="menuitem"
          >
            <Trash2 size={13} /> 删除
          </button>
        </>
      )}
    </div>
  );
}

/* ---------------- 收藏面板 ---------------- */

function StarredPanel() {
  const [items, setItems] = useState<DocumentMeta[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const list = await (await getBackend()).starredFiles();
      setItems(list);
      setError('');
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const unstar = async (m: DocumentMeta) => {
    await (await getBackend()).setMeta(m.path, { starred: false });
    useStore.setState((s) =>
      s.meta && s.meta.path === m.path ? { meta: { ...s.meta, starred: false } } : {},
    );
    await load();
  };

  return (
    <div className="starred-panel">
      {error && <div className="search-status error">{error}</div>}
      {items.length === 0 && !error && <div className="empty-tip">还没有收藏,点击工具栏的 ☆ 收藏文档</div>}
      {items.map((m) => (
        <div key={m.path} className="starred-item">
          <button
            className="starred-open"
            onClick={async () => {
              const b = await getBackend();
              const f = await b.readFile(m.path);
              const meta = await b.getMeta(m.path);
              useStore.getState().openDoc(f.path, f.content, meta);
            }}
          >
            <Star size={13} className="icon-star" />
            <span className="starred-title">{m.title}</span>
            <span className="starred-path">{m.path}</span>
          </button>
          <button className="starred-remove" title="取消收藏" onClick={() => void unstar(m)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/* ---------------- 搜索面板 ---------------- */

function SearchPanel() {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ path: string; snippet: string; line: number }[]>([]);
  const [total, setTotal] = useState(0);
  const [took, setTook] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const search = async (q: string) => {
    setQuery(q);
    if (!q.trim()) {
      setHits([]);
      setTotal(0);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const r = await (await getBackend()).search(q.trim());
      setHits(r.hits);
      setTotal(r.total);
      setTook(r.tookMs);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="search-panel">
      <div className="search-box">
        <Search size={14} className="icon-dim" />
        <input
          autoFocus
          placeholder="全库搜索…"
          value={query}
          onChange={(e) => void search(e.target.value)}
        />
      </div>
      {busy && <div className="search-status">搜索中…</div>}
      {!busy && query && (
        <div className="search-status">
          {total > 0 ? `${total} 条结果,耗时 ${took}ms` : '无结果'}
        </div>
      )}
      {error && <div className="search-status error">{error}</div>}
      <div className="search-results">
        {hits.map((h, i) => (
          <button
            key={i}
            className="search-hit"
            onClick={async () => {
              try {
                const b = await getBackend();
                const f = await b.readFile(h.path);
                const meta = await b.getMeta(h.path);
                useStore.getState().openDoc(f.path, f.content, meta);
              } catch (e) {
                console.error(e);
              }
            }}
          >
            <div className="hit-path">{h.path}</div>
            <div className="hit-snippet" dangerouslySetInnerHTML={{ __html: escapeHtml(h.snippet) }} />
          </button>
        ))}
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
