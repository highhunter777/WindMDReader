/**
 * Mock 后端 —— 浏览器 dev 模式的数据层。
 * 数据保存在 IndexedDB,文件树由内置示例文档构成。
 * 接口与 Tauri 后端完全一致,便于提前开发 UI 与渲染管线。
 */

import type {
  WindMDBackend,
  FileEntry,
  OpenFile,
  SearchResult,
  DocumentMeta,
  VaultInfo,
  OpenPathResult,
  DocLinks,
  TagEntry,
  SpeechApi,
  SayOutcome,
} from '../types';

/* ---------------- 示例文档 ---------------- */

const SAMPLE_WELCOME = `# 欢迎使用 WindMD 🎉

> WindMD 是一个本地优先、高性能的 Markdown 阅读器。
> 本页面是内置示例文档,演示渲染能力。接下来轮到它了:

## ✨ 功能一览

- [x] CommonMark / GFM 渲染(表格、任务列表、删除线)
- [x] 脚注 ^[常见于学术笔记] 与 KaTeX 公式
- [ ] 更多的 Mermaid 图表(懒加载渲染)

| 能力 | 状态 | 备注 |
|---|---|---|
| 代码高亮 | ✅ | Shiki,VS Code 级观感 |
| 数学公式 | ✅ | KaTeX,支持 \`$\` 行内与 \`$$\` 块级 |
| 图表 | 🚧 | Mermaid,按需渲染 |

## 🧮 数学公式

行内公式 $E = mc^2$ 与 $\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$。

块级公式:

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}
$$

## 💻 代码

\`\`\`ts
// 类型安全,默认启用严格模式
interface Reader {
  open(path: string): Promise<string>;
  render(md: string): string;
}

const reader: Reader = {
  open: async (p) => await file(p),
  render: (md) => markdownIt.render(md),
};
\`\`\`

## 🖼 图片

![示例图](https://picsum.photos/seed/windmd/640/360)

## 脚注

本地优先意味着数据不出本机。[^privacy]

[^privacy]: WindMD 不收集遥测,不上传你的文档。

---

## 下一步

1. 在设置中打开一个真实的知识库目录
2. 全库搜索 \`Ctrl+Shift+F\`
3. 试试\`专注模式\`(\`z z\`)专注阅读
`;

const SAMPLE_GUIDE = `# 使用指南

## 打开库

点击左侧 **打开库** 按钮,选择一个目录作为知识库根。

支持的格式:Markdown(\`.md\` / \`.markdown\`) 与纯文本(\`.txt\`)。

## 快捷键

| 快捷键 | 功能 |
|---|---|
| \`Ctrl+O\` | 打开库 |
| \`Ctrl+F\` | 文档内查找 |
| \`Ctrl+Shift+F\` | 全库搜索 |
| \`j\` / \`k\` | 向下 / 向上滚动 |
| \`[\` / \`]\` | 上一个 / 下一个标题 |
| \`z z\` | 专注模式 |

## 双链

用 \`[[文章名]]\` 引用其他文档。示例:[[欢迎使用 WindMD]]。

## 标签

用 \`#tag\` 标记内容,侧栏标签视图可聚合浏览。
`;

const SAMPLE_CONVENTIONS = `# 阅读约定

本文档约定 WindMD 的渲染行为,供测试与调试参考。

## 警告容器

::: warning
这是一条 **警告** 提示(markdown-it-container)。
:::

::: tip
这是一条 **技巧** 提示。
:::

## 任务列表

- [ ] 支持容器语法
- [x] 支持任务列表
- [x] 支持 \`[[双链]]\`

## 长内容测试

\`\`\`text
此处是一段用于测试滚动与分段渲染性能的填充文本。
Lorem ipsum dolor sit amet, consectetur adipiscing elit.
WindMD 使用 content-visibility 跳过屏外区块,
大文档也能保持 60fps 滚动。
\`\`\`
`;

