/**
 * 导出:单文件 HTML / PDF(打印流)/ 长图(PNG)。
 *
 * 设计要点:
 * - 导出来自**已增强的正文 DOM**(代码高亮 / 公式 / 图表均已渲染),
 *   而不是重新解析 Markdown —— 导出结果与屏幕所见一致,且无需 JS 即可打开。
 * - HTML 与长图都先离线化:图片与 KaTeX 字体转 data URL 内联,单文件可分享;
 *   离线化失败的图片在长图中降级为占位块,避免污染画布(跨域图片会锁死 canvas)。
 * - PDF 走打印流:新窗口打开导出 HTML 后调 print(),
 *   WebView2 / 浏览器均可选「另存为 PDF」,保留高亮与公式。
 */
import { enhanceAll } from './enhance';

export type ExportTheme = 'light' | 'dark';

export interface ExportDocInfo {
  title: string;
  /** 库内相对路径,写入导出页脚 */
  sourcePath?: string;
  theme: ExportTheme;
  fontSize: number;
  fontFamily: 'sans' | 'serif';
}

/* ---------------- 字体栈(与 styles/index.css 的 token 保持一致) ---------------- */

const FONT_STACKS = {
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  serif: "'Source Han Serif SC', 'Songti SC', 'Noto Serif CJK SC', Georgia, 'Times New Roman', serif",
  mono: "'JetBrains Mono', 'Cascadia Code', 'SF Mono', Consolas, 'Courier New', monospace",
} as const;

/* ---------------- 纯函数:文件名 / 日期 / 转义 ---------------- */

/** Windows 文件名非法字符 + 控制字符;结尾的点和空格同样不接受 */
export function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
}

export function exportFileName(title: string, ext: string): string {
  const base = sanitizeFileName(title);
  return `${base || '未命名文档'}.${ext.replace(/^\./, '')}`;
}

export function formatExportDate(ts: number = Date.now()): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------------- 导出样式表(自包含,不依赖应用 CSS) ---------------- */

/**
 * 生成导出文档的完整样式:主题 token + prose 排版 + 打印规则。
 * token 挂在 `.export-root` 上(而非 :root),使同一份 CSS 既能用于
 * HTML 文档(body),也能嵌入长图的 SVG foreignObject。
 */
