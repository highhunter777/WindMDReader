import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// 构建目标:现代 WebView(WebView2 / WKWebView / WebKitGTK),不需要兼容旧浏览器
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    target: 'es2022',
    // katex / shiki / mermaid 已改为动态 import,不参与首屏,阈值只用于告警
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // 仅隔离稳定的基础依赖;重依赖(katex/shiki/mermaid)由动态 import 自动分包,
        // 不在此列举,否则会被拉进首屏 preload。
        manualChunks: {
          vendor: ['react', 'react-dom'],
          markdown: [
            'markdown-it',
            'markdown-it-anchor',
            'markdown-it-container',
            'markdown-it-footnote',
            'markdown-it-task-lists',
          ],
        },
      },
    },
  },
  test: {
    // 渲染管线与 enhance 均依赖 DOM
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
    // shiki / katex 在 node 环境下加载较慢,放宽超时
    testTimeout: 20_000,
  },
});