/**
 * 错误边界:渲染管线(或任何子树)抛出异常时,渲染兜底卡片而不是白屏。
 *
 * - `resetKey` 变化时自动恢复(如 Viewer 传 activePath:切文档即自愈)
 * - 用户也可点「重试」立即恢复
 * - 异常仍会 console.error 出来,不吞问题
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** 变化时自动清除错误状态(子组件失忆重挂) */
  resetKey?: string;
  /** 兜底卡片标题 */
  title?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && this.props.resetKey !== prev.resetKey) {
      this.setState({ error: null });
    }
  }

  private retry = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-boundary" role="alert">
        <h3>{this.props.title ?? '内容加载出错'}</h3>
        <p className="error-boundary-msg">{error.message || '未知错误'}</p>
        <button className="error-boundary-retry" onClick={this.retry}>
          重试
        </button>
      </div>
    );
  }
}
