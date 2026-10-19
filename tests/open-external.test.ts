/**
 * 外部打开流程:文件关联传入绝对路径时,
 * 必须打开后端定位的那一篇,而不是“最近文件”或上次的库。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../src/store';
import type { DocumentMeta, OpenFile, VaultInfo } from '../src/types';

const mocks = vi.hoisted(() => ({
  openPath: vi.fn(),
  openVault: vi.fn(),
  recentFiles: vi.fn(),
  readFile: vi.fn(),
  getMeta: vi.fn(),
}));

vi.mock('../src/ipc', () => ({
  getBackend: async () => mocks,
}));

import { loadVaultContents, openPathFromOS } from '../src/open-vault';

const vault: VaultInfo = { name: 'notes', root: 'E:/notes', fileCount: 2 };

const metaOf = (path: string): DocumentMeta => ({
  path,
  title: path.replace(/\.md$/, ''),
  size: 10,
  mtime: 0,
  readProgress: 0,
  starred: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({
    vault: null,
    activePath: null,
    content: '',
    meta: null,
    recentFiles: [],
    panelTab: 'files',
  });
  mocks.openVault.mockResolvedValue(vault);
  mocks.openPath.mockResolvedValue({ vault, path: 'b.md' });
  mocks.recentFiles.mockResolvedValue([metaOf('a.md')]);
  mocks.getMeta.mockImplementation(async (path: string) => metaOf(path));
  mocks.readFile.mockImplementation(
    async (path: string): Promise<OpenFile> => ({
      path,
      content: `# ${path}`,
      mtime: 0,
      size: 10,
    }),
  );
});

describe('外部文件打开', () => {
  it('loadVaultContents 指定文档时不回落到最近一篇', async () => {
    await loadVaultContents(vault, 'b.md');

    expect(mocks.readFile).toHaveBeenCalledWith('b.md');
    expect(useStore.getState().activePath).toBe('b.md');
    expect(useStore.getState().content).toBe('# b.md');
    expect(localStorage.getItem('windmd-vault')).toBe('E:/notes');
  });

  it('openPathFromOS 切换到所在目录的库并定位到该文件', async () => {
    await openPathFromOS('E:/notes/b.md');

    expect(mocks.openPath).toHaveBeenCalledWith('E:/notes/b.md');
    expect(useStore.getState().vault?.root).toBe('E:/notes');
    expect(useStore.getState().activePath).toBe('b.md');
    expect(useStore.getState().recentFiles.map((f) => f.path)).toEqual(['a.md']);
  });
});
