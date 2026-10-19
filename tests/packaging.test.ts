/**
 * 打包配置冒烟测试(M4 验收项)。
 *
 * 图标/安装器配置的破坏往往是「静默」的:改错一个字段要到打包才炸,
 * 而打包要几分钟。这里把关键不变量钉住,跑普通测试就能发现。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const cargo = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8');

describe('打包配置(tauri.conf.json)', () => {
  it('bundle 启用且覆盖三大桌面平台安装器', () => {
    expect(conf.bundle.active).toBe(true);
    expect(conf.bundle.targets).toContain('nsis'); // Windows
    expect(conf.bundle.targets).toContain('msi'); // Windows(企业静默部署)
    expect(conf.bundle.targets).toContain('dmg'); // macOS
    expect(conf.bundle.targets).toContain('deb'); // Linux
  });

  it('引用的图标文件都在', () => {
    for (const icon of conf.bundle.icon) {
      expect(existsSync(join(root, 'src-tauri', icon)), `缺失 ${icon}`).toBe(true);
    }
    // ico 是 Windows 安装器与任务栏图标的实际来源
    const ico = readFileSync(join(root, 'src-tauri/icons/icon.ico'));
    expect(ico.length).toBeGreaterThan(1000);
    expect(ico.readUInt16LE(0)).toBe(0); // ICO 保留字段
    expect(ico.readUInt16LE(2)).toBe(1); // 类型 1 = 图标
  });

  it('注册 Markdown 文件关联(安装后可选为默认打开方式)', () => {
    const assoc = (conf.bundle.fileAssociations ?? []) as Array<{
      ext?: string[];
      mimeType?: string;
      role?: string;
    }>;
    const exts = assoc.flatMap((a) => a.ext ?? []);
    for (const ext of ['md', 'markdown', 'mdown']) {
      expect(exts, `缺少 .${ext} 关联`).toContain(ext);
    }
    const markdown = assoc.find((a) => a.ext?.includes('md'));
    expect(markdown?.mimeType).toBe('text/markdown');
    expect(markdown?.role).toBe('Viewer');
  });

  it('依赖单实例插件:第二个进程把文件路径转交给已开窗口', () => {
    expect(cargo).toContain('tauri-plugin-single-instance');
  });

  it('NSis 当前用户安装(免管理员),安装界面带中英文', () => {
    expect(conf.bundle.windows?.nsis?.installMode).toBe('currentUser');
    expect(conf.bundle.windows?.nsis?.languages).toContain('SimpChinese');
    expect(conf.bundle.windows?.nsis?.languages).toContain('English');
  });

  it('WebView2 缺失时由引导程序代装', () => {
    expect(conf.bundle.windows?.webviewInstallMode?.type).toBe('downloadBootstrapper');
  });

  it('版本号:Cargo.toml 与 tauri.conf.json 一致', () => {
    const m = cargo.match(/^version = "(.+)"/m);
    expect(m?.[1]).toBeTruthy();
    expect(m?.[1]).toBe(conf.version);
  });

  it('应用标识与产品名就绪', () => {
    expect(conf.identifier).toMatch(/^[a-zA-Z][\w.]*$/);
    expect(conf.productName).toBe('WindMD');
  });
});
