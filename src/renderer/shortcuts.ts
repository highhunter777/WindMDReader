/**
 * 快捷键绑定系统(T3.4)。
 *
 * 设计:
 * - 每个动作一个 id,默认绑定在此登记;用户改键存 localStorage(`windmd-keys`),
 *   加载时与默认合并 —— 新增动作自动获得默认绑定,旧配置不失效。
 * - 组合串规范:`ctrl+shift+f` / `j` / `[`;序列绑定(两次按键)用空格分隔:`g g`。
 * - 规范化由 `comboOf` 统一产出:修饰键按 ctrl → alt → shift 排序,主键小写。
 *   `G`(需 Shift 输入)规范为 `shift+g`,与「按下 Shift+G」的直觉一致。
 * - 匹配时含修饰键的绑定全局生效(与旧版 Ctrl+F 行为一致);
 *   纯键绑定只在非输入态生效(避免与键入抢键)。
 */

export type ShortcutAction =
  | 'open-vault'
  | 'find'
  | 'global-search'
  | 'toggle-sidebar'
  | 'toggle-toc'
  | 'toggle-theme'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'export-menu'
  | 'open-settings'
  | 'scroll-down'
  | 'scroll-up'
  | 'scroll-top'
  | 'scroll-bottom'
  | 'prev-heading'
  | 'next-heading'
  | 'zen'
  | 'focus-line'
  | 'typewriter'
  | 'speak';

export interface ActionMeta {
  /** 设置页中的显示名 */
  name: string;
  /** 分组(设置页分节) */
  group: '文件与面板' | '阅读导航' | '阅读模式' | '排版与导出';
  hint?: string;
}

export const DEFAULT_BINDINGS: Record<ShortcutAction, string> = {
  'open-vault': 'ctrl+o',
  find: 'ctrl+f',
  'global-search': 'ctrl+shift+f',
  'toggle-sidebar': 'ctrl+b',
  'toggle-toc': 'ctrl+shift+b',
  'toggle-theme': 'ctrl+e',
  'zoom-in': 'ctrl+=',
  'zoom-out': 'ctrl+-',
  'zoom-reset': 'ctrl+0',
  'export-menu': 'ctrl+p',
  'open-settings': 'ctrl+,',
  'scroll-down': 'j',
  'scroll-up': 'k',
  'scroll-top': 'g g',
  'scroll-bottom': 'shift+g',
  'prev-heading': '[',
  'next-heading': ']',
  zen: 'z z',
  'focus-line': 'f',
  typewriter: 't',
  speak: 's',
};

export const ACTION_META: Record<ShortcutAction, ActionMeta> = {
  'open-vault': { name: '打开库', group: '文件与面板', hint: '选择目录作为知识库' },
  find: { name: '文档内查找', group: '文件与面板' },
  'global-search': { name: '全库搜索', group: '文件与面板' },
  'toggle-sidebar': { name: '侧栏(文件树)', group: '文件与面板' },
  'toggle-toc': { name: '右侧面板(大纲/双链/标签)', group: '文件与面板' },
  'open-settings': { name: '设置', group: '文件与面板', hint: '改键 / 在线翻译' },
  'scroll-down': { name: '向下滚动', group: '阅读导航' },
  'scroll-up': { name: '向上滚动', group: '阅读导航' },
  'scroll-top': { name: '回到顶部', group: '阅读导航' },
  'scroll-bottom': { name: '回到底部', group: '阅读导航' },
  'prev-heading': { name: '上一标题', group: '阅读导航' },
  'next-heading': { name: '下一标题', group: '阅读导航' },
  zen: { name: '专注模式', group: '阅读模式', hint: '隐藏全部 UI, Esc 退出' },
  'focus-line': { name: '焦点行', group: '阅读模式', hint: '淡出非当前段落' },
  typewriter: { name: '打字机', group: '阅读模式', hint: '当前段对齐视口锚点行' },
  speak: { name: '朗读', group: '阅读模式' },
  'toggle-theme': { name: '切换主题', group: '排版与导出' },
  'zoom-in': { name: '放大字号', group: '排版与导出' },
  'zoom-out': { name: '缩小字号', group: '排版与导出' },
  'zoom-reset': { name: '重置字号', group: '排版与导出' },
  'export-menu': { name: '导出菜单', group: '排版与导出', hint: 'HTML / PDF / 长图' },
};

/** 设置页展示顺序 */
export const ACTION_ORDER: ShortcutAction[] = [
  'open-vault',
  'find',
  'global-search',
  'toggle-sidebar',
  'toggle-toc',
  'open-settings',
  'scroll-down',
  'scroll-up',
  'scroll-top',
  'scroll-bottom',
  'prev-heading',
  'next-heading',
  'zen',
  'focus-line',
  'typewriter',
  'speak',
  'toggle-theme',
  'zoom-in',
  'zoom-out',
  'zoom-reset',
  'export-menu',
];

/** 键盘事件 → 规范组合串;无法表示(如纯修饰键)返回 null */
export function comboOf(e: KeyboardEvent): string | null {
  if (e.key === 'Escape') return 'escape';
  if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  if (!key) return null;
  parts.push(key);
  return parts.join('+');
}

/** 组合串 → 人类可读形式(设置页展示) */
export function formatCombo(combo: string): string {
  return combo
    .split(' ')
    .map((part) =>
      part
        .split('+')
        .map((k) => {
          if (k === 'ctrl') return 'Ctrl';
          if (k === 'alt') return 'Alt';
          if (k === 'shift') return 'Shift';
          if (k === 'escape') return 'Esc';
          if (k.length === 1) return k.toUpperCase();
          return k;
        })
        .join(' + '),
    )
    .join(' 然后 ');
}

/** 绑定是否含修饰键(决定是否在输入态也生效) */
export function hasModifier(combo: string): boolean {
  return /(^|\s)(ctrl|alt|shift)(\+|\s)/.test(combo + ' ');
}

/** 反查:组合串(含序列)对应哪个动作;无则 null */
export function actionForCombo(
  bindings: Record<ShortcutAction, string>,
  combo: string,
): ShortcutAction | null {
  for (const a of ACTION_ORDER) {
    if (bindings[a] === combo) return a;
  }
  return null;
}

/** 某组合串是否已被占用(排除自身) */
export function comboOwner(
  bindings: Record<ShortcutAction, string>,
  combo: string,
  except?: ShortcutAction,
): ShortcutAction | null {
  for (const a of ACTION_ORDER) {
    if (a === except) continue;
    if (bindings[a] === combo) return a;
  }
  return null;
}

/** 序列匹配的宽限窗口(毫秒) */
export const SEQUENCE_WINDOW_MS = 600;
