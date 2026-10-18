/**
 * 全局状态(Zustand):文档、主题、导航、UI 面板。
 */
import { create } from 'zustand';
import type { DocumentMeta, VaultInfo } from '../types';
import type { Heading } from '../renderer/markdown';
import {
  ACTION_ORDER,
  DEFAULT_BINDINGS,
  type ShortcutAction,
} from '../renderer/shortcuts';

export type ThemeName = 'light' | 'dark';
/** 主题偏好:system = 跟随操作系统(prefers-color-scheme) */
export type ThemeMode = ThemeName | 'system';
export type PanelTab = 'files' | 'search' | 'starred';
export type OutlinerTab = 'toc' | 'links' | 'tags';

interface WindMDState {
  /* --- 库 / 文档 --- */
  vault: VaultInfo | null;
  activePath: string | null;
  content: string;
  meta: DocumentMeta | null;
  headings: Heading[];
  recentFiles: DocumentMeta[];

  /* --- UI --- */
  /** 生效主题(UI 与代码高亮都用它);mode 为 system 时随系统联动 */
  theme: ThemeName;
  /** 主题偏好:显式浅色/深色,或跟随系统 */
  themeMode: ThemeMode;
  zen: boolean;
  sidebarOpen: boolean;
  tocVisible: boolean;
  panelTab: PanelTab;
  /** 右侧面板页签:大纲 / 双链 / 标签 */
  outlinerTab: OutlinerTab;
  findOpen: boolean;
  findQuery: string;
  /** 当前查询的命中总数 */
  findTotal: number;
  /** 当前定位的命中下标 */
  findIndex: number;
  renderMs: number;

  /* --- 排版 --- */
  fontSize: number;
  readingWidth: number;
  fontFamily: 'sans' | 'serif';
  /** 焦点行:淡出非当前段落 */
  focusLine: boolean;
  /** 打字机:当前段落始终对齐视口锚点行 */
  typewriter: boolean;

  /* --- 朗读 --- */
  /** 语速,`-10..=10`(系统音色的原生单位) */
  speakRate: number;
  /** 音色名;空串表示用系统默认 */
  speakVoice: string;

  /* --- 划词翻译:在线端点(可选,默认关闭) --- */
  /** 在线翻译开关。默认 false:不配置端点就不发任何网络请求 */
  translateOnlineEnabled: boolean;
  /** OpenAI 兼容端点 base URL,如 https://api.openai.com/v1 */
  translateEndpoint: string;
  /** 模型名 */
  translateModel: string;
  /** API Key(本地/自托管服务通常留空) */
  translateApiKey: string;

  /* --- 快捷键绑定(设置页可改键) --- */
  bindings: Record<ShortcutAction, string>;

  /* --- Actions --- */
  setVault(v: VaultInfo | null): void;
  openDoc(path: string, content: string, meta: DocumentMeta | null): void;
  setMeta(meta: DocumentMeta | null): void;
  setHeadings(h: Heading[]): void;
  setRecent(arr: DocumentMeta[]): void;
  toggleTheme(): void;
  setTheme(t: ThemeName): void;
  /** 设置主题偏好(三态);system 时立即按当前系统主题解析生效值 */
  setThemeMode(m: ThemeMode): void;
  toggleZen(): void;
  setSidebarOpen(v: boolean): void;
  setTocVisible(v: boolean): void;
  setPanelTab(t: PanelTab): void;
  setOutlinerTab(t: OutlinerTab): void;
  setFindOpen(v: boolean): void;
  setFindQuery(q: string): void;
  /** 由 Viewer 在完成高亮后回写,供查找条显示命中数与当前位置 */
  setFindState(total: number, index: number): void;
  setRenderMs(ms: number): void;
  setFontSize(n: number): void;
  setReadingWidth(n: number): void;
  setFontFamily(f: 'sans' | 'serif'): void;
  setFocusLine(v: boolean): void;
  toggleFocusLine(): void;
  setTypewriter(v: boolean): void;
  toggleTypewriter(): void;
  setSpeakRate(n: number): void;
  setSpeakVoice(v: string): void;
  setTranslateOnlineEnabled(v: boolean): void;
  setTranslateEndpoint(v: string): void;
  setTranslateModel(v: string): void;
  setTranslateApiKey(v: string): void;
  setBinding(action: ShortcutAction, combo: string): void;
  resetBindings(): void;
}

