//! 后台索引:扫描库目录,把文档内容写入 FTS 表。
//!
//! 采用增量策略 —— 以 (mtime, size) 判断是否需要重建索引,
//! 大部分文档在日常使用中不会被重新索引。
//!
//! 性能要点(大库实测,8600+ 篇 / 17 万文件):
//! - 遍历时**先按文件名判扩展名**再取 file_type:纯字符串比较,
//!   比先 is_file() 少一次元数据判定(实测 6.4s → 5.5s);
//! - `prune_missing` 不再单独遍历一遍库,而是复用 `reindex_all` 扫描时
//!   收集到的路径集合(原实现每趟启动要扫两遍库,白花一倍时间);
//! - 不做"跳过无关目录"的优化:那会漏掉 `Library/PackageCache` 之类
//!   目录下的文档(实测会少索引 1794 篇),宁可慢也不能丢文档。

use crate::db::{Db, DocRow};
use crate::fs::{is_markdown, Fs};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

/// 一次全库扫描的结果。
pub struct ScanOutcome {
    /// 本次真正写入/更新索引的文档数
    pub indexed: usize,
    /// 磁盘上实际存在的全部文档路径(供清理失联记录用)
    pub present: HashSet<String>,
    /// 是否被 `keep_going` 中途打断(打断时 `present` 不完整,不可用于清理)
    pub aborted: bool,
    /// 本次实际检查过的文档数(= present.len,单独给出便于统计)
    pub scanned: usize,
    /// 遍历过程中是否出现过错误(权限不足 / 路径过长等)
    ///
    /// 只要为 true,`present` 就**不能**用来清理失联记录 ——
    /// 遍历失败的那些路径不在集合里,看起来就像"文件已被删除",
    /// 直接清理会把它们的索引和阅读进度一起删掉(实测踩过:
    /// Windows 长路径导致的遍历错误让 5867 篇文档的索引被误删)。
    pub walk_errors: usize,
}

/// 全量重建索引,并顺带收集磁盘上现存的文档路径。
///
/// `keep_going` 每篇检查一次:切库后旧任务能及时停手,不把旧库数据写进新库。
///
/// 返回的 `present` 让调用方无需再遍历第二遍库就能清理失联记录 ——
/// 库越大这部分越值钱(本项目实测单趟遍历约 6 秒)。
///
/// **安全约束**:`present` 只有在 `aborted == false` 且 `walk_errors == 0`
/// 时才可用于清理。遍历错误必须被计数而不是静默丢弃,否则会误删索引。
pub fn reindex_all(
    fs: &Fs,
    db: &Arc<Db>,
    mut keep_going: impl FnMut() -> bool,
) -> rusqlite::Result<ScanOutcome> {
    let mut indexed = 0usize;
    let mut scanned = 0usize;
    let mut present: HashSet<String> = HashSet::new();
    let mut aborted = false;
    let mut walk_errors = 0usize;

    for entry in walkdir::WalkDir::new(fs.root()).into_iter() {
        // 遍历错误不能静默丢弃:计数后继续,但会让本次结果不可用于清理
        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                walk_errors += 1;
                continue;
            }
        };
        // 先判扩展名(纯字符串),命中率极低,可省掉绝大多数 is_file 判定
        let name = entry.file_name().to_string_lossy();
        if !is_markdown(&name) {
            continue;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        if !keep_going() {
            aborted = true;
            break;
        }
        let Some(rel) = crate::fs::relativize(fs.root(), entry.path()) else {
            walk_errors += 1;
            continue;
        };
        present.insert(rel.clone());
        scanned += 1;
        if index_one(fs, db, &rel) {
            indexed += 1;
        }
    }

    Ok(ScanOutcome {
        indexed,
        present,
        aborted,
        scanned,
        walk_errors,
    })
}

/// 移除已不存在文件的元数据与索引。
///
/// `present` 由 [`reindex_all`] 的同一趟扫描收集,避免重复遍历库目录。
pub fn prune_missing(db: &Arc<Db>, present: &HashSet<String>) -> rusqlite::Result<usize> {
    let mut removed = 0;
    for path in db.all_paths()? {
        if !present.contains(&path) {
            let _ = db.remove_from_index(&path);
            let _ = db.remove_meta(&path);
            removed += 1;
        }
    }
    Ok(removed)
}

