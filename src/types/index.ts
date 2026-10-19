/**
 * WindMD 核心类型定义
 */

export interface FileEntry {
  /** 相对库根的路径,用 / 分隔 */
  path: string;
  name: string;
  isDir: boolean;
  kind: 'file' | 'dir';
  size?: number;
  mtime?: number;
}

export interface OpenFile {
  path: string;
  content: string;
  mtime: number;
  size: number;
}

export interface SearchHit {
  path: string;
  /** 命中片段(已高亮排版,配 snippets 使用) */
  snippet: string;
  line: number;
  score: number;
}

export interface SearchResult {
  total: number;
  hits: SearchHit[];
  /** 本次搜索耗时 ms(展示用) */
  tookMs: number;
}

export interface DocumentMeta {
  path: string;
  title: string;
  size: number;
  mtime: number;
  readProgress: number;
  starred: boolean;
}

export interface VaultInfo {
  name: string;
  root: string;
  fileCount: number;
}

/** 打开系统送来的文件后,后端确定的库与库内相对路径 */
export interface OpenPathResult {
  vault: VaultInfo;
  /** 目标文件相对库根的路径 */
  path: string;
}

/** 一个双链目标:归一化目标 + 解析结果(null 表示目标文件尚未创建) */
export interface LinkTarget {
  target: string;
  resolvedPath: string | null;
}

/** 某文档的双链视图:出链(含解析状态)与反链 */
export interface DocLinks {
  outgoing: LinkTarget[];
  backlinks: DocumentMeta[];
}

/** 标签聚合项 */
export interface TagEntry {
  tag: string;
  count: number;
}

/* ================================================================
 * 朗读(TTS)
 * ================================================================ */

/** 一个可用音色 */
export interface VoiceInfo {
  name: string;
  /** BCP-47 语言标记,如 `zh-CN`;部分平台解析不到时为空 */
  culture: string;
  /** `Female` / `Male` / `Neutral`;未知时为空 */
  gender: string;
}

/** 单句朗读的结果 */
export type SayOutcome = 'finished' | 'cancelled';

/** 朗读参数 */
export interface SpeakOptions {
  /** 语速,`-10..=10`(统一单位,各后端自行换算) */
  rate?: number;
  /** 音量 `0..=100` */
  volume?: number;
  /** 音色名 */
  voice?: string;
}

/**
 * 朗读能力。
 *
 * 桌面端由 Rust 走系统音色(Windows: SAPI;macOS: `say`;Linux: `espeak-ng`),
 * 浏览器 dev 模式回退 Web Speech —— 注意 WebView2 并**不**支持
 * `speechSynthesis`,所以桌面端必须走后端通道。
 *
 * 约定为「逐句」:`say` 直到该句播完才 resolve,
 * 于是暂停/继续/停止都能落在句边界上。
 */
export interface SpeechApi {
  /** 引擎是否可用(不可用时前端应给出明确提示而非静默无响应) */
  ready(): Promise<boolean>;
  voices(): Promise<VoiceInfo[]>;
  say(text: string, options?: SpeakOptions): Promise<SayOutcome>;
  /** 返回是否真的暂停了(引擎不支持时为 false) */
  pause(): Promise<boolean>;
  /** 返回是否真的继续了 */
  resume(): Promise<boolean>;
  cancel(): Promise<void>;
  /** 该引擎是否支持暂停/继续 */
  supportsPause(): Promise<boolean>;
}

/**
 * IPC 通道抽象。
 * 浏览器模式(dev):由 mock 实现,数据保存在 IndexedDB/内存。
 * Tauri 模式:由 src-tauri 后端实现,经 invoke/events 转发。
 * UI 层只依赖本接口,不感知具体后端。
 */
export interface WindMDBackend {
  readonly mode: 'mock' | 'tauri';

  /** 朗读能力 */
  readonly speech: SpeechApi;

  /* --- 库 / 文件 --- */
  openVault(path?: string): Promise<VaultInfo>;
  /** 打开系统传入的绝对路径:以所在目录为库,并返回库内相对路径 */
  openPath(path: string): Promise<OpenPathResult>;
  /** 取走启动时待打开的外部文件路径(取后清空) */
  takeOpenFile(): Promise<string | null>;
  /** 运行中再次通过文件关联打开时通知 */
  onOpenFile(cb: (path: string) => void): () => void;
  listFiles(dir: string): Promise<FileEntry[]>;
  readFile(path: string): Promise<OpenFile>;
  writeFile(path: string, content: string): Promise<void>;
  createFile(path: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  renameFile(from: string, to: string): Promise<void>;

  /* --- 搜索 / 元数据 --- */
  search(query: string): Promise<SearchResult>;
  getMeta(path: string): Promise<DocumentMeta | null>;
  setMeta(path: string, patch: Partial<Pick<DocumentMeta, 'readProgress' | 'starred'>>): Promise<void>;
  recentFiles(limit?: number): Promise<DocumentMeta[]>;
  starredFiles(): Promise<DocumentMeta[]>;

  /* --- 双链与标签 --- */
  getLinks(path: string): Promise<DocLinks>;
  listTags(): Promise<TagEntry[]>;
  docsByTag(tag: string): Promise<DocumentMeta[]>;

  /* --- 文件监视事件 --- */
  onFileChanged(cb: (paths: string[]) => void): () => void;
}
