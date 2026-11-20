/**
 * 编辑器分栏组件:进入编辑、实时预览、格式化按键、保存、冲突条。
 *
 * 断言口径尽量贴近用户可见行为:预览里真的出现 <strong>、
 * 保存按钮真的写盘、冲突时真的出现两条处置按钮。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EditorPane, { exitEditing } from '../src/ui/EditorPane';
import { useStore } from '../src/store';
import { __resetSaver } from '../src/editor/session';

const writes: Array<{ path: string; content: string }> = [];

vi.mock('../src/ipc', () => ({
  getBackend: async () => ({
    writeFile: async (path: string, content: string) => {
      writes.push({ path, content });
    },
  }),
}));

const NL = String.fromCharCode(10);

const DOC = `# 标题

第一段文字。

- 列表项
`;

beforeEach(() => {
  writes.length = 0;
  __resetSaver();
  useStore.setState({
    activePath: 'a.md',
    content: DOC,
    draft: DOC,
    previewSource: DOC,
    baseline: DOC,
    editing: true,
    dirty: false,
    saving: false,
    saveError: '',
    savedAt: 0,
    conflict: null,
    autoSave: false,
    splitRatio: 50,
    fontSize: 17,
    readingWidth: 720,
    fontFamily: 'sans',
    theme: 'light',
    headings: [],
    findOpen: false,
    findQuery: '',
  });
});

afterEach(() => {
  cleanup();
  useStore.setState({ editing: false, conflict: null });
});

const input = () => screen.getByPlaceholderText(/在这里写 Markdown/) as HTMLTextAreaElement;

/** 触发一次受控输入(React 需要 native setter 才能感知) */
function type(value: string) {
  const ta = input();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(ta, value);
    fireEvent.input(ta);
  });
}

describe('EditorPane — 分栏结构', () => {
  it('同时渲染源码面板与预览面板', () => {
    render(<EditorPane />);
    expect(document.querySelector('.editor-source')).not.toBeNull();
    expect(document.querySelector('.editor-preview')).not.toBeNull();
    expect(document.querySelector('.editor-divider')).not.toBeNull();
  });

  it('预览按 markdown 渲染(标题/段落/列表)', async () => {
    render(<EditorPane />);
    const prose = document.querySelector('.editor-prose')!;
    await waitFor(() => expect(prose.querySelector('h1')).not.toBeNull());
    expect(prose.querySelector('h1')!.textContent).toBe('标题');
    expect(prose.querySelector('ul li')).not.toBeNull();
  });

  it('行数统计与源码一致', () => {
    render(<EditorPane />);
    // DOC 有 6 行(末尾换行也算一行)
    expect(screen.getByText(`${DOC.split('\n').length} 行`)).toBeInTheDocument();
  });

  it('分栏比例来自 store', () => {
    useStore.setState({ splitRatio: 35 });
    render(<EditorPane />);
    const split = document.querySelector('.editor-split') as HTMLElement;
    expect(split.style.getPropertyValue('--split')).toBe('35');
  });

  it('无文档时不渲染', () => {
    useStore.setState({ activePath: null });
    const { container } = render(<EditorPane />);
    expect(container.querySelector('.editor-split')).toBeNull();
  });
});

describe('EditorPane — 实时预览', () => {
  it('输入后防抖 200ms 更新预览', async () => {
    render(<EditorPane />);
    // 首帧挂载是异步的(清洗 chunk 懒加载),先等首个渲染落地
    await waitFor(() => expect(document.querySelector('.editor-prose h1')).not.toBeNull());
    type('# 改过的标题\n\n新段落');
    // 立即:预览还是旧的
    expect(document.querySelector('.editor-prose h1')!.textContent).toBe('标题');
    await waitFor(
      () => expect(document.querySelector('.editor-prose h1')!.textContent).toBe('改过的标题'),
      { timeout: 1500 },
    );
  });

  it('预览里保留源码行号锚点(供点击跳转)', async () => {
    render(<EditorPane />);
    const prose = document.querySelector('.editor-prose')!;
    await waitFor(() => expect(prose.querySelector('[data-src-line]')).not.toBeNull());
    expect(prose.querySelector('h1')!.getAttribute('data-src-line')).toBe('0');
  });

  it('超过体积阈值:不自动刷新,给出提示与手动刷新按钮', async () => {
    const huge = '# 大\n\n' + 'x'.repeat(300 * 1024);
    useStore.setState({ draft: huge });
    render(<EditorPane />);
    expect(screen.getByText(/实时预览已关闭/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /刷新预览/ })).toBeInTheDocument();
  });

  it('手动刷新按钮把当前草稿推给预览', async () => {
    const huge = '# 大\n\n' + 'y'.repeat(300 * 1024);
    useStore.setState({ draft: huge });
    render(<EditorPane />);
    fireEvent.click(screen.getByRole('button', { name: /刷新预览/ }));
    await waitFor(() => expect(useStore.getState().previewSource).toBe(huge));
  });

  it('预览刷新时同步大纲(标题改了,目录也要跟着变)', async () => {
    render(<EditorPane />);
    type('## 二级\n');
    await waitFor(() => {
      const h = useStore.getState().headings;
      expect(h.length).toBe(1);
      expect(h[0]).toMatchObject({ level: 2, text: '二级' });
    });
  });
});

