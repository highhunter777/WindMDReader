/**
 * IPC 层统一入口。
 * 通过动态检测是否运行于 Tauri 环境,自动选择 mock 或 tauri 后端。
 */
import type { WindMDBackend } from '../types';

let backend: WindMDBackend | null = null;

export async function getBackend(): Promise<WindMDBackend> {
  if (backend) return backend;
  // Tauri 环境检测:window.__TAURI_INTERNALS__ 是 Tauri 2 的标记
  const isTauri =
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as unknown as object);
  if (isTauri) {
    const { createTauriBackend } = await import('./tauri');
    backend = createTauriBackend();
  } else {
    const { createMockBackend } = await import('./mock');
    backend = createMockBackend();
  }
  return backend;
}

export type { WindMDBackend };
