/**
 * 「打开库」的统一收尾流程。
 *
 * 入口共用同一套逻辑:启动(复用 remembered 路径或弹选择框)、快捷键 Ctrl+O、
 * 文件树「打开库」按钮、欢迎页「打开库」按钮。
 * 收尾 = 记住库 → 切到文件页签 → 列近期文件 → 打开最近一篇
 * (无历史则打开内置示例;库为空则保持无文档状态,交给欢迎页引导)。
 */
import { getBackend } from './ipc';
import { useStore } from './store';
import type { VaultInfo } from './types';

/** 内置示例文档:空库时给用户一个可读的东西 */
export const SAMPLE_DOC = '欢迎使用 WindMD.md';

/** 库就绪后的收尾(选择框由调用方或本模块另一个导出负责) */
export async function loadVaultContents(v: VaultInfo): Promise<void> {
  const s = useStore.getState();
  s.setVault(v);
  s.setPanelTab('files');
  const b = await getBackend();
  const recent = await b.recentFiles(10);
  s.setRecent(recent);
  const target = recent[0]?.path ?? SAMPLE_DOC;
  try {
    const f = await b.readFile(target);
    const meta = await b.getMeta(target);
    s.openDoc(f.path, f.content, meta);
  } catch (e) {
    // 空库/示例缺失不是错误:保持无文档状态,欢迎页会引导用户新建
    if (recent.length > 0) console.error(e);
  }
}

/** 弹系统选择框打开库;用户取消时静默返回(调用方无需区分取消与失败) */
export async function openVaultWithPicker(): Promise<void> {
  try {
    const v = await (await getBackend()).openVault();
    await loadVaultContents(v);
  } catch {
    /* 用户取消选择:维持现状(欢迎页/文件树可见) */
  }
}