describe('EditorPane — 编辑动作', () => {
  it('输入会置脏并更新草稿', () => {
    render(<EditorPane />);
    type('# x');
    expect(useStore.getState().draft).toBe('# x');
    expect(useStore.getState().dirty).toBe(true);
    expect(screen.getByText(/未保存/)).toBeInTheDocument();
  });

  it('Ctrl+B 加粗(并阻止全局侧栏快捷键)', () => {
    render(<EditorPane />);
    const ta = input();
    act(() => {
      ta.setSelectionRange(2, 4); // 「标题」
      fireEvent.select(ta);
    });
    fireEvent.keyDown(ta, { key: 'b', ctrlKey: true });
    expect(useStore.getState().draft).toContain('**标题**');
    // 侧栏开关没有被这次按键碰到
    expect(useStore.getState().sidebarOpen).toBe(true);
  });

  it('Ctrl+1/2 切换标题层级(同级再按 = 取消)', () => {
    render(<EditorPane />);
    act(() => input().setSelectionRange(0, 0));
    // 原本就是 h1:再按 Ctrl+1 是同级 → 取消标题
    fireEvent.keyDown(input(), { key: '1', ctrlKey: true });
    expect(useStore.getState().draft.split(NL)[0]).toBe('标题');
    // 在无标题的行上按 Ctrl+2 → 直接升为 h2
    fireEvent.keyDown(input(), { key: '2', ctrlKey: true });
    expect(useStore.getState().draft.split(NL)[0]).toBe('## 标题');
  });

  it('Enter 在列表项后续写新项', () => {
    render(<EditorPane />);
    const ta = input();
    const end = DOC.indexOf('- 列表项') + '- 列表项'.length;
    act(() => ta.setSelectionRange(end, end));
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(useStore.getState().draft).toContain('- 列表项\n- ');
  });

  it('Enter 在普通段落不接管(默认行为继续冒泡)', () => {
    render(<EditorPane />);
    const ta = input();
    const end = DOC.indexOf('第一段文字。') + 6;
    act(() => ta.setSelectionRange(end, end));
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(useStore.getState().draft).toBe(DOC);
  });

  it('Tab 缩进,Shift+Tab 反缩进', () => {
    render(<EditorPane />);
    const ta = input();
    const at = DOC.indexOf('- 列表项');
    act(() => ta.setSelectionRange(at, at));
    fireEvent.keyDown(ta, { key: 'Tab' });
    expect(useStore.getState().draft).toContain('  - 列表项');
    const ta2 = input();
    act(() => ta2.setSelectionRange(at, at));
    fireEvent.keyDown(ta2, { key: 'Tab', shiftKey: true });
    expect(useStore.getState().draft).toContain('\n- 列表项');
  });

  it('Ctrl+S 立即保存', async () => {
    render(<EditorPane />);
    type('# 要保存');
    fireEvent.keyDown(input(), { key: 's', ctrlKey: true });
    await waitFor(() => expect(writes.at(-1)).toEqual({ path: 'a.md', content: '# 要保存' }));
    expect(useStore.getState().dirty).toBe(false);
  });

  it('工具栏按钮:加粗 / 列表 / 引用 都可点', () => {
    render(<EditorPane />);
    act(() => input().setSelectionRange(2, 4)); // 「标题」两个字
    fireEvent.click(screen.getByTitle('加粗 (Ctrl+B)'));
    expect(useStore.getState().draft.split(NL)[0]).toBe('# **标题**');

    // 列表/引用按行作用:先把光标放回第一行行首
    act(() => input().setSelectionRange(0, 0));
    fireEvent.click(screen.getByTitle('无序列表'));
    expect(useStore.getState().draft.split(NL)[0]).toBe('- # **标题**');

    act(() => input().setSelectionRange(0, 0));
    fireEvent.click(screen.getByTitle('引用'));
    expect(useStore.getState().draft.split(NL)[0]).toBe('> - # **标题**');
  });
});

