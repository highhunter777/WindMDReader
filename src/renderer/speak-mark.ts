/**
 * 朗读的 DOM 支撑:把正文拆成可朗读的块,并标记当前正在读的那一句。
 *
 * 两处必须一致,否则句级高亮会失配:
 * - 朗读文本 `readableText()` 与句级定位的字符索引 `buildFlat()` 都用同一个
 *   遍历规则(跳过代码/公式/图表),因此"从块文本切出的句子"一定能在 DOM 内定位回原处;
 * - 送 TTS 的文本另做一次压空白归一化(引擎读顺口),但**不用**它做定位。
 */

/** 块级候选:标题、段落、列表项、表格单元格、引用 */
const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, figcaption, dt, dd, td, th, summary';

/** 朗读时跳过:整块独占的代码/图表/脚注,以及块内嵌的行内公式与图形 */
const SKIP_BLOCK = 'pre, code, .math-block, .mermaid-block, .footnotes, .find-hit, .speaking-sentence';
const SKIP_TEXT =
  'pre, code, mark, .katex, .math-block, .mermaid-block, svg, img, .footnotes';

/** 一个可朗读的块 */
export interface ReadableBlock {
  el: HTMLElement;
  /** 跳过公式/代码后的朗读文本(保留原始空白,与 DOM 字符索引一致) */
  text: string;
}

/** 收集块内的文本节点,统一跳过不该朗读的部分 */
function collectTextNodes(root: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest(SKIP_TEXT)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) out.push(walker.currentNode as Text);
  return out;
}

/** 块的朗读文本:跳过代码/公式/图表,其余原样拼接 */
export function readableText(el: HTMLElement): string {
  return collectTextNodes(el)
    .map((n) => n.nodeValue ?? '')
    .join('');
}

/**
 * 收集正文里可朗读的块(按文档顺序)。
 *
 * 只保留**最内层**的块:`blockquote > p`、`li > p`(松散列表)等嵌套结构下
 * 外层会被剔除,否则同一段文字会被读两遍。
 */
export function collectBlocks(container: HTMLElement): ReadableBlock[] {
  const out: ReadableBlock[] = [];
  for (const el of Array.from(container.querySelectorAll<HTMLElement>(BLOCK_SELECTOR))) {
    // 外层块里还有同类型块 → 内容归内层管
    if (el.querySelector(BLOCK_SELECTOR)) continue;
    if (el.closest(SKIP_BLOCK)) continue;
    const text = readableText(el);
    if (!text.trim()) continue;
    out.push({ el, text });
  }
  return out;
}

