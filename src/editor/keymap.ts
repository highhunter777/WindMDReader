/**
 * 编辑器按键与格式化命令(纯函数,不碰 DOM)。
 *
 * 设计:
 * - 所有命令吃「当前源码 + 选区」,返回「新源码 + 新选区」,便于单测与撤销栈接入;
 * - 加粗 / 斜体 / 行内代码是**切换**语义:已包着就脱掉,再按一次回来;
 * - 列表 / 引用 / 标题是**行级前缀**语义:选中多行时整块处理,且同样可切换;
 * - Enter 续写列表/引用由 `continueList` 负责,空项再回车则退出该结构。
 *
 * 为什么要自己实现:``textarea`` 没有富文本能力,而引入完整编辑器
 * (CodeMirror/Monaco)会把首屏与依赖体积顶穿红线;这一层只覆盖
 * 「写 Markdown 最常打断思路的那几个动作」。
 */

/** 编辑器的一次编辑状态:源码 + 选区(selectionStart/End 为字符偏移) */
export interface EditState {
  value: string;
  start: number;
  end: number;
}

export interface EditResult {
  value: string;
  start: number;
  end: number;
}

/** 选区归一化:允许传反选的 start/end */
function norm(s: EditState): EditState {
  return s.start <= s.end ? s : { value: s.value, start: s.end, end: s.start };
}

export function lineStartOf(value: string, pos: number): number {
  return value.lastIndexOf('\n', Math.max(0, pos - 1)) + 1;
}

export function lineEndOf(value: string, pos: number): number {
  const i = value.indexOf('\n', pos);
  return i === -1 ? value.length : i;
}

/** 选区覆盖的完整行范围(含首尾行的边界) */
export function selectedLineRange(value: string, start: number, end: number): { from: number; to: number } {
  return { from: lineStartOf(value, start), to: lineEndOf(value, end) };
}

/* ================================================================
 * 包裹类:加粗 / 斜体 / 删除线 / 行内代码
 * ================================================================ */

/**
 * 切换包裹标记。
 *
 * 判定顺序(命中即返回):
 * ① 选区外侧紧邻标记 → 去掉外侧这层;
 * ② 选区自身以标记开头结尾 → 去掉内侧这层;
 * ③ 否则加上标记。
 *
 * 空选区时:光标两侧若能拼出标记(如 `**|**`)则脱掉,否则插入 `****`
 * 并把光标放到中间,用户直接打字就是加粗内容。
 */
export function toggleWrap(state: EditState, left: string, right = left): EditResult {
  const s = norm(state);
  const { value } = s;
  const sel = value.slice(s.start, s.end);
  const before = value.slice(Math.max(0, s.start - left.length), s.start);
  const after = value.slice(s.end, s.end + right.length);

  // ① 外侧标记
  if (before === left && after === right) {
    return {
      value: value.slice(0, s.start - left.length) + sel + value.slice(s.end + right.length),
      start: s.start - left.length,
      end: s.end - left.length,
    };
  }

  // ② 内侧标记
  if (sel.length >= left.length + right.length && sel.startsWith(left) && sel.endsWith(right)) {
    const inner = sel.slice(left.length, sel.length - right.length);
    return {
      value: value.slice(0, s.start) + inner + value.slice(s.end),
      start: s.start,
      end: s.start + inner.length,
    };
  }

  // ③ 加上标记
  return {
    value: value.slice(0, s.start) + left + sel + right + value.slice(s.end),
    start: s.start + left.length,
    end: s.end + left.length,
  };
}

/** 插入链接:有选区则作为文字,无选区则留空并选中文字位 */
export function insertLink(state: EditState, url = ''): EditResult {
  const s = norm(state);
  const text = s.value.slice(s.start, s.end);
  const middle = `[${text}](${url})`;
  return {
    value: s.value.slice(0, s.start) + middle + s.value.slice(s.end),
    // 无 URL 时把光标停在括号内,方便直接粘贴地址
    start: url ? s.start + middle.length : s.start + text.length + 3,
    end: url ? s.start + middle.length : s.start + text.length + 3,
  };
}

