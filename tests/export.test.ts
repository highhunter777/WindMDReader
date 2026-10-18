/**
 * 导出测试:HTML / PDF(打印流)/ 长图。
 *
 * 重点覆盖:
 * - 纯函数(文件名清洗、文档组装、SVG 包装)的行为边界
 * - 离线化(图片 data URL、字体 url 重写)与失败降级
 * - prepareExportBody 的克隆隔离性(增强/清理只发生在克隆上)
 * - print / download 的副作用入口(新窗口、a.click)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildExportCss,
  buildExportHtml,
  buildExportRoot,
  buildForeignObjectSvg,
  collectInlineFontCss,
  defaultFetchAsDataUrl,
  downloadBlob,
  exportFileName,
  formatExportDate,
  inlineImages,
  prepareExportBody,
  printExportHtml,
  rewriteCssUrls,
  sanitizeFileName,
  stripFindMarks,
  type ExportDocInfo,
} from '../src/renderer/export';

const info: ExportDocInfo = {
  title: '测试文档',
  sourcePath: '笔记/测试文档.md',
  theme: 'light',
  fontSize: 17,
  fontFamily: 'sans',
};

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ---------------- 文件名 / 日期 ---------------- */

describe('sanitizeFileName / exportFileName', () => {
  it('剔除 Windows 非法字符', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
  });

  it('剔除控制字符', () => {
    expect(sanitizeFileName('a\u0000b\u001fc')).toBe('a b c');
  });

  it('折叠连续空白并去掉首尾空白', () => {
    expect(sanitizeFileName('  多个   空格  ')).toBe('多个 空格');
  });

  it('连字符是合法字符,保留', () => {
    expect(sanitizeFileName('2026-10-16 笔记')).toBe('2026-10-16 笔记');
  });

  it('结尾的点和空格不接受(Windows 限制)', () => {
    expect(sanitizeFileName('标题. ')).toBe('标题');
  });

  it('空标题回退为「未命名文档」', () => {
    expect(exportFileName('   ', 'html')).toBe('未命名文档.html');
    expect(exportFileName('', 'png')).toBe('未命名文档.png');
  });

  it('ext 支持带点与不带点两种写法', () => {
    expect(exportFileName('文档', '.html')).toBe('文档.html');
    expect(exportFileName('文档', 'html')).toBe('文档.html');
  });
});

describe('formatExportDate', () => {
  it('按本地时间格式化为 YYYY-MM-DD', () => {
    const ts = new Date(2026, 9, 16, 23, 30).getTime();
    expect(formatExportDate(ts)).toBe('2026-10-16');
  });

  it('月日补零', () => {
    const ts = new Date(2026, 0, 5, 0, 0).getTime();
    expect(formatExportDate(ts)).toBe('2026-01-05');
  });
});

/* ---------------- 样式与文档组装 ---------------- */

describe('buildExportCss', () => {
  it('浅色主题使用浅色 token', () => {
    const css = buildExportCss('light', 17, 'sans');
    expect(css).toContain('--bg:#ffffff');
    expect(css).toContain('--fg:#1f2328');
  });

  it('深色主题使用深色 token', () => {
    const css = buildExportCss('dark', 17, 'sans');
    expect(css).toContain('--bg:#16181d');
    expect(css).toContain('--fg:#d8dce2');
  });

  it('token 挂在 .export-root 上(foreignObject 内没有 :root)', () => {
    const css = buildExportCss('light', 17, 'sans');
    expect(css).toContain('.export-root {');
    expect(css).not.toContain(':root');
  });

  it('衬线/等宽字体栈按字体族切换', () => {
    expect(buildExportCss('light', 17, 'serif')).toContain('Songti SC');
    expect(buildExportCss('light', 17, 'sans')).toContain('PingFang SC');
    expect(buildExportCss('light', 17, 'sans')).toContain('JetBrains Mono');
  });

  it('包含打印规则(分页避让)', () => {
    const css = buildExportCss('light', 17, 'sans');
    expect(css).toContain('@page');
    expect(css).toContain('break-inside: avoid');
  });

  it('复制按钮在导出物中隐藏', () => {
    expect(buildExportCss('light', 17, 'sans')).toContain('.code-copy { display: none; }');
  });
});

