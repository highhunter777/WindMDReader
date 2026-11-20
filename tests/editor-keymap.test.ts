/**
 * 编辑器按键命令(纯函数)。
 *
 * 这些命令没有 DOM 可依赖,却最容易出错:包裹的切换语义、
 * 多行前缀的全有全无、列表续写的序号与缩进 —— 全在这里钉住。
 */
import { describe, expect, it } from 'vitest';
import {
  bulletPrefix,
  caretToLine,
  continueList,
  headingPrefix,
  indent,
  insertLink,
  lineIndexAt,
  lineRange,
  orderedPrefix,
  quotePrefix,
  selectedLineRange,
  toggleLinePrefix,
  toggleWrap,
  type EditState,
} from '../src/editor/keymap';

/** 用 `|` 标出光标、`[...]` 标出选区,便于把测试写成「所见即所得」 */
function pos(src: string): EditState {
  const startMark = src.indexOf('|');
  if (startMark !== -1) {
    const value = src.slice(0, startMark) + src.slice(startMark + 1);
    return { value, start: startMark, end: startMark };
  }
  const from = src.indexOf('[');
  const to = src.indexOf(']');
  const value = src.slice(0, from) + src.slice(from + 1, to) + src.slice(to + 1);
  return { value, start: from, end: to - 1 };
}

/** 把结果按同一约定还原成可读字符串 */
function show(r: { value: string; start: number; end: number }): string {
  if (r.start === r.end) return r.value.slice(0, r.start) + '|' + r.value.slice(r.start);
  return r.value.slice(0, r.start) + '[' + r.value.slice(r.start, r.end) + ']' + r.value.slice(r.end);
}

describe('toggleWrap — 加粗/斜体/行内代码', () => {
  it('无标记时包裹选区', () => {
    expect(show(toggleWrap(pos('a [bc] d'), '**'))).toBe('a **[bc]** d');
  });

  it('已包着则脱掉(切换语义)', () => {
    expect(show(toggleWrap(pos('a **[bc]** d'), '**'))).toBe('a [bc] d');
  });

  it('选区自身含标记也脱掉', () => {
    expect(show(toggleWrap(pos('a [**bc**] d'), '**'))).toBe('a [bc] d');
  });

  it('空选区插入标记并把光标放到中间', () => {
    expect(show(toggleWrap(pos('ab|cd'), '**'))).toBe('ab**|**cd');
  });

  it('斜体只用一个星号,不会误吃加粗', () => {
    expect(show(toggleWrap(pos('x [y] z'), '*'))).toBe('x *[y]* z');
  });

  it('行内代码用反引号', () => {
    expect(show(toggleWrap(pos('[a]'), '`'))).toBe('`[a]`');
  });

  it('反选(start > end)按归一化处理', () => {
    const r = toggleWrap({ value: 'abcd', start: 3, end: 1 }, '*');
    expect(r.value).toBe('a*bc*d');
  });
});

describe('insertLink', () => {
  it('有选区:文字进方括号,光标留在括号内待填 URL', () => {
    expect(show(insertLink(pos('[文档]')))).toBe('[文档](|)');
  });

  it('给了 URL 则直接成形,光标落到末尾', () => {
    expect(show(insertLink(pos('[文档]'), 'https://a.b'))).toBe('[文档](https://a.b)|');
  });

  it('空选区:留出空文字位', () => {
    expect(show(insertLink(pos('|')))).toBe('[](|)');
  });
});

describe('toggleLinePrefix — 行级前缀', () => {
  it('单行加无序列表', () => {
    expect(show(toggleLinePrefix(pos('|a'), bulletPrefix()))).toBe('[- a]');
  });

  it('多行全部加上', () => {
    expect(show(toggleLinePrefix(pos('[a\nb]'), bulletPrefix()))).toBe('[- a\n- b]');
  });

  it('全部已带则全部去掉(全有全无)', () => {
    expect(show(toggleLinePrefix(pos('[- a\n- b]'), bulletPrefix()))).toBe('[a\nb]');
  });

  it('部分已带时补全,而不是翻转', () => {
    expect(show(toggleLinePrefix(pos('[- a\nb]'), bulletPrefix()))).toBe('[- a\n- b]');
  });

  it('空行不处理(不留尾随标记)', () => {
    expect(show(toggleLinePrefix(pos('[a\n\nb]'), bulletPrefix()))).toBe('[- a\n\n- b]');
  });

  it('有序列表按序号递增', () => {
    expect(show(toggleLinePrefix(pos('[a\nb\nc]'), orderedPrefix(1)))).toBe('[1. a\n2. b\n3. c]');
  });

  it('标题同层级再加一次 = 取消', () => {
    expect(show(toggleLinePrefix(pos('[# a]'), headingPrefix(1)))).toBe('[a]');
  });

  it('标题换层级会替换而非叠加', () => {
    expect(show(toggleLinePrefix(pos('[# a]'), headingPrefix(2)))).toBe('[## a]');
  });

  it('引用可切换', () => {
    expect(show(toggleLinePrefix(pos('[a]'), quotePrefix()))).toBe('[> a]');
    expect(show(toggleLinePrefix(pos('[> a]'), quotePrefix()))).toBe('[a]');
  });
});

