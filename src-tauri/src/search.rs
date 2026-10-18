//! 检索:走 SQLite FTS5,返回带上下文片段的结果。
//!
//! 搜索模块独立成层,便于将来把后端换成 Tantivy 而不动前端接口
//! (见规划 4.4:接口抽象留升级位)。

use crate::db::Db;
use crate::error::Result;
use std::sync::Arc;
use std::time::Instant;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub snippet: String,
    pub line: i64,
    pub score: f64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub total: usize,
    pub hits: Vec<SearchHit>,
    pub took_ms: u128,
}

/// 执行检索。
///
/// 片段的高亮标记已在 `db::search` 内完成(见该函数的 trigram 说明),
/// 这里只负责耗时统计与行号推算。
pub fn search(db: &Arc<Db>, query: &str, limit: usize) -> Result<SearchResult> {
    let t0 = Instant::now();
    let rows = db.search(query, limit)?;
    let took_ms = t0.elapsed().as_millis();

    let hits: Vec<SearchHit> = rows
        .into_iter()
        .map(|(path, snippet)| SearchHit {
            line: snippet
                .split('\n')
                .position(|l| l.contains("<mark>"))
                .map(|i| i as i64 + 1)
                .unwrap_or(0),
            path,
            snippet,
            // FTS5 的 rank 已用于排序;此处统一给 1,前端只用它做稳定排序
            score: 1.0,
        })
        .collect();

    let total = hits.len();
    Ok(SearchResult { total, hits, took_ms })
}