describe('buildExportRoot / buildExportHtml', () => {
  it('页脚含日期与来源路径', () => {
    const root = buildExportRoot('<p>正文</p>', info);
    expect(root).toContain('由 WindMD 导出');
    expect(root).toContain('笔记/测试文档.md');
    expect(root).toContain('<p>正文</p>');
  });

  it('字体 CSS 以 style 标签内联', () => {
    const root = buildExportRoot('<p>x</p>', info, '@font-face{font-family:KaTeX}');
    expect(root).toContain('<style>@font-face{font-family:KaTeX}</style>');
  });

  it('HTML 文档结构完整', () => {
    const html = buildExportHtml('<p>正文</p>', info);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<body class="export-root" data-theme="light"');
    expect(html).toContain('<p>正文</p>');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('标题做 HTML 转义,不注入脚本', () => {
    const html = buildExportHtml('<p>x</p>', { ...info, title: '<script>alert(1)</script>' });
    expect(html).toContain('<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>');
    expect(html).not.toContain('<script>alert');
  });

  it('深色主题写入 data-theme', () => {
    expect(buildExportHtml('<p>x</p>', { ...info, theme: 'dark' })).toContain('data-theme="dark"');
  });

  it('正文字号按 info 设置', () => {
    expect(buildExportHtml('<p>x</p>', { ...info, fontSize: 20 })).toContain('font-size:20px');
  });
});

describe('buildForeignObjectSvg', () => {
  it('SVG 根与 XHTML 命名空间齐全', () => {
    const svg = buildForeignObjectSvg('<p>x</p>', 860, 1200, 'dark');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('xmlns="http://www.w3.org/1999/xhtml"');
    expect(svg).toContain('width="860" height="1200" viewBox="0 0 860 1200"');
    expect(svg).toContain('data-theme="dark"');
    expect(svg).toContain('<p>x</p>');
  });
});

/* ---------------- 离线化 ---------------- */

describe('rewriteCssUrls', () => {
  it('重写可解析的 url()', async () => {
    const out = await rewriteCssUrls('src:url(fonts/a.woff2)', async () => 'data:font/woff2;base64,AAA');
    expect(out).toBe('src:url("data:font/woff2;base64,AAA")');
  });

  it('多个 url 全部重写', async () => {
    const out = await rewriteCssUrls(
      'src:url(a.woff2) format("woff2"), url(b.woff)',
      async (u) => `data:${u}`,
    );
    expect(out).toBe('src:url("data:a.woff2") format("woff2"), url("data:b.woff")');
  });

  it('解析失败保留原值', async () => {
    const css = 'src:url(a.woff2)';
    expect(await rewriteCssUrls(css, async () => null)).toBe(css);
  });

  it('data: 引用不处理', async () => {
    const css = 'src:url(data:font/woff2;base64,AAA)';
    expect(await rewriteCssUrls(css, async () => 'data:other')).toBe(css);
  });

  it('带引号的 url 也认', async () => {
    const out = await rewriteCssUrls("src:url('a.woff2')", async () => 'data:x');
    expect(out).toBe('src:url("data:x")');
  });
});

describe('defaultFetchAsDataUrl', () => {
  it('fetch 成功时返回 data URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x']) })),
    );
    const reader = vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (
      this: FileReader,
    ) {
      Object.defineProperty(this, 'result', {
        value: 'data:application/octet-stream;base64,eA==',
        configurable: true,
      });
      this.onload?.(new ProgressEvent('load') as unknown as ProgressEvent<FileReader>);
    });
    await expect(defaultFetchAsDataUrl('https://x/a.png')).resolves.toBe(
      'data:application/octet-stream;base64,eA==',
    );
    expect(reader).toHaveBeenCalled();
  });

  it('fetch 失败返回 null(不抛出)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    await expect(defaultFetchAsDataUrl('https://x/a.png')).resolves.toBeNull();
  });

  it('fetch 抛错返回 null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    await expect(defaultFetchAsDataUrl('https://x/a.png')).resolves.toBeNull();
  });
});

