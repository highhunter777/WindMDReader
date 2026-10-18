/**
 * 设置页测试(T3.4):改键捕获、冲突拒绝、恢复默认、翻译配置落库。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SettingsPage } from '../src/ui/SettingsPage';
import { useStore } from '../src/store';
import { DEFAULT_BINDINGS } from '../src/renderer/shortcuts';

afterEach(() => {
  cleanup();
  useStore.getState().resetBindings();
  useStore.setState({
    translateOnlineEnabled: false,
    translateEndpoint: '',
    translateModel: '',
    translateApiKey: '',
    themeMode: 'system',
    theme: 'light',
    fontSize: 17,
    readingWidth: 720,
    fontFamily: 'sans',
  });
});

function renderPage(onClose = () => {}) {
  return render(<SettingsPage onClose={onClose} />);
}

describe('SettingsPage — 渲染', () => {
  it('展示全部分组的快捷键', () => {
    renderPage();
    for (const g of ['文件与面板', '阅读导航', '阅读模式', '排版与导出']) {
      expect(screen.getByText(g)).toBeInTheDocument();
    }
    expect(screen.getByText('文档内查找')).toBeInTheDocument();
    expect(screen.getByText('回到顶部')).toBeInTheDocument();
  });

  it('展示默认绑定(可读形式)', () => {
    renderPage();
    expect(screen.getByText('Ctrl + F')).toBeInTheDocument();
    expect(screen.getByText('G 然后 G')).toBeInTheDocument();
  });

  it('展示在线翻译配置区', () => {
    renderPage();
    expect(screen.getByText(/在线端点/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('https://api.openai.com/v1')).toBeInTheDocument();
  });
});

describe('SettingsPage — 改键', () => {
  it('点击按键进入捕获态,按新组合后落库', () => {
    renderPage();
    // 「文档内查找」行
    const row = screen.getByText('文档内查找').closest('.settings-row')!;
    fireEvent.click(row.querySelector('.settings-key')!);
    expect(screen.getByText('按下新按键…')).toBeInTheDocument();
    // 按 Ctrl+H
    fireEvent.keyDown(window, { key: 'h', ctrlKey: true });
    expect(useStore.getState().bindings.find).toBe('ctrl+h');
    expect(screen.queryByText('按下新按键…')).not.toBeInTheDocument();
  });

  it('改键持久化到 localStorage', () => {
    renderPage();
    const row = screen.getByText('向上滚动').closest('.settings-row')!;
    fireEvent.click(row.querySelector('.settings-key')!);
    fireEvent.keyDown(window, { key: 'u', ctrlKey: true });
    const saved = JSON.parse(localStorage.getItem('windmd-keys')!);
    expect(saved['scroll-up']).toBe('ctrl+u');
  });

  it('组合被其他动作占用时拒绝并提示', () => {
    renderPage();
    // 把「向上滚动」改成 Ctrl+F(已被查找占用)
    const row = screen.getByText('向上滚动').closest('.settings-row')!;
    fireEvent.click(row.querySelector('.settings-key')!);
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(screen.getByText(/已被「文档内查找」占用/)).toBeInTheDocument();
    expect(useStore.getState().bindings['scroll-up']).toBe(DEFAULT_BINDINGS['scroll-up']);
  });

  it('捕获态按 Esc 取消,不改键', () => {
    renderPage();
    const row = screen.getByText('向下滚动').closest('.settings-row')!;
    fireEvent.click(row.querySelector('.settings-key')!);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('按下新按键…')).not.toBeInTheDocument();
    expect(useStore.getState().bindings['scroll-down']).toBe('j');
  });

  it('恢复默认清掉所有改键', () => {
    useStore.getState().setBinding('find', 'ctrl+h');
    renderPage();
    fireEvent.click(screen.getByText('恢复默认'));
    expect(useStore.getState().bindings.find).toBe('ctrl+f');
    expect(localStorage.getItem('windmd-keys')).toBeNull();
  });
});

describe('SettingsPage — 在线翻译配置', () => {
  it('填写端点与启用开关落 store', () => {
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('https://api.openai.com/v1'), {
      target: { value: 'https://x.com/v1' },
    });
    expect(useStore.getState().translateEndpoint).toBe('https://x.com/v1');
    const checkbox = screen
      .getByText('启用在线翻译')
      .closest('label')!
      .querySelector('input')!;
    fireEvent.click(checkbox);
    expect(useStore.getState().translateOnlineEnabled).toBe(true);
  });
});

describe('SettingsPage — 外观', () => {
  it('三态主题:默认跟随系统,点击切换并同步生效主题', () => {
    renderPage();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(screen.getByRole('radio', { name: '跟随系统' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: '深色' }));
    expect(useStore.getState().themeMode).toBe('dark');
    expect(useStore.getState().theme).toBe('dark');
    expect(screen.getByRole('radio', { name: '深色' }).getAttribute('aria-checked')).toBe('true');
    // 提示行展示当前生效主题
    expect(screen.getByText(/当前生效:深色/)).toBeInTheDocument();
  });
});

describe('SettingsPage — 排版', () => {
  it('展示当前排版值,可一键恢复默认', () => {
    useStore.setState({ fontSize: 20, readingWidth: 900, fontFamily: 'serif' });
    renderPage();
    expect(screen.getByText(/字号 20px · 阅读宽度 900px · 衬线/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/恢复默认排版/));
    const s = useStore.getState();
    expect(s.fontSize).toBe(17);
    expect(s.readingWidth).toBe(720);
    expect(s.fontFamily).toBe('sans');
  });
});

describe('SettingsPage — 关闭', () => {
  it('Esc 触发 onClose', () => {
    let closed = false;
    renderPage(() => {
      closed = true;
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closed).toBe(true);
  });

  it('点背景触发 onClose', () => {
    let closed = false;
    const { container } = renderPage(() => {
      closed = true;
    });
    fireEvent.mouseDown(container.querySelector('.settings-overlay')!);
    expect(closed).toBe(true);
  });

  it('点页面内部不关闭', () => {
    let closed = false;
    const { container } = renderPage(() => {
      closed = true;
    });
    fireEvent.mouseDown(container.querySelector('.settings-page')!);
    expect(closed).toBe(false);
  });
});