describe('indent — Tab / Shift+Tab', () => {
  it('单行缩进两个空格', () => {
    expect(show(indent(pos('|a'), 1))).toBe('  |a');
  });

  it('多行整块缩进,选区覆盖整块', () => {
    expect(show(indent(pos('[a\nb]'), 1))).toBe('[  a\n  b]');
  });

  it('反缩进去掉一层(空格或 tab 都算)', () => {
    expect(show(indent(pos('[  a\n\tb\n a]'), -1))).toBe('[a\nb\na]');
  });

  it('空行不动', () => {
    expect(show(indent(pos('[a\n\nb]'), 1))).toBe('[  a\n\n  b]');
  });

  it('已是行首时反缩进不产生负偏移', () => {
    const r = indent({ value: 'ab', start: 0, end: 0 }, -1);
    expect(r.start).toBe(0);
  });
});

describe('continueList — 回车续写', () => {
  it('无序列表续写同标记', () => {
    expect(show(continueList(pos('- a|'))!)).toBe('- a\n- |');
  });

  it('有序列表序号 +1', () => {
    expect(show(continueList(pos('1. a|'))!)).toBe('1. a\n2. |');
  });

  it('保持缩进层级', () => {
    expect(show(continueList(pos('  - a|'))!)).toBe('  - a\n  - |');
  });

  it('空列表项回车 → 退出列表', () => {
    expect(show(continueList(pos('- |'))!)).toBe('|');
  });

  it('引用内续写引用', () => {
    expect(show(continueList(pos('> a|'))!)).toBe('> a\n> |');
  });

  it('引用内的列表:两者都保留', () => {
    expect(show(continueList(pos('> - a|'))!)).toBe('> - a\n> - |');
  });

  it('空引用行回车 → 退出引用', () => {
    expect(show(continueList(pos('> |'))!)).toBe('|');
  });

  it('普通段落不接管(交回浏览器)', () => {
    expect(continueList(pos('普通文本|'))).toBeNull();
  });

  it('光标不在行尾不接管(行中回车是插入)', () => {
    expect(continueList(pos('- a|b'))).toBeNull();
  });

  it('有选区不接管(意图是替换)', () => {
    expect(continueList(pos('- [a]b'))).toBeNull();
  });
});

describe('行号工具 — 源码 ↔ 预览定位', () => {
  it('lineIndexAt 按换行计数', () => {
    expect(lineIndexAt('a\nb\nc', 0)).toBe(0);
    expect(lineIndexAt('a\nb\nc', 2)).toBe(1);
    expect(lineIndexAt('a\nb\nc', 4)).toBe(2);
  });

  it('lineIndexAt 越界不炸', () => {
    expect(lineIndexAt('abc', 999)).toBe(0);
  });

  it('lineRange 给出该行起止', () => {
    expect(lineRange('aa\nbb\ncc', 1)).toEqual({ from: 3, to: 5 });
  });

  it('lineRange 最后一行无换行也能取到末尾', () => {
    expect(lineRange('aa\nbb', 1)).toEqual({ from: 3, to: 5 });
  });

  it('caretToLine 把光标移到行首', () => {
    const r = caretToLine(pos('aa\nbb\n|cc'), 1);
    expect(r.start).toBe(3);
    expect(r.start).toBe(r.end);
  });

  it('selectedLineRange 覆盖首尾整行', () => {
    expect(selectedLineRange('aa\nbb\ncc', 4, 8)).toEqual({ from: 3, to: 8 });
  });
});
