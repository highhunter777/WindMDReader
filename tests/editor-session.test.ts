/**
 * 编辑会话:预览降级闸门、外部变更判定、保存器。
 *
 * 这三块是「改文件」这件事里最容易出静默 bug 的地方:
 * 自写回环、脏覆盖、保存失败却清了脏标记。全部用普通测试钉住。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOSAVE_IDLE_MS,
  PREVIEW_MAX_BYTES,
  PREVIEW_MAX_LINES,
  __resetSaver,
  createSaver,
  decideExternalChange,
  getSaver,
  previewBudget,
} from '../src/editor/session';
import { useStore } from '../src/store';

const writes: Array<{ path: string; content: string }> = [];
let failNext = false;

vi.mock('../src/ipc', () => ({
  getBackend: async () => ({
    writeFile: async (path: string, content: string) => {
      if (failNext) {
        failNext = false;
        throw { code: 'IO', message: '磁盘写入失败' };
      }
      writes.push({ path, content });
    },
  }),
}));

beforeEach(() => {
  writes.length = 0;
  failNext = false;
  __resetSaver();
  useStore.setState({
    activePath: 'a.md',
    content: '# a',
    draft: '# a',
    baseline: '# a',
    previewSource: '# a',
    editing: true,
    dirty: false,
    saving: false,
    saveError: '',
    savedAt: 0,
    conflict: null,
    autoSave: true,
  });
});

describe('previewBudget — 实时预览降级闸门', () => {
  it('小文档不降级', () => {
    const b = previewBudget('# 标题\n\n正文');
    expect(b.degrade).toBe(false);
    expect(b.reason).toBe('');
    expect(b.lines).toBe(3);
  });

  it('超过 256KB 降级并给出原因', () => {
    const b = previewBudget('a'.repeat(PREVIEW_MAX_BYTES + 1));
    expect(b.degrade).toBe(true);
    expect(b.reason).toContain('256KB');
  });

  it('超过 5000 行降级', () => {
    const b = previewBudget(Array.from({ length: PREVIEW_MAX_LINES + 1 }, () => 'x').join('\n'));
    expect(b.degrade).toBe(true);
    expect(b.reason).toContain('5000 行');
  });

  it('字节数按 UTF-8 估算:中文 3 字节', () => {
    expect(previewBudget('中').bytes).toBe(3);
    expect(previewBudget('ab').bytes).toBe(2);
  });

  it('代理对(emoji)按 4 字节算,不重复计数', () => {
    expect(previewBudget('😀').bytes).toBe(4);
  });

  it('空文档也算 0 行,不误判', () => {
    expect(previewBudget('').lines).toBe(0);
    expect(previewBudget('').degrade).toBe(false);
  });
});

describe('decideExternalChange — 外部变更判定', () => {
  const base = { draft: 'draft', baseline: 'disk', lastWritten: null };

  it('磁盘内容与草稿相同 → 忽略', () => {
    expect(decideExternalChange(base, 'draft')).toBe('ignore');
  });

  it('就是自己刚写下去的内容 → 忽略(防重载打回光标)', () => {
    expect(decideExternalChange({ ...base, lastWritten: 'mine' }, 'mine')).toBe('ignore');
  });

  it('保存中一律忽略(磁盘是自己写的中间态)', () => {
    expect(decideExternalChange({ ...base, saving: true }, 'other')).toBe('ignore');
  });

  it('本地无改动 → 跟随磁盘重载', () => {
    expect(decideExternalChange({ draft: 'disk', baseline: 'disk', lastWritten: null }, 'external')).toBe('reload');
  });

  it('本地有改动且磁盘变了 → 冲突,不能替用户决定', () => {
    expect(decideExternalChange(base, 'external')).toBe('conflict');
  });
});

describe('createSaver — 保存', () => {
  it('保存成功:写盘、清脏、记时间与基准', async () => {
    useStore.setState({ draft: '# 改过' , dirty: true });
    const ok = await createSaver().save();
    expect(ok).toBe(true);
    expect(writes).toEqual([{ path: 'a.md', content: '# 改过' }]);
    const s = useStore.getState();
    expect(s.dirty).toBe(false);
    expect(s.baseline).toBe('# 改过');
    expect(s.lastWritten).toBe('# 改过');
    expect(s.savedAt).toBeGreaterThan(0);
    expect(s.saving).toBe(false);
  });

  it('无改动时不写盘(避免无意义的 mtime 抖动)', async () => {
    const ok = await createSaver().save();
    expect(ok).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('写盘失败:保留脏标记并给出错误,不假装存好了', async () => {
    useStore.setState({ draft: 'x', dirty: true });
    failNext = true;
    const ok = await createSaver().save();
    expect(ok).toBe(false);
    const s = useStore.getState();
    expect(s.dirty).toBe(true);
    expect(s.saveError).toContain('磁盘写入失败');
    expect(s.saving).toBe(false);
  });

  it('保存期间继续输入:脏标记保留(不能把新内容当已存)', async () => {
    useStore.setState({ draft: 'v1', dirty: true });
    const saver = createSaver();
    const p = saver.save();
    // 保存进行中又敲了一个字符
    useStore.setState({ draft: 'v2' });
    await p;
    const s = useStore.getState();
    expect(s.baseline).toBe('v1');
    expect(s.dirty).toBe(true);
  });

  it('并发保存合并:保存中再调用只记一次待办', async () => {
    useStore.setState({ draft: 'v1', dirty: true });
    const saver = createSaver();
    const [a, b] = await Promise.all([saver.save(), saver.save()]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    // 第二次触发的是排队后的补存,但内容已一致 → 不会重复写盘
    expect(writes.filter((w) => w.content === 'v1')).toHaveLength(1);
  });

  it('自动保存关闭时 schedule 不排期', async () => {
    useStore.setState({ draft: 'x', dirty: true, autoSave: false });
    const saver = createSaver();
    saver.schedule();
    await new Promise((r) => setTimeout(r, AUTOSAVE_IDLE_MS + 80));
    expect(writes).toHaveLength(0);
  });

  it('自动保存开启:空闲后落盘', async () => {
    useStore.setState({ draft: 'x', dirty: true, autoSave: true });
    const saver = createSaver();
    saver.schedule();
    await new Promise((r) => setTimeout(r, AUTOSAVE_IDLE_MS + 120));
    expect(writes.at(-1)).toEqual({ path: 'a.md', content: 'x' });
  });

  it('连续输入只落一次盘(防抖)', async () => {
    useStore.setState({ draft: 'a', dirty: true });
    const saver = createSaver();
    saver.schedule();
    await new Promise((r) => setTimeout(r, 300));
    useStore.setState({ draft: 'ab' });
    saver.schedule();
    await new Promise((r) => setTimeout(r, 300));
    useStore.setState({ draft: 'abc' });
    saver.schedule();
    await new Promise((r) => setTimeout(r, AUTOSAVE_IDLE_MS + 120));
    expect(writes.map((w) => w.content)).toEqual(['abc']);
  });

  it('flush:有改动才保存', async () => {
    const saver = createSaver();
    await saver.flush();
    expect(writes).toHaveLength(0);
    useStore.setState({ draft: 'y', dirty: true });
    await saver.flush();
    expect(writes.at(-1)?.content).toBe('y');
  });

  it('非编辑态不写盘', async () => {
    useStore.setState({ editing: false, draft: 'z', dirty: true });
    await createSaver().save();
    expect(writes).toHaveLength(0);
  });

  it('切换文档后保存不影响新文档的脏状态', async () => {
    useStore.setState({ draft: 'old', dirty: true });
    const saver = createSaver();
    const p = saver.save();
    useStore.setState({ activePath: 'b.md', draft: 'new', dirty: false });
    await p;
    const s = useStore.getState();
    expect(s.activePath).toBe('b.md');
    expect(s.dirty).toBe(false);
  });

  it('getSaver 返回同一实例(避免多个定时器互相覆盖)', () => {
    expect(getSaver()).toBe(getSaver());
  });
});
