//! 双链与标签解析:从 Markdown 文本中提取 `[[Wiki 链接]]` 与 `#标签`。
//!
//! 手工扫描而非正则 —— 需要区分:
//! - 围栏代码块(``` / ~~~)内的 `[[`、`#` 不算链接/标签;
//! - 行内代码(反引号对)内的同样不算;
//! - 行首的 `#` 是 ATX 标题语法,不是标签。
//!
//! 解析为 O(n) 单遍扫描,万行文档开销可忽略。

use crate::fs::strip_ext;

/// 一篇文档解析出的双链与标签(均已归一化、去重)
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ParsedLinks {
    /// 链接目标:去扩展名、去 `#锚点` 后的路径或标题
    pub links: Vec<String>,
    /// 标签(不含 `#`)
    pub tags: Vec<String>,
}

/// 解析文本中的双链与标签
pub fn parse(content: &str) -> ParsedLinks {
    let mut links: Vec<String> = Vec::new();
    let mut tags: Vec<String> = Vec::new();
    let mut seen_links: HashSet<String> = HashSet::new();
    let mut seen_tags: HashSet<String> = HashSet::new();

    // 围栏状态:`Some(围栏字符与长度)` 表示处于代码块内
    let mut fence: Option<(char, usize)> = None;
    // 行内代码状态:开标记的反引号数量
    let mut code_run: Option<usize> = None;
    let mut at_line_start = true;

    let chars: Vec<char> = content.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];

        // --- 行首:检测 ATX 标题(整行跳过,避免 `# 标题` 被当作标签)---
        // CommonMark:行首 1~6 个 `#` 后跟空格/制表符/行尾才算标题;
        // `#知识管理`、`##标签` 这类无空格形式是标签而非标题。
        if at_line_start {
            let mut j = i;
            let mut spaces = 0;
            while j < chars.len() && chars[j] == ' ' && spaces < 4 {
                j += 1;
                spaces += 1;
            }
            let hashes = run_len(&chars, j, '#');
            let is_heading = spaces < 4
                && (1..=6).contains(&hashes)
                && matches!(
                    chars.get(j + hashes),
                    Some(c) if *c == ' ' || *c == '\t' || *c == '\n'
                ) || (j + hashes == chars.len() && (1..=6).contains(&hashes) && spaces < 4);
            if is_heading {
                // 标题行:跳到行尾
                while j < chars.len() && chars[j] != '\n' {
                    j += 1;
                }
                i = j;
                continue;
            }
            at_line_start = false;
        }

        // --- 围栏代码块 ---
        if fence.is_none() && (c == '`' || c == '~') {
            let run = run_len(&chars, i, c);
            // 围栏需 ≥3;行内代码可为任意长度
            if run >= 3 {
                fence = Some((c, run));
                i += run;
                continue;
            }
            if code_run.is_none() {
                code_run = Some(run);
            } else if run >= code_run.unwrap() {
                code_run = None;
            }
            i += run;
            continue;
        }
        if let Some((f, len)) = fence {
            if c == f {
                let run = run_len(&chars, i, c);
                if run >= len {
                    fence = None;
                    i += run;
                    continue;
                }
            }
            if c == '\n' {
                at_line_start = true;
            }
            i += 1;
            continue;
        }

        // --- 行内代码内的内容跳过 ---
        if code_run.is_some() {
            if c == '`' {
                let run = run_len(&chars, i, '`');
                if run >= code_run.unwrap() {
                    code_run = None;
                }
                i += run;
                continue;
            }
            if c == '\n' {
                at_line_start = true;
            }
            i += 1;
            continue;
        }

        // --- Wiki 链接 [[目标|显示名]] ---
        if c == '[' && i + 1 < chars.len() && chars[i + 1] == '[' {
            if let Some(close) = find_close(&chars, i + 2) {
                let inner: String = chars[i + 2..close].iter().collect();
                if let Some(target) = normalize_link(&inner) {
                    if !seen_links.contains(&target) {
                        seen_links.insert(target.clone());
                        links.push(target);
                    }
                }
                i = close + 2;
                continue;
            }
        }

        // --- 标签 #tag ---
        if c == '#' && is_tag_start(&chars, i) {
            let mut j = i + 1;
            while j < chars.len() && is_tag_char(chars[j]) {
                j += 1;
            }
            if j > i + 1 {
                let tag: String = chars[i + 1..j].iter().collect();
                if !seen_tags.contains(&tag) {
                    seen_tags.insert(tag.clone());
                    tags.push(tag);
                }
            }
            i = j;
            continue;
        }

        if c == '\n' {
            at_line_start = true;
        }
        i += 1;
    }

    ParsedLinks { links, tags }
}

/// 相同字符连续重复的长度
fn run_len(chars: &[char], start: usize, c: char) -> usize {
    let mut n = 0;
    while start + n < chars.len() && chars[start + n] == c {
        n += 1;
    }
    n
}