/// 索引单个文档;内容未变化则跳过。
///
/// 返回是否真的写了索引(用于统计)。
pub fn index_one(fs: &Fs, db: &Arc<Db>, rel_path: &str) -> bool {
    let Ok(meta) = std::fs::metadata(fs.root().join(rel_path)) else {
        // 文件可能已被删除;只清全文索引,元数据留给 prune_missing,
        // 避免编辑器原子保存时的瞬时缺失把收藏/阅读进度一起删掉
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

    // 增量判断:已存在且 size/mtime 未变则无需重写。
    // 这也是"常态启动"最关键的短路 —— 未变化的文档到此为止,不读盘不写库。
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("windmd-idx-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// 建库 + 若干文档,返回 (根目录, db)
    fn setup(name: &str) -> (std::path::PathBuf, Arc<Db>) {
        let root = tmp(name);
        fs::create_dir_all(root.join("sub/deep")).unwrap();
        fs::write(root.join("a.md"), "# a\n").unwrap();
        fs::write(root.join("sub/b.markdown"), "# b\n").unwrap();
        // 深层目录里也要能索引到 —— 不做"跳过无关目录"的优化正是为了这个
        fs::write(root.join("sub/deep/c.txt"), "c\n").unwrap();
        // 非文档不应进索引
        fs::write(root.join("ignore.png"), "x").unwrap();
        let db = Arc::new(Db::open_in_memory().unwrap());
        (root, db)
    }

    #[test]
    fn 一次扫描索引全部文档且不漏深层目录() {
        let (root, db) = setup("all");
        let fs_root = Fs::new(&root);
        let out = reindex_all(&fs_root, &db, || true).unwrap();

        assert_eq!(out.indexed, 3, "三篇文档都应被索引");
        assert_eq!(out.present.len(), 3);
        assert!(!out.aborted);
        assert!(out.present.contains("a.md"));
        assert!(out.present.contains("sub/b.markdown"));
        assert!(out.present.contains("sub/deep/c.txt"));
        // 非文档不进索引
        assert!(!out.present.contains("ignore.png"));
        assert_eq!(db.count_docs().unwrap(), 3);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn 扫描结果自带的现存集合可直接用于清理失联记录() {
        // 这保证"清理"不需要再遍历一遍库(第 2 步的核心)
        let (root, db) = setup("prune");
        let fs_root = Fs::new(&root);
        let _ = reindex_all(&fs_root, &db, || true).unwrap();
        assert_eq!(db.count_docs().unwrap(), 3);

        // 删掉一篇后重扫,用同一趟结果清理
        fs::remove_file(root.join("a.md")).unwrap();
        let out2 = reindex_all(&fs_root, &db, || true).unwrap();
        let removed = prune_missing(&db, &out2.present).unwrap();

        assert_eq!(removed, 1, "a.md 的残留记录应被清掉");
        assert_eq!(db.count_docs().unwrap(), 2);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn 内容未变的文档不会被重复索引() {
        let (root, db) = setup("incr");
        let fs_root = Fs::new(&root);
        let first = reindex_all(&fs_root, &db, || true).unwrap();
        assert_eq!(first.indexed, 3);

        // 立刻再扫:mtime/size 未变,应全部短路
        let second = reindex_all(&fs_root, &db, || true).unwrap();
        assert_eq!(second.indexed, 0, "未变更的文档不应重写索引");
        assert_eq!(second.present.len(), 3, "但仍要收集到全部现存路径");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn 中断时如实标记为放弃() {
        let (root, db) = setup("abort");
        let fs_root = Fs::new(&root);
        let mut calls = 0;
        // 第一次检查就返回 false:模拟切库
        let out = reindex_all(&fs_root, &db, || {
            calls += 1;
            false
        }).unwrap();

        assert!(out.aborted, "被打断必须如实标记,否则会误删索引");
        assert_eq!(out.indexed, 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn 阅读进度与收藏在重索引后保留() {
        let (root, db) = setup("keep");
        let fs_root = Fs::new(&root);
        reindex_all(&fs_root, &db, || true).unwrap();

        // 模拟用户读过并收藏
        let mut row = db.get_meta("a.md").unwrap().unwrap();
        row.read_progress = 0.5;
        row.starred = true;
        row.last_read_at = 12345;
        db.upsert_meta(&row).unwrap();

        // 改动内容触发重索引
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(root.join("a.md"), "# a changed\n").unwrap();
        let out = reindex_all(&fs_root, &db, || true).unwrap();
        assert_eq!(out.indexed, 1);

        let after = db.get_meta("a.md").unwrap().unwrap();
        assert_eq!(after.read_progress, 0.5, "阅读进度不能丢");
        assert!(after.starred, "收藏不能丢");
        assert_eq!(after.last_read_at, 12345, "最近阅读时间不能丢");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn 遍历无错误时walk_errors为零() {
        let (root, db) = setup("noerr");
        let fs_root = Fs::new(&root);
        let out = reindex_all(&fs_root, &db, || true).unwrap();
        assert_eq!(out.walk_errors, 0, "正常库不应报遍历错误");
        assert_eq!(out.present.len(), 3);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn 清理必须排除不完整集合的情况() {
        // 回归(真实事故):walkdir 的遍历错误曾被 filter_map(Result::ok) 静默丢弃,
        // 导致 present 不完整 → prune_missing 把"遍历失败"误判为"文件已删除",
        // 实测误删了 5867 篇文档的索引与阅读进度。
        //
        // 这里锁住判定契约:只有 aborted=false 且 walk_errors=0 才允许清理。
        let (root, db) = setup("safety");
        let fs_root = Fs::new(&root);
        let out = reindex_all(&fs_root, &db, || true).unwrap();
        assert_eq!(db.count_docs().unwrap(), 3);

        let safe_to_prune = !out.aborted && out.walk_errors == 0;
        assert!(safe_to_prune, "完整扫描后应允许清理");

        // 构造一个"看起来不完整的集合"(模拟遍历漏掉文件)
        let mut partial = out.present.clone();
        partial.remove("a.md");
        // 若误用不完整集合清理,a.md 的记录会被删 —— 这在实现上必须靠
        // walk_errors/aborted 闸门拦住,而不是靠集合本身正确
        let removed = prune_missing(&db, &partial).unwrap();
        assert_eq!(removed, 1, "不完整集合确实会误删(说明闸门必不可少)");
        assert_eq!(db.count_docs().unwrap(), 2);
        let _ = fs::remove_dir_all(&root);
    }
}