/** 句末标点(半角 + 全角;`;` 分号也算,长句读起来需要换气) */
const SENTENCE_END = /[。!?！？；…]/;
/** 可紧跟在句末符号之后、应一并归入本句的收尾符号 */
const TRAILING = /[。!?！？；…"'”’」』）)\]}]/;

/**
 * 把块文本切成句子。
 *
 * 中英文句末标点都切;英文句点要小心:
 * - 后接字母或数字时不切(`3.14`、`v1.0`);
 * - 后接空白时,再看空白的下一个字符是不是大写字母/引号:
 *   是则确为句末(`end. Next`),否则当缩写处理(`e.g. this file.`)。
 *
 * 过长的无标点片段按长度兜底切开,免得整段塞给引擎后无法暂停。
 */
export function splitSentences(text: string, maxLen = 160): string[] {
  const src = text.replace(/\s+/g, ' ').trim();
  if (!src) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    let cut = false;
    if (SENTENCE_END.test(c)) {
      // 紧跟的收尾符号(?!、……、引号)一并带走
      let end = i + 1;
      while (end < src.length && TRAILING.test(src[end])) end++;
      i = end - 1;
      cut = true;
    } else if (c === '.') {
      const next = src[i + 1];
      if (next === undefined) {
        cut = true;
      } else if (next === ' ') {
        // 大写字母/引号开头才像新句,否则视为缩写
        const after = src[i + 2];
        cut = after === undefined || /[A-Z“‘"'(]/.test(after);
      }
    }
    if (!cut) continue;
    const piece = src.slice(start, i + 1).trim();
    if (piece) out.push(piece);
    start = i + 1;
  }
  const tail = src.slice(start).trim();
  if (tail) out.push(tail);
  // 超长片段兜底:优先在逗号处断,否则按长度硬切
  const result: string[] = [];
  for (const piece of out) {
    if (piece.length <= maxLen) {
      result.push(piece);
      continue;
    }
    let rest = piece;
    while (rest.length > maxLen) {
      const comma = rest.lastIndexOf(',', maxLen);
      const cutAt = comma > maxLen * 0.4 ? comma + 1 : maxLen;
      result.push(rest.slice(0, cutAt).trim());
      rest = rest.slice(cutAt).trim();
    }
    if (rest) result.push(rest);
  }
  return result.filter(Boolean);
}

/** 送引擎的文本:压空白(引擎读顺口),不改字符内容 */
export function normalizeForSpeech(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/* ================================================================
 * 句级高亮
 * ================================================================ */

/** 块内文本的字符索引:full 保留原样,norm 去空白小写并记录到 full 的映射 */
interface FlatIndex {
  full: string;
  norm: string;
  /** norm 每个字符对应的 full 下标 */
  normToFull: number[];
  nodes: { node: Text; start: number }[];
}

function buildFlat(root: HTMLElement): FlatIndex {
  let full = '';
  let norm = '';
  const normToFull: number[] = [];
  const nodes: { node: Text; start: number }[] = [];
  for (const node of collectTextNodes(root)) {
    const value = node.nodeValue ?? '';
    nodes.push({ node, start: full.length });
    for (let i = 0; i < value.length; i++) {
      const c = value[i];
      full += c;
      if (!/\s/.test(c)) {
        norm += c.toLowerCase();
        normToFull.push(full.length - 1);
      }
    }
  }
  return { full, norm, normToFull, nodes };
}

interface Insertion {
  parent: Node;
  inserted: Node[];
  text: string;
}

/** 当前朗读位置的标记 */
export interface SentenceMark {
  blockEl: HTMLElement;
  /** 有句级高亮时为 true;定位失败只保留块级标记 */
  precise: boolean;
  cleanup(): void;
}

/** 加/撤块级标记:撤完若 class 归零则连属性一起去掉,保证 DOM 回到原样 */
function setBlockFlag(el: HTMLElement, on: boolean) {
  if (on) {
    el.classList.add('speaking-block');
    return;
  }
  el.classList.remove('speaking-block');
  if (el.classList.length === 0) el.removeAttribute('class');
}

/**
 * 标记块内正在朗读的句子。
 *
 * 匹配用"去空白小写"后的序列,所以块文本里的换行/多余空格不影响定位;
 * 定位失败时返回仅含块级标记的结果(调用方据此降级),不抛错。
 */
export function markSentence(block: ReadableBlock, sentence: string): SentenceMark {
  setBlockFlag(block.el, true);
  const flat = buildFlat(block.el);
  const key = sentence.replace(/\s+/g, '').toLowerCase();
  const idx = key ? flat.norm.indexOf(key) : -1;
  if (idx === -1) {
    return {
      blockEl: block.el,
      precise: false,
      cleanup: () => setBlockFlag(block.el, false),
    };
  }
  const startFull = flat.normToFull[idx];
  const endFull = flat.normToFull[idx + key.length - 1] + 1;

  const insertions: Insertion[] = [];
  for (const { node, start } of flat.nodes) {
    const value = node.nodeValue ?? '';
    const nodeEnd = start + value.length;
    const from = Math.max(start, startFull);
    const to = Math.min(nodeEnd, endFull);
    if (to <= from) continue;
    const parent = node.parentNode;
    if (!parent) continue;
    const relFrom = from - start;
    const relTo = to - start;

    const frag = document.createDocumentFragment();
    const inserted: Node[] = [];
    if (relFrom > 0) {
      const head = document.createTextNode(value.slice(0, relFrom));
      frag.appendChild(head);
      inserted.push(head);
    }
    const mark = document.createElement('mark');
    mark.className = 'speaking-sentence';
    mark.textContent = value.slice(relFrom, relTo);
    frag.appendChild(mark);
    inserted.push(mark);
    if (relTo < value.length) {
      const tail = document.createTextNode(value.slice(relTo));
      frag.appendChild(tail);
      inserted.push(tail);
    }
    parent.replaceChild(frag, node);
    insertions.push({ parent, inserted, text: value });
  }

  return {
    blockEl: block.el,
    precise: insertions.length > 0,
    cleanup() {
      for (const rec of insertions) {
        const children = rec.parent.childNodes;
        const start = Array.prototype.indexOf.call(children, rec.inserted[0]);
        if (start === -1) continue;
        for (let i = 0; i < rec.inserted.length; i++) children[start].remove();
        rec.parent.insertBefore(document.createTextNode(rec.text), children[start] ?? null);
      }
      insertions.length = 0;
      setBlockFlag(block.el, false);
    },
  };
}