describe('collectInlineFontCss', () => {
  const fakeFontRule = (src: string) => ({
    type: 5, // CSSRule.FONT_FACE_RULE
    style: {
      getPropertyValue: (p: string) =>
        p === 'src' ? src : p === 'font-family' ? 'KaTeX_Main' : '',
    },
  });

  it('字体 url 按样式表地址解析,而非文档地址', async () => {
    const seen: string[] = [];
    const fakeSheet = {
      href: 'https://cdn.example.com/assets/katex.css',
      cssRules: [fakeFontRule('url(fonts/a.woff2)')],
    };
    vi.spyOn(document, 'styleSheets', 'get').mockReturnValue([fakeSheet] as unknown as StyleSheetList);
    const css = await collectInlineFontCss(async (src) => {
      seen.push(src);
      return `data:${src}`;
    });
    expect(seen).toEqual(['https://cdn.example.com/assets/fonts/a.woff2']);
    expect(css).toContain('src:url("data:https://cdn.example.com/assets/fonts/a.woff2")');
    expect(css).toContain('font-family:KaTeX_Main');
    expect(css).toContain('font-display:swap');
  });

  it('内联 <style>(无 href)按文档地址解析', async () => {
    const seen: string[] = [];
    const fakeSheet = { href: '', cssRules: [fakeFontRule('url(fonts/b.woff2)')] };
    vi.spyOn(document, 'styleSheets', 'get').mockReturnValue([fakeSheet] as unknown as StyleSheetList);
    await collectInlineFontCss(async (src) => {
      seen.push(src);
      return null;
    });
    expect(seen[0]).toBe(new URL('fonts/b.woff2', document.baseURI).href);
  });

  it('跨域样式表读不到规则时静默跳过', async () => {
    const fakeSheet = {
      href: 'https://cross.example/x.css',
      get cssRules(): CSSRuleList {
        throw new Error('SecurityError');
      },
    };
    vi.spyOn(document, 'styleSheets', 'get').mockReturnValue([fakeSheet] as unknown as StyleSheetList);
    await expect(collectInlineFontCss(async () => 'data:x')).resolves.toBe('');
  });

  it('字体获取失败时保留原始 url', async () => {
    const fakeSheet = { href: 'https://cdn.example.com/a.css', cssRules: [fakeFontRule('url(fonts/a.woff2)')] };
    vi.spyOn(document, 'styleSheets', 'get').mockReturnValue([fakeSheet] as unknown as StyleSheetList);
    const css = await collectInlineFontCss(async () => null);
    expect(css).toContain('url(fonts/a.woff2)');
  });

  it('非字体规则被忽略', async () => {
    const styleRule = { type: 1, style: { getPropertyValue: () => '' } };
    const fakeSheet = { href: 'https://cdn.example.com/a.css', cssRules: [styleRule, fakeFontRule('url(a.woff2)')] };
    vi.spyOn(document, 'styleSheets', 'get').mockReturnValue([fakeSheet] as unknown as StyleSheetList);
    const css = await collectInlineFontCss(async (src) => `data:${src}`);
    expect((css.match(/@font-face/g) || []).length).toBe(1);
  });
});

describe('stripFindMarks', () => {
  it('剥掉查找高亮但保留文本与结构', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<p>a <mark class="find-hit">hit</mark> b</p><p><mark class="find-hit find-current">x</mark></p>';
    const n = stripFindMarks(root);
    expect(n).toBe(2);
    expect(root.querySelector('mark')).toBeNull();
    expect(root.textContent).toBe('a hit bx');
  });

  it('没有命中时返回 0', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>plain</p>';
    expect(stripFindMarks(root)).toBe(0);
  });
});

