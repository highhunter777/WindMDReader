/**
 * Tauri 后端实现(IPC → Rust commands)。
 * 仅在 Tauri 运行时被 import,浏览器 dev 模式不会加载本文件。
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  WindMDBackend,
  FileEntry,
  OpenFile,
  SearchResult,
  DocumentMeta,
  VaultInfo,
  DocLinks,
  TagEntry,
  VoiceInfo,
  SayOutcome,
} from '../types';

export function createTauriBackend(): WindMDBackend {
  return {
    mode: 'tauri',

    /* --- 朗读:系统音色(WebView2 无 speechSynthesis,只能走后端) --- */
    speech: {
      ready: () => invoke<boolean>('tts_supports_pause'),
      voices: () => invoke<VoiceInfo[]>('tts_voices'),
      say: (text, options) => invoke<SayOutcome>('tts_say', { text, options: options ?? null }),
      pause: () => invoke<boolean>('tts_pause'),
      resume: () => invoke<boolean>('tts_resume'),
      cancel: () => invoke('tts_cancel'),
      supportsPause: () => invoke<boolean>('tts_supports_pause'),
    },

    openVault: (path?: string) => invoke<VaultInfo>('open_vault', { path: path ?? null }),
    listFiles: (dir: string) => invoke<FileEntry[]>('list_files', { dir }),
    readFile: (path: string) => invoke<OpenFile>('read_file', { path }),
    writeFile: (path: string, content: string) => invoke('write_file', { path, content }),
    createFile: (path: string) => invoke('create_file', { path }),
    deleteFile: (path: string) => invoke('delete_file', { path }),
    renameFile: (from: string, to: string) => invoke('rename_file', { from, to }),

    search: (query: string) => invoke<SearchResult>('search', { query }),
    getMeta: (path: string) => invoke<DocumentMeta | null>('get_meta', { path }),
    setMeta: (path: string, patch) => invoke('set_meta', { path, patch }),
    recentFiles: (limit = 20) => invoke<DocumentMeta[]>('recent_files', { limit }),
    starredFiles: () => invoke<DocumentMeta[]>('starred_files'),

    getLinks: (path: string) => invoke<DocLinks>('get_links', { path }),
    listTags: () => invoke<TagEntry[]>('list_tags'),
    docsByTag: (tag: string) => invoke<DocumentMeta[]>('docs_by_tag', { tag }),

    onFileChanged(cb) {
      const un: UnlistenFn[] = [];
      listen<string[]>('file-changed', (e) => cb(e.payload)).then((u) => un.push(u));
      return () => un.forEach((u) => u());
    },
  };
}
