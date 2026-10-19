/**
 * 「打开库」的统一收尾流程。
 *
 * 入口共用同一套逻辑:启动(复用 remembered 路径、外部文件或弹选择框)、
 * 快捷键 Ctrl+O、文件树「打开库」按钮、欢迎页「打开库」按钮、文件关联唤起。
 * 收尾 = 记住库 → 切到文件页签 → 列近期文件 → 打开指定文档
 * (未指定则打开最近一篇;无历史则打开内置示例;空库保持无文档状态)。
 *
 * 所有切库操作串行执行:启动流程与「运行中双击文档」可能并发,
 * 若交错完成,后开始的会被先开始的覆盖。
 */
import { getBackend } from './ipc';
import { useStore } from './store';
import type { VaultInfo } from './types';

/** 内置示例文档:空库时给用户一个可读的东西 */
export const SAMPLE_DOC = '欢迎使用 WindMD.md';

let vaultQueue: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): Promise<void> {
  const run = vaultQueue.then(task);
  // 队列自身吞掉失败,避免一次打开失败卡死后续操作;调用方仍能拿到 reject
  vaultQueue = run.catch(() => {});
  return run;
}

/**
 * 库就绪后的收尾(选择框由调用方或本模块另一个导出负责)。
 * `switchTab=false` 供启动流程使用:索引/读盘期间用户可能已切到搜索页签,
 * 收尾不应把用户的选择抢回「文件」。
 */
export async function loadVaultContents(
  v: VaultInfo,
  preferredPath?: string,
  switchTab = true,
): Promise<void> {
  const s = useStore.getState();
  s.setVault(v);
  if (switchTab) s.setPanelTab('files');
  const b = await getBackend();
  const recent = await b.recentFiles(10);
  s.setRecent(recent);
  const target = preferredPath ?? recent[0]?.path ?? SAMPLE_DOC;
  try {
    const f = await b.readFile(target);
    const meta = await b.getMeta(target);
    s.openDoc(f.path, f.content, meta);
  } catch (e) {
    // 空库/示例缺失不是错误:保持无文档状态,欢迎页会引导用户新建
    if (preferredPath || recent.length > 0) console.error(e);
  }
}

/** 复用上次的库;路径失效时 reject,由启动流程回退到选择框 */
export function openSavedVault(path: string): Promise<void> {
  return enqueue(async () => {
    const v = await (await getBackend()).openVault(path);
    await loadVaultContents(v, undefined, false);
  });
}

/**
 * 弹系统选择框打开库;用户取消时静默返回(调用方无需区分取消与失败)。
 * 启动流程传 `false`,避免收尾覆盖用户已切换的面板页签。
 */
export function openVaultWithPicker(switchTab = true): Promise<void> {
  return enqueue(async () => {
    try {
      const v = await (await getBackend()).openVault();
      await loadVaultContents(v, undefined, switchTab);
    } catch {
      /* 用户取消选择:维持现状(欢迎页/文件树可见) */
    }
  });
}

/** 文件关联/命令行传入的绝对路径:以所在目录为库,并定位到该文件 */
export function openPathFromOS(path: string): Promise<void> {
  return enqueue(async () => {
    const b = await getBackend();
    const opened = await b.openPath(path);
    const s = useStore.getState();
    // 事件通道与启动补取可能送来同一篇;已经在这篇上就不重复读盘
    if (s.vault?.root === opened.vault.root && s.activePath === opened.path) return;
    await loadVaultContents(opened.vault, opened.path);
  });
}