describe('inlineImages', () => {
  const makeRoot = () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<img src="https://x/a.png" alt="A">' +
      '<img src="data:image/png;base64,AAA" alt="B">' +
      '<img src="https://x/b.png" alt="C">';
    return root;
  };

  it('data URL 跳过,其余替换为 data URL', async () => {
    const root = makeRoot();
    const r = await inlineImages(root, {
      fetchAsDataUrl: async (src) => `data:${src}`,
    });
    expect(r).toEqual({ total: 3, inlined: 2, failed: 0 });
    const imgs = root.querySelectorAll('img');
    expect(imgs[0].getAttribute('src')).toBe('data:https://x/a.png');
    expect(imgs[1].getAttribute('src')).toBe('data:image/png;base64,AAA'); // 原样保留
  });

  it('失败默认保留原 src(HTML 导出仍可展示远程图)', async () => {
    const root = makeRoot();
    await inlineImages(root, { fetchAsDataUrl: async () => null });
    expect(root.querySelectorAll('img')).toHaveLength(3);
    expect(root.querySelector('img')?.getAttribute('src')).toBe('https://x/a.png');
  });

  it('失败且 onFail=placeholder 时替换为占位块(长图防画布污染)', async () => {
    const root = makeRoot();
    const r = await inlineImages(root, {
      fetchAsDataUrl: async (src) => (src.includes('a.png') ? null : 'data:ok'),
      onFail: 'placeholder',
    });
    expect(r.failed).toBe(1);
    expect(r.inlined).toBe(1);
    const box = root.querySelector('.img-error');
    expect(box).not.toBeNull();
    expect(box?.textContent).toBe('A');
  });

  it('占位块无 alt 时给出说明文字', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<img src="https://x/a.png">';
    await inlineImages(root, { fetchAsDataUrl: async () => null, onFail: 'placeholder' });
    expect(root.querySelector('.img-error')?.textContent).toContain('图片未能内联');
  });
});

/* ---------------- 导出内容准备 ---------------- */

describe('prepareExportBody', () => {
  const makeSource = () => {
    const article = document.createElement('article');
    article.className = 'prose';
    article.innerHTML =
      '<h1>标题</h1>' +
      '<p>前<mark class="find-hit">命中</mark>后</p>' +
      '<pre class="code-block" data-lang="ts"><code>const a = 1;</code></pre>' +
      '<button class="code-copy">复制</button>' +
      '<img src="https://x/a.png" alt="图">';
    document.body.appendChild(article);
    return article;
  };

  it('增强只发生在克隆上,原界面不被修改', async () => {
    const source = makeSource();
    const enhance = vi.fn(async (c: HTMLElement) => {
      expect(c).not.toBe(source);
      c.querySelector('.code-block')?.classList.add('code-highlighted');
    });
    const { bodyXml } = await prepareExportBody(source, info, {
      enhance,
      fetchAsDataUrl: async () => 'data:ok',
    });
    expect(enhance).toHaveBeenCalledTimes(1);
    // 原 DOM 保持原样
    expect(source.querySelector('.code-copy')).not.toBeNull();
    expect(source.querySelector('mark.find-hit')).not.toBeNull();
    expect(source.querySelector('.code-highlighted')).toBeNull();
    // 导出物:已增强、无查找高亮、无复制按钮
    expect(bodyXml).toContain('code-highlighted');
    expect(bodyXml).not.toContain('find-hit');
    expect(bodyXml).not.toContain('code-copy');
  });

  it('增强补的复制按钮会被清掉', async () => {
    const source = makeSource();
    const { bodyXml } = await prepareExportBody(source, info, {
      enhance: async (c) => {
        const btn = document.createElement('button');
        btn.className = 'code-copy';
        c.querySelector('.code-block')?.appendChild(btn);
      },
      fetchAsDataUrl: async () => 'data:ok',
    });
    expect(bodyXml).not.toContain('code-copy');
  });

  it('图片内联为 data URL', async () => {
    const source = makeSource();
    const { bodyXml } = await prepareExportBody(source, info, {
      enhance: async () => {},
      fetchAsDataUrl: async () => 'data:image/png;base64,QUJD',
    });
    expect(bodyXml).toContain('src="data:image/png;base64,QUJD"');
  });

  it('默认分支(enhanceAll)下代码块内容完好', async () => {
    // 不注入 enhance:走默认分支(enhanceAll → shiki/katex 动态 import)。
    // jsdom 无布局,enhanceAll 对离屏克隆依然安全(失败块保留原文);
    // shiki 在 vitest 里能真正跑起来,代码文本会被拆进高亮 span。
    const source = makeSource();
    const { bodyXml } = await prepareExportBody(source, info, {
      fetchAsDataUrl: async () => null,
    });
    // 无论高亮成功还是回退原文,代码内容都必须完整保留
    expect(bodyXml).toContain('const');
    expect(bodyXml).toContain('code-block');
    expect(bodyXml).not.toContain('code-copy');
  });

  it('输出是 XML 序列化(img 自闭合)', async () => {
    const source = makeSource();
    const { bodyXml } = await prepareExportBody(source, info, {
      enhance: async () => {},
      fetchAsDataUrl: async () => 'data:ok',
    });
    expect(bodyXml).toContain('/>');
  });
});

