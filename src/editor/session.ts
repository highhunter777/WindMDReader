/**
 * 编辑会话:草稿、脏标记、自动保存、外部变更冲突判定。
 *
 * 这里只放**可判定、可单测**的逻辑(session 决策)与一个很薄的保存控制器;
 * 真正的状态由 store 承载,DOM 由 EditorPane 负责。
 *
 * 为什么要单独一层:保存/冲突涉及「谁写谁读」的时序,混进组件后
 * 只能靠手点验证;抽成纯函数后,回环抑制、脏改动保护这些容易踩的点
 * 都能被普通测试钉住。
 */
import { getBackend } from '../ipc';
import { errMsg } from '../ipc/errors';
import { useStore } from '../store';
import { markSaved } from './actions';

/** 自动保存的空闲阈值:停手 1.2s 落盘 */
export const AUTOSAVE_IDLE_MS = 1200;

/** 实时预览的体积闸门:超过任一阈值改为手动刷新 */
export const PREVIEW_MAX_BYTES = 256 * 1024;
export const PREVIEW_MAX_LINES = 5000;

/** 预览是否需要降级为手动刷新 */
export interface PreviewBudget {
  bytes: number;
  lines: number;
  degrade: boolean;
  /** 降级原因(展示给用户,不能静默变慢) */
  reason: string;
}

/** 统计体积并给出降级结论。按 UTF-8 近似(中文按 3 字节)比只数字符更贴近真实写盘量 */
export function previewBudget(source: string): PreviewBudget {
  const lines = source.length === 0 ? 0 : source.split('\n').length;
  let bytes = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4; // 代理对:两个 code unit 算 4 字节
      i++;
    } else bytes += 3;
  }
  const tooBig = bytes > PREVIEW_MAX_BYTES;
  const tooLong = lines > PREVIEW_MAX_LINES;
  return {
    bytes,
    lines,
    degrade: tooBig || tooLong,
    reason: tooBig
      ? '文档超过 256KB,实时预览已关闭(保存后或点「刷新预览」更新)'
      : tooLong
        ? '文档超过 5000 行,实时预览已关闭(保存后或点「刷新预览」更新)'
        : '',
  };
}

/* 外部变更判定见 ./external —— 纯函数单独成文件,避免把 IPC 拉进首屏 */
export { decideExternalChange, type ExternalContext, type ExternalDecision } from './external';

/* ================================================================
 * 保存控制器
 * ================================================================ */

export interface Saver {
  /** 立即保存(可重入保护:保存中再调用只记一个待办) */
  save(): Promise<boolean>;
  /** 安排一次空闲自动保存(连续输入只落一次) */
  schedule(): void;
  /** 取消待执行的自动保存 */
  cancel(): void;
  /** 有待保存的内容就立刻保存(切文档 / 失焦 / 关闭编辑时用) */
  flush(): Promise<void>;
}

/**
 * 创建保存器。`enabled` 在每次调用时求值,便于用户随时关掉自动保存。
 *
 * 失败不吞:`saveError` 落到 store,由状态栏提示;草稿保留,
 * 绝不在写盘失败时把 dirty 清掉(那等于让用户以为存好了)。
 */
export function createSaver(): Saver {
  let timer: number | null = null;
  let inFlight: Promise<boolean> | null = null;
  let pending = false;

  const clear = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  const run = async (): Promise<boolean> => {
    const s = useStore.getState();
    const path = s.activePath;
    if (!path || !s.editing) return false;
    if (s.draft === s.baseline) return false;

    useStore.getState().setSaving(true);
    const snapshot = s.draft;
    try {
      const b = await getBackend();
      await b.writeFile(path, snapshot);
      const st = useStore.getState();
      // 保存期间用户可能已切走:只回写仍指向同一篇的状态
      if (st.activePath === path) markSaved(snapshot);
      else useStore.getState().setSaving(false);
      return true;
    } catch (e) {
      useStore.getState().setSaveError(errMsg(e));
      return false;
    }
  };

  const save = (): Promise<boolean> => {
    clear();
    if (inFlight) {
      pending = true;
      return inFlight;
    }
    inFlight = run().finally(() => {
      inFlight = null;
      if (pending) {
        pending = false;
        void save();
      }
    });
    return inFlight;
  };

  return {
    save,
    schedule() {
      if (!useStore.getState().autoSave) return;
      clear();
      timer = window.setTimeout(() => {
        timer = null;
        void save();
      }, AUTOSAVE_IDLE_MS);
    },
    cancel: clear,
    async flush() {
      clear();
      const s = useStore.getState();
      if (!s.activePath || !s.editing) return;
      if (s.draft === s.baseline) return;
      await save();
    },
  };
}

/**
 * 切换文档前把旧文档的草稿写回它自己的路径。
 *
 * 不能复用 `save()`:它读的是 store 里**当前**的 draft,而调用点已经换成
 * 新文档了。这里显式带上目标路径与内容,写的是「离开时那篇」。
 * 失败只记日志 —— 用户已经在看新文档,再用弹窗打断不合适;
 * 草稿本身还在 localStorage 之外的内存里,下条消息会提示。
 */
export async function flushPathTo(path: string, content: string): Promise<void> {
  try {
    await (await getBackend()).writeFile(path, content);
  } catch (e) {
    console.error('切换文档前保存失败', path, e);
  }
}

/** 全局单例:编辑态只有一个保存器,避免多个定时器互相覆盖 */
let singleton: Saver | null = null;

export function getSaver(): Saver {
  singleton ??= createSaver();
  return singleton;
}

/** 仅测试用:重置单例,避免用例之间共享定时器 */
export function __resetSaver(): void {
  singleton?.cancel();
  singleton = null;
}