export function buildExportCss(theme: ExportTheme, fontSize: number, fontFamily: 'sans' | 'serif'): string {
  const tokens =
    theme === 'dark'
      ? `--bg:#16181d; --bg-subtle:#1c1f26; --border:#2b2f37; --border-strong:#3d434d;
   --fg:#d8dce2; --fg-muted:#8b949e; --fg-faint:#6e7681;
   --link:#7aa7ff; --link-hover:#a3c0ff; --accent:#6b93ff;
   --code-bg:#1b1e24; --code-border:#2b2f37; --quote-bar:#3d434d; --quote-fg:#9aa2ac;
   --table-stripe:#1b1e24; --table-head-bg:#22262e;`
      : `--bg:#ffffff; --bg-subtle:#f6f7f9; --border:#e3e6ea; --border-strong:#cfd4da;
   --fg:#1f2328; --fg-muted:#6a737d; --fg-faint:#9aa2ac;
   --link:#2f6feb; --link-hover:#1a5fd0; --accent:#4f7cf7;
   --code-bg:#f6f8fa; --code-border:#e6e9ed; --quote-bar:#d0d7de; --quote-fg:#5a6472;
   --table-stripe:#fafbfc; --table-head-bg:#f2f4f7;`;

  return `*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
.export-root {
  ${tokens}
  background: var(--bg);
  color: var(--fg);
  font-family: ${FONT_STACKS.sans};
  line-height: 1.75;
  -webkit-font-smoothing: antialiased;
  overflow-wrap: break-word;
}
.export-root[data-font='serif'], .export-root[data-font='serif'] .prose { font-family: ${FONT_STACKS.serif}; }

.prose {
  width: 100%;
  font-family: ${fontFamily === 'serif' ? FONT_STACKS.serif : FONT_STACKS.sans};
  font-size: ${fontSize}px;
  line-height: 1.75;
  color: var(--fg);
  min-width: 0;
}
.prose[data-font='serif'] { font-family: ${FONT_STACKS.serif}; }

/* --- 标题 --- */
.prose h1, .prose h2, .prose h3, .prose h4, .prose h5, .prose h6 {
  margin: 1.6em 0 0.6em; font-weight: 650; line-height: 1.3;
}
.prose > :first-child { margin-top: 0; }
.prose h1 { font-size: 1.8em; }
.prose h2 { font-size: 1.5em; padding-bottom: 0.3em; border-bottom: 1px solid var(--border); }
.prose h3 { font-size: 1.3em; }
.prose h4 { font-size: 1.2em; }
.prose h5 { font-size: 1.15em; }
.prose h6 { font-size: 1.05em; color: var(--fg-muted); }

/* --- 段落与列表 --- */
.prose p { margin: 0 0 0.75em; }
.prose ul, .prose ol { margin: 0 0 0.75em; padding-left: 1.6em; }
.prose li { margin: 0.25em 0; }
.prose li > ul, .prose li > ol { margin: 0.25em 0; }
.prose li::marker { color: var(--fg-faint); }
.prose .contains-task-list { list-style: none; padding-left: 0.2em; }
.prose .task-list-item { display: flex; align-items: baseline; gap: 0.5em; }
.prose .task-list-item input[type='checkbox'] { margin: 0; accent-color: var(--accent); transform: translateY(1px); }

/* --- 链接 / 行内代码 --- */
.prose a { color: var(--link); text-decoration: none; border-bottom: 1px solid transparent; }
.prose code {
  padding: 0.15em 0.35em; font-family: ${FONT_STACKS.mono}; font-size: 0.875em;
  background: var(--code-bg); border: 1px solid var(--code-border); border-radius: 4px;
}

/* --- 代码块(Shiki 输出自带底色) --- */
.prose .code-block {
  position: relative; margin: 0 0 0.75em; padding: 14px 16px;
  overflow-x: auto; font-size: 0.875em; line-height: 1.6;
  background: var(--code-bg); border: 1px solid var(--code-border); border-radius: 6px;
}
.prose .code-block code {
  display: block; padding: 0; font-family: ${FONT_STACKS.mono};
  background: none; border: none; white-space: pre;
}
.prose .code-block.code-highlighted { padding: 14px 16px; }
.prose .code-block pre { margin: 0; background: none !important; }
.code-copy { display: none; }

/* --- 引用 / 分割线 / 表格 --- */
.prose blockquote {
  margin: 0 0 0.75em; padding: 0.2em 1.1em;
  color: var(--quote-fg); border-left: 3px solid var(--quote-bar);
}
.prose blockquote > :last-child { margin-bottom: 0; }
.prose hr { height: 1px; margin: 2em 0; background: var(--border); border: none; }
.prose table {
  display: block; width: 100%; margin: 0 0 0.75em;
  border-collapse: collapse; font-size: 0.94em; overflow-x: auto;
}
.prose thead { background: var(--table-head-bg); }
.prose th, .prose td { padding: 7px 12px; border: 1px solid var(--border); }
.prose th { font-weight: 600; }
.prose tbody tr:nth-child(even) { background: var(--table-stripe); }

/* --- 图片 / 公式 / 图表 --- */
.prose img { display: block; max-width: 100%; height: auto; border-radius: 6px; }
.prose img.img-error {
  min-height: 80px; padding: 20px; font-size: 12px; color: var(--fg-muted);
  background: var(--bg-subtle); border: 1px dashed var(--border-strong); border-radius: 6px;
}
.prose .math-inline { padding: 0 0.15em; }
.prose .math-block { margin: 0 0 0.75em; padding: 0.6em 0; overflow-x: auto; text-align: center; }
.katex { font-size: 1.05em; }
.katex-display { margin: 0; }
.prose .mermaid-block {
  margin: 0 0 0.75em; padding: 16px; overflow-x: auto; text-align: center;
  background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 6px;
}
.prose .mermaid-block svg { max-width: 100%; height: auto; }
.mermaid-error { font-size: 12px; color: #d9534f; text-align: left; white-space: pre-wrap; }

/* --- 容器 / 脚注 --- */
.prose .callout {
  margin: 0 0 0.75em; padding: 12px 16px;
  border-left: 3px solid; border-radius: 6px;
}
.prose .callout-title { margin-bottom: 0.4em; font-weight: 600; }
.prose .callout > :last-child { margin-bottom: 0; }
.prose .callout-warning { background: ${theme === 'dark' ? '#2b2415' : '#fff8e6'}; border-color: ${theme === 'dark' ? '#6b5518' : '#f0c36d'}; }
.prose .callout-tip { background: ${theme === 'dark' ? '#14261d' : '#eefaf3'}; border-color: ${theme === 'dark' ? '#2c6b4c' : '#4fbf8b'}; }
.prose .footnotes { margin-top: 2.5em; padding-top: 1em; font-size: 0.9em; color: var(--fg-muted); border-top: 1px solid var(--border); }
.prose .footnotes-sep { display: none; }

/* --- 文档内查找高亮(导出时已剥离 mark,规则仅兜底) --- */
.prose mark.find-hit, .prose mark.find-current { background: transparent; color: inherit; padding: 0; }

/* --- 页脚 --- */
.export-footer {
  max-width: 860px; margin: 0 auto; padding: 18px 32px 40px;
  font-size: 12px; color: var(--fg-faint);
  border-top: 1px solid var(--border);
}

/* --- 打印(PDF) --- */
@page { margin: 16mm 14mm; }
@media print {
  .prose pre, .prose blockquote, .prose table, .prose .mermaid-block,
  .prose .math-block, .prose img, .prose .callout { break-inside: avoid; }
  .prose h1, .prose h2, .prose h3, .prose h4 { break-after: avoid; }
  .prose .code-block { white-space: pre-wrap; word-break: break-all; }
}`.replace(/\n\s*/g, '\n');
}

