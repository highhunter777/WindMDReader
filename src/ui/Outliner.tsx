/**
 * 右侧面板:大纲 / 双链 / 标签,三页签。
 * - 大纲:标题树,滚动高亮当前节
 * - 双链:当前文档的出链(含未创建标记)与反链
 * - 标签:全库标签聚合,点击查看该标签下的文档
 */
import { useCallback, useEffect, useState } from 'react';
import { BookOpen, Hash, Link2 } from 'lucide-react';
import { useStore } from '../store';
import { scrollToHeading } from '../renderer/enhance';
import { getBackend } from '../ipc';
import { errMsg } from '../ipc/errors';
import type { DocumentMeta, DocLinks, TagEntry } from '../types';

export function Outliner() {
  const visible = useStore((s) => s.tocVisible);
  const tab = useStore((s) => s.outlinerTab);
  const setTab = useStore((s) => s.setOutlinerTab);
  if (!visible) return null;
  return (
    <aside className="outliner">
      <div className="outliner-tabs">
        <button className={`tab ${tab === 'toc' ? 'active' : ''}`} title="大纲" onClick={() => setTab('toc')}>
          <BookOpen size={13} />
        </button>
        <button className={`tab ${tab === 'links' ? 'active' : ''}`} title="双链" onClick={() => setTab('links')}>
          <Link2 size={13} />
        </button>
        <button className={`tab ${tab === 'tags' ? 'active' : ''}`} title="标签" onClick={() => setTab('tags')}>
          <Hash size={13} />
        </button>
      </div>
      {tab === 'toc' ? <TocPanel /> : tab === 'links' ? <LinksPanel /> : <TagsPanel />}
    </aside>
  );
}

/* ---------------- 大纲 ---------------- */

function TocPanel() {
  const headings = useStore((s) => s.headings);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: Event) => setActiveId((e as CustomEvent<string>).detail);
    document.addEventListener('windmd:active-heading', handler);
    return () => document.removeEventListener('windmd:active-heading', handler);
  }, []);

  if (!headings.length) return <div className="outliner-empty">当前文档没有标题</div>;

  const minLevel = Math.min(...headings.map((h) => h.level));

  return (
    <>
      <div className="outliner-header">
        <span>大纲</span>
        <span className="outliner-count">{headings.length}</span>
      </div>
      {headings.map((h) => {
        const indent = h.level - minLevel;
        const target = document.getElementById(h.id);
        return (
          <div
            key={h.id}
            className={`toc-item lv-${indent} ${activeId === h.id ? 'active' : ''}`}
            style={{ paddingLeft: `${4 + indent * 14}px` }}
          >
            <button
              onClick={() => {
                if (target) scrollToHeading(target);
              }}
              title={h.text}
            >
              {h.text}
            </button>
          </div>
        );
      })}
    </>
  );
}

/* ---------------- 双链 ---------------- */

async function openMeta(meta: DocumentMeta) {
  const b = await getBackend();
  const f = await b.readFile(meta.path);
  const fresh = await b.getMeta(meta.path);
  useStore.getState().openDoc(f.path, f.content, fresh);
}

function LinksPanel() {
  const activePath = useStore((s) => s.activePath);
  const [links, setLinks] = useState<DocLinks | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!activePath) {
      setLinks(null);
      return;
    }
    try {
      setLinks(await (await getBackend()).getLinks(activePath));
      setError('');
    } catch (e) {
      setError(errMsg(e));
    }
  }, [activePath]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!activePath) return <div className="outliner-empty">打开一个文档后查看双链</div>;

  return (
    <div className="links-panel">
      {error && <div className="outliner-error">{error}</div>}
      <div className="outliner-header">
        <span>反链</span>
        <span className="outliner-count">{links?.backlinks.length ?? 0}</span>
      </div>
      {links?.backlinks.length ? (
        links.backlinks.map((m) => (
          <button key={m.path} className="link-item" onClick={() => void openMeta(m)} title={m.path}>
            <Link2 size={12} className="icon-dim" />
            <span className="link-title">{m.title}</span>
          </button>
        ))
      ) : (
        <div className="outliner-empty">没有被任何文档引用</div>
      )}

      <div className="outliner-header">
        <span>出链</span>
        <span className="outliner-count">{links?.outgoing.length ?? 0}</span>
      </div>
      {links?.outgoing.length ? (
        links.outgoing.map((o) => (
          <button
            key={o.target}
            className={`link-item ${o.resolvedPath ? '' : 'unresolved'}`}
            title={o.resolvedPath ?? `${o.target}(未创建,点击新建)`}
            onClick={async () => {
              if (!o.resolvedPath) return;
              const b = await getBackend();
              const f = await b.readFile(o.resolvedPath);
              const meta = await b.getMeta(o.resolvedPath);
              useStore.getState().openDoc(f.path, f.content, meta);
            }}
          >
            <Link2 size={12} className="icon-dim" />
            <span className="link-title">{o.target}</span>
            {!o.resolvedPath && <span className="link-badge">未创建</span>}
          </button>
        ))
      ) : (
        <div className="outliner-empty">本文档没有链出到其他文档</div>
      )}
    </div>
  );
}

/* ---------------- 标签 ---------------- */

function TagsPanel() {
  const [tags, setTags] = useState<TagEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [docs, setDocs] = useState<DocumentMeta[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setTags(await (await getBackend()).listTags());
      setError('');
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const select = async (tag: string) => {
    setSelected(tag);
    try {
      setDocs(await (await getBackend()).docsByTag(tag));
      setError('');
    } catch (e) {
      setError(errMsg(e));
    }
  };

  return (
    <div className="tags-panel">
      {error && <div className="outliner-error">{error}</div>}
      <div className="outliner-header">
        <span>标签</span>
        <span className="outliner-count">{tags.length}</span>
      </div>
      {tags.length ? (
        tags.map((t) => (
          <button
            key={t.tag}
            className={`tag-item ${selected === t.tag ? 'active' : ''}`}
            onClick={() => void select(t.tag)}
          >
            <Hash size={12} className="icon-dim" />
            <span className="tag-name">{t.tag}</span>
            <span className="tag-count">{t.count}</span>
          </button>
        ))
      ) : (
        <div className="outliner-empty">库中还没有 #标签</div>
      )}

      {selected && (
        <>
          <div className="outliner-header">
            <span>#{selected}</span>
            <span className="outliner-count">{docs.length}</span>
          </div>
          {docs.map((m) => (
            <button key={m.path} className="link-item" onClick={() => void openMeta(m)} title={m.path}>
              <Hash size={12} className="icon-dim" />
              <span className="link-title">{m.title}</span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}
