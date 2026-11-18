/**
 * 代码高亮的共享类型。
 *
 * 单独成文件是为了让 `highlight.ts`(主线程)与 `highlight.worker.ts`
 * (Worker)引用同一份主题名,而不必互相 import —— 后者会把 shiki
 * 拉进主线程的打包单元,产生重复副本。
 */
export type ThemeName = 'github-light' | 'github-dark';
