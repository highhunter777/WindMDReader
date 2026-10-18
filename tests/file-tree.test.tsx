/**
 * 文件树增删改 + 收藏面板测试(T2.1 / T2.6)。
 * 通过 mock 后端驱动 Sidebar,验证右键菜单、行内输入、删除确认与收藏列表。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Sidebar } from '../src/ui/Sidebar';
import { Toolbar } from '../src/ui/Toolbar';
import { getBackend } from '../src/ipc';
import { useStore } from '../src/store';

/** 等待组件内的异步后端调用刷新完成(fake-indexeddb 为真实异步,需多轮宏任务) */
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
};

/** 测试用的库信息;与后端 openVault 保持一致(两侧都要就绪,否则 mock 会按 NO_VAULT 拒绝) */
const TEST_VAULT = { name: '测试库', root: 'mock://测试库', fileCount: 0 };

beforeEach(async () => {
  useStore.setState({
    sidebarOpen: true,
    panelTab: 'files',
    activePath: null,
    meta: null,
    vault: TEST_VAULT,
  });
  // 清掉上个用例遗留的测试文件,保证列表可预期
  const b = await getBackend();
  await b.openVault(TEST_VAULT.root);
  for (const p of ['树测-新文件.md', '树测-重命名.md', '树测-删除我.md', '树测-失焦创建.md', '树测-旧名.md', '树测-失敏改名.md']) {
    try {
      await b.deleteFile(p);
    } catch {
      /* 不存在则忽略 */
    }
  }
});

