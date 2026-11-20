/**
 * 编辑器分栏:左源码(等宽 textarea)/ 右预览(复用渲染管线)。
 *
 * 为什么是 textarea 而不是 CodeMirror/Monaco:
 * - 首屏红线只剩 0.2KB,任何编辑器内核都进不了 entry,而它又必须随
 *   「进入编辑」即时可用 —— 再叠一层懒加载会让首次进入编辑出现可见空窗;
 * - 渲染管线已有 CommonMark 652 例回归,预览必须与阅读态逐像素一致,
 *   换编辑器内核等于把渲染结果也换掉。
 * 代价是没有语法着色与行内补全,用 `keymap.ts` 的格式化命令补上最常用的动作。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bold, Columns2, List, Quote, RefreshCw, Save, X } from 'lucide-react';
import { useStore } from '../store';
import { errMsg } from '../ipc/errors';
import { renderMarkdown } from '../renderer/markdown';
import { mountRendered } from '../renderer/enhance';
import type { ThemeName } from '../renderer/highlight';
import { getSaver, previewBudget } from '../editor/session';
import { refreshPreview, setDraft, startEditing, stopEditing } from '../editor/actions';
import {
  bulletPrefix,
  caretToLine,
  continueList,
  headingPrefix,
  indent,
  insertLink,
  lineIndexAt,
  quotePrefix,
  toggleLinePrefix,
  toggleWrap,
  type EditResult,
  type EditState,
} from '../editor/keymap';
import './editor.css';

/** 预览防抖:200ms 内连续输入只重渲一次(实测手速上限约 8 字符/秒) */
const PREVIEW_DEBOUNCE_MS = 200;

