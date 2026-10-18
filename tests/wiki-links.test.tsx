/**
 * 双链与标签测试:渲染规则、mock 后端、Outliner 面板。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { renderMarkdown } from '../src/renderer/markdown';
import { createMockBackend } from '../src/ipc/mock';
import { Outliner } from '../src/ui/Outliner';
import { useStore } from '../src/store';

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
};

/* ---------------- 渲染规则 ---------------- */

describe('渲染 — Wiki 链接', () => {
  it('[[目标]] 渲染为 wiki-link', () => {
    const { html } = renderMarkdown('参见 [[其他文档]] 说明');
    expect(html).toContain('class="wiki-link"');
    expect(html).toContain('data-wiki="其他文档"');
  });

  it('[[目标|显示名]] 目标进 data-wiki,显示名进文本', () => {
    const { html } = renderMarkdown('[[目录/文档|显示名]]');
    expect(html).toContain('data-wiki="目录/文档"');
    expect(html).toContain('>显示名</a>');
  });

  it('代码块内不渲染链接', () => {
    const { html } = renderMarkdown('```\n[[假链接]]\n```');
    expect(html).not.toContain('wiki-link');
  });

  it('大纲收集包含 wiki 链接文本', () => {
    const { headings } = renderMarkdown('# 关于 [[某文档]]');
    expect(headings[0].text).toContain('某文档');
  });
});

describe('渲染 — 标签', () => {
  it('#标签 渲染为 hash-tag', () => {
    const { html } = renderMarkdown('记录 #读书笔记 一下');
    expect(html).toContain('class="hash-tag"');
    expect(html).toContain('data-tag="读书笔记"');
  });

  it('ATX 标题的 # 不是标签', () => {
    const { html } = renderMarkdown('# 这是标题');
    expect(html).not.toContain('hash-tag');
  });

  it('#后非字母不渲染标签', () => {
    const { html } = renderMarkdown('issue #12 与 C# 编程');
    expect(html).not.toContain('hash-tag');
  });
});

/* ---------------- mock 后端 ---------------- */

describe('mock 后端 — 双链与标签', () => {
  let b: ReturnType<typeof createMockBackend>;
  beforeEach(() => {
    b = createMockBackend();
  });

  it('getLinks 返回出链与解析状态', async () => {
    await b.writeFile('源.md', '链接到 [[使用指南]] 与 [[未创建文档]]');
    const links = await b.getLinks('源.md');
    expect(links.outgoing.map((o) => o.target).sort()).toEqual(['使用指南', '未创建文档']);
    expect(links.outgoing.find((o) => o.target === '使用指南')?.resolvedPath).toBe('使用指南.md');
    expect(links.outgoing.find((o) => o.target === '未创建文档')?.resolvedPath).toBeNull();
  });

  it('getLinks 返回反链', async () => {
    await b.writeFile('甲.md', '引用 [[乙]]');
    const links = await b.getLinks('乙.md');
    expect(links.backlinks.map((m) => m.path)).toEqual(['甲.md']);
  });

  it('listTags 聚合并计数', async () => {
    await b.writeFile('甲.md', '内容 #读书 #方法');
    await b.writeFile('乙.md', '内容 #读书');
    const tags = await b.listTags();
    expect(tags.find((t) => t.tag === '读书')?.count).toBe(2);
    expect(tags.find((t) => t.tag === '方法')?.count).toBe(1);
  });

  it('docsByTag 返回该标签下的文档', async () => {
    await b.writeFile('甲.md', '内容 #读书');
    await b.writeFile('乙.md', '内容 #其他');
    const docs = await b.docsByTag('读书');
    expect(docs.map((m) => m.path)).toEqual(['甲.md']);
  });

  it('代码块内的链接与标签不解析', async () => {
    await b.writeFile('甲.md', '```\n[[假]] #假\n```\n#真');
    const links = await b.getLinks('甲.md');
    expect(links.outgoing).toHaveLength(0);
    const tags = (await b.listTags()).map((t) => t.tag);
    expect(tags).toContain('真');
    expect(tags).not.toContain('假');
  });
});

/* ---------------- Outliner 面板 ---------------- */

describe('Outliner — 双链与标签面板', () => {
  beforeEach(() => {
    useStore.setState({
      tocVisible: true,
      outlinerTab: 'links',
      activePath: '乙.md',
      meta: { path: '乙.md', title: '乙', size: 0, mtime: 0, readProgress: 0, starred: false },
    });
  });

  it('双链页签展示反链与出链', async () => {
    const backend = createMockBackend();
    await backend.writeFile('甲.md', '引用 [[乙]]');
    await backend.writeFile('乙.md', '参见 [[丙]]');

    render(<Outliner />);
    await flush();

    expect(screen.getByText('反链')).toBeInTheDocument();
    expect(screen.getByText('甲')).toBeInTheDocument();
    expect(screen.getByText('出链')).toBeInTheDocument();
    expect(screen.getByText('丙')).toBeInTheDocument();
  });

  it('标签页签展示聚合并可筛选文档', async () => {
    useStore.setState({ outlinerTab: 'tags' });
    const backend = createMockBackend();
    await backend.writeFile('甲.md', '内容 #读书');
    await backend.writeFile('乙.md', '内容 #读书 #方法');

    render(<Outliner />);
    await flush();

    fireEvent.click(screen.getByText('读书'));
    await flush();
    expect(within(document.querySelector('.tags-panel') as HTMLElement).getByText('#读书')).toBeInTheDocument();
  });
});
