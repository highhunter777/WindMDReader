//! 库扫描状态:决定启动时能不能跳过全库扫描。
//!
//! 背景(实测):本项目用户的库有 8600+ 篇文档、17 万个文件,
//! 一次全库遍历约 6 秒。应用每次启动都无条件扫一遍,代价明显。
//!
//! 跳过扫描需要同时满足两个条件,任一不满足就老实全扫:
//!
//! 1. **同一个库**:记录里存着上次扫描的库根路径,和当前一致;
//! 2. **库没被动过**:库根目录的 mtime 与上次扫描时记录的一致。
//!
//! 为什么用库根 mtime 而不是"上次扫描时间"做比较:
//! 应用关闭期间如果增删了根目录下的文件/文件夹,库根 mtime 必然变化,
//! 这时会退回全量扫描。反过来,只要库根 mtime 没变,根目录结构就没动过,
//! 已有的 FTS 索引依然有效 —— 这比"固定时间窗"更贴近事实。
//!
//! 局限(明确写在这里,避免后人误以为万能):
//! - 只覆盖**根目录**结构的增删。若在深层子目录里增删文件而根目录 mtime 未变,
//!   这次启动不会发现;下次根目录变动时的全量扫描会补上。
//! - 因此这里只跳过"扫描",不跳过 watcher:本次运行期间的任何变更仍由
//!   watcher 实时增量索引,不受此判断影响。
//! - 用户可通过 [`force_rescan`] 主动作废记录(如怀疑索引不全)。

use crate::db::Db;

/// 记录"上次全库扫描"的库根路径
const KEY_ROOT: &str = "scan.root";
/// 记录扫描时库根目录的 mtime(毫秒时间戳)
const KEY_ROOT_MTIME: &str = "scan.root_mtime";

/// 取目录的 mtime(毫秒);读不到返回 None
fn dir_mtime_ms(path: &std::path::Path) -> Option<i64> {
    let meta = std::fs::metadata(path).ok()?;
    let t = meta.modified().ok()?;
    let d = t.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(d.as_millis() as i64)
}

/// 判断本次启动能否跳过全库扫描。
///
/// 返回 true 表示:库未变、已有索引可信,无需再遍历 17 万个文件。
pub fn can_skip_scan(db: &Db, root: &std::path::Path) -> bool {
    let Some(prev_root) = db.get_kv(KEY_ROOT).ok().flatten() else {
        return false; // 从没扫过:必须全扫
    };
    // 库根变了(切换库):必须对新库全扫
    if prev_root != root.to_string_lossy() {
        return false;
    }
    let Some(prev_mtime) = db
        .get_kv(KEY_ROOT_MTIME)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
    else {
        return false;
    };
    // 库根 mtime 变了 → 关闭期间根目录有增删,必须全扫
    match dir_mtime_ms(root) {
        Some(now) => now == prev_mtime,
        None => false, // 读不到就不冒险
    }
}

/// 记录一次成功的全量扫描(写库根路径与当前 mtime)。
pub fn mark_scanned(db: &Db, root: &std::path::Path, doc_count: usize) -> rusqlite::Result<()> {
    db.set_kv(KEY_ROOT, &root.to_string_lossy())?;
    let mtime = dir_mtime_ms(root).unwrap_or(0);
    db.set_kv(KEY_ROOT_MTIME, &mtime.to_string())?;
    db.set_kv("scan.doc_count", &doc_count.to_string())?;
    Ok(())
}

/// 作废扫描记录,强制下次启动全量重扫。
///
/// 供"怀疑索引不全"或数据结构升级后使用;当前无 UI 入口,
/// 保留函数以便将来接"重建索引"按钮。
#[allow(dead_code)]
pub fn force_rescan(db: &Db) -> rusqlite::Result<()> {
    db.set_kv(KEY_ROOT, "")?;
    db.set_kv(KEY_ROOT_MTIME, "0")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("windmd-scan-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn 从未扫描过时必须全扫() {
        let db = Db::open_in_memory().unwrap();
        let dir = tmp("never");
        assert!(!can_skip_scan(&db, &dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 扫描后库未变则可跳过() {
        let db = Db::open_in_memory().unwrap();
        let dir = tmp("same");
        mark_scanned(&db, &dir, 10).unwrap();
        assert!(can_skip_scan(&db, &dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 库根新增文件后不可跳过() {
        let db = Db::open_in_memory().unwrap();
        let dir = tmp("changed");
        mark_scanned(&db, &dir, 10).unwrap();
        assert!(can_skip_scan(&db, &dir));

        // 根目录加一个文件 → mtime 变化
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(dir.join("new.md"), "# new").unwrap();
        assert!(!can_skip_scan(&db, &dir), "根目录变动后必须重扫");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 换库后不可跳过() {
        let db = Db::open_in_memory().unwrap();
        let a = tmp("vault-a");
        let b = tmp("vault-b");
        mark_scanned(&db, &a, 5).unwrap();
        assert!(can_skip_scan(&db, &a));
        assert!(!can_skip_scan(&db, &b), "换成另一个库必须对新库全扫");
        let _ = fs::remove_dir_all(&a);
        let _ = fs::remove_dir_all(&b);
    }

    #[test]
    fn 强制重扫后不可跳过() {
        let db = Db::open_in_memory().unwrap();
        let dir = tmp("force");
        mark_scanned(&db, &dir, 3).unwrap();
        assert!(can_skip_scan(&db, &dir));
        force_rescan(&db).unwrap();
        assert!(!can_skip_scan(&db, &dir));
        let _ = fs::remove_dir_all(&dir);
    }
}