describe('Sidebar — 文件树渲染', () => {
  it('展示根目录下的示例文档', async () => {
    render(<Sidebar />);
    await flush();
    expect(screen.getByText('欢迎使用 WindMD.md')).toBeInTheDocument();
    expect(screen.getByText('使用指南.md')).toBeInTheDocument();
  });

  it('右键节点弹出上下文菜单', async () => {
    render(<Sidebar />);
    await flush();
    fireEvent.contextMenu(screen.getByText('使用指南.md'), { clientX: 10, clientY: 20 });
    const menu = document.querySelector('.tree-menu') as HTMLElement;
    expect(menu).toBeInTheDocument();
    expect(within(menu).getByText('新建文件')).toBeInTheDocument();
    expect(within(menu).getByText('重命名')).toBeInTheDocument();
    expect(within(menu).getByText('删除')).toBeInTheDocument();
  });

  it('Escape 关闭菜单', async () => {
    render(<Sidebar />);
    await flush();
    fireEvent.contextMenu(screen.getByText('使用指南.md'), { clientX: 10, clientY: 20 });
    expect(document.querySelector('.tree-menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('.tree-menu')).toBeNull();
  });
});

describe('Sidebar — 新建文件', () => {
  it('工具栏新建按钮 → 输入名称 → 回车创建并自动打开', async () => {
    render(<Sidebar />);
    await flush();
    fireEvent.click(screen.getByTitle('在库根新建文件'));
    const input = document.querySelector('.tree-name-input') as HTMLInputElement;
    expect(input).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '树测-新文件' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await flush();

    // 自动补 .md 后缀并出现在树中
    expect(screen.getByText('树测-新文件.md')).toBeInTheDocument();
    // 自动打开:成为当前文档
    expect(useStore.getState().activePath).toBe('树测-新文件.md');
    // 输入框消失
    expect(document.querySelector('.tree-name-input')).toBeNull();
  });

  it('空名称不会创建文件', async () => {
    render(<Sidebar />);
    await flush();
    fireEvent.click(screen.getByTitle('在库根新建文件'));
    const input = document.querySelector('.tree-name-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await flush();
    expect(screen.queryByText('树测-新文件.md')).toBeNull();
  });

  it('Escape 取消新建', async () => {
    render(<Sidebar />);
    await flush();
    fireEvent.click(screen.getByTitle('在库根新建文件'));
    const input = document.querySelector('.tree-name-input') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(document.querySelector('.tree-name-input')).toBeNull();
  });

  it('失焦且有内容时自动创建(点击别处即确认)', async () => {
    render(<Sidebar />);
    await flush();
    fireEvent.click(screen.getByTitle('在库根新建文件'));
    const input = document.querySelector('.tree-name-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '树测-失焦创建' } });
    fireEvent.blur(input);
    await flush();
    expect(screen.getByText('树测-失焦创建.md')).toBeInTheDocument();
    expect(useStore.getState().activePath).toBe('树测-失焦创建.md');
  });

  it('失焦且无内容时取消', async () => {
    render(<Sidebar />);
    await flush();
    fireEvent.click(screen.getByTitle('在库根新建文件'));
    const input = document.querySelector('.tree-name-input') as HTMLInputElement;
    fireEvent.blur(input);
    expect(document.querySelector('.tree-name-input')).toBeNull();
    expect(screen.queryByText('树测-失焦创建.md')).toBeNull();
  });
});

describe('Sidebar — 重命名', () => {
  it('右键 → 重命名 → 输入新名 → 列表更新', async () => {
    const b = await getBackend();
    await b.writeFile('树测-旧名.md', '内容');
    render(<Sidebar />);
    await flush();

    fireEvent.contextMenu(screen.getByText('树测-旧名.md'), { clientX: 5, clientY: 5 });
    fireEvent.click(within(document.querySelector('.tree-menu') as HTMLElement).getByText('重命名'));
    const input = document.querySelector('.tree-name-input') as HTMLInputElement;
    expect(input.value).toBe('树测-旧名.md');

    fireEvent.change(input, { target: { value: '树测-重命名' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await flush();

    expect(screen.queryByText('树测-旧名.md')).toBeNull();
    expect(screen.getByText('树测-重命名.md')).toBeInTheDocument();
    expect((await b.readFile('树测-重命名.md')).content).toBe('内容');
  });

  it('名称未变化时直接退出编辑', async () => {
    const b = await getBackend();
    await b.writeFile('树测-旧名.md', '内容');
    render(<Sidebar />);
    await flush();
    fireEvent.contextMenu(screen.getByText('树测-旧名.md'), { clientX: 5, clientY: 5 });
    fireEvent.click(within(document.querySelector('.tree-menu') as HTMLElement).getByText('重命名'));
    const input = document.querySelector('.tree-name-input') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(document.querySelector('.tree-name-input')).toBeNull();
    expect(screen.getByText('树测-旧名.md')).toBeInTheDocument();
  });

  it('重命名失焦即提交', async () => {
    const b = await getBackend();
    await b.writeFile('树测-旧名.md', '内容');
    render(<Sidebar />);
    await flush();
    fireEvent.contextMenu(screen.getByText('树测-旧名.md'), { clientX: 5, clientY: 5 });
    fireEvent.click(within(document.querySelector('.tree-menu') as HTMLElement).getByText('重命名'));
    const input = document.querySelector('.tree-name-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '树测-失敏改名' } });
    fireEvent.blur(input);
    await flush();
    expect(screen.queryByText('树测-旧名.md')).toBeNull();
    expect(screen.getByText('树测-失敏改名.md')).toBeInTheDocument();
  });
});

describe('Sidebar — 删除', () => {
  it('两步确认后删除文件', async () => {
    const b = await getBackend();
    await b.writeFile('树测-删除我.md', '内容');
    render(<Sidebar />);
    await flush();

    fireEvent.contextMenu(screen.getByText('树测-删除我.md'), { clientX: 5, clientY: 5 });
    const menu = document.querySelector('.tree-menu') as HTMLElement;
    fireEvent.click(within(menu).getByText('删除'));
    // 进入确认态
    expect(within(menu).getByText(/删除「树测-删除我.md」/)).toBeInTheDocument();

    fireEvent.click(within(menu).getByText('确认删除'));
    await flush();

    expect(screen.queryByText('树测-删除我.md')).toBeNull();
    await expect(b.readFile('树测-删除我.md')).rejects.toThrow();
  });

  it('取消删除保留文件', async () => {
    const b = await getBackend();
    await b.writeFile('树测-删除我.md', '内容');
    render(<Sidebar />);
    await flush();

    fireEvent.contextMenu(screen.getByText('树测-删除我.md'), { clientX: 5, clientY: 5 });
    const menu = document.querySelector('.tree-menu') as HTMLElement;
    fireEvent.click(within(menu).getByText('删除'));
    fireEvent.click(within(menu).getByText('取消'));
    await flush();

    expect(screen.getByText('树测-删除我.md')).toBeInTheDocument();
    expect((await b.readFile('树测-删除我.md')).content).toBe('内容');
  });
});

describe('Sidebar — 收藏面板', () => {
  it('展示收藏文档并可取消收藏', async () => {
    const b = await getBackend();
    await b.setMeta('欢迎使用 WindMD.md', { starred: true });

    render(<Sidebar />);
    await flush();
    fireEvent.click(screen.getByText('收藏'));
    await flush();

    const panel = document.querySelector('.starred-panel') as HTMLElement;
    expect(within(panel).getByText('欢迎使用 WindMD')).toBeInTheDocument();

    fireEvent.click(within(panel).getByTitle('取消收藏'));
    await flush();
    expect(within(panel).queryByText('欢迎使用 WindMD')).toBeNull();
    expect((await b.starredFiles()).length).toBe(0);
  });

  it('无收藏时显示空提示', async () => {
    render(<Sidebar />);
    await flush();
    fireEvent.click(screen.getByText('收藏'));
    await flush();
    expect(screen.getByText(/还没有收藏/)).toBeInTheDocument();
  });
});

/**
 * 回归:真实环境报过"首次打开桌面端,文件目录出现 [object Object]"。
 *
 * 起因是竞态 —— 库由 App 启动流程异步打开,文件树却在挂载时就去列目录,
 * 必然撞上 NO_VAULT;而 Rust 的 AppError 序列化后是普通对象,String(e) 就成了
 * "[object Object]"。这两条都锁住。
 */
describe('Sidebar — 库未就绪时的加载时序', () => {
  it('库还没打开时不列目录,也不显示任何错误', async () => {
    useStore.setState({ vault: null });
    render(<Sidebar />);
    await flush();
    expect(document.querySelector('.tree-error')).toBeNull();
    expect(document.body.textContent).not.toContain('[object Object]');
  });

  it('库就绪后才拉目录,条目正常出现', async () => {
    useStore.setState({ vault: null });
    render(<Sidebar />);
    await flush();
    expect(screen.queryByText('欢迎使用 WindMD.md')).toBeNull();

    // 模拟启动流程:openVault 完成后 setVault
    useStore.setState({ vault: TEST_VAULT });
    await flush();
    expect(screen.getByText('欢迎使用 WindMD.md')).toBeInTheDocument();
  });

  it('列目录失败时给出可读文案,并在下次成功后消失', async () => {
    render(<Sidebar />);
    await flush();

    // 后端拒绝(store 说有库、mock 说没有,模拟两侧不一致的真实瞬间)
    const b = await getBackend();
    const spy = vi.spyOn(b, 'listFiles').mockRejectedValueOnce({ code: 'NO_VAULT', message: '未选择库目录' });
    useStore.setState({ vault: { ...TEST_VAULT, root: 'mock://另一个库' } });
    await flush();

    const err = document.querySelector('.tree-error') as HTMLElement | null;
    expect(err).not.toBeNull();
    expect(err?.textContent).toBe('未选择库目录');
    expect(document.body.textContent).not.toContain('[object Object]');
    spy.mockRestore();

    // 下一次成功加载后错误条应被清掉(旧实现里它会一直挂着)
    useStore.setState({ vault: TEST_VAULT });
    await flush();
    expect(document.querySelector('.tree-error')).toBeNull();
    expect(screen.getByText('欢迎使用 WindMD.md')).toBeInTheDocument();
  });
});

describe('Toolbar — 收藏按钮', () => {
  const meta = (starred: boolean) => ({
    path: '欢迎使用 WindMD.md',
    title: '欢迎使用 WindMD',
    size: 100,
    mtime: 0,
    readProgress: 0,
    starred,
  });

  beforeEach(() => {
    useStore.setState({
      zen: false,
      activePath: '欢迎使用 WindMD.md',
      meta: meta(false),
    });
  });

  it('点击收藏写入后端并更新状态', async () => {
    const b = await getBackend();
    render(<Toolbar />);
    fireEvent.click(screen.getByTitle('收藏本文档'));
    await flush();
    expect(useStore.getState().meta?.starred).toBe(true);
    expect((await b.getMeta('欢迎使用 WindMD.md'))?.starred).toBe(true);
    // 按钮切换为取消收藏态
    expect(screen.getByTitle('取消收藏')).toBeInTheDocument();
  });

  it('再次点击取消收藏', async () => {
    const b = await getBackend();
    await b.setMeta('欢迎使用 WindMD.md', { starred: true });
    useStore.setState({ meta: meta(true) });
    render(<Toolbar />);
    fireEvent.click(screen.getByTitle('取消收藏'));
    await flush();
    expect(useStore.getState().meta?.starred).toBe(false);
    expect((await b.getMeta('欢迎使用 WindMD.md'))?.starred).toBe(false);
  });
});
