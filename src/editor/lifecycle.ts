/**
 * 编辑态的运行时守卫(随编辑器 chunk 一起按需加载)。
 *
 * 职责:在「编辑中切文档」时把旧文档的草稿写回它自己的路径。
 *
 * 为什么必须监在 store 上而不是某个组件里:切库、外部打开、双链跳转、
 * 文件树点击……所有入口最终都落到 `openDoc`,只有订阅 store 才能一网打尽。
 * 而这段监听只在**编辑过**之后才有意义,所以由 startEditing 安装,
 * 不占首屏。
 */
import { useStore } from '../store';
import { flushPathTo } from './session';

let installed = false;
/** 已安装的订阅:重置时必须真正取消,否则旧订阅会继续按旧快照写盘 */
let unsubscribe: (() => void) | null = null;

export function installEditingGuards(): void {
  if (installed) return;
  installed = true;

  let prevPath = useStore.getState().activePath;
  let prevDraft = useStore.getState().draft;
  let prevDirty = useStore.getState().dirty;

  unsubscribe = useStore.subscribe((s) => {
    // 先判「离开」:同一次变更里 activePath 与 draft 可能一起变
    if (s.activePath !== prevPath && prevPath && prevDirty) {
      void flushPathTo(prevPath, prevDraft);
    }
    if (s.activePath !== prevPath) {
      prevPath = s.activePath;
      prevDraft = s.draft;
      prevDirty = s.dirty;
    } else {
      prevDraft = s.draft;
      prevDirty = s.dirty;
    }
  });
}

/** 仅测试用:取消订阅并允许重复安装 */
export function __resetEditingGuards(): void {
  unsubscribe?.();
  unsubscribe = null;
  installed = false;
}