/* ================================================================
 * 行级前缀:标题 / 列表 / 引用
 * ================================================================ */

/** 行级前缀的判定与生成 */
export interface LinePrefix {
  /** 该行是否已带此前缀 */
  test(line: string): boolean;
  /** 给该行加上前缀 */
  add(line: string): string;
  /** 去掉该行的前缀 */
  remove(line: string): string;
}

/** 标题:`#`~`######`;层级相同则取消,不同则替换 */
export function headingPrefix(level: number): LinePrefix {
  const marks = '#'.repeat(Math.min(6, Math.max(1, level)));
  return {
    test: (line) => new RegExp(`^ {0,3}${marks} `).test(line),
    add: (line) => `${marks} ${line.replace(/^ {0,3}#{1,6} /, '')}`,
    remove: (line) => line.replace(/^ {0,3}#{1,6} /, ''),
  };
}

/** 无序列表:`- `;`*`/`+` 也视为已带,便于切换 */
export function bulletPrefix(char = '-'): LinePrefix {
  return {
    test: (line) => /^\s*[-*+] /.test(line),
    add: (line) => `${char} ${line.replace(/^\s*[-*+]\s+/, '')}`,
    remove: (line) => line.replace(/^\s*[-*+]\s+/, ''),
  };
}

/** 有序列表:`1. `;编号在 add 时按序号重排 */
export function orderedPrefix(start = 1): LinePrefix {
  let n = start;
  return {
    test: (line) => /^\s*\d+[.)] /.test(line),
    add: (line) => `${n++}. ${line.replace(/^\s*\d+[.)]\s+/, '')}`,
    remove: (line) => line.replace(/^\s*\d+[.)]\s+/, ''),
  };
}

/** 引用:`> ` */
export function quotePrefix(): LinePrefix {
  return {
    test: (line) => /^\s*> /.test(line),
    add: (line) => `> ${line.replace(/^\s*>\s?/, '')}`,
    remove: (line) => line.replace(/^\s*>\s?/, ''),
  };
}

/**
 * 切换行级前缀(整块)。
 * 选中行**全部**已带前缀 → 全部去掉;否则全部加上。
 * 返回的选区覆盖整块(便于连按多次仍作用在同一批行上)。
 */
export function toggleLinePrefix(state: EditState, prefix: LinePrefix): EditResult {
  const s = norm(state);
  const { from, to } = selectedLineRange(s.value, s.start, s.end);
  const block = s.value.slice(from, to);
  const lines = block.split('\n');
  const allMarked = lines.every((l) => l === '' || prefix.test(l));
  const next = lines
    .map((l) => (l === '' ? l : allMarked ? prefix.remove(l) : prefix.add(l)))
    .join('\n');
  return {
    value: s.value.slice(0, from) + next + s.value.slice(to),
    start: from,
    end: from + next.length,
  };
}

/* ================================================================
 * 缩进 / 反缩进
 * ================================================================ */

export const INDENT_UNIT = '  ';

/** 换行常量:避免在模板/字符串里出现真实换行,便于阅读与断言 */
const NL = String.fromCharCode(10);

/** 多行缩进(Tab)与反缩进(Shift+Tab);空行不处理,避免尾随空格 */
export function indent(state: EditState, dir: 1 | -1): EditResult {
  const s = norm(state);
  const { from, to } = selectedLineRange(s.value, s.start, s.end);
  const lines = s.value.slice(from, to).split(NL);
  /** 首行被增删的字符数:光标的平移量 */
  let firstDelta = 0;
  const next = lines.map((l, i) => {
    if (l === '') return l;
    if (dir === 1) {
      if (i === 0) firstDelta = INDENT_UNIT.length;
      return INDENT_UNIT + l;
    }
    const stripped = l.replace(/^(	| {1,2})/, '');
    if (i === 0) firstDelta = stripped.length - l.length;
    return stripped;
  });
  const block = next.join(NL);
  // 有选区:选区扩到整块(连缩进一起选中),便于连着按 Tab;
  // 只有光标:跟随光标平移,停在原来那个字符旁边
  const caret = s.start === s.end;
  return {
    value: s.value.slice(0, from) + block + s.value.slice(to),
    start: caret ? Math.max(from, s.start + firstDelta) : from,
    end: caret ? Math.max(from, s.end + firstDelta) : from + block.length,
  };
}