/* ---------------- 副作用入口 ---------------- */

describe('printExportHtml', () => {
  it('写入新窗口并调起打印', () => {
    const docListeners: Record<string, () => void> = {};
    const winListeners: Record<string, () => void> = {};
    const fake = {
      document: {
        readyState: 'loading',
        open: vi.fn(),
        write: vi.fn(),
        close: vi.fn(),
        addEventListener: (ev: string, cb: () => void) => {
          docListeners[ev] = cb;
        },
      },
      addEventListener: (ev: string, cb: () => void) => {
        winListeners[ev] = cb;
      },
      focus: vi.fn(),
      print: vi.fn(),
    };
    vi.spyOn(window, 'open').mockReturnValue(fake as unknown as Window);

    printExportHtml('<html>doc</html>');
    expect(fake.document.open).toHaveBeenCalled();
    expect(fake.document.write).toHaveBeenCalledWith('<html>doc</html>');
    expect(fake.document.close).toHaveBeenCalled();
    expect(fake.print).not.toHaveBeenCalled(); // 等 load 事件

    winListeners.load();
    expect(fake.focus).toHaveBeenCalled();
    expect(fake.print).toHaveBeenCalledTimes(1);
  });

  it('readyState 已完成时直接打印', () => {
    const fake = {
      document: {
        readyState: 'complete',
        open: vi.fn(),
        write: vi.fn(),
        close: vi.fn(),
        addEventListener: vi.fn(),
      },
      focus: vi.fn(),
      print: vi.fn(),
    };
    vi.spyOn(window, 'open').mockReturnValue(fake as unknown as Window);
    printExportHtml('<html>doc</html>');
    expect(fake.print).toHaveBeenCalledTimes(1);
  });

  it('新窗口被拦截时回退到离屏 iframe 打印(WebView2 实测行为)', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(() => printExportHtml('<html><body><p>打印内容</p></body></html>')).not.toThrow();
    const iframe = document.querySelector('iframe');
    expect(iframe).not.toBeNull();
    // 离屏摆放:不干扰界面,同时保持渲染(visibility:hidden 会影响打印输出)
    expect(iframe!.style.position).toBe('fixed');
    expect(iframe!.style.left).toBe('-10000px');
    expect(iframe!.getAttribute('aria-hidden')).toBe('true');
    expect(iframe!.contentDocument?.body.innerHTML).toContain('打印内容');
    iframe!.remove();
  });
});

describe('downloadBlob', () => {
  it('以指定文件名触发下载并回收 URL', async () => {
    vi.useFakeTimers();
    // jsdom 未实现 URL.createObjectURL,直接挂桩
    const create = vi.fn().mockReturnValue('blob:fake');
    const revoke = vi.fn();
    const urlObj = URL as unknown as {
      createObjectURL?: typeof create;
      revokeObjectURL?: typeof revoke;
    };
    urlObj.createObjectURL = create;
    urlObj.revokeObjectURL = revoke;
    try {
      let clicked: HTMLAnchorElement | null = null;
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        clicked = this;
      });

      downloadBlob('文档.html', new Blob(['x'], { type: 'text/html' }));
      expect(create).toHaveBeenCalledTimes(1);
      expect(clicked).not.toBeNull();
      expect(clicked!.getAttribute('download')).toBe('文档.html');
      expect(clicked!.getAttribute('href')).toBe('blob:fake');

      expect(revoke).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(revoke).toHaveBeenCalledWith('blob:fake');
      // 下载锚点已从文档移除
      expect(document.querySelector('a[download]')).toBeNull();
    } finally {
      delete urlObj.createObjectURL;
      delete urlObj.revokeObjectURL;
      vi.useRealTimers();
    }
  });
});
