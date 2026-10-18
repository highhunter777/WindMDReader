/**
 * 后端错误可读化的测试。
 *
 * 背景:Rust 的 `AppError` 自实现 `Serialize`,经 invoke reject 到前端的是
 * `{ code, message }` 普通对象,`String(e)` 会得到 "[object Object]"。
 * 这行曾经显示在文件树的错误条上,所以这里的每个用例都对应一种真实通道形态。
 */
import { describe, expect, it } from 'vitest';
import { errMsg } from '../src/ipc/errors';

describe('errMsg — 后端错误可读化', () => {
  it('取出 Rust AppError 序列化出的 message', () => {
    // 与 src-tauri/src/error.rs 的 AppError::serialize 同构
    expect(errMsg({ code: 'NO_VAULT', message: '未选择库目录' })).toBe('未选择库目录');
    expect(errMsg({ code: 'IO_ERROR', message: '无法创建文件' })).toBe('无法创建文件');
  });

  it('绝不返回 [object Object]', () => {
    for (const e of [
      { code: 'NO_VAULT', message: '未选择库目录' },
      { code: 'IO_ERROR', message: 'x' },
      {},
    ]) {
      expect(errMsg(e)).not.toBe('[object Object]');
    }
  });

  it('Error 实例取 message', () => {
    expect(errMsg(new Error('文件不存在'))).toBe('文件不存在');
  });

  it('字符串原样返回', () => {
    expect(errMsg('已经是字符串了')).toBe('已经是字符串了');
  });

  it('message 缺失时退回错误码', () => {
    expect(errMsg({ code: 'IO_ERROR' })).toBe('IO_ERROR');
  });

  it('其他形态退化为 String,不留空白', () => {
    expect(errMsg(42)).toBe('42');
    expect(errMsg(null)).toBe('null');
    expect(errMsg(undefined)).toBe('undefined');
    // message 不是字符串时(如嵌套对象)也不能变成 [object Object]
    const out = errMsg({ code: 'X', message: { deep: 1 } });
    expect(out).not.toBe('[object Object]');
  });

  it('空 message 视为缺失', () => {
    expect(errMsg({ code: 'IO_ERROR', message: '' })).toBe('IO_ERROR');
  });
});