export function EditorPane() {
  const activePath = useStore((s) => s.activePath);
  const draft = useStore((s) => s.draft);
  const previewSource = useStore((s) => s.previewSource);
  const theme = useStore((s) => s.theme);
  const fontSize = useStore((s) => s.fontSize);
  const fontFamily = useStore((s) => s.fontFamily);
  const readingWidth = useStore((s) => s.readingWidth);
  const splitRatio = useStore((s) => s.splitRatio);
  const dirty = useStore((s) => s.dirty);
  const saving = useStore((s) => s.saving);
  const saveError = useStore((s) => s.saveError);
  const savedAt = useStore((s) => s.savedAt);
  const autoSave = useStore((s) => s.autoSave);
  const conflict = useStore((s) => s.conflict);
  const findOpen = useStore((s) => s.findOpen);
  const findQuery = useStore((s) => s.findQuery);
  const setFindState = useStore((s) => s.setFindState);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const [manualTick, setManualTick] = useState(0);
  const budget = useMemo(() => previewBudget(draft), [draft]);

  /* 进入编辑:聚焦并把光标落到可见区域对应的源码行 */
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    const line = visiblePreviewLine();
    if (line > 0) {
      const next = caretToLine({ value: draft, start: ta.selectionStart, end: ta.selectionEnd }, line);
      ta.setSelectionRange(next.start, next.end);
      revealLine(ta, next.start);
    }
    // 只在文档切换时定位一次,不跟随每次输入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath]);

  /* 输入 → 草稿(脏标记/自动保存由 store 与保存器负责) */
  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    // 选区信息对格式化命令是必需的,单靠 state 会滞后一帧
    selectionRef.current = { start: e.target.selectionStart, end: e.target.selectionEnd };
  };

  /* 选区快照:按键时才读,避免每次光标移动都触发渲染 */
  const selectionRef = useRef({ start: 0, end: 0 });
  const onSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    selectionRef.current = { start: ta.selectionStart, end: ta.selectionEnd };
  };

  /**
   * 待恢复的选区。
   *
   * 受控 textarea 有个反直觉行为:**值被外部改写后,React 会把光标顶到末尾**。
   * 所以在命令里直接 setSelectionRange 是无效的(会在 React 提交时被覆盖),
   * 必须把它存下来,等 commit 之后的 layout effect 里再设。
   * 不修的话症状是:按完 Ctrl+1,下次打字跑到文末。
   */
  const pendingSel = useRef<{ start: number; end: number } | null>(null);

  useLayoutEffect(() => {
    const ta = taRef.current;
    const sel = pendingSel.current;
    if (!ta || !sel) return;
    pendingSel.current = null;
    ta.setSelectionRange(sel.start, sel.end);
    selectionRef.current = sel;
    revealLine(ta, sel.start);
  }, [draft]);

  /** 应用一次编辑命令,并安排选区恢复 */
  const apply = useCallback((fn: (s: EditState) => EditResult | null) => {
    const ta = taRef.current;
    if (!ta) return;
    const out = fn({ value: ta.value, start: ta.selectionStart, end: ta.selectionEnd });
    if (!out) return;
    if (out.value === ta.value) {
      // 内容没变(例如空列表项退出),只需移动光标
      ta.setSelectionRange(out.start, out.end);
      return;
    }
    pendingSel.current = { start: out.start, end: out.end };
    setDraft(out.value);
  }, []);

  /**
   * 编辑器的按键拦截。
   *
   * 原则:只管「Markdown 语义键」,并且 `stopPropagation` —— 否则
   * 全局的 Ctrl+B(侧栏)、`j`/`k`(滚动)、`f`(焦点行)会在打字时被触发。
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.ctrlKey || e.metaKey;

    if (e.key === 's' && mod) {
      e.preventDefault();
      e.stopPropagation();
      void getSaver().save();
      return;
    }

    // 自动保存关闭时,Ctrl+S 是唯一出口 —— 已在上面处理
    if (e.key === 'Tab' && !mod) {
      e.preventDefault();
      e.stopPropagation();
      apply((s) => indent(s, e.shiftKey ? -1 : 1));
      return;
    }

    if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey) {
      const ta = e.currentTarget;
      const out = continueList({ value: ta.value, start: ta.selectionStart, end: ta.selectionEnd });
      if (out) {
        e.preventDefault();
        e.stopPropagation();
        apply(() => out);
      }
      return;
    }

    if (!mod) return;

    const key = e.key.toLowerCase();
    const map: Record<string, () => EditResult | null> = {
      b: () => toggleWrap(cur(), '**'),
      i: () => toggleWrap(cur(), '*'),
      e: () => toggleWrap(cur(), '`'),
      k: () => insertLink(cur()),
    };
    if (map[key]) {
      e.preventDefault();
      e.stopPropagation();
      apply(map[key]);
      return;
    }

    // Ctrl+1..6 标题层级,Ctrl+0 取消标题
    if (/^[0-6]$/.test(e.key) && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      const lvl = Number(e.key);
      apply((s) => (lvl === 0 ? toggleLinePrefix(s, headingPrefix(1)) : toggleHeading(s, lvl)));
      return;
    }
  };

  /**
   * 当前状态:直接读 DOM。
   * 读 selectionRef 不可靠 —— 它只在 select 事件里更新,键盘快捷键
   * 之前若没触发过 select,拿到的就是 0/0(表现为「加粗作用到了文首」)。
   */
  const cur = (): EditState => {
    const ta = taRef.current;
    if (!ta) return { value: draft, start: 0, end: 0 };
    return { value: ta.value, start: ta.selectionStart, end: ta.selectionEnd };
  };

  /* 实时预览:防抖 + 体积闸门 */
  useEffect(() => {
    if (!activePath) return;
    if (budget.degrade) return; // 降级:等保存或手动刷新
    if (draft === previewSource) return;
    const t = window.setTimeout(() => {
      refreshPreview(draft);
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [draft, previewSource, budget.degrade, activePath]);

  /* 挂载预览:与阅读态完全相同的一条管线(清洗 → 视口增强) */
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const { html, headings } = renderMarkdown(previewSource, { lineMap: true });
    useStore.getState().setHeadings(headings);
    const cleanup = mountRendered(el, html, themeToShiki(theme), () => {
      // 预览是只读镜像:任务列表的复选框必须真的禁用。
      // 只靠 CSS pointer-events 也能挡点击,但键盘(Tab + Space)仍能翻,
      // 而「看着勾上了、源码没变」是最容易骗人的一类假象 —— 用 disabled 属性钉死。
      for (const box of el.querySelectorAll<HTMLInputElement>('.task-list-item input')) box.disabled = true;
    });
    return cleanup;
  }, [previewSource, theme, activePath, manualTick]);

  /* 预览 → 源码:点击预览里的块,光标跳到对应源码行 */
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // 链接/图片/复制按钮有自己的语义,不抢
      if (target.closest('a, img, button, .code-copy, .wiki-link')) return;
      const block = target.closest<HTMLElement>('[data-src-line]');
      if (!block) return;
      const line = Number(block.getAttribute('data-src-line'));
      if (!Number.isFinite(line)) return;
      const ta = taRef.current;
      if (!ta) return;
      const next = caretToLine({ value: ta.value, start: ta.selectionStart, end: ta.selectionEnd }, line);
      ta.focus();
      ta.setSelectionRange(next.start, next.end);
      revealLine(ta, next.start);
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [previewSource]);

  /* --- 编辑态查找:在源码里检索并把命中选中 ---
     阅读态的 FindBar 依赖渲染后的 DOM,编辑态正文已被编辑器取代,
     若不接管,Ctrl+F 会静默失效(命中数恒 0)。 */
  const findHits = useMemo(() => {
    if (!findOpen || !findQuery.trim()) return [] as number[];
    const q = findQuery.toLowerCase();
    const hay = draft.toLowerCase();
    const out: number[] = [];
    let i = hay.indexOf(q);
    while (i !== -1) {
      out.push(i);
      i = hay.indexOf(q, i + Math.max(1, q.length));
    }
    return out;
  }, [findOpen, findQuery, draft]);

  useEffect(() => {
    if (!findOpen) {
      setFindState(0, 0);
      return;
    }
    if (!findHits.length) {
      setFindState(0, 0);
      return;
    }
    const goto = (index: number) => {
      const ta = taRef.current;
      const at = findHits[index];
      if (!ta || at === undefined) return;
      const len = Math.max(1, findQuery.trim().length);
      ta.focus();
      ta.setSelectionRange(at, at + len);
      revealLine(ta, at);
      setFindState(findHits.length, index);
    };
    goto(0);
    const onGoto = (e: Event) => {
      const { index } = (e as CustomEvent<{ index: number }>).detail;
      goto(index);
    };
    document.addEventListener('windmd:find-goto', onGoto);
    return () => document.removeEventListener('windmd:find-goto', onGoto);
  }, [findHits, findOpen, findQuery, setFindState]);

  /* 源码 → 预览:光标移动时把预览滚到对应块(只跟随,不反向写入) */
  const lastFollow = useRef(0);
  const followPreview = () => {
    const now = Date.now();
    if (now - lastFollow.current < 120) return; // 连续移动的光标不逐次滚动
    lastFollow.current = now;
    const ta = taRef.current;
    const el = previewRef.current;
    if (!ta || !el) return;
    const line = lineIndexAt(ta.value, ta.selectionStart);
    const blocks = el.querySelectorAll<HTMLElement>('[data-src-line]');
    let best: HTMLElement | null = null;
    for (const b of blocks) {
      const l = Number(b.getAttribute('data-src-line'));
      if (Number.isFinite(l) && l <= line) best = b;
      else break;
    }
    if (!best) return;
    const top = best.offsetTop - 8;
    el.parentElement?.scrollTo({ top, behavior: 'smooth' });
  };

  if (!activePath) return null;

  return (
    <div className="editor-wrap">
      {conflict && (
        <div className="editor-conflict" role="alert">
          <span className="editor-conflict-text">
            磁盘上的这篇文档被外部改过了,你本地还有未保存的修改。
          </span>
          <button
            className="editor-conflict-btn"
            onClick={() => {
              // 保留我的修改:把磁盘内容作为基准、草稿保持不变,下一次保存即覆盖
              useStore.setState({ baseline: conflict.incoming, lastWritten: conflict.incoming, dirty: true, conflict: null });
            }}
          >
            保留我的修改
          </button>
          <button
            className="editor-conflict-btn primary"
            onClick={() => {
              const s = useStore.getState();
              s.openDoc(s.activePath ?? '', conflict.incoming, s.meta);
              startEditing();
            }}
          >
            重新加载磁盘版本
          </button>
        </div>
      )}
      <div className="editor-split" style={{ '--split': String(splitRatio) } as React.CSSProperties}>
      <section className="editor-source">
        <header className="editor-bar">
          <span className="editor-bar-title">
            <Columns2 size={13} /> 源码
          </span>
          <span className="editor-bar-meta">{budget.lines} 行</span>
          <span className="editor-bar-spacer" />
          <SaveState saving={saving} dirty={dirty} savedAt={savedAt} error={saveError} autoSave={autoSave} />
          <button
            className="icon-btn"
            title="加粗 (Ctrl+B)"
            onClick={() => apply((s) => toggleWrap(s, '**'))}
          >
            <Bold size={14} />
          </button>
          <button
            className="icon-btn"
            title="无序列表"
            onClick={() => apply((s) => toggleLinePrefix(s, bulletPrefix()))}
          >
            <List size={14} />
          </button>
          <button
            className="icon-btn"
            title="引用"
            onClick={() => apply((s) => toggleLinePrefix(s, quotePrefix()))}
          >
            <Quote size={14} />
          </button>
          <button className="icon-btn" title="保存 (Ctrl+S)" onClick={() => void getSaver().save()}>
            <Save size={14} />
          </button>
          <button
            className="icon-btn"
            title="退出编辑 (Ctrl+E)"
            onClick={() => void exitEditing()}
          >
            <X size={14} />
          </button>
        </header>
        <textarea
          ref={taRef}
          className="editor-input"
          value={draft}
          spellCheck={false}
          placeholder="在这里写 Markdown…"
          onChange={onChange}
          onSelect={onSelect}
          onKeyDown={onKeyDown}
          onKeyUp={followPreview}
          onClick={followPreview}
          style={{ fontSize: `${Math.max(12, fontSize - 2)}px` }}
        />
      </section>

      <div
        className="editor-divider"
        role="separator"
        aria-orientation="vertical"
        title="拖动调整比例"
        onPointerDown={(e) => {
          e.preventDefault();
          const divider = e.currentTarget;
          divider.setPointerCapture(e.pointerId);
          const host = divider.parentElement;
          if (!host) return;
          const move = (ev: PointerEvent) => {
            const rect = host.getBoundingClientRect();
            if (rect.width <= 0) return;
            useStore.getState().setSplitRatio(((ev.clientX - rect.left) / rect.width) * 100);
          };
          const up = () => {
            divider.removeEventListener('pointermove', move);
            divider.removeEventListener('pointerup', up);
          };
          divider.addEventListener('pointermove', move);
          divider.addEventListener('pointerup', up);
        }}
      />

      <section className="editor-preview">
        <header className="editor-bar">
          <span className="editor-bar-title">预览</span>
          {budget.degrade && (
            <>
              <span className="editor-degraded" title={budget.reason}>
                {budget.reason}
              </span>
              <button
                className="editor-refresh"
                onClick={() => {
                  refreshPreview(draft);
                  setManualTick((n) => n + 1);
                }}
              >
                <RefreshCw size={12} /> 刷新预览
              </button>
            </>
          )}
          <span className="editor-bar-spacer" />
          <span className="editor-bar-meta">{previewSource.length.toLocaleString()} 字符</span>
        </header>
        <div className="editor-preview-scroll">
          <article
            ref={previewRef}
            className="prose editor-prose"
            data-font={fontFamily}
            style={{ fontSize: `${fontSize}px`, maxWidth: `${readingWidth}px` }}
          />
        </div>
      </section>
      </div>
    </div>
  );
}