/* ---------------- 导出文档组装 ---------------- */

/** 正文 + 页脚的内部 HTML(HTML 文档与长图 SVG 共用) */
export function buildExportRoot(bodyXml: string, info: ExportDocInfo, fontCss = ''): string {
  const footer = `由 WindMD 导出 · ${formatExportDate()}${info.sourcePath ? ` · ${escapeHtml(info.sourcePath)}` : ''}`;
  return (
    `<style>${fontCss}</style>` +
    `<article class="prose" data-font="${info.fontFamily}" style="font-size:${info.fontSize}px;">${bodyXml}</article>` +
    `<footer class="export-footer">${footer}</footer>`
  );
}

/** 组装完整的单文件 HTML 文档 */
export function buildExportHtml(bodyXml: string, info: ExportDocInfo, fontCss = ''): string {
  const css = buildExportCss(info.theme, info.fontSize, info.fontFamily);
  return (
    `<!doctype html>\n` +
    `<html lang="zh-CN">\n` +
    `<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${escapeHtml(info.title)}</title>\n` +
    `<style>${css}</style>\n` +
    `</head>\n` +
    `<body class="export-root" data-theme="${info.theme}" data-font="${info.fontFamily}">\n` +
    `<div style="max-width:860px;margin:0 auto;padding:48px 32px 0;">\n` +
    buildExportRoot(bodyXml, info, fontCss) +
    `\n</div>\n</body>\n</html>`
  );
}

