/**
 * 外部变更判定(纯函数,零依赖)。
 *
 * 单独成文件的原因:App.tsx 需要它来分流 watcher 事件,而 App 属于首屏。
 * 若直接从 session.ts 引入,会连带把保存器、IPC 一起拉进 entry
 * (首屏红线只剩 0.2KB,多一个字节都要较真)。
 */
export type ExternalDecision =
  /** 磁盘内容与草稿一致,或就是自己刚写下去的 —— 不动 */
  | 'ignore'
  /** 本地没有未保存改动 → 直接跟随磁盘 */
  | 'reload'
  /** 本地有改动且磁盘被外部改过 → 不能替用户做决定 */
  | 'conflict';

export interface ExternalContext {
  draft: string;
  /** 最近一次与磁盘同步的内容(打开时读到的,或自己保存的) */
  baseline: string;
  /** 最近一次自己写入的内容(用于抑制 watcher 自写回环) */
  lastWritten: string | null;
  /** 是否正在保存 */
  saving?: boolean;
}

/**
 * 判定一次 file-changed 事件。
 *
 * 关键点:watcher 会把**自己刚保存**的文件也报上来。若不抑制,
 * 保存后立刻重读 → 触发重渲染 → 预览重挂载 → 光标位置丢。
 * 因此先比对 `lastWritten`,再比对草稿,最后才看脏标记。
 */
export function decideExternalChange(ctx: ExternalContext, incoming: string): ExternalDecision {
  if (incoming === ctx.draft) return 'ignore';
  if (ctx.lastWritten !== null && incoming === ctx.lastWritten) return 'ignore';
  // 保存中:磁盘此刻可能是我们自己的中间态,等保存完成再判
  if (ctx.saving) return 'ignore';
  if (ctx.draft === ctx.baseline) return 'reload';
  return 'conflict';
}

