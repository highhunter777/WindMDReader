/**
 * 主题三态测试(T4.2):显式切换、跟随系统解析、系统变化联动、持久化。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../src/store';

beforeEach(() => {
  localStorage.clear();
  // 回到已知状态:显式浅色(避开默认的「跟随系统」)
  useStore.setState({ theme: 'light', themeMode: 'light' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('主题三态', () => {
  it('setThemeMode 显式值立即生效并持久化', () => {
    useStore.getState().setThemeMode('dark');
    expect(useStore.getState().theme).toBe('dark');
    expect(useStore.getState().themeMode).toBe('dark');
    expect(localStorage.getItem('windmd-theme-mode')).toBe('dark');
  });

  it('toggleTheme 按当前生效主题取反,并落到显式模式', () => {
    useStore.getState().toggleTheme();
    expect(useStore.getState().theme).toBe('dark');
    expect(useStore.getState().themeMode).toBe('dark');
    useStore.getState().toggleTheme();
    expect(useStore.getState().theme).toBe('light');
    expect(useStore.getState().themeMode).toBe('light');
  });

  it('system 模式按系统明暗解析(jsdom 恒为浅色)', () => {
    useStore.getState().setThemeMode('system');
    expect(useStore.getState().theme).toBe('light');
  });

  it('系统切到深色时,system 模式跟随;显式模式不跟随', async () => {
    let onChange: ((e: MediaQueryListEvent) => void) | null = null;
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: false,
      addEventListener: (_t: string, cb: (e: MediaQueryListEvent) => void) => {
        onChange = cb;
      },
      removeEventListener: () => {},
    } as unknown as MediaQueryList);

    // 动态导入:让 store 在 mock 之后初始化,模块级监听才会挂到假 MQL 上
    vi.resetModules();
    const { useStore: fresh } = await import('../src/store');
    fresh.setState({ themeMode: 'system', theme: 'light' });

    expect(onChange).toBeTypeOf('function');
    onChange!({ matches: true } as MediaQueryListEvent);
    expect(fresh.getState().theme).toBe('dark');

    // 显式模式不受系统变化影响
    fresh.getState().setThemeMode('light');
    onChange!({ matches: true } as MediaQueryListEvent);
    expect(fresh.getState().theme).toBe('light');

    onChange!({ matches: false } as MediaQueryListEvent);
    expect(fresh.getState().theme).toBe('light');
  });

  it('旧版显式主题键可作为迁移值(无三态键时)', async () => {
    localStorage.setItem('windmd-theme', 'dark');
    vi.resetModules();
    const { useStore: fresh } = await import('../src/store');
    expect(fresh.getState().themeMode).toBe('dark');
    expect(fresh.getState().theme).toBe('dark');
  });

  it('三态键优先于旧版键', async () => {
    localStorage.setItem('windmd-theme', 'dark');
    localStorage.setItem('windmd-theme-mode', 'system');
    vi.resetModules();
    const { useStore: fresh } = await import('../src/store');
    expect(fresh.getState().themeMode).toBe('system');
  });
});
