/**
 * mock 后端测试:文件树、读写、搜索、元数据持久化。
 * mock 层是浏览器 dev 模式的唯一数据源,行为需与 Tauri 后端一致。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createMockBackend } from '../src/ipc/mock';

let b: ReturnType<typeof createMockBackend>;

beforeEach(async () => {
  b = createMockBackend();
  // mock 的开库状态是每实例独立的,而 listFiles 现在与 Rust 一样
  // 要求先开库(否则抛 NO_VAULT),所以默认先开好。
  await b.openVault();
});

describe('mock 后端 — 库与文件树', () => {
  it('未开库时列目录按 NO_VAULT 拒绝(与 Rust AppError 同构)', async () => {
    // 抛的是**普通对象** { code, message },不是 Error —— 必须与 Rust 一致,
    // 否则前端把错误当 Error 处理,真实环境才会冒出 [object Object]
    const fresh = createMockBackend();
    await expect(fresh.listFiles('/')).rejects.toMatchObject({ code: 'NO_VAULT' });
    await expect(fresh.listFiles('/')).rejects.toMatchObject({ message: expect.any(String) });
  });

  it('openVault 返回库信息', async () => {
    const v = await b.openVault();
    expect(v.name).toBeTruthy();
    expect(v.fileCount).toBeGreaterThan(0);
  });

  it('openVault 接受指定路径并取目录名', async () => {
    const v = await b.openVault('D:/notes/my-vault');
    expect(v.name).toBe('my-vault');
    expect(v.root).toBe('D:/notes/my-vault');
  });

  it('列出根目录下的示例文档', async () => {
    const files = await b.listFiles('/');
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.path.includes('.md'))).toBe(true);
  });

  it('文件条目携带 kind 与大小', async () => {
    const [first] = await b.listFiles('/');
    expect(first?.kind).toBe('file');
    expect(first?.isDir).toBe(false);
    expect(first?.size).toBeGreaterThan(0);
  });
});

describe('mock 后端 — 读写', () => {
  it('读取已存在文件', async () => {
    const f = await b.readFile('欢迎使用 WindMD.md');
    expect(f.content).toContain('欢迎使用 WindMD');
    expect(f.path).toBe('欢迎使用 WindMD.md');
  });

  it('读取不存在的文件抛出明确错误', async () => {
    await expect(b.readFile('不存在.md')).rejects.toThrow(/不存在/);
  });

  it('写入后可读回新内容', async () => {
    await b.writeFile('测试.md', '# 新内容\n');
    const f = await b.readFile('测试.md');
    expect(f.content).toBe('# 新内容\n');
  });

  it('创建文件时自动生成标题占位', async () => {
    await b.createFile('新笔记.md');
    const f = await b.readFile('新笔记.md');
    expect(f.content).toContain('# 新笔记');
  });

  it('重复创建同一文件报错', async () => {
    await b.createFile('重复.md');
    await expect(b.createFile('重复.md')).rejects.toThrow(/已存在/);
  });

  it('重命名保留内容', async () => {
    await b.writeFile('原名.md', '内容');
    await b.renameFile('原名.md', '新名.md');
    await expect(b.readFile('原名.md')).rejects.toThrow();
    expect((await b.readFile('新名.md')).content).toBe('内容');
  });

  it('删除文件后不可再读', async () => {
    await b.createFile('待删.md');
    await b.deleteFile('待删.md');
    await expect(b.readFile('待删.md')).rejects.toThrow();
  });
});

describe('mock 后端 — 变更通知', () => {
  it('写入触发 file-changed 事件', async () => {
    const seen: string[][] = [];
    const off = b.onFileChanged((paths) => seen.push(paths));
    await b.writeFile('事件.md', 'x');
    off();
    expect(seen).toContainEqual(['事件.md']);
  });

  it('取消订阅后不再收到事件', async () => {
    const seen: string[][] = [];
    const off = b.onFileChanged((paths) => seen.push(paths));
    off();
    await b.writeFile('事件2.md', 'x');
    expect(seen).toHaveLength(0);
  });

  it('重命名同时通知新旧路径', async () => {
    await b.writeFile('移动源.md', 'x');
    const seen: string[][] = [];
    const off = b.onFileChanged((paths) => seen.push(paths));
    await b.renameFile('移动源.md', '移动目标.md');
    off();
    expect(seen[0]).toEqual(expect.arrayContaining(['移动源.md', '移动目标.md']));
  });
});

describe('mock 后端 — 全文搜索', () => {
  it('命中内容并返回片段', async () => {
    await b.writeFile('搜索目标.md', '第一行\n第二行包含关键词\n第三行\n');
    const r = await b.search('关键词');
    expect(r.total).toBeGreaterThan(0);
    expect(r.hits[0].path).toBe('搜索目标.md');
    expect(r.hits[0].snippet).toContain('关键词');
  });

  it('返回正确的行号', async () => {
    await b.writeFile('行号.md', 'a\nb\nc 目标\n');
    const r = await b.search('目标');
    expect(r.hits[0].line).toBe(3);
  });

  it('无结果时返回空', async () => {
    const r = await b.search('绝对不存在的词xyz');
    expect(r.total).toBe(0);
  });

  it('大小写不敏感', async () => {
    await b.writeFile('大小写.md', 'WindMD Reader');
    expect((await b.search('windmd')).total).toBeGreaterThan(0);
  });

  it('返回耗时字段', async () => {
    const r = await b.search('a');
    expect(typeof r.tookMs).toBe('number');
  });
});

describe('mock 后端 — 元数据', () => {
  it('getMeta 派生标题(去扩展名)', async () => {
    const m = await b.getMeta('欢迎使用 WindMD.md');
    expect(m?.title).toBe('欢迎使用 WindMD');
    expect(m?.readProgress).toBe(0);
    expect(m?.starred).toBe(false);
  });

  it('setMeta 写入后能被 getMeta 读回', async () => {
    await b.setMeta('欢迎使用 WindMD.md', { readProgress: 0.42, starred: true });
    const m = await b.getMeta('欢迎使用 WindMD.md');
    expect(m?.readProgress).toBeCloseTo(0.42);
    expect(m?.starred).toBe(true);
  });

  it('patch 为局部更新,不覆盖其他字段', async () => {
    await b.setMeta('欢迎使用 WindMD.md', { starred: true });
    await b.setMeta('欢迎使用 WindMD.md', { readProgress: 0.8 });
    const m = await b.getMeta('欢迎使用 WindMD.md');
    expect(m?.starred).toBe(true);
    expect(m?.readProgress).toBeCloseTo(0.8);
  });

  it('不存在的文件返回 null', async () => {
    expect(await b.getMeta('不存在.md')).toBeNull();
  });

  it('recentFiles 按修改时间倒序', async () => {
    const r = await b.recentFiles(10);
    expect(r.length).toBeGreaterThan(0);
    for (let i = 1; i < r.length; i++) {
      expect(r[i - 1].mtime).toBeGreaterThanOrEqual(r[i].mtime);
    }
  });

  it('starredFiles 只返回收藏的文档', async () => {
    await b.setMeta('欢迎使用 WindMD.md', { starred: true });
    await b.setMeta('使用指南.md', { starred: false });
    const list = await b.starredFiles();
    expect(list.map((m) => m.path)).toContain('欢迎使用 WindMD.md');
    expect(list.map((m) => m.path)).not.toContain('使用指南.md');
    expect(list.every((m) => m.starred)).toBe(true);
  });

  it('取消收藏后从 starredFiles 消失', async () => {
    await b.setMeta('欢迎使用 WindMD.md', { starred: true });
    expect((await b.starredFiles()).length).toBe(1);
    await b.setMeta('欢迎使用 WindMD.md', { starred: false });
    expect((await b.starredFiles()).length).toBe(0);
  });
});

describe('mock 后端 — 目录级操作', () => {
  it('删除目录连带删除其中的文件', async () => {
    await b.writeFile('目录甲/子1.md', 'x');
    await b.writeFile('目录甲/子2.md', 'x');
    await b.deleteFile('目录甲');
    await expect(b.readFile('目录甲/子1.md')).rejects.toThrow();
    expect(await b.listFiles('目录甲')).toHaveLength(0);
  });

  it('重命名目录迁移其中的文件', async () => {
    await b.writeFile('目录乙/子.md', '内容');
    await b.renameFile('目录乙', '目录丙');
    expect((await b.readFile('目录丙/子.md')).content).toBe('内容');
    await expect(b.readFile('目录乙/子.md')).rejects.toThrow();
  });

  it('createFile 支持带目录的路径', async () => {
    await b.createFile('目录丁/新笔记.md');
    const entries = await b.listFiles('目录丁');
    expect(entries.map((e) => e.name)).toContain('新笔记.md');
  });
});