/**
 * 把导出内容包进 SVG foreignObject(长图渲染用)。
 * foreignObject 内是隔离的渲染上下文:样式必须随 SVG 一起内联,
 * 且根节点需显式声明 XHTML 命名空间,否则 XML 解析失败。
 */
export function buildForeignObjectSvg(rootHtml: string, width: number, height: number, theme: ExportTheme): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<foreignObject x="0" y="0" width="${width}" height="${height}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" class="export-root" data-theme="${theme}" style="width:${width}px;">` +
    rootHtml +
    `</div>` +
    `</foreignObject></svg>`
  );
}

/* ---------------- 离线化:图片 / 字体 ---------------- */

/** 默认取图方式:fetch → blob → data URL;跨域或离线时返回 null */
export async function defaultFetchAsDataUrl(src: string): Promise<string | null> {
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export interface InlineImagesResult {
  total: number;
  inlined: number;
  failed: number;
}

/**
 * 把 root 内全部 `<img>` 的 src 替换为 data URL。
 * onFail='placeholder' 时(长图路径),失败的图片替换为占位块 ——
 * 跨域图片留在画布里会让 canvas 被锁死,toBlob 直接抛 SecurityError。
 */
export async function inlineImages(
  root: HTMLElement,
  opts: {
    fetchAsDataUrl?: (src: string) => Promise<string | null>;
    onFail?: 'keep' | 'placeholder';
  } = {},
): Promise<InlineImagesResult> {
  const fetchAsDataUrl = opts.fetchAsDataUrl ?? defaultFetchAsDataUrl;
  const onFail = opts.onFail ?? 'keep';
  const imgs = Array.from(root.querySelectorAll('img'));
  let inlined = 0;
  let failed = 0;
  for (const img of imgs) {
    const src = img.getAttribute('src') ?? '';
    if (!src || src.startsWith('data:')) continue;
    const dataUrl = await fetchAsDataUrl(src);
    if (dataUrl) {
      img.setAttribute('src', dataUrl);
      inlined++;
    } else {
      failed++;
      if (onFail === 'placeholder') {
        const box = document.createElement('div');
        box.className = 'img-error';
        box.textContent = img.getAttribute('alt') || '图片未能内联(离线或跨域)';
        img.replaceWith(box);
      }
    }
  }
  return { total: imgs.length, inlined, failed };
}

/**
 * 重写 CSS 文本中的 url(...) 引用。
 * resolve 返回 null(取不到)时保留原值;data: 等无需处理。
 */
export async function rewriteCssUrls(
  css: string,
  resolve: (url: string) => Promise<string | null>,
): Promise<string> {
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  const parts: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const url = m[2];
    if (/^(data:|#|about:)/i.test(url)) continue;
    const replaced = await resolve(url);
    if (!replaced) continue;
    parts.push(css.slice(last, m.index), `url("${replaced}")`);
    last = m.index + m[0].length;
  }
  parts.push(css.slice(last));
  return parts.join('');
}

/**
 * 收集文档中已加载的 @font-face 规则(主要是 KaTeX 公式字体),
 * 字体文件转 data URL 后随导出文件内联 —— 导出的公式在未安装
 * 对应字体的机器上仍能正确排版。
 * 任何一步失败都静默跳过:导出不应被字体问题拖垮。
 */
export async function collectInlineFontCss(
  fetchAsDataUrl: (src: string) => Promise<string | null> = defaultFetchAsDataUrl,
): Promise<string> {
  const out: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules; // 跨域样式表读不了规则
    } catch {
      continue;
    }
    // CSS 里的 url() 是相对路径,必须按**样式表自身地址**解析;
    // 直接 fetch 相对路径会按文档地址去找,必然 404。
    const base = sheet.href || document.baseURI;
    for (const rule of Array.from(rules)) {
      const isFontFace =
        typeof CSSFontFaceRule !== 'undefined' && rule instanceof CSSFontFaceRule
          ? true
          : rule.type === 5; /* CSSRule.FONT_FACE_RULE */
      if (!isFontFace) continue;
      const style = (rule as CSSFontFaceRule).style;
      const src = style.getPropertyValue('src');
      if (!src) continue;
      const rewritten = await rewriteCssUrls(src, async (url) => {
        try {
          return await fetchAsDataUrl(new URL(url, base).href);
        } catch {
          return null; // url 解析失败(极少数非法值),保留原值
        }
      });
      out.push(
        `@font-face{font-family:${style.getPropertyValue('font-family')};` +
          `font-style:${style.getPropertyValue('font-style') || 'normal'};` +
          `font-weight:${style.getPropertyValue('font-weight') || 'normal'};` +
          `src:${rewritten};font-display:swap}`,
      );
    }
  }
  return out.join('\n');
}

/* ---------------- 导出内容准备 ---------------- */

/** 剥掉文档内查找注入的 <mark>,导出物不应残留临时高亮 */
export function stripFindMarks(root: HTMLElement): number {
  const marks = Array.from(root.querySelectorAll('mark.find-hit, mark.find-current'));
  for (const m of marks) {
    m.replaceWith(...Array.from(m.childNodes));
  }
  return marks.length;
}

export interface PreparedExport {
  /** XML 序列化的正文(foreignObject 与 HTML 均可直接嵌入) */
  bodyXml: string;
  /** 内联后的字体 CSS(可能为空) */
  fontCss: string;
}

export interface PrepareExportOptions {
  /** 增强注入(测试可替换;默认 enhanceAll,按当前主题) */
  enhance?: (container: HTMLElement, theme: ExportTheme) => Promise<void>;
  /** 取图注入(测试可替换) */
  fetchAsDataUrl?: (src: string) => Promise<string | null>;
  /** 图片离线化失败时的降级策略;长图传 placeholder */
  imageFail?: 'keep' | 'placeholder';
}

/**
 * 准备导出内容:克隆正文 → 去查找高亮/复制按钮 → 补全全部增强 →
 * 图片与字体离线化。克隆是离线的,不影响当前界面。
 */
export async function prepareExportBody(
  source: HTMLElement,
  info: ExportDocInfo,
  opts: PrepareExportOptions = {},
): Promise<PreparedExport> {
  const enhance =
    opts.enhance ??
    ((c, t) => enhanceAll(c, t === 'dark' ? 'github-dark' : 'github-light'));
  const fetchAsDataUrl = opts.fetchAsDataUrl ?? defaultFetchAsDataUrl;

  const clone = source.cloneNode(true) as HTMLElement;
  clone.removeAttribute('id');
  stripFindMarks(clone);
  clone.querySelectorAll('.code-copy').forEach((n) => n.remove());

  await enhance(clone, info.theme);
  // 增强过程会补复制按钮,导出物里再清一次
  clone.querySelectorAll('.code-copy').forEach((n) => n.remove());

  await inlineImages(clone, { fetchAsDataUrl, onFail: opts.imageFail ?? 'keep' });
  const fontCss = await collectInlineFontCss(fetchAsDataUrl);

  return { bodyXml: new XMLSerializer().serializeToString(clone), fontCss };
}

/* ---------------- 三种导出动作 ---------------- */

/** 触发浏览器/WebView 下载 */
export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 延迟回收,确保下载流程已取得引用
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * 新窗口打开导出 HTML 并调起打印对话框(用户可选「另存为 PDF」)。
 * WebView2/Tauri 会拦截 window.open(即便在用户点击的手势里也返回 null),
 * 此时回退为隐藏 iframe 打印其内容 —— 同样走系统打印对话框,
 * 且 iframe 文档自带 @page 规则,分页避让规则不受影响。
 */
export function printExportHtml(html: string): void {
  const w = window.open('', '_blank');
  if (w) {
    writeAndPrint(w, html);
    return;
  }
  printViaIframe(html);
}

function writeAndPrint(w: Window, html: string): void {
  w.document.open();
  w.document.write(html);
  w.document.close();
  const run = () => {
    w.focus();
    w.print();
  };
  if (w.document.readyState === 'complete') run();
  else w.addEventListener('load', run, { once: true });
}

/** window.open 被拦截时的打印路径:离屏 iframe + 打印其文档 */
function printViaIframe(html: string): void {
  const iframe = document.createElement('iframe');
  // 离屏但保持渲染(visibility:hidden 会影响打印输出),不干扰界面
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:860px;height:600px;border:0;';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  if (!doc) {
    iframe.remove();
    throw new Error('PDF 导出失败:无法创建打印上下文');
  }
  doc.open();
  doc.write(html);
  doc.close();
  const run = () => {
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
    // 打印预览是异步对话框,给足时间后再回收 iframe
    window.setTimeout(() => iframe.remove(), 60_000);
  };
  if (doc.readyState === 'complete') run();
  else iframe.addEventListener('load', run, { once: true });
}

export async function exportHtmlFile(source: HTMLElement, info: ExportDocInfo): Promise<void> {
  const { bodyXml, fontCss } = await prepareExportBody(source, info, { imageFail: 'keep' });
  const html = buildExportHtml(bodyXml, info, fontCss);
  downloadBlob(exportFileName(info.title, 'html'), new Blob([html], { type: 'text/html;charset=utf-8' }));
}

export async function exportPdf(source: HTMLElement, info: ExportDocInfo): Promise<void> {
  const { bodyXml, fontCss } = await prepareExportBody(source, info, { imageFail: 'keep' });
  printExportHtml(buildExportHtml(bodyXml, info, fontCss));
}

/** 在离屏容器中测量内容实际高度(jsdom 无布局,返回 0) */
async function measureContentHeight(rootHtml: string, width: number, theme: ExportTheme): Promise<number> {
  const stage = document.createElement('div');
  stage.setAttribute('aria-hidden', 'true');
  stage.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;';
  const root = document.createElement('div');
  root.className = 'export-root';
  root.dataset.theme = theme;
  root.style.width = `${width}px`;
  root.innerHTML = rootHtml;
  stage.appendChild(root);
  document.body.appendChild(stage);
  // 等一帧,让浏览器完成布局
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const height = Math.ceil(root.getBoundingClientRect().height);
  stage.remove();
  return height;
}

/** 把正文 HTML 渲染为整页 PNG(2x 清晰度) */
export async function htmlToPngBlob(
  bodyXml: string,
  info: ExportDocInfo,
  opts: { width: number; fontCss?: string; scale?: number },
): Promise<Blob> {
  const width = Math.max(320, Math.round(opts.width));
  const scale = opts.scale ?? 2;
  // foreignObject 是隔离的渲染上下文:全部样式(基础 + 内联字体)必须随 SVG 一起嵌入
  const fullCss = buildExportCss(info.theme, info.fontSize, info.fontFamily) + (opts.fontCss ?? '');
  const rootHtml = buildExportRoot(bodyXml, info, fullCss);

  const height = await measureContentHeight(rootHtml, width, info.theme);
  if (!(height > 0)) {
    throw new Error('长图导出失败:无法测量内容高度');
  }

  const svg = buildForeignObjectSvg(rootHtml, width, height, info.theme);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('长图导出失败:SVG 载入异常'));
    img.src = url;
  });

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('长图导出失败:无法创建画布');
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
  if (!blob) {
    throw new Error('长图导出失败:画布导出为空');
  }
  return blob;
}

export async function exportLongImage(
  source: HTMLElement,
  info: ExportDocInfo,
  imageWidth = 860,
): Promise<void> {
  const { bodyXml, fontCss } = await prepareExportBody(source, info, { imageFail: 'placeholder' });
  const blob = await htmlToPngBlob(bodyXml, info, { width: imageWidth, fontCss });
  downloadBlob(exportFileName(info.title, 'png'), blob);
}