/// 从 `[[` 内容起点找 `]]`,不跨越空行(链接不会跨行)
fn find_close(chars: &[char], from: usize) -> Option<usize> {
    let mut i = from;
    while i + 1 < chars.len() {
        if chars[i] == '\n' && i + 1 < chars.len() && chars[i + 1] == '\n' {
            return None;
        }
        if chars[i] == ']' && chars[i + 1] == ']' {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// 归一化链接目标:`[[a/b.md#锚点|显示名]]` → `a/b`
fn normalize_link(inner: &str) -> Option<String> {
    let target = inner.split('|').next()?.trim();
    if target.is_empty() {
        return None;
    }
    // 去掉 #锚点 与查询串
    let path = target.split(['#', '?']).next().unwrap_or(target);
    let path = path.trim();
    if path.is_empty() {
        return None;
    }
    let stripped = strip_ext(path);
    Some(stripped.to_string())
}

/// `#` 能否作为标签起点:
/// - 位于文档/行首(此时已确认不是 ATX 标题,`#` 后无空格);
/// - 或前一个字符是空白(排除 `C#`、URL 锚点 `x#y`);
/// - 后一个字符必须是字母(中文/英文),排除 `#1` 这类序号。
fn is_tag_start(chars: &[char], i: usize) -> bool {
    if i > 0 {
        let prev = chars[i - 1];
        if !prev.is_whitespace() {
            return false;
        }
    }
    match chars.get(i + 1) {
        Some(c) => c.is_alphabetic(),
        None => false,
    }
}

/// 标签字符:字母、数字、`_`、`-`、`/`(Obsidian 嵌套标签)
fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-' | '/')
}

use std::collections::HashSet;

#[cfg(test)]
mod tests {
    use super::*;

    fn links(s: &str) -> Vec<String> {
        parse(s).links
    }

    fn tags(s: &str) -> Vec<String> {
        parse(s).tags
    }

    #[test]
    fn 基本双链() {
        assert_eq!(links("参见 [[其他文档]] 说明"), vec!["其他文档"]);
    }

    #[test]
    fn 带显示名的双链取目标() {
        assert_eq!(links("[[目录/文档|显示名]]"), vec!["目录/文档"]);
    }

    #[test]
    fn 链接目标去扩展名与锚点() {
        assert_eq!(links("[[a/b.md#章节]]"), vec!["a/b"]);
    }

    #[test]
    fn 同一目标去重() {
        assert_eq!(links("[[a]] 和 [[a]]"), vec!["a"]);
    }

    #[test]
    fn 代码块内不解析() {
        let md = "正文 [[真链接]]\n```\n[[假链接]] #假标签\n```\n";
        assert_eq!(links(md), vec!["真链接"]);
        assert!(tags(md).is_empty());
    }

    #[test]
    fn 行内代码内不解析() {
        assert_eq!(links("用 `[[代码]]` 包裹"), Vec::<String>::new());
        assert_eq!(tags("用 `#代码` 包裹"), Vec::<String>::new());
    }

    #[test]
    fn 波浪线围栏同样跳过() {
        let md = "~~~\n[[x]] #y\n~~~\n";
        assert_eq!(links(md), Vec::<String>::new());
    }

    #[test]
    fn atx标题不是标签() {
        assert_eq!(tags("# 这是标题\n"), Vec::<String>::new());
        assert_eq!(tags("## 二级 #标题内\n"), Vec::<String>::new());
    }

    #[test]
    fn 无空格井号是标签而非标题() {
        // `##标签` 仍是 Markdown 歧义文本,按普通文本处理(不产生标签)
        assert_eq!(tags("#知识管理/方法论"), vec!["知识管理/方法论"]);
        assert_eq!(tags("##标签名"), Vec::<String>::new());
    }

    #[test]
    fn 基本标签() {
        assert_eq!(tags("记录一下 #读书笔记 和 #idea"), vec!["读书笔记", "idea"]);
    }

    #[test]
    fn 中文标签() {
        assert_eq!(tags("#知识管理/方法论"), vec!["知识管理/方法论"]);
    }

    #[test]
    fn 井号后非字母不算标签() {
        assert_eq!(tags("issue #12 和 C# 编程"), Vec::<String>::new());
    }

    #[test]
    fn url锚点不算标签() {
        assert_eq!(tags("见 https://example.com/page#section 链接"), Vec::<String>::new());
    }

    #[test]
    fn 标签去重() {
        assert_eq!(tags("#a #a #a"), vec!["a"]);
    }

    #[test]
    fn 空链接不产生条目() {
        assert_eq!(links("[[]] 与 [[|显示名]]"), Vec::<String>::new());
    }

    #[test]
    fn 链接不跨越空行() {
        assert_eq!(links("[[开头\n\n结尾]]"), Vec::<String>::new());
    }

    #[test]
    fn 双反引号行内代码() {
        let md = "``[[a]]`` 与 [[b]]\n";
        assert_eq!(links(md), vec!["b"]);
    }
}
