/**
 * 欢迎页测试(T4.2 空库引导):未开库/空库两态、打开库、新建文档(不重名)。
 *
 * 注意:store 的 `vault` 与 mock 后端的 `vaultRoot` 是两回事 ——
 * 需要后端能力(listFiles/createFile)的用例,要先让 mock 侧真正开库。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Welcome } from '../src/ui/Welcome';
import { useStore } from '../src/store';
import { getBackend } from '../src/ipc';
import type { VaultInfo } from '../src/types';

const VAULT: VaultInfo = { name: '示例库', root: 'mock://vault', fileCount: 3 };

beforeEach(() => {
  useStore.setState({ vault: null, activePath: null, content: '', meta: null, recentFiles: [] });
});

afterEach(cleanup);

describe('Welcome 欢迎页', () => {
  it('未开库:给出引导,「新建文档」不可用', () => {
    render(<Welcome />);
    expect(screen.getByText('还没有打开库')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /新建文档/ })).toBeDisabled();
    // 快捷键速览(读当前绑定)
    expect(screen.getByText('文档内查找')).toBeInTheDocument();
    expect(screen.getByText('全库搜索')).toBeInTheDocument();
  });

  it('空库:提示这个库还没有文档,「新建文档」可用', () => {
    useStore.setState({ vault: VAULT });
    render(<Welcome />);
    expect(screen.getByText('这个库还没有文档')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /新建文档/ })).toBeEnabled();
  });

  it('新建文档:创建并自动打开,重名自动加序号', async () => {
    // 先让 mock 侧开库,否则 listFiles 会抛 NO_VAULT
    await (await getBackend()).openVault();
    useStore.setState({ vault: VAULT });
    render(<Welcome />);
    fireEvent.click(screen.getByRole('button', { name: /新建文档/ }));
    await waitFor(() => expect(useStore.getState().activePath).toBe('未命名文档.md'));
    expect(useStore.getState().content).toContain('未命名文档');
    // 再建一次:不得覆盖刚才那篇
    fireEvent.click(screen.getByRole('button', { name: /新建文档/ }));
    await waitFor(() => expect(useStore.getState().activePath).toBe('未命名文档-1.md'));
  });

  it('打开库:走统一流程(记库 + 列近期 + 打开最近一篇)', async () => {
    render(<Welcome />);
    fireEvent.click(screen.getByRole('button', { name: /打开库/ }));
    // 等到整条流程走完(近期列表就绪),而不是中间态
    await waitFor(() => {
      const s = useStore.getState();
      expect(s.vault).not.toBeNull();
      expect(s.recentFiles.length).toBeGreaterThan(0);
    });
    const s = useStore.getState();
    // mock 库的近期第一篇被自动打开
    expect(s.activePath).toBe(s.recentFiles[0].path);
    expect(s.content.length).toBeGreaterThan(0);
  });
});
