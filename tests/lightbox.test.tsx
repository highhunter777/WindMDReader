/**
 * 图片灯箱测试:打开、切换、缩放、旋转、关闭。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Lightbox } from '../src/ui/Lightbox';

/** 在正文中铺 N 张图片,并渲染灯箱 */
function setup(count = 3) {
  document.body.innerHTML =
    '<article class="prose">' +
    Array.from({ length: count }, (_, i) => `<img src="/img-${i}.png" alt="图${i}">`).join('') +
    '</article>';
  return render(<Lightbox />);
}

/** enhance.ts 用原生 CustomEvent 通知,这里需 act 包裹以等待 React 状态更新 */
function openAt(index: number) {
  act(() => {
    document.dispatchEvent(
      new CustomEvent('windmd:lightbox-open', { detail: { src: `/img-${index}.png`, alt: `图${index}` } }),
    );
  });
}

/** 灯箱内的大图(正文中的原图也有 img role,必须限定范围) */
function lightboxImg(): HTMLImageElement {
  const dialog = document.querySelector('.lightbox') as HTMLElement;
  return dialog.querySelector('img') as HTMLImageElement;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Lightbox — 打开与关闭', () => {
  it('未打开时不渲染任何内容', () => {
    setup();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('派发事件后打开并显示图片', () => {
    setup();
    openAt(0);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    const img = lightboxImg();
    expect(img).toHaveAttribute('src', '/img-0.png');
    expect(img).toHaveAttribute('alt', '图0');
  });

  it('Esc 关闭', () => {
    setup();
    openAt(0);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('关闭按钮关闭', () => {
    setup();
    openAt(0);
    fireEvent.click(screen.getByTitle('关闭 (Esc)'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('单张图片时不显示左右切换按钮', () => {
    setup(1);
    openAt(0);
    expect(screen.queryByTitle('下一张 (→)')).toBeNull();
  });

  it('多张图片时显示左右切换按钮', () => {
    setup(3);
    openAt(0);
    expect(screen.getByTitle('下一张 (→)')).toBeInTheDocument();
    expect(screen.getByTitle('上一张 (←)')).toBeInTheDocument();
  });
});

describe('Lightbox — 切换', () => {
  it('下一张', () => {
    setup(3);
    openAt(0);
    fireEvent.click(screen.getByTitle('下一张 (→)'));
    expect(lightboxImg()).toHaveAttribute('src', '/img-1.png');
  });

  it('上一张', () => {
    setup(3);
    openAt(1);
    fireEvent.click(screen.getByTitle('上一张 (←)'));
    expect(lightboxImg()).toHaveAttribute('src', '/img-0.png');
  });

  it('最后一张的下一张回到第一张(循环)', () => {
    setup(3);
    openAt(2);
    fireEvent.click(screen.getByTitle('下一张 (→)'));
    expect(lightboxImg()).toHaveAttribute('src', '/img-0.png');
  });

  it('第一张的上一张回到最后一张(循环)', () => {
    setup(3);
    openAt(0);
    fireEvent.click(screen.getByTitle('上一张 (←)'));
    expect(lightboxImg()).toHaveAttribute('src', '/img-2.png');
  });

  it('方向键切换', () => {
    setup(3);
    openAt(0);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(lightboxImg()).toHaveAttribute('src', '/img-1.png');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(lightboxImg()).toHaveAttribute('src', '/img-0.png');
  });

  it('j/k 也可切换', () => {
    setup(3);
    openAt(0);
    fireEvent.keyDown(window, { key: 'j' });
    expect(lightboxImg()).toHaveAttribute('src', '/img-1.png');
  });

  it('加载失败的图片不进入图集', () => {
    // 两张可用图片夹着一张加载失败的
    document.body.innerHTML =
      '<article class="prose">' +
      '<img src="/a.png"><img src="/bad.png" class="img-error"><img src="/b.png">' +
      '</article>';
    render(<Lightbox />);
    act(() => {
      document.dispatchEvent(
        new CustomEvent('windmd:lightbox-open', { detail: { src: '/a.png', alt: 'a' } }),
      );
    });
    // 失败图不计入,下一张应直接到 /b.png 而非 /bad.png
    fireEvent.click(screen.getByTitle('下一张 (→)'));
    expect(lightboxImg()).toHaveAttribute('src', '/b.png');
  });
});

describe('Lightbox — 缩放与旋转', () => {
  it('放大并显示百分比', () => {
    setup(1);
    openAt(0);
    fireEvent.click(screen.getByTitle('放大 (+)'));
    expect(screen.getByText('125%')).toBeInTheDocument();
  });

  it('缩小', () => {
    setup(1);
    openAt(0);
    fireEvent.click(screen.getByTitle('放大 (+)'));
    fireEvent.click(screen.getByTitle('缩小 (-)'));
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('缩放有下限', () => {
    setup(1);
    openAt(0);
    for (let i = 0; i < 10; i++) fireEvent.click(screen.getByTitle('缩小 (-)'));
    expect(screen.getByText('25%')).toBeInTheDocument();
  });

  it('缩放有上限', () => {
    setup(1);
    openAt(0);
    for (let i = 0; i < 20; i++) fireEvent.click(screen.getByTitle('放大 (+)'));
    expect(screen.getByText('400%')).toBeInTheDocument();
  });

  it('键盘 +/- 缩放', () => {
    setup(1);
    openAt(0);
    fireEvent.keyDown(window, { key: '+' });
    expect(screen.getByText('125%')).toBeInTheDocument();
  });

  it('旋转 90 度', () => {
    setup(1);
    openAt(0);
    fireEvent.click(screen.getByTitle('旋转 (r)'));
    expect(lightboxImg().style.transform).toContain('rotate(90deg)');
  });

  it('r 键旋转,四次回到原位', () => {
    setup(1);
    openAt(0);
    for (let i = 0; i < 4; i++) fireEvent.keyDown(window, { key: 'r' });
    expect(lightboxImg().style.transform).toContain('rotate(0deg)');
  });

  it('0 键复位缩放与旋转', () => {
    setup(1);
    openAt(0);
    fireEvent.click(screen.getByTitle('放大 (+)'));
    fireEvent.click(screen.getByTitle('旋转 (r)'));
    fireEvent.keyDown(window, { key: '0' });
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(lightboxImg().style.transform).toContain('rotate(0deg)');
  });

  it('切换图片后缩放与旋转复位', () => {
    setup(3);
    openAt(0);
    fireEvent.click(screen.getByTitle('放大 (+)'));
    fireEvent.click(screen.getByTitle('旋转 (r)'));
    fireEvent.click(screen.getByTitle('下一张 (→)'));
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(lightboxImg().style.transform).toContain('rotate(0deg)');
  });
});

describe('Lightbox — 滚动锁定', () => {
  it('打开时锁定 body 滚动', () => {
    setup(1);
    openAt(0);
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('关闭后恢复滚动', () => {
    setup(1);
    document.body.style.overflow = 'auto';
    openAt(0);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.body.style.overflow).toBe('auto');
  });
});

describe('Lightbox — 点击行为', () => {
  it('点击遮罩关闭', () => {
    setup(1);
    openAt(0);
    fireEvent.click(screen.getByRole('dialog'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('点击图片本身不关闭', () => {
    setup(1);
    openAt(0);
    fireEvent.click(lightboxImg());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('点击工具栏不关闭', () => {
    setup(1);
    openAt(0);
    fireEvent.click(screen.getByTitle('放大 (+)'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});