/**
 * 标题 slug 生成:小写、去标点、空格转连字符。
 *
 * 另提供 uniqueSlugs —— markdown-it-anchor 自带的去重逻辑在标题大量重名时
 * 会退化为 O(n²)(每次都从 -1 开始逐个试探后缀,而试探值往往已被占用)。
 * 性能目标要求万行文档秒开,故此处改为按 base slug 记录下一个可用后缀。
 */

export function slugify(input: string): string {
  return (
    input
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  );
}

/**
 * 生成 slug 去重器,行为与 markdown-it-anchor 默认一致:
 * 首次出现用原名,重复则依次追加 -2、-3 …
 *
 * @returns slugify 函数,可直接传给 markdown-it-anchor 的 slugifyWithState
 */
export function createSlugDeduplicator(): (input: string) => string {
  const used = new Set<string>();
  /** 每个 base slug 已经试探到的后缀,下次直接从这里继续 */
  const nextSuffix = new Map<string, number>();

  return function dedupe(input: string): string {
    const base = slugify(input);
    if (!used.has(base)) {
      used.add(base);
      nextSuffix.set(base, 2);
      return base;
    }
    let n = nextSuffix.get(base) ?? 2;
    let candidate = `${base}-${n}`;
    while (used.has(candidate)) {
      n += 1;
      candidate = `${base}-${n}`;
    }
    nextSuffix.set(base, n + 1);
    used.add(candidate);
    return candidate;
  };
}