/* ================================================================
 * Enter:列表 / 引用续写
 * ================================================================ */

const LIST_LINE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const QUOTE_LINE = /^(\s*>\s?)(.*)$/;

/**
 * 回车时的结构续写。返回 null 表示「交给浏览器默认行为」。
 *
 * - 列表项有内容 → 新起一项(有序列表序号 +1);
 * - 列表项为空 → 删掉该标记并返回,相当于退出列表;
 * - 引用同理(空引用行退出)。
 */
export function continueList(state: EditState): EditResult | null {
  const s = norm(state);
  // 有选区时不接管:用户意图是替换内容
  if (s.start !== s.end) return null;
  const lineFrom = lineStartOf(s.value, s.start);
  const lineTo = lineEndOf(s.value, s.start);
  // 光标必须在行尾才接管:否则回车是在行中插入,交给默认行为更符合直觉
  if (s.start !== lineTo) return null;

  const line = s.value.slice(lineFrom, lineTo);
  const quote = QUOTE_LINE.exec(line);
  const body = quote ? quote[2] : line;
  const list = LIST_LINE.exec(body);

  /** 整行替换(用于「空项退出」),光标停在替换后行尾 */
  const replaceLine = (text: string): EditResult => ({
    value: s.value.slice(0, lineFrom) + text + s.value.slice(lineTo),
    start: lineFrom + text.length,
    end: lineFrom + text.length,
  });

  /** 在光标处插入,光标跟随到插入内容之后 */
  const insertAt = (text: string): EditResult => ({
    value: s.value.slice(0, s.start) + text + s.value.slice(s.start),
    start: s.start + text.length,
    end: s.start + text.length,
  });

  if (list) {
    const [, ind, marker, content] = list;
    if (!content.trim()) {
      // 空项再回车 → 退出列表:去掉标记与该项缩进,外层引用保留
      return replaceLine(quote ? quote[1] : '');
    }
    const ordered = /^\d+[.)]$/.test(marker);
    const nextMarker = ordered
      ? `${Number(marker.slice(0, -1)) + 1}${marker.slice(-1)}`
      : marker;
    return insertAt(NL + (quote ? quote[1] : '') + ind + nextMarker + ' ');
  }

  if (quote) {
    const [, marker, content] = quote;
    if (!content.trim()) return replaceLine('');
    return insertAt(NL + marker);
  }

  return null;
}

/* ================================================================
 * 选区行号:供「源码 → 预览」滚动同步使用
 * ================================================================ */

/** 光标/选区所在行(0 基),与 markdown-it 的 token.map 同坐标系 */
export function lineIndexAt(value: string, pos: number): number {
  let line = 0;
  const end = Math.min(pos, value.length);
  for (let i = 0; i < end; i++) if (value.charCodeAt(i) === 10) line++;
  return line;
}

/** 某行在全文中的字符起止偏移 */
export function lineRange(value: string, line: number): { from: number; to: number } {
  let cur = 0;
  let from = 0;
  for (let i = 0; i <= value.length && cur < line; i++) {
    if (i === value.length || value.charCodeAt(i) === 10) {
      cur++;
      from = i + 1;
    }
  }
  return { from, to: lineEndOf(value, from) };
}

/** 把光标定位到某行(点击预览跳转用),pos 缺省为行首 */
export function caretToLine(state: EditState, line: number): EditResult {
  const { from, to } = lineRange(state.value, Math.max(0, line));
  const pos = Math.min(from, to);
  return { value: state.value, start: pos, end: pos };
}
