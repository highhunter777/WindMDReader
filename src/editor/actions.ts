/**
 * 编辑态的动作(进入/退出、草稿、预览、保存回写)。
 *
 * 为什么不在 store 里:这些动作只被编辑器与保存器调用,而 store 属于首屏。
 * 把它们留在 store 会把编辑相关的判断逻辑一起打进 entry
 * (实测超红线 3.5KB)。抽出来后,App 只保留一个 `setConflict` 就能分流 watcher。
 *
 * 约定:调用方需确保已进入编辑态;这里不做二次守卫以外的副作用。
 */
import { useStore } from '../store';
import { installEditingGuards } from './lifecycle';

/** 进入编辑:以当前正文为草稿起点 */
export function startEditing(): void {
  const s = useStore.getState();
  if (!s.activePath || s.editing) return;
  // 安装「切文档前落盘」的守卫(幂等);它只在编辑过之后才有意义
  installEditingGuards();
  useStore.setState({
    editing: true,
    draft: s.content,
    previewSource: s.content,
    baseline: s.content,
    lastWritten: null,
    dirty: false,
    saveError: '',
    conflict: null,
    // 编辑时收起焦点行/打字机:它们按正文段落计算,分栏下会误伤预览侧
    focusLine: false,
    typewriter: false,
  });
}

/** 退出编辑(调用前应先 flush;冲突态一并收起) */
export function stopEditing(): void {
  useStore.setState({ editing: false, conflict: null });
}

/**
 * 输入:更新草稿与脏标记。
 * 冲突态的处理:用户继续编辑即视为「保留我的内容」,冲突条让路 ——
 * 否则一个已经不可能回滚的歧义提示会一直挂着。
 */
export function setDraft(next: string): void {
  const s = useStore.getState();
  if (!s.editing) return;
  useStore.setState({
    draft: next,
    dirty: next !== s.baseline,
    conflict: s.conflict && next !== s.conflict.incoming ? null : s.conflict,
  });
}

/** 把草稿推给预览(防抖后由 EditorPane 调用;保存成功时也会直接调用) */
export function refreshPreview(source?: string): void {
  useStore.setState((s) => ({ previewSource: source ?? s.draft }));
}

/**
 * 保存成功回写。
 *
 * 同步更新 `content`:退出编辑后阅读态直接用它,不必再读盘一次
 * (少一次 I/O,也避免读盘失败导致「刚保存的内容看不见」)。
 */
export function markSaved(snapshot: string): void {
  useStore.setState((s) => ({
    baseline: snapshot,
    lastWritten: snapshot,
    dirty: s.draft !== snapshot,
    savedAt: Date.now(),
    saving: false,
    saveError: '',
    previewSource: snapshot,
    content: snapshot,
  }));
}
