/**
 * 文档内查找:在容器内高亮匹配文本并支持逐个跳转。
 *
 * 实现要点:命中标记必须可完整撤销 —— 直接替换文本节点会破坏
 * 已渲染的代码块(Shiki 输出的 token 被 mark 切碎),因此这里记录
 * 每个插入点,撤销时按原样还原为单个文本节点。
 */

/** 不参与查找的容器:代码块的空白敏感,且内容已由语法高亮负责 */
const SKIP = 'pre, code, script, style, mark, .math-block, .mermaid-block';

interface Insertion {
  parent: Node;
  /** 按插入顺序排列的节点,撤销时整段移除 */
  inserted: Node[];
  text: string;
}

export interface FindSession {
  /** 当前所有命中,按文档顺序 */
  hits: HTMLElement[];
  /** 撤销全部改动,恢复原 DOM */
  cleanup(): void;
}

/** 在 container 内查找 query(大小写不敏感),返回可撤销的会话 */
export function applyFind(container: HTMLElement, query: string): FindSession | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;

  // 先清理上一轮,避免反复替换导致 DOM 膨胀
  const insertions: Insertion[] = [];
  const hits: HTMLElement[] = [];

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest(SKIP)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const targets: Text[] = [];
  while (walker.nextNode()) targets.push(walker.currentNode as Text);

  for (const node of targets) {
    const text = node.nodeValue;
    if (!text || !text.toLowerCase().includes(q)) continue;
    const parent = node.parentNode;
    if (!parent) continue;

    const frag = document.createDocumentFragment();
    const inserted: Node[] = [];
    let rest = text;
    let lower = rest.toLowerCase();
    let idx = lower.indexOf(q);

    while (idx !== -1) {
      const before = rest.slice(0, idx);
      if (before) {
        const t = document.createTextNode(before);
        frag.appendChild(t);
        inserted.push(t);
      }
      const mark = document.createElement('mark');
      mark.className = 'find-hit';
      mark.textContent = rest.slice(idx, idx + q.length);
      frag.appendChild(mark);
      inserted.push(mark);
      hits.push(mark);

      rest = rest.slice(idx + q.length);
      lower = rest.toLowerCase();
      idx = lower.indexOf(q);
    }
    if (rest) {
      const t = document.createTextNode(rest);
      frag.appendChild(t);
      inserted.push(t);
    }

    parent.replaceChild(frag, node);
    insertions.push({ parent, inserted, text });
  }

  return {
    hits,
    cleanup() {
      for (const rec of insertions) {
        // 插入的节点在 parent 中连续,用首节点定位后整段还原为原始文本
        const children = rec.parent.childNodes;
        const start = Array.prototype.indexOf.call(children, rec.inserted[0]);
        if (start === -1) continue;
        for (let i = 0; i < rec.inserted.length; i++) {
          children[start].remove();
        }
        rec.parent.insertBefore(document.createTextNode(rec.text), children[start] ?? null);
      }
      insertions.length = 0;
      hits.length = 0;
    },
  };
}