//! SQLite 数据层:文档元数据、阅读进度、书签、FTS5 全文索引。
//!
//! schema 与规划文档 5.5 一致。

use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;

use crate::fs::strip_ext;

/// 各处读取的列顺序必须一致,故抽出常量避免漂移
const SELECT_COLS: &str =
    "SELECT path, title, size, mtime, read_progress, starred, last_read_at";

/// 数据库包装。Mutex 保证 rusqlite::Connection 的 Send 约束。
pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let db = Db {
            conn: Mutex::new(Connection::open(path)?),
        };
        db.migrate()?;
        Ok(db)
    }

    /// 内存库,供测试与降级使用
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        let db = Db {
            conn: Mutex::new(Connection::open_in_memory()?),
        };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS documents (
                path          TEXT PRIMARY KEY,   -- 相对库根,统一用 /
                title         TEXT NOT NULL,
                size          INTEGER NOT NULL DEFAULT 0,
                mtime         INTEGER NOT NULL DEFAULT 0,
                last_read_at  INTEGER NOT NULL DEFAULT 0,
                read_progress REAL NOT NULL DEFAULT 0,
                starred       INTEGER NOT NULL DEFAULT 0,
                tags          TEXT NOT NULL DEFAULT ''  -- 逗号分隔,见 set_tags
            );
            CREATE INDEX IF NOT EXISTS idx_documents_last_read
                ON documents(last_read_at DESC);

            -- 双链:source_id 为源文档相对路径,target_path 为归一化目标
            -- (去扩展名与 #锚点,可为尚未创建的文件)
            CREATE TABLE IF NOT EXISTS links (
                source_id   TEXT NOT NULL,
                target_path TEXT NOT NULL,
                UNIQUE(source_id, target_path)
            );
            CREATE INDEX IF NOT EXISTS idx_links_target
                ON links(target_path);

            -- FTS5 虚表;path 不参与索引,只用于回传定位
            -- tokenizer 选 trigram 而非默认的 unicode61:
            -- unicode61 把整段中文当作一个 token,中文子串检索必然落空;
            -- trigram 按三字符切分,中文子串可命中。
            -- 代价是索引体积更大、精确度略低,故把中文短语拆成三元组查询。
            CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
                path UNINDEXED,
                content,
                tokenize = "trigram"
            );
            "#,
        )?;
        // 旧库迁移:documents 表补 tags 列(建表语句的 IF NOT EXISTS 不会加列)
        let has_tags: bool = self
            .conn
            .lock()
            .unwrap()
            .prepare("SELECT COUNT(*) FROM pragma_table_info('documents') WHERE name = 'tags'")?
            .query_row([], |r| r.get::<_, i64>(0))?
            > 0;
        if !has_tags {
            self.conn
                .lock()
                .unwrap()
                .execute("ALTER TABLE documents ADD COLUMN tags TEXT NOT NULL DEFAULT ''", [])?;
        }
        Ok(())
    }

    /// 读取文档元数据
    pub fn get_meta(&self, path: &str) -> rusqlite::Result<Option<DocRow>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("{SELECT_COLS} FROM documents WHERE path = ?1");
        conn.query_row(&sql, params![path], row_to_doc).optional()
    }

    /// 写入(或更新)文档元数据
    pub fn upsert_meta(&self, doc: &DocRow) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        // last_read_at 取 max:重新索引等操作不应冲掉「最近阅读」顺序
        conn.execute(
            "INSERT INTO documents (path, title, size, mtime, last_read_at, read_progress, starred)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(path) DO UPDATE SET
                 title = excluded.title,
                 size = excluded.size,
                 mtime = excluded.mtime,
                 last_read_at = MAX(documents.last_read_at, excluded.last_read_at),
                 read_progress = excluded.read_progress,
                 starred = excluded.starred",
            params![
                doc.path,
                doc.title,
                doc.size,
                doc.mtime,
                doc.last_read_at,
                doc.read_progress,
                doc.starred as i64,
            ],
        )?;
        Ok(())
    }

    /// 最近阅读的文档
    pub fn recent(&self, limit: usize) -> rusqlite::Result<Vec<DocRow>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("{SELECT_COLS} FROM documents ORDER BY last_read_at DESC, mtime DESC LIMIT ?1");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map([limit as i64], row_to_doc)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 收藏的文档,按最近阅读倒序
    pub fn starred(&self) -> rusqlite::Result<Vec<DocRow>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("{SELECT_COLS} FROM documents WHERE starred = 1 ORDER BY last_read_at DESC, mtime DESC");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map([], row_to_doc)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 全部文档路径(用于清理已删除文件的残留记录)
    pub fn all_paths(&self) -> rusqlite::Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT path FROM documents")?;
        let rows = stmt
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 写入全文索引(先删旧条目,避免重复命中)
    pub fn index_content(&self, path: &str, content: &str) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM fts WHERE path = ?1", params![path])?;
        tx.execute(
            "INSERT INTO fts (path, content) VALUES (?1, ?2)",
            params![path, content],
        )?;
        tx.commit()
    }

    pub fn remove_from_index(&self, path: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM fts WHERE path = ?1", params![path])?;
        Ok(())
    }

    pub fn remove_meta(&self, path: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM documents WHERE path = ?1", params![path])?;
        conn.execute("DELETE FROM links WHERE source_id = ?1", params![path])?;
        Ok(())
    }

    /* ---------------- 标签 ---------------- */

    /// 覆盖写入某文档的标签(逗号分隔存储)
    pub fn set_tags(&self, path: &str, tags: &[String]) -> rusqlite::Result<()> {
        let joined = tags.join(",");
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE documents SET tags = ?1 WHERE path = ?2",
            params![joined, path],
        )?;
        Ok(())
    }

    /// 全库标签聚合(标签, 文档数),按数量倒序
    pub fn all_tags(&self) -> rusqlite::Result<Vec<(String, usize)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT tags FROM documents")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for row in rows {
            for tag in row?.split(',') {
                if !tag.is_empty() {
                    *counts.entry(tag.to_string()).or_insert(0) += 1;
                }
            }
        }
        let mut out: Vec<(String, usize)> = counts.into_iter().collect();
        out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        Ok(out)
    }

    /// 按标签查文档。用 instr 精确匹配分隔片段,避免 LIKE 通配符误判。
    pub fn docs_by_tag(&self, tag: &str, limit: usize) -> rusqlite::Result<Vec<DocRow>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "{SELECT_COLS} FROM documents
             WHERE instr(',' || tags || ',', ',' || ?1 || ',') > 0
             ORDER BY last_read_at DESC, mtime DESC LIMIT ?2"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params![tag, limit as i64], row_to_doc)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /* ---------------- 双链 ---------------- */

    /// 覆盖写入某文档的出链(先删旧条目)
    pub fn set_links(&self, source: &str, targets: &[String]) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM links WHERE source_id = ?1", params![source])?;
        for target in targets {
            tx.execute(
                "INSERT OR IGNORE INTO links (source_id, target_path) VALUES (?1, ?2)",
                params![source, target],
            )?;
        }
        tx.commit()
    }

    /// 某文档的所有出链目标(归一化形式)
    pub fn links_from(&self, source: &str) -> rusqlite::Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT target_path FROM links WHERE source_id = ?1 ORDER BY target_path",
        )?;
        let rows = stmt
            .query_map(params![source], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 反链:哪些文档链接到目标文档。target 为文档路径(带扩展名),
    /// 内部按 links 表的归一化形式查询。
    pub fn backlinks(&self, target_path: &str) -> rusqlite::Result<Vec<String>> {
        let normalized = strip_ext(target_path);
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT DISTINCT source_id FROM links WHERE target_path = ?1 ORDER BY source_id",
        )?;
        let rows = stmt
            .query_map(params![normalized], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 按标题找文档路径(双链解析的兜底:同名文档可放在任意目录)
    pub fn find_by_title(&self, title: &str) -> rusqlite::Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT path FROM documents WHERE title = ?1 LIMIT 1",
            params![title],
            |r| r.get(0),
        )
        .optional()
        .map_err(Into::into)
    }

    /// 全文检索。返回 (路径, 已用 `<mark>` 标记命中词的片段)。
    ///
    /// 索引使用 trigram 分词(见 migrate 注释),因此:
    /// - 查询须≥3 字符,否则 trigram 无法切分;
    /// - 查询串不能含 FTS5 语法字符与空白,否则整条查询报错。
    /// 短查询退化为 LIKE 扫描,保证功能可用。
    ///
    /// 注意:trigram 下 FTS5 的 `snippet()`/`highlight()` **不插入标记**
    /// (它按三元组而非词边界着色),故高亮由 [`mark_snippet`] 自行完成。
    pub fn search(&self, query: &str, limit: usize) -> rusqlite::Result<Vec<(String, String)>> {
        let cleaned: String = query
            .chars()
            .filter(|c| {
                !c.is_whitespace()
                    && !matches!(
                        c,
                        '"' | '\'' | '*' | '(' | ')' | ':' | '^' | '-' | '!' | '+' | '.' | ','
                    )
            })
            .collect();

        if cleaned.is_empty() {
            return Ok(Vec::new());
        }

        let conn = self.conn.lock().unwrap();

        // 长度不足 trigram 阈值,退化为 LIKE 扫描
        let rows: Vec<(String, String)> = if cleaned.chars().count() < 3 {
            let mut stmt = conn.prepare(
                "SELECT path, content FROM fts WHERE content LIKE ?1 LIMIT ?2",
            )?;
            let pattern = format!("%{cleaned}%");
            let out = stmt
                .query_map(params![pattern, limit as i64], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            out
        } else {
            let mut stmt = conn.prepare(
                "SELECT path, content FROM fts WHERE fts MATCH ?1 ORDER BY rank LIMIT ?2",
            )?;
            let out = stmt
                .query_map(params![cleaned, limit as i64], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            out
        };

        Ok(rows
            .into_iter()
            .map(|(path, content)| {
                let snippet = excerpt_around(&content, &cleaned);
                (path, mark_snippet(&snippet, &cleaned))
            })
            .collect())
    }
}

/// 截取命中位置附近的上下文,便于前端展示结果片段。
fn excerpt_around(content: &str, needle: &str) -> String {
    const RADIUS: usize = 60;
    let total = content.chars().count();
    let needle_lower = needle.to_lowercase();

    match find_ci(content, &needle_lower) {
        // hit 是字符偏移,可直接用于 chars().skip/take
        Some(hit) => {
            let start = hit.saturating_sub(RADIUS);
            let end = (hit + RADIUS * 2).min(total);
            let text: String = content.chars().skip(start).take(end - start).collect();
            format!(
                "{}{}{}",
                if start > 0 { "…" } else { "" },
                text.replace('\n', " "),
                if end < total { "…" } else { "" }
            )
        }
        None => {
            let text: String = content.chars().take(RADIUS * 2).collect();
            text.replace('\n', " ")
        }
    }
}

/// 把片段中所有命中词包进 `<mark>`。
///
/// FTS5 的 trigram 分词器不提供高亮标记(见 [`Db::search`] 注释),
/// 故在此自行标记;命中词本身做 HTML 转义,防止文档内容破坏结构。
fn mark_snippet(snippet: &str, needle: &str) -> String {
    if needle.is_empty() {
        return escape_html(snippet);
    }
    let needle_lower = needle.to_lowercase();
    let mut out = String::with_capacity(snippet.len() * 2);
    let mut rest = snippet;

    // 按「字符」而非字节推进:大小写转换可能改变字节长度,
    // 用字节偏移切原串会在非 ASCII 文本上错位。
    while let Some(hit_chars) = find_ci(rest, &needle_lower) {
        let (head, tail) = split_at_chars(rest, hit_chars);
        out.push_str(&escape_html(&head));

        let (hit, after) = split_at_chars(tail, needle_lower.chars().count());
        out.push_str("<mark>");
        out.push_str(&escape_html(&hit));
        out.push_str("</mark>");
        rest = after;
    }
    out.push_str(&escape_html(rest));
    out
}

/// 在 `haystack` 中大小写不敏感查找 `needle`,返回其字符起始位置。
fn find_ci(haystack: &str, needle_lower: &str) -> Option<usize> {
    if needle_lower.is_empty() {
        return None;
    }
    let hay_lower = haystack.to_lowercase();
    // to_lowercase 不改变字符数,故字符偏移可直接沿用
    let byte_pos = hay_lower.find(needle_lower)?;
    Some(hay_lower[..byte_pos].chars().count())
}

/// 按字符数切分,返回 (前 n 个字符, 余下部分),均为原串的切片。
fn split_at_chars(s: &str, n: usize) -> (&str, &str) {
    match s.char_indices().nth(n) {
        Some((idx, _)) => (&s[..idx], &s[idx..]),
        None => (s, ""),
    }
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn row_to_doc(row: &rusqlite::Row<'_>) -> rusqlite::Result<DocRow> {
    Ok(DocRow {
        path: row.get(0)?,
        title: row.get(1)?,
        size: row.get(2)?,
        mtime: row.get(3)?,
        read_progress: row.get(4)?,
        starred: row.get::<_, i64>(5)? != 0,
        last_read_at: row.get(6)?,
    })
}

/// 与前端 `DocumentMeta` 对应的行结构。
#[derive(Debug, Clone)]
pub struct DocRow {
    pub path: String,
    pub title: String,
    pub size: i64,
    pub mtime: i64,
    pub last_read_at: i64,
    pub read_progress: f64,
    pub starred: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(path: &str, size: i64, mtime: i64) -> DocRow {
        DocRow {
            path: path.to_string(),
            title: path.to_string(),
            size,
            mtime,
            last_read_at: 0,
            read_progress: 0.0,
            starred: false,
        }
    }

    #[test]
    fn 写入后可读回() {
        let db = Db::open_in_memory().unwrap();
        db.upsert_meta(&row("a.md", 10, 100)).unwrap();
        let got = db.get_meta("a.md").unwrap().unwrap();
        assert_eq!(got.path, "a.md");
        assert_eq!(got.size, 10);
        assert_eq!(got.mtime, 100);
    }

    #[test]
    fn 不存在的文档返回_none() {
        let db = Db::open_in_memory().unwrap();
        assert!(db.get_meta("nope.md").unwrap().is_none());
    }

    #[test]
    fn 重复写入为更新而非插入() {
        let db = Db::open_in_memory().unwrap();
        db.upsert_meta(&row("a.md", 10, 100)).unwrap();
        db.upsert_meta(&row("a.md", 20, 200)).unwrap();
        let got = db.get_meta("a.md").unwrap().unwrap();
        assert_eq!(got.size, 20);
        assert_eq!(got.mtime, 200);
    }

    #[test]
    fn 阅读时间单调递增() {
        let db = Db::open_in_memory().unwrap();
        let mut a = row("a.md", 1, 1);
        a.last_read_at = 500;
        db.upsert_meta(&a).unwrap();

        // 更小的值不应冲掉「最近阅读」顺序
        let mut b = row("a.md", 2, 2);
        b.last_read_at = 100;
        db.upsert_meta(&b).unwrap();
        assert_eq!(db.get_meta("a.md").unwrap().unwrap().last_read_at, 500);

        // 更大的值应生效
        let mut c = row("a.md", 3, 3);
        c.last_read_at = 900;
        db.upsert_meta(&c).unwrap();
        assert_eq!(db.get_meta("a.md").unwrap().unwrap().last_read_at, 900);
    }

    #[test]
    fn 收藏状态可往返() {
        let db = Db::open_in_memory().unwrap();
        let mut r = row("a.md", 1, 1);
        r.starred = true;
        db.upsert_meta(&r).unwrap();
        assert!(db.get_meta("a.md").unwrap().unwrap().starred);
    }

    #[test]
    fn 收藏列表只含收藏文档且按阅读时间倒序() {
        let db = Db::open_in_memory().unwrap();
        let mut a = row("a.md", 1, 1);
        a.starred = true;
        a.last_read_at = 100;
        let mut b = row("b.md", 1, 1);
        b.starred = true;
        b.last_read_at = 300;
        db.upsert_meta(&a).unwrap();
        db.upsert_meta(&b).unwrap();
        db.upsert_meta(&row("c.md", 1, 1)).unwrap();

        let list = db.starred().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].path, "b.md");
        assert_eq!(list[1].path, "a.md");
    }

    #[test]
    fn 双链写入与反链查询() {
        let db = Db::open_in_memory().unwrap();
        db.upsert_meta(&row("甲.md", 1, 1)).unwrap();
        db.upsert_meta(&row("乙.md", 1, 1)).unwrap();

        db.set_links("甲.md", &["乙".into(), "不存在".into()]).unwrap();
        // 出链按目标排序,保证顺序稳定
        assert_eq!(db.links_from("甲.md").unwrap(), vec!["不存在", "乙"]);
        // 反链按归一化目标匹配(路径去扩展名)
        assert_eq!(db.backlinks("乙.md").unwrap(), vec!["甲.md"]);

        // 覆盖写入:旧目标被清除
        db.set_links("甲.md", &["丙".into()]).unwrap();
        assert_eq!(db.links_from("甲.md").unwrap(), vec!["丙"]);
        assert!(db.backlinks("乙.md").unwrap().is_empty());
    }

    #[test]
    fn 删除元数据连带清除出链() {
        let db = Db::open_in_memory().unwrap();
        db.upsert_meta(&row("甲.md", 1, 1)).unwrap();
        db.set_links("甲.md", &["乙".into()]).unwrap();
        db.remove_meta("甲.md").unwrap();
        assert!(db.links_from("甲.md").unwrap().is_empty());
    }

    #[test]
    fn 标签写入聚合与查询() {
        let db = Db::open_in_memory().unwrap();
        db.upsert_meta(&row("甲.md", 1, 1)).unwrap();
        db.upsert_meta(&row("乙.md", 1, 1)).unwrap();
        db.set_tags("甲.md", &["读书".into(), "方法论".into()]).unwrap();
        db.set_tags("乙.md", &["读书".into()]).unwrap();

        let all = db.all_tags().unwrap();
        assert_eq!(all[0], ("读书".to_string(), 2));
        assert_eq!(all.len(), 2);

        let docs = db.docs_by_tag("读书", 10).unwrap();
        assert_eq!(docs.len(), 2);
        assert!(db.docs_by_tag("不存在的标签", 10).unwrap().is_empty());
    }

    #[test]
    fn 标签查询不受下划线通配影响() {
        let db = Db::open_in_memory().unwrap();
        db.upsert_meta(&row("甲.md", 1, 1)).unwrap();
        db.set_tags("甲.md", &["a_b".into()]).unwrap();
        // 下划线在 LIKE 中是通配符,这里必须精确匹配
        assert!(db.docs_by_tag("axb", 10).unwrap().is_empty());
        assert_eq!(db.docs_by_tag("a_b", 10).unwrap().len(), 1);
    }

    #[test]
    fn 按标题查找文档() {
        let db = Db::open_in_memory().unwrap();
        let mut r = row("子目录/甲.md", 1, 1);
        r.title = "甲".into();
        db.upsert_meta(&r).unwrap();
        assert_eq!(db.find_by_title("甲").unwrap().as_deref(), Some("子目录/甲.md"));
        assert!(db.find_by_title("不存在").unwrap().is_none());
    }

    #[test]
    fn 最近阅读按时间倒序() {
        let db = Db::open_in_memory().unwrap();
        for (path, t) in [("a.md", 300), ("b.md", 200), ("c.md", 100)] {
            let mut r = row(path, 1, 1);
            r.last_read_at = t;
            db.upsert_meta(&r).unwrap();
        }
        let list = db.recent(10).unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].path, "a.md");
        assert_eq!(list[2].path, "c.md");
    }

    #[test]
    fn 最近阅读受limit限制() {
        let db = Db::open_in_memory().unwrap();
        for i in 0..5 {
            let mut r = row(&format!("f{i}.md"), 1, 1);
            r.last_read_at = i;
            db.upsert_meta(&r).unwrap();
        }
        assert_eq!(db.recent(2).unwrap().len(), 2);
    }

    #[test]
    fn 索引后可检索() {
        let db = Db::open_in_memory().unwrap();
        db.index_content("a.md", "这里是关于 Rust 编程的内容").unwrap();
        let hits = db.search("Rust", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, "a.md");
        assert!(hits[0].1.contains("Rust"));
    }

    #[test]
    fn 检索片段带上下文() {
        let db = Db::open_in_memory().unwrap();
        db.index_content("a.md", "第一行无关内容 第二行包含目标词 第三行")
            .unwrap();
        let hits = db.search("目标词", 10).unwrap();
        assert_eq!(hits.len(), 1);
        // 片段应含命中词附近的上下文,而非全文
        assert!(hits[0].1.contains("目标词"));
        assert!(hits[0].1.contains("第二行"));
    }

    #[test]
    fn 重新索引替换旧内容() {
        let db = Db::open_in_memory().unwrap();
        db.index_content("a.md", "旧内容 关键词").unwrap();
        db.index_content("a.md", "新内容").unwrap();
        // 旧关键词不应再命中
        assert!(db.search("关键词", 10).unwrap().is_empty());
        assert_eq!(db.search("新内容", 10).unwrap().len(), 1);
    }

    #[test]
    fn 从索引与元数据中移除() {
        let db = Db::open_in_memory().unwrap();
        db.index_content("a.md", "内容").unwrap();
        db.upsert_meta(&row("a.md", 1, 1)).unwrap();
        db.remove_from_index("a.md").unwrap();
        db.remove_meta("a.md").unwrap();
        assert!(db.search("内容", 10).unwrap().is_empty());
        assert!(db.get_meta("a.md").unwrap().is_none());
    }

    #[test]
    fn 空查询返回空结果() {
        let db = Db::open_in_memory().unwrap();
        db.index_content("a.md", "内容").unwrap();
        assert!(db.search("", 10).unwrap().is_empty());
        assert!(db.search("   ", 10).unwrap().is_empty());
    }

    #[test]
    fn 特殊字符查询不报错() {
        let db = Db::open_in_memory().unwrap();
        db.index_content("a.md", "内容").unwrap();
        // FTS5 语法字符若不清理会导致查询报错
        for q in ["\"引号\"", "a*b", "(括号)", "a:b", "^", "-", "!", "+"] {
            let _ = db.search(q, 10);
        }
    }

    #[test]
    fn 中文可被检索() {
        let db = Db::open_in_memory().unwrap();
        db.index_content("a.md", "本地优先的阅读器").unwrap();
        assert_eq!(db.search("阅读器", 10).unwrap().len(), 1);
    }

    #[test]
    fn 中文子串可被检索() {
        let db = Db::open_in_memory().unwrap();
        db.index_content("a.md", "这是一个关于性能优化的长篇技术笔记").unwrap();
        // 截取中间一段作为查询词
        assert_eq!(db.search("性能优化", 10).unwrap().len(), 1);
    }

    #[test]
    fn 短查询退化为like扫描仍可命中() {
        let db = Db::open_in_memory().unwrap();
        db.index_content("a.md", "本地优先的阅读器").unwrap();
        // 少于 3 字符,trigram 无法切分,但功能仍须可用
        assert_eq!(db.search("阅读", 10).unwrap().len(), 1);
    }

    #[test]
    fn 含空格的查询可用() {
        let db = Db::open_in_memory().unwrap();
        db.index_content("a.md", "hello world example").unwrap();
        assert_eq!(db.search("hello", 10).unwrap().len(), 1);
    }

    #[test]
    fn 跨文档检索() {
        let db = Db::open_in_memory().unwrap();
        db.index_content("a.md", "第一个文档关于 渲染管线")
            .unwrap();
        db.index_content("b.md", "第二个文档关于 渲染管线").unwrap();
        assert_eq!(db.search("渲染管线", 10).unwrap().len(), 2);
    }

    #[test]
    fn 无匹配返回空() {
        let db = Db::open_in_memory().unwrap();
        db.index_content("a.md", "内容").unwrap();
        assert!(db.search("绝对不存在的词xyz", 10).unwrap().is_empty());
    }

    #[test]
    fn 检索片段带mark标记() {
        let db = Db::open_in_memory().unwrap();
        db.index_content("a.md", "第一行无关内容 第二行包含目标词 第三行")
            .unwrap();
        let hits = db.search("目标词", 10).unwrap();
        assert_eq!(hits.len(), 1);
        // trigram 下 FTS5 不出标记,由 mark_snippet 自行标记
        assert!(hits[0].1.contains("<mark>目标词</mark>"), "实际: {}", hits[0].1);
    }

    #[test]
    fn 片段中多处命中全部标记() {
        let db = Db::open_in_memory().unwrap();
        db.index_content("a.md", "aaa 目标词 bbb 目标词 ccc").unwrap();
        let hits = db.search("目标词", 10).unwrap();
        assert_eq!(hits[0].1.matches("<mark>").count(), 2);
    }

    #[test]
    fn 标记时对内容做html转义() {
        let db = Db::open_in_memory().unwrap();
        // 文档内容含尖括号,不应破坏返回的 HTML 结构
        db.index_content("a.md", "<script>alert(1)</script> 目标词")
            .unwrap();
        let hits = db.search("目标词", 10).unwrap();
        assert!(hits[0].1.contains("&lt;script&gt;"));
        assert!(!hits[0].1.contains("<script>"));
    }

    #[test]
    fn 片段保留上下文且不长于全文() {
        let db = Db::open_in_memory().unwrap();
        let filler = "前置内容".repeat(60); // 远超片段半径
        db.index_content("a.md", &format!("{filler} 目标词 {filler}"))
            .unwrap();
        let hits = db.search("目标词", 10).unwrap();
        assert!(hits[0].1.contains("<mark>目标词</mark>"));
        // 命中词应在片段内,且片段被省略号截断(未返回全文)
        assert!(hits[0].1.contains('…'));
        // 按字符数比较:半径 60 字符 ×2 + 省略号,远小于全文(480 字符)
        assert!(hits[0].1.chars().count() < 200);
    }

    #[test]
    fn 检索结果大小写不敏感() {
        let db = Db::open_in_memory().unwrap();
        db.index_content("a.md", "WindMD Reader").unwrap();
        assert_eq!(db.search("windmd", 10).unwrap().len(), 1);
    }

    #[test]
    fn 列出全部路径() {
        let db = Db::open_in_memory().unwrap();
        db.upsert_meta(&row("a.md", 1, 1)).unwrap();
        db.upsert_meta(&row("b.md", 1, 1)).unwrap();
        let mut paths = db.all_paths().unwrap();
        paths.sort();
        assert_eq!(paths, vec!["a.md".to_string(), "b.md".to_string()]);
    }

    /// 规划 3.1 验收项:1 万文件库全文检索 ≤ 200ms。
    /// 只度量查询本身 —— 索引构建是后台增量任务,不计入交互延迟。
    /// 这是「唯一可能触发架构返工」的项:若超时,说明 trigram + FTS5
    /// 方案在万级规模下不成立,须提前换 Tantivy。
    #[test]
    fn 万级文档库检索延迟() {
        let db = Db::open_in_memory().unwrap();
        let filler = "这是一段用于填充的中文技术笔记内容".repeat(10); // 每篇约 200 字
        for i in 0..10_000 {
            let path = format!("文档{i:05}.md");
            db.upsert_meta(&row(&path, filler.len() as i64, i)).unwrap();
            // 10% 的文档包含目标词,模拟真实库的命中密度
            let content = if i % 10 == 0 {
                format!("{filler} 性能优化基准 {filler}")
            } else {
                filler.clone()
            };
            db.index_content(&path, &content).unwrap();
        }

        let t0 = std::time::Instant::now();
        let hits = db.search("性能优化", 50).unwrap();
        let elapsed = t0.elapsed();

        assert_eq!(hits.len(), 50, "limit 应生效(命中约 1000 篇)");
        assert!(
            elapsed.as_millis() < 200,
            "万级库检索耗时 {}ms,超过 200ms 预算",
            elapsed.as_millis()
        );

        // 短查询走 LIKE 退化路径,单独记录耗时(不设硬性预算)
        let t1 = std::time::Instant::now();
        let _ = db.search("渲染", 50).unwrap();
        eprintln!(
            "[压测] 万级库: FTS 查询 {}ms / LIKE 退化查询 {}ms",
            elapsed.as_millis(),
            t1.elapsed().as_millis()
        );
    }
}