/* ---------------- 辅助 ---------------- */

function themeToShiki(theme: 'light' | 'dark'): ThemeName {
  return theme === 'dark' ? 'github-dark' : 'github-light';
}

/** 标题切换:同层级再按一次 → 取消标题 */
function toggleHeading(s: EditState, level: number): EditResult {
  const prefix = headingPrefix(level);
  const line = s.value.slice(
    s.value.lastIndexOf('\n', Math.max(0, s.start - 1)) + 1,
    s.value.indexOf('\n', s.start) === -1 ? s.value.length : s.value.indexOf('\n', s.start),
  );
  // 已是同级标题 → 脱掉;否则替换层级
  return toggleLinePrefix(s, prefix.test(line) ? { ...prefix, add: prefix.remove } : prefix);
}

/** 让某字符偏移在 textarea 里可见 */
function revealLine(ta: HTMLTextAreaElement, pos: number): void {
  const lineHeight = parseFloat(getComputedStyle(ta).lineHeight || '20') || 20;
  const line = lineIndexAt(ta.value, pos);
  const target = line * lineHeight;
  const viewTop = ta.scrollTop;
  const viewBottom = viewTop + ta.clientHeight;
  if (target < viewTop + lineHeight) ta.scrollTop = Math.max(0, target - lineHeight * 2);
  else if (target > viewBottom - lineHeight * 2) ta.scrollTop = target - ta.clientHeight / 2;
}