/* ---------------- IndexedDB 持久化 ---------------- */

const DB_NAME = 'windmd-mock';
const DB_VERSION = 1;
const META_STORE = 'meta';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'path' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const req = tx.objectStore(META_STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------------- Mock 文件系统 ---------------- */

interface MockNode {
  content: string;
  mtime: number;
}

const files = new Map<string, MockNode>([
  ['欢迎使用 WindMD.md', { content: SAMPLE_WELCOME, mtime: Date.now() - 3_600_000 }],
  ['使用指南.md', { content: SAMPLE_GUIDE, mtime: Date.now() - 2_400_000 }],
  ['阅读约定.md', { content: SAMPLE_CONVENTIONS, mtime: Date.now() - 1_200_000 }],
]);
let rootName = '示例库';

/* ---------------- 工具 ---------------- */

const ext = (name: string) => /\.(md|markdown|txt)$/i.test(name);

function stripMd(name: string): string {
  return name.replace(/\.(md|markdown|txt)$/i, '');
}

/**
 * 解析双链与标签(mock 版,与 Rust links.rs 语义对齐:
 * 跳过围栏/行内代码,`#` 后须为字母,标题行的 `#` 不算标签)。
 */
function parseLinksAndTags(content: string): { links: string[]; tags: string[] } {
  const stripped = content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '');
  const links = [...stripped.matchAll(/\[\[([^\]\n]+)\]\]/g)]
    .map((m) => m[1].split('|')[0].trim().split('#')[0].trim())
    .map((t) => stripMd(t))
    .filter(Boolean);
  const tags = [...stripped.matchAll(/(^|\s)#(\p{L}[\p{L}\p{N}_\-/]*)/gu)].map((m) => m[2]);
  return { links: [...new Set(links)], tags: [...new Set(tags)] };
}

function snippetAround(content: string, pos: number, radius = 60): string {
  const start = Math.max(0, pos - radius);
  const end = Math.min(content.length, pos + radius);
  const slice = content.slice(start, end).replace(/\s+/g, ' ');
  return (start > 0 ? '…' : '') + slice + (end < content.length ? '…' : '');
}

/* ---------------- 朗读(浏览器回退:Web Speech) ---------------- */

/** SAPI 的 `-10..=10` 语速换算到 Web Speech 的倍率(0.1–10) */
export function webRate(rate?: number): number {
  if (rate == null) return 1;
  return Math.max(0.1, Math.min(10, 1 + rate * 0.1));
}

/**
 * Web Speech 回退实现。
 *
 * 仅浏览器 dev 模式用得上 —— 桌面 WebView2 **不提供** `speechSynthesis`,
 * 那里走后端系统音色(tts.rs)。
 */
export function createWebSpeech(): SpeechApi {
  const synth = () =>
    typeof window !== 'undefined' ? (window.speechSynthesis as SpeechSynthesis | undefined) : undefined;
  const available = () => !!synth() && typeof window.SpeechSynthesisUtterance === 'function';

  return {
    async ready() {
      return available();
    },
    async voices() {
      if (!available()) return [];
      return synth()!.getVoices().map((v) => ({ name: v.name, culture: v.lang, gender: '' }));
    },
    say(text, options) {
      return new Promise<SayOutcome>((resolve) => {
        if (!available()) {
          resolve('cancelled');
          return;
        }
        const s = synth()!;
        const u = new SpeechSynthesisUtterance(text);
        u.rate = webRate(options?.rate);
        if (options?.volume != null) u.volume = Math.max(0, Math.min(1, options.volume / 100));
        const picked = options?.voice ? s.getVoices().find((v) => v.name === options.voice) : undefined;
        if (picked) u.voice = picked;
        u.onend = () => resolve('finished');
        // Web Speech 的 error 事件不区分"被取消"与"真出错",统一按取消处理
        u.onerror = () => resolve('cancelled');
        s.speak(u);
      });
    },
    async pause() {
      if (!available()) return false;
      const s = synth()!;
      if (!s.speaking || s.paused) return false;
      s.pause();
      return true;
    },
    async resume() {
      if (!available()) return false;
      const s = synth()!;
      if (!s.paused) return false;
      s.resume();
      return true;
    },
    async cancel() {
      if (!available()) return;
      synth()!.cancel();
    },
    async supportsPause() {
      return available();
    },
  };
}

/* ---------------- 事件 ---------------- */

type Listener = (paths: string[]) => void;
const listeners = new Set<Listener>();

function emitChanged(paths: string[]) {
  listeners.forEach((l) => l(paths));
}

/* ---------------- 导出 ---------------- */

export function createMockBackend(): WindMDBackend {
  let vaultRoot: VaultInfo | null = null;

  return {
    mode: 'mock',

    speech: createWebSpeech(),

    async openVault(path?: string) {
      rootName = path ? path.split(/[\\/]/).filter(Boolean).pop() || path : '示例库';
      vaultRoot = {
        name: rootName,
        root: path ?? 'mock://vault',
        fileCount: [...files.keys()].filter(ext).length,
      };
      return vaultRoot;
    },

    // 浏览器 dev 模式没有真实文件关联,这三项只在 Tauri 下有意义
    async openPath(_path: string): Promise<OpenPathResult> {
      throw new Error('浏览器模式不支持打开本地文件');
    },

    async takeOpenFile(): Promise<string | null> {
      return null;
    },

    onOpenFile() {
      return () => {};
    },

    async listFiles(dir: string): Promise<FileEntry[]> {
      // 与 Rust 一致:未开库时 require_fs() 会失败。**必须抛普通对象而非 Error** ——
      // Rust 的 AppError 序列化后就是 { code, message },之前 mock 永不失败,
      // 导致"首次打开库还没好就去列目录"这条真实路径在测试里根本走不到,
      // 界面上的 "[object Object]" 也因此漏网。这里保持同构才能测出来。
      if (!vaultRoot) throw { code: 'NO_VAULT', message: '未选择库目录' };
      const prefix = dir === '/' ? '' : dir + '/';
      const names = new Set<string>();
      for (const p of files.keys()) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const [head] = rest.split('/');
        names.add(head);
      }
      const entries: FileEntry[] = [];
      [...names].sort((a, b) =>
        files.has(prefix + a) === files.has(prefix + b) ? a.localeCompare(b) : files.has(prefix + a) ? 1 : -1,
      ).forEach((n) => {
        const full = prefix + n;
        const node = files.get(full);
        if (node) {
          entries.push({ path: full, name: n, isDir: false, kind: 'file', size: node.content.length, mtime: node.mtime });
        } else {
          entries.push({ path: full, name: n, isDir: true, kind: 'dir' });
        }
      });
      return entries;
    },

    async readFile(path: string): Promise<OpenFile> {
      const node = files.get(path);
      if (!node) throw new Error(`文件不存在: ${path}`);
      return { path, content: node.content, mtime: node.mtime, size: node.content.length };
    },

    async writeFile(path: string, content: string): Promise<void> {
      files.set(path, { content, mtime: Date.now() });
      emitChanged([path]);
    },

    async createFile(path: string): Promise<void> {
      if (files.has(path)) throw new Error(`文件已存在: ${path}`);
      files.set(path, { content: `# ${stripMd(path.split('/').pop() ?? path)}\n\n`, mtime: Date.now() });
      emitChanged([path]);
    },

    async deleteFile(path: string): Promise<void> {
      const prefix = path + '/';
      for (const p of [...files.keys()]) {
        if (p === path || p.startsWith(prefix)) files.delete(p);
      }
      emitChanged([path]);
    },

    async renameFile(from: string, to: string): Promise<void> {
      const node = files.get(from);
      if (node) {
        files.delete(from);
        files.set(to, node);
      } else {
        // 目录重命名:批量迁移前缀
        const prefix = from + '/';
        for (const p of [...files.keys()]) {
          if (p.startsWith(prefix)) {
            files.set(to + p.slice(from.length), files.get(p)!);
            files.delete(p);
          }
        }
      }
      emitChanged([from, to]);
    },

    /* --- 搜索 --- */

    async search(query: string): Promise<SearchResult> {
      const t0 = performance.now();
      const q = query.toLowerCase();
      const hits: SearchResult['hits'] = [];
      for (const [path, node] of files) {
        if (!ext(path)) continue;
        const content = node.content;
        let idx = content.toLowerCase().indexOf(q);
        while (idx !== -1 && hits.length < 50) {
          const line = content.slice(0, idx).split('\n').length;
          hits.push({ path, snippet: snippetAround(content, idx), line, score: 1 });
          idx = content.toLowerCase().indexOf(q, idx + q.length);
        }
      }
      return { total: hits.length, hits, tookMs: Math.round(performance.now() - t0) };
    },

    /* --- 元数据(IndexedDB 持久化) --- */

    async getMeta(path: string): Promise<DocumentMeta | null> {
      const node = files.get(path);
      if (!node) return null;
      const stored = await idbGet<Partial<DocumentMeta>>(path);
      return {
        path,
        title: stripMd(path.split('/').pop() ?? path),
        size: node.content.length,
        mtime: node.mtime,
        readProgress: stored?.readProgress ?? 0,
        starred: stored?.starred ?? false,
      };
    },

    async setMeta(path: string, patch): Promise<void> {
      const existing = (await idbGet<Record<string, unknown>>(path)) ?? {};
      await idbSet({ path, ...existing, ...patch });
    },

    async recentFiles(limit = 20): Promise<DocumentMeta[]> {
      const out: DocumentMeta[] = [];
      for (const p of files.keys()) {
        if (!ext(p)) continue;
        const meta = await this.getMeta(p);
        if (meta) out.push(meta);
      }
      return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
    },

    async starredFiles(): Promise<DocumentMeta[]> {
      const out: DocumentMeta[] = [];
      for (const p of files.keys()) {
        if (!ext(p)) continue;
        const stored = await idbGet<Partial<DocumentMeta>>(p);
        if (stored?.starred) {
          const meta = await this.getMeta(p);
          if (meta) out.push(meta);
        }
      }
      return out;
    },

    /* --- 双链与标签 --- */

    async getLinks(path: string): Promise<DocLinks> {
      const node = files.get(path);
      const { links } = node ? parseLinksAndTags(node.content) : { links: [] as string[] };
      const outgoing = links.map((target) => ({
        target,
        resolvedPath: files.has(target) || files.has(`${target}.md`) ? (files.has(target) ? target : `${target}.md`) : null,
      }));
      const backlinks: DocumentMeta[] = [];
      for (const [p, n] of files) {
        if (!ext(p) || p === path) continue;
        if (parseLinksAndTags(n.content).links.includes(stripMd(path))) {
          const meta = await this.getMeta(p);
          if (meta) backlinks.push(meta);
        }
      }
      return { outgoing, backlinks };
    },

    async listTags(): Promise<TagEntry[]> {
      const counts = new Map<string, number>();
      for (const [p, node] of files) {
        if (!ext(p)) continue;
        for (const tag of parseLinksAndTags(node.content).tags) {
          counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
      }
      return [...counts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    },

    async docsByTag(tag: string): Promise<DocumentMeta[]> {
      const out: DocumentMeta[] = [];
      for (const [p, node] of files) {
        if (!ext(p)) continue;
        if (!parseLinksAndTags(node.content).tags.includes(tag)) continue;
        const meta = await this.getMeta(p);
        if (meta) out.push(meta);
      }
      return out;
    },

    /* --- 变更事件 --- */

    onFileChanged(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
