//! 后台索引:扫描库目录,把文档内容写入 FTS 表。
//!
//! 采用增量策略 —— 以 (mtime, size) 判断是否需要重建索引,
//! 大部分文档在日常使用中不会被重新索引。

use crate::db::{Db, DocRow};
use crate::fs::{is_markdown, Fs};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

/// 全量重建索引。返回已索引的文档数。
pub fn reindex_all(fs: &Fs, db: &Arc<Db>) -> rusqlite::Result<usize> {
    let mut count = 0usize;
    for abs in walkdir::WalkDir::new(fs.root())
        .into_iter()
        .filter_map(std::result::Result::ok)
        .filter(|e| e.file_type().is_file())
    {
        let name = abs.file_name().to_string_lossy().to_string();
        if !is_markdown(&name) {
            continue;
        }
        let Some(rel) = crate::fs::relativize(fs.root(), abs.path()) else {
            continue;
        };
        if index_one(fs, db, &rel) {
            count += 1;
        }
    }
    Ok(count)
}

/// 索引单个文档;内容未变化则跳过。
///
/// 返回是否真的写了索引(用于统计)。
pub fn index_one(fs: &Fs, db: &Arc<Db>, rel_path: &str) -> bool {
    let Ok(meta) = std::fs::metadata(fs.root().join(rel_path)) else {
        // 文件可能已被删除,顺手清掉索引与元数据
        let _ = db.remove_from_index(rel_path);
        return false;
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let size = meta.len() as i64;

    // 增量判断:已存在且 size/mtime 未变则无需重写
    if let Ok(Some(prev)) = db.get_meta(rel_path) {
        if prev.size == size && prev.mtime == mtime {
            return false;
        }
    }

    let Ok(file) = fs.read(rel_path) else {
        return false;
    };

    // 阅读进度与收藏是用户数据,重新索引时必须保留
    let prev = db.get_meta(rel_path).ok().flatten();

    let doc = DocRow {
        path: rel_path.to_string(),
        // 标题取去掉扩展名的文件名;路径含目录时只取末段
        title: {
            let name = rel_path.rsplit('/').next().unwrap_or(rel_path);
            crate::fs::strip_ext(name).to_string()
        },
        size,
        mtime,
        last_read_at: prev.as_ref().map_or(0, |p| p.last_read_at),
        read_progress: prev.as_ref().map_or(0.0, |p| p.read_progress),
        starred: prev.as_ref().is_some_and(|p| p.starred),
    };
    let _ = db.upsert_meta(&doc);
    let _ = db.index_content(rel_path, &file.content);

    // 双链与标签随内容索引,保持增量一致
    let parsed = crate::links::parse(&file.content);
    let _ = db.set_tags(rel_path, &parsed.tags);
    let _ = db.set_links(rel_path, &parsed.links);
    true
}

/// 移除已不存在文件的元数据与索引。
pub fn prune_missing(fs: &Fs, db: &Arc<Db>) -> rusqlite::Result<usize> {
    let existing: HashSet<String> = walkdir::WalkDir::new(fs.root())
        .into_iter()
        .filter_map(std::result::Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| crate::fs::relativize(fs.root(), e.path()))
        .collect();

    let mut removed = 0;
    for path in db.all_paths()? {
        if !existing.contains(&path) {
            let _ = db.remove_from_index(&path);
            let _ = db.remove_meta(&path);
            removed += 1;
        }
    }
    Ok(removed)
}