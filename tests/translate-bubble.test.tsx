/**
 * 划词翻译气泡测试:离线结果渲染、未收录建议、在线翻译交互。
 * 隐私红线:未配置端点时,任何渲染/点击都不得触发 fetch。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TranslateBubble } from '../src/ui/TranslateBubble';
import { useStore } from '../src/store';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useStore.setState({
    translateOnlineEnabled: false,
    translateEndpoint: '',
    translateModel: '',
    translateApiKey: '',
  });
});

function renderBubble(text: string) {
  return render(<TranslateBubble text={text} x={100} y={100} onClose={() => {}} />);
}

describe('TranslateBubble — 离线结果', () => {
  it('渲染英文词条与释义', () => {
    const { container } = renderBubble('cache');
    expect(container.querySelector('.translate-src')?.textContent).toBe('cache');
    expect(container.querySelector('.translate-entry-head b')?.textContent).toBe('cache');
    expect(container.querySelector('.translate-entry-defs')?.textContent).toContain('缓存');
  });

  it('词形还原时标注来源词(单词走整串命中分支)', () => {
    const { container } = renderBubble('queries');
    expect(container.querySelector('.translate-entry-head b')?.textContent).toBe('query');
    expect(container.querySelector('.translate-from')?.textContent).toBe('← queries');
    expect(container.querySelector('.translate-entry-defs')?.textContent).toContain('查询');
  });

  it('中文选区反查英文词', () => {
    const { container } = renderBubble('缓存');
    expect(container.querySelector('.translate-entry-head b')?.textContent).toBe('缓存');
    expect(container.querySelector('.translate-entry-defs')?.textContent).toContain('cache');
  });

  it('未收录时给出近似建议,且不重复显示空横幅', () => {
    const { container } = renderBubble('cach');
    expect(container.querySelector('.translate-suggest')?.textContent).toContain('未收录,你是否找');
    expect(container.querySelector('.translate-suggest-word')?.textContent).toBe('cache');
    expect(container.querySelector('.translate-empty')).toBeNull();
  });

  it('完全无提示时才显示空横幅', () => {
    const { container } = renderBubble('zzqqxx');
    expect(container.querySelector('.translate-empty')?.textContent).toContain('离线词典未收录');
  });

  it('长选区截断显示', () => {
    const { container } = renderBubble('x'.repeat(300));
    expect(container.querySelector('.translate-src')?.textContent).toMatch(/…$/);
  });

  it('默认展示隐私提示', () => {
    renderBubble('cache');
    expect(screen.getByText(/默认不发网络请求/)).toBeInTheDocument();
  });
});

describe('TranslateBubble — 在线翻译(可选)', () => {
  it('未配置时不渲染在线按钮,只给配置入口', () => {
    renderBubble('cache');
    expect(screen.queryByText('在线翻译')).not.toBeInTheDocument();
    expect(screen.getByText('配置在线翻译(可选)')).toBeInTheDocument();
  });

  it('展开配置并勾选启用也不触发 fetch(隐私红线)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    renderBubble('cache');
    fireEvent.click(screen.getByText('配置在线翻译(可选)'));
    fireEvent.click(screen.getByText(/启用在线翻译/));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('配置并启用后出现在线按钮,点击后请求端点', async () => {
    useStore.setState({
      translateOnlineEnabled: true,
      translateEndpoint: 'https://api.example.com/v1',
      translateModel: 'm1',
      translateApiKey: 'sk-x',
    });
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '译文' } }] }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    renderBubble('cache');
    fireEvent.click(screen.getByText('在线翻译'));
    await waitFor(() => expect(screen.getByText('译文')).toBeInTheDocument());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.example.com/v1/chat/completions');
  });

  it('在线请求失败时展示错误,不影响离线结果', async () => {
    useStore.setState({
      translateOnlineEnabled: true,
      translateEndpoint: 'https://api.example.com/v1',
      translateModel: 'm1',
      translateApiKey: '',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    renderBubble('cache');
    fireEvent.click(screen.getByText('在线翻译'));
    await waitFor(() => expect(screen.getByText(/HTTP 500/)).toBeInTheDocument());
    expect(screen.getByText(/缓存/)).toBeInTheDocument(); // 离线结果仍在
  });

  it('配置表单可填写端点并落 store', async () => {
    renderBubble('cache');
    fireEvent.click(screen.getByText('配置在线翻译(可选)'));
    fireEvent.change(screen.getByPlaceholderText('https://api.openai.com/v1'), {
      target: { value: 'https://x.com/v1' },
    });
    expect(useStore.getState().translateEndpoint).toBe('https://x.com/v1');
  });
});

describe('TranslateBubble — 关闭', () => {
  it('点关闭按钮触发 onClose', () => {
    const onClose = vi.fn();
    render(<TranslateBubble text="cache" x={100} y={100} onClose={onClose} />);
    fireEvent.click(screen.getByTitle('关闭 (Esc)'));
    expect(onClose).toHaveBeenCalled();
  });

  it('Esc 关闭', () => {
    const onClose = vi.fn();
    render(<TranslateBubble text="cache" x={100} y={100} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('点击气泡外部关闭', () => {
    const onClose = vi.fn();
    render(<TranslateBubble text="cache" x={100} y={100} onClose={onClose} />);
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });
});