const saved = {
  fontSize: Number(localStorage.getItem('windmd-fontSize') ?? 17),
  readingWidth: Number(localStorage.getItem('windmd-width') ?? 720),
  fontFamily: (localStorage.getItem('windmd-font') as 'sans' | 'serif' | null) ?? 'sans',
  focusLine: localStorage.getItem('windmd-focus') === '1',
  typewriter: localStorage.getItem('windmd-typewriter') === '1',
  speakRate: clampRate(Number(localStorage.getItem('windmd-speakRate') ?? 0)),
  speakVoice: localStorage.getItem('windmd-speakVoice') ?? '',
  translateOnlineEnabled: localStorage.getItem('windmd-translate-online') === '1',
  translateEndpoint: localStorage.getItem('windmd-translate-endpoint') ?? '',
  translateModel: localStorage.getItem('windmd-translate-model') ?? '',
  translateApiKey: localStorage.getItem('windmd-translate-key') ?? '',
  outlinerTab: (localStorage.getItem('windmd-outliner-tab') as OutlinerTab | null) ?? 'toc',
};

/** 系统是否深色(无 matchMedia 的环境按浅色) */
function systemDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

/**
 * 主题偏好:优先读三态键;没有则沿用旧版显式主题键做迁移;
 * 两者都没有(全新用户)默认跟随系统。
 */
function savedThemeMode(): ThemeMode {
  const mode = localStorage.getItem('windmd-theme-mode');
  if (mode === 'light' || mode === 'dark' || mode === 'system') return mode;
  const legacy = localStorage.getItem('windmd-theme');
  if (legacy === 'light' || legacy === 'dark') return legacy;
  return 'system';
}

/** 偏好 → 生效主题 */
function resolveTheme(mode: ThemeMode): ThemeName {
  return mode === 'system' ? (systemDark() ? 'dark' : 'light') : mode;
}

/** 语速限幅:落库的脏值不该拖垮后端 */
function clampRate(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(-10, Math.min(10, Math.round(n)));
}

/**
 * 读取快捷键绑定:localStorage 覆盖 + 默认合并。
 * 合并而非替换 —— 新增动作自动拿到默认绑定,旧配置不失效;
 * 存了非法值的条目回退默认,脏数据不拖垮匹配。
 */
function loadBindings(): Record<ShortcutAction, string> {
  const out = { ...DEFAULT_BINDINGS };
  try {
    const raw = localStorage.getItem('windmd-keys');
    if (raw) {
      const saved = JSON.parse(raw) as Record<string, unknown>;
      for (const a of ACTION_ORDER) {
        const v = saved[a];
        if (typeof v === 'string' && v.trim()) out[a] = v.trim().toLowerCase();
      }
    }
  } catch {
    /* 坏 JSON 用默认 */
  }
  return out;
}