describe('EditorPane — 预览是只读镜像', () => {
  it('任务列表复选框被真正禁用(否则「看着勾上了、源码没变」)', async () => {
    useStore.setState({ draft: '- [ ] 未完成' + NL + '- [x] 已完成' + NL });
    render(<EditorPane />);
    let boxes: NodeListOf<HTMLInputElement> = document.querySelectorAll('input');
    await waitFor(() => {
      boxes = document.querySelectorAll<HTMLInputElement>(".editor-prose input[type='checkbox']");
      expect(boxes.length).toBe(2);
    });
    // disabled 而非仅 CSS:键盘 Tab+Space 也翻不动
    expect(Array.from(boxes).every((b) => b.disabled)).toBe(true);
    // 勾选状态与源码一致,未被预览侧改动
    expect(Array.from(boxes).map((b) => b.checked)).toEqual([false, true]);
  });
});

describe('EditorPane — 查找与冲突', () => {
  it('编辑态查找:命中数来自源码,并选中首个命中', async () => {
    useStore.setState({ findOpen: true, findQuery: '列表' });
    render(<EditorPane />);
    await waitFor(() => expect(useStore.getState().findTotal).toBe(1));
    expect(input().selectionStart).toBe(DOC.indexOf('列表'));
  });

  it('关闭查找会清零命中数', async () => {
    useStore.setState({ findOpen: true, findQuery: '列表' });
    render(<EditorPane />);
    await waitFor(() => expect(useStore.getState().findTotal).toBe(1));
    act(() => useStore.getState().setFindOpen(false));
    await waitFor(() => expect(useStore.getState().findTotal).toBe(0));
  });

  it('冲突条:两个处置按钮都在', () => {
    useStore.setState({ conflict: { incoming: '# 磁盘版' } });
    render(<EditorPane />);
    expect(screen.getByText(/被外部改过/)).toBeInTheDocument();
    expect(screen.getByText('保留我的修改')).toBeInTheDocument();
    expect(screen.getByText('重新加载磁盘版本')).toBeInTheDocument();
  });

  it('「保留我的修改」把磁盘内容当基准,草稿不动', () => {
    useStore.setState({ conflict: { incoming: '# 磁盘版' }, draft: '# 我的' });
    render(<EditorPane />);
    fireEvent.click(screen.getByText('保留我的修改'));
    const s = useStore.getState();
    expect(s.draft).toBe('# 我的');
    expect(s.baseline).toBe('# 磁盘版');
    expect(s.conflict).toBeNull();
    expect(s.dirty).toBe(true);
  });

  it('「重新加载磁盘版本」丢弃本地草稿', () => {
    useStore.setState({ conflict: { incoming: '# 磁盘版' }, draft: '# 我的' });
    render(<EditorPane />);
    fireEvent.click(screen.getByText('重新加载磁盘版本'));
    const s = useStore.getState();
    expect(s.draft).toBe('# 磁盘版');
    expect(s.dirty).toBe(false);
    expect(s.editing).toBe(true);
  });
});

describe('exitEditing — 退出编辑', () => {
  it('有改动时先落盘再退出', async () => {
    useStore.setState({ draft: '# 未保存', dirty: true });
    await exitEditing();
    expect(writes.at(-1)).toEqual({ path: 'a.md', content: '# 未保存' });
    expect(useStore.getState().editing).toBe(false);
  });

  it('退出后正文与刚落盘的内容一致(不再多读一次盘)', async () => {
    useStore.setState({ draft: '# 未保存', dirty: true });
    await exitEditing();
    expect(useStore.getState().content).toBe('# 未保存');
  });

  it('无改动时也退出,不写盘', async () => {
    await exitEditing();
    expect(writes).toHaveLength(0);
    expect(useStore.getState().editing).toBe(false);
  });

  it('非编辑态调用是空操作', async () => {
    useStore.setState({ editing: false });
    await exitEditing();
    expect(writes).toHaveLength(0);
  });
});
