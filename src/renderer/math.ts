/**
 * KaTeX 数学公式渲染封装。
 * katex 体积较大且只在视口内渲染,故用动态 import,避免进入首屏包。
 */

type KatexModule = typeof import('katex');

let katexPromise: Promise<KatexModule> | null = null;

function loadKatex(): Promise<KatexModule> {
  katexPromise ??= import('katex').then(async (mod) => {
    // KaTeX 的排版完全由其样式表承担(分数线/大型运算符/字体度量),
    // 缺了它公式会退化成无布局的纯文本,导出也会丢失公式样式。
    // 样式表随组件一起按需加载,不进首屏包。
    await import('katex/dist/katex.min.css');
    return mod;
  });
  return katexPromise;
}

/** 空闲时预取 katex,避免首次滚动到公式时等待 */
export function preloadMath(): void {
  void loadKatex();
}

/**
 * 渲染 TeX 为 HTML。
 * katex 加载失败时返回 null,由调用方回退为原始 TeX 文本。
 */
export async function renderMath(tex: string, displayMode: boolean): Promise<string | null> {
  try {
    const { default: katex } = await loadKatex();
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      strict: false,
      output: 'html',
    });
  } catch {
    return null;
  }
}