/** 进入编辑前可见的预览块 → 源码行(让编辑从「正在读的地方」开始) */
function visiblePreviewLine(): number {
  const el = document.querySelector<HTMLElement>('.main .prose');
  const scroller = document.querySelector<HTMLElement>('.main');
  if (!el || !scroller) return 0;
  const blocks = el.querySelectorAll<HTMLElement>('[data-src-line]');
  const top = scroller.getBoundingClientRect().top;
  let best = 0;
  for (const b of blocks) {
    const line = Number(b.getAttribute('data-src-line'));
    if (!Number.isFinite(line)) continue;
    if (b.getBoundingClientRect().top - top <= 60) best = line;
    else break;
  }
  return best;
}

/** 退出编辑:先落盘(失败则留在编辑态,不静默丢内容) */
export async function exitEditing(): Promise<void> {
  const s = useStore.getState();
  if (!s.editing) return;
  try {
    await getSaver().flush();
  } catch (e) {
    useStore.getState().setSaveError(errMsg(e));
    return;
  }
  // flush 失败时 dirty 仍在,不能当成功退出(否则等于静默丢内容)
  if (useStore.getState().dirty) return;
  stopEditing();
  // 正文已由 markSaved 同步成刚落盘的内容,无需再读一次盘 ——
  // 少一次 I/O,也不会出现「保存成功但读盘失败 → 退出后看见旧内容」。
}

function SaveState(props: { saving: boolean; dirty: boolean; savedAt: number; error: string; autoSave: boolean }) {
  if (props.error) return <span className="editor-save-state error">保存失败:{props.error}</span>;
  if (props.saving) return <span className="editor-save-state">保存中…</span>;
  if (props.dirty) {
    return (
      <span className="editor-save-state dirty">
        {props.autoSave ? '未保存…' : '未保存 · Ctrl+S'}
      </span>
    );
  }
  if (!props.savedAt) return <span className="editor-save-state">已同步</span>;
  return <span className="editor-save-state">已保存 {hhmm(props.savedAt)}</span>;
}

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default EditorPane;
