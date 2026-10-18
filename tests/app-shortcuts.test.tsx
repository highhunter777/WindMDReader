/**
 * App 级快捷键集成测试(T3.4 重构后的全局处理器):
 * 默认绑定行为、输入态豁免、Esc、设置页与导出菜单的快捷键入口。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../src/App';
import { useStore } from '../src/store';

beforeEach(() => {
  useStore.setState({
    focusLine: false,
    typewriter: false,
    zen: false,
    fontSize: 17,
    findOpen: false,
    sidebarOpen: true,
    panelTab: 'files',
    bindings: useStore.getState().bindings, // 由各用例自行改
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  useStore.getState().resetBindings();
});

async function renderApp() {
  render(<App />);
  // 等工具栏挂载(同步渲染;不依赖后端启动链,避免受 mock 持久化状态影响)
  await waitFor(() => expect(document.querySelector('.toolbar')).not.toBeNull());
}

describe('App 快捷键 — 阅读模式', () => {
  it('f 切换焦点行', async () => {
    await renderApp();
    fireEvent.keyDown(window, { key: 'f' });
    expect(useStore.getState().focusLine).toBe(true);
    fireEvent.keyDown(window, { key: 'f' });
    expect(useStore.getState().focusLine).toBe(false);
  });

  it('t 切换打字机', async () => {
    await renderApp();
    fireEvent.keyDown(window, { key: 't' });
    expect(useStore.getState().typewriter).toBe(true);
  });

  it('序列键连按触发序列动作', async () => {
    await renderApp();
    // 序列动作难以在此断言滚动(jsdom 无布局),改为改键后验证序列可达:
    // 把「打字机」绑到 x x(避开默认 g g / z z),连按两次应触发它
    useStore.getState().setBinding('typewriter', 'x x');
    fireEvent.keyDown(window, { key: 'x' });
    fireEvent.keyDown(window, { key: 'x' });
    expect(useStore.getState().typewriter).toBe(true);
  });

  it('序列超窗口(>600ms)不触发', async () => {
    await renderApp();
    useStore.getState().setBinding('typewriter', 'x x');
    fireEvent.keyDown(window, { key: 'x' });
    await new Promise((r) => setTimeout(r, 650));
    fireEvent.keyDown(window, { key: 'x' });
    expect(useStore.getState().typewriter).toBe(false);
  });
});

describe('App 快捷键 — 输入态豁免', () => {
  it('输入框内的纯键不触发阅读快捷键', async () => {
    await renderApp();
    useStore.getState().setFindOpen(true);
    const input = await screen.findByPlaceholderText(/查找/);
    input.focus();
    fireEvent.keyDown(input, { key: 'f' });
    expect(useStore.getState().focusLine).toBe(false);
  });

  it('输入框内的 Ctrl 组合仍然生效', async () => {
    await renderApp();
    useStore.getState().setFindOpen(true);
    const input = await screen.findByPlaceholderText(/查找/);
    input.focus();
    fireEvent.keyDown(input, { key: 'e', ctrlKey: true });
    expect(useStore.getState().theme).toBe('dark'); // 初始 light → 切换后 dark
  });
});

describe('App 快捷键 — 缩放', () => {
  it('Ctrl+= 放大、Ctrl+- 缩小、Ctrl+0 重置', async () => {
    await renderApp();
    fireEvent.keyDown(window, { key: '=', ctrlKey: true });
    expect(useStore.getState().fontSize).toBe(18);
    fireEvent.keyDown(window, { key: '=', ctrlKey: true });
    expect(useStore.getState().fontSize).toBe(19);
    fireEvent.keyDown(window, { key: '-', ctrlKey: true });
    expect(useStore.getState().fontSize).toBe(18);
    fireEvent.keyDown(window, { key: '0', ctrlKey: true });
    expect(useStore.getState().fontSize).toBe(17);
  });

  it('缩放有上下限(14..22)', async () => {
    await renderApp();
    useStore.setState({ fontSize: 22 });
    fireEvent.keyDown(window, { key: '=', ctrlKey: true });
    expect(useStore.getState().fontSize).toBe(22);
    useStore.setState({ fontSize: 14 });
    fireEvent.keyDown(window, { key: '-', ctrlKey: true });
    expect(useStore.getState().fontSize).toBe(14);
  });
});

describe('App 快捷键 — 面板入口', () => {
  it('Ctrl+, 打开设置页', async () => {
    await renderApp();
    fireEvent.keyDown(window, { key: ',', ctrlKey: true });
    expect(await screen.findByRole('dialog', { name: '设置' })).toBeInTheDocument();
    // Esc 关闭
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '设置' })).not.toBeInTheDocument(),
    );
  });

  it('Ctrl+P 打开导出菜单', async () => {
    await renderApp();
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
    // 导出菜单懒加载 + 空闲预取,等 chunk 就绪
    await waitFor(() => expect(screen.getByText('导出 HTML')).toBeInTheDocument(), { timeout: 4000 });
  });

  it('Ctrl+F 打开文档内查找', async () => {
    await renderApp();
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(useStore.getState().findOpen).toBe(true);
  });

  it('Ctrl+Shift+F 打开全库搜索(侧栏收起时也能打开)', async () => {
    await renderApp();
    useStore.setState({ sidebarOpen: false, panelTab: 'files' });
    fireEvent.keyDown(window, { key: 'F', ctrlKey: true, shiftKey: true });
    expect(useStore.getState().sidebarOpen).toBe(true);
    expect(useStore.getState().panelTab).toBe('search');
    // 面板真的渲染出来了(不只是标志位)
    expect(await screen.findByPlaceholderText('全库搜索…')).toBeInTheDocument();
  });

  it('工具栏全库搜索按钮:侧栏收起时点击可打开搜索面板', async () => {
    await renderApp();
    // act 包裹:保证组件先按新状态渲染完,点击时闭包里的才是新值
    act(() => {
      useStore.setState({ sidebarOpen: false, panelTab: 'files' });
    });
    fireEvent.click(screen.getByTitle('全库搜索 (Ctrl+Shift+F)'));
    expect(useStore.getState().sidebarOpen).toBe(true);
    expect(useStore.getState().panelTab).toBe('search');
    expect(await screen.findByPlaceholderText('全库搜索…')).toBeInTheDocument();
  });

  it('工具栏全库搜索按钮:已在搜索面板时再点一次收起侧栏', async () => {
    await renderApp();
    act(() => {
      useStore.setState({ sidebarOpen: true, panelTab: 'files' });
    });
    fireEvent.click(screen.getByTitle('全库搜索 (Ctrl+Shift+F)'));
    expect(useStore.getState().panelTab).toBe('search');
    fireEvent.click(screen.getByTitle('全库搜索 (Ctrl+Shift+F)'));
    expect(useStore.getState().sidebarOpen).toBe(false);
  });
});

describe('App 快捷键 — 改键生效', () => {
  it('改掉焦点行绑定后,原键失效、新键生效', async () => {
    await renderApp();
    useStore.getState().setBinding('focus-line', 'ctrl+h');
    fireEvent.keyDown(window, { key: 'f' });
    expect(useStore.getState().focusLine).toBe(false);
    fireEvent.keyDown(window, { key: 'h', ctrlKey: true });
    expect(useStore.getState().focusLine).toBe(true);
  });
});
