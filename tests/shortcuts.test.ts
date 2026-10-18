/**
 * 快捷键绑定系统测试(T3.4):规范化、序列、冲突、默认值完整性。
 */
import { describe, expect, it } from 'vitest';
import {
  ACTION_META,
  ACTION_ORDER,
  DEFAULT_BINDINGS,
  actionForCombo,
  comboOf,
  comboOwner,
  formatCombo,
  hasModifier,
  SEQUENCE_WINDOW_MS,
} from '../src/renderer/shortcuts';

function keyEvent(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init);
}

describe('comboOf — 规范化', () => {
  it('纯键小写', () => {
    expect(comboOf(keyEvent({ key: 'j' }))).toBe('j');
    expect(comboOf(keyEvent({ key: '[' }))).toBe('[');
  });

  it('Ctrl 组合', () => {
    expect(comboOf(keyEvent({ key: 'f', ctrlKey: true }))).toBe('ctrl+f');
    expect(comboOf(keyEvent({ key: 'F', ctrlKey: true, shiftKey: true }))).toBe('ctrl+shift+f');
  });

  it('大写字母归一到 shift+字母', () => {
    expect(comboOf(keyEvent({ key: 'G', shiftKey: true }))).toBe('shift+g');
  });

  it('meta 视同 ctrl(macOS)', () => {
    expect(comboOf(keyEvent({ key: 'o', metaKey: true }))).toBe('ctrl+o');
  });

  it('修饰键顺序固定 ctrl → alt → shift', () => {
    expect(comboOf(keyEvent({ key: 'p', ctrlKey: true, altKey: true, shiftKey: true }))).toBe(
      'ctrl+alt+shift+p',
    );
  });

  it('Esc 单列', () => {
    expect(comboOf(keyEvent({ key: 'Escape' }))).toBe('escape');
  });

  it('纯修饰键无法表示,返回 null', () => {
    expect(comboOf(keyEvent({ key: 'Control' }))).toBeNull();
    expect(comboOf(keyEvent({ key: 'Shift' }))).toBeNull();
  });
});

describe('formatCombo — 人类可读', () => {
  it('单组合', () => {
    expect(formatCombo('ctrl+shift+f')).toBe('Ctrl + Shift + F');
    expect(formatCombo('j')).toBe('J');
  });

  it('序列', () => {
    expect(formatCombo('g g')).toBe('G 然后 G');
  });
});

describe('hasModifier', () => {
  it('含修饰键', () => {
    expect(hasModifier('ctrl+f')).toBe(true);
    expect(hasModifier('g ctrl+f')).toBe(true);
  });

  it('纯键(含序列)不含', () => {
    expect(hasModifier('j')).toBe(false);
    expect(hasModifier('g g')).toBe(false);
  });
});

describe('匹配与冲突', () => {
  it('精确匹配动作', () => {
    expect(actionForCombo(DEFAULT_BINDINGS, 'ctrl+f')).toBe('find');
    expect(actionForCombo(DEFAULT_BINDINGS, 'g g')).toBe('scroll-top');
  });

  it('无匹配返回 null', () => {
    expect(actionForCombo(DEFAULT_BINDINGS, 'ctrl+q')).toBeNull();
    expect(actionForCombo(DEFAULT_BINDINGS, 'g j')).toBeNull();
  });

  it('冲突检测可排除自身(改键场景)', () => {
    expect(comboOwner(DEFAULT_BINDINGS, 'ctrl+f')).toBe('find');
    expect(comboOwner(DEFAULT_BINDINGS, 'ctrl+f', 'find')).toBeNull();
  });

  it('序列窗口为 600ms', () => {
    expect(SEQUENCE_WINDOW_MS).toBe(600);
  });
});

describe('默认绑定完整性', () => {
  it('每个动作都有绑定与元数据', () => {
    for (const a of ACTION_ORDER) {
      expect(DEFAULT_BINDINGS[a]).toBeTruthy();
      expect(ACTION_META[a].name).toBeTruthy();
      expect(ACTION_META[a].group).toBeTruthy();
    }
  });

  it('元数据覆盖所有动作类型(无孤儿)', () => {
    expect(Object.keys(ACTION_META).sort()).toEqual([...ACTION_ORDER].sort());
  });

  it('默认绑定无重复占用', () => {
    const seen = new Map<string, string>();
    for (const a of ACTION_ORDER) {
      const combo = DEFAULT_BINDINGS[a];
      expect(seen.has(combo), `${combo} 被 ${seen.get(combo)} 与 ${a} 同时占用`).toBe(false);
      seen.set(combo, a);
    }
  });

  it('规划中的缺失项已补齐:g g / 缩放 / Ctrl+P / Ctrl+,', () => {
    expect(DEFAULT_BINDINGS['scroll-top']).toBe('g g');
    expect(DEFAULT_BINDINGS['zoom-in']).toBe('ctrl+=');
    expect(DEFAULT_BINDINGS['zoom-out']).toBe('ctrl+-');
    expect(DEFAULT_BINDINGS['export-menu']).toBe('ctrl+p');
    expect(DEFAULT_BINDINGS['open-settings']).toBe('ctrl+,');
  });
});