export const useStore = create<WindMDState>((set, get) => ({
  vault: null,
  activePath: null,
  content: '',
  meta: null,
  headings: [],
  recentFiles: [],

  theme: resolveTheme(savedThemeMode()),
  themeMode: savedThemeMode(),
  zen: false,
  sidebarOpen: true,
  tocVisible: true,
  panelTab: 'files',
  outlinerTab: saved.outlinerTab,
  findOpen: false,
  findQuery: '',
  findTotal: 0,
  findIndex: 0,
  renderMs: 0,

  fontSize: saved.fontSize,
  readingWidth: saved.readingWidth,
  fontFamily: saved.fontFamily,
  focusLine: saved.focusLine,
  typewriter: saved.typewriter,
  speakRate: saved.speakRate,
  speakVoice: saved.speakVoice,
  translateOnlineEnabled: saved.translateOnlineEnabled,
  translateEndpoint: saved.translateEndpoint,
  translateModel: saved.translateModel,
  translateApiKey: saved.translateApiKey,
  bindings: loadBindings(),

  // 记住上次库路径,重启后免去重新选择(路径失效时由启动流程回退到选择框)
  setVault: (v) => {
    if (v) localStorage.setItem('windmd-vault', v.root);
    set({ vault: v });
  },
  openDoc: (path, content, meta) => set({ activePath: path, content, meta }),
  setMeta: (meta) => set({ meta }),
  setHeadings: (headings) => set({ headings }),
  setRecent: (recentFiles) => set({ recentFiles }),
  toggleTheme: () => {
    // 按当前生效主题取反:即便正处于「跟随系统」,点击也落到显式值,
    // 否则用户连点两下看起来毫无变化
    const t: ThemeName = get().theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('windmd-theme-mode', t);
    set({ themeMode: t, theme: t });
  },
  setTheme: (t) => {
    localStorage.setItem('windmd-theme-mode', t);
    set({ themeMode: t, theme: t });
  },
  setThemeMode: (m) => {
    localStorage.setItem('windmd-theme-mode', m);
    set({ themeMode: m, theme: resolveTheme(m) });
  },
  toggleZen: () => set((s) => ({ zen: !s.zen })),
  setSidebarOpen: (v) => set({ sidebarOpen: v }),
  setTocVisible: (v) => set({ tocVisible: v }),
  setPanelTab: (t) => set({ panelTab: t }),
  setOutlinerTab: (t) => {
    localStorage.setItem('windmd-outliner-tab', t);
    set({ outlinerTab: t });
  },
  setFindOpen: (v) => set(v ? { findOpen: true } : { findOpen: false, findQuery: '', findTotal: 0, findIndex: 0 }),
  setFindQuery: (q) => set({ findQuery: q }),
  setFindState: (findTotal, findIndex) => set({ findTotal, findIndex }),
  setRenderMs: (ms) => set({ renderMs: ms }),
  setFontSize: (n) => {
    localStorage.setItem('windmd-fontSize', String(n));
    set({ fontSize: n });
  },
  setReadingWidth: (n) => {
    localStorage.setItem('windmd-width', String(n));
    set({ readingWidth: n });
  },
  setFontFamily: (f) => {
    localStorage.setItem('windmd-font', f);
    set({ fontFamily: f });
  },
  setFocusLine: (v) => {
    localStorage.setItem('windmd-focus', v ? '1' : '0');
    set({ focusLine: v });
  },
  toggleFocusLine: () => {
    const v = !get().focusLine;
    localStorage.setItem('windmd-focus', v ? '1' : '0');
    set({ focusLine: v });
  },
  setTypewriter: (v) => {
    localStorage.setItem('windmd-typewriter', v ? '1' : '0');
    set({ typewriter: v });
  },
  toggleTypewriter: () => {
    const v = !get().typewriter;
    localStorage.setItem('windmd-typewriter', v ? '1' : '0');
    set({ typewriter: v });
  },
  setSpeakRate: (n) => {
    const v = clampRate(n);
    localStorage.setItem('windmd-speakRate', String(v));
    set({ speakRate: v });
  },
  setSpeakVoice: (v) => {
    localStorage.setItem('windmd-speakVoice', v);
    set({ speakVoice: v });
  },
  setTranslateOnlineEnabled: (v) => {
    localStorage.setItem('windmd-translate-online', v ? '1' : '0');
    set({ translateOnlineEnabled: v });
  },
  setTranslateEndpoint: (v) => {
    localStorage.setItem('windmd-translate-endpoint', v);
    set({ translateEndpoint: v });
  },
  setTranslateModel: (v) => {
    localStorage.setItem('windmd-translate-model', v);
    set({ translateModel: v });
  },
  setTranslateApiKey: (v) => {
    localStorage.setItem('windmd-translate-key', v);
    set({ translateApiKey: v });
  },
  setBinding: (action, combo) => {
    const next = { ...get().bindings, [action]: combo };
    localStorage.setItem('windmd-keys', JSON.stringify(next));
    set({ bindings: next });
  },
  resetBindings: () => {
    localStorage.removeItem('windmd-keys');
    set({ bindings: { ...DEFAULT_BINDINGS } });
  },
}));

/* --- 跟随系统:偏好为 system 时,系统明暗变化要同步到生效主题 --- */
const darkMql =
  typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') : undefined;
darkMql?.addEventListener?.('change', (e) => {
  if (useStore.getState().themeMode === 'system') {
    useStore.setState({ theme: e.matches ? 'dark' : 'light' });
  }
});
