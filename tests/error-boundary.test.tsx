/**
 * 错误边界测试(T4.2):渲染异常不白屏 —— 兜底卡片、重试、resetKey 自愈。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { ErrorBoundary } from '../src/ui/ErrorBoundary';

afterEach(cleanup);

/** 可控炸弹:boom 为 true 时渲染即抛 */
function Bomb({ boom }: { boom: boolean }) {
  if (boom) throw new Error('炸了');
  return <p>正常内容</p>;
}

describe('ErrorBoundary', () => {
  it('子树正常时原样渲染', () => {
    render(
      <ErrorBoundary title="文档加载出错">
        <Bomb boom={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('正常内容')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('子树抛出时渲染兜底卡片(含错误信息)并上报', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary title="文档加载出错">
        <Bomb boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('文档加载出错')).toBeInTheDocument();
    expect(screen.getByText('炸了')).toBeInTheDocument();
    // 异常被 componentDidCatch 记录(带组件栈),不静默吞掉
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('[ErrorBoundary]'))).toBe(true);
    errSpy.mockRestore();
  });

  it('点「重试」重新挂载子树', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Harness() {
      const [boom, setBoom] = useState(true);
      return (
        <>
          <ErrorBoundary title="文档加载出错">
            <Bomb boom={boom} />
          </ErrorBoundary>
          {/* 修复开关在边界外:兜底卡片替换不掉它 */}
          <button onClick={() => setBoom(false)}>修复</button>
        </>
      );
    }
    render(<Harness />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByText('修复'));
    // 修好了但边界还停在错误态:点重试才恢复
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByText('重试'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('正常内容')).toBeInTheDocument();
    errSpy.mockRestore();
  });

  it('resetKey 变化自动恢复,无需用户点重试', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Harness() {
      const [fixed, setFixed] = useState(false);
      return (
        <>
          <ErrorBoundary resetKey={fixed ? 'v2' : 'v1'} title="文档加载出错">
            <Bomb boom={!fixed} />
          </ErrorBoundary>
          <button onClick={() => setFixed(true)}>修复</button>
        </>
      );
    }
    render(<Harness />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByText('修复'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('正常内容')).toBeInTheDocument();
    errSpy.mockRestore();
  });
});
