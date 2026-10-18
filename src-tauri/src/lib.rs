//! WindMD Rust 后端。
//!
//! 模块划分对应规划文档 5.6:
//! - `fs` 文件读写 / 原子写入 / 回收站删除
//! - `watcher` 库目录变更监视(节流后派发)
//! - `db` SQLite 元数据 + FTS5 索引
//! - `indexer` 后台索引构建(增量)
//! - `links` 双链与标签解析
//! - `search` 检索 + 片段生成(接口抽象,便于将来换 Tantivy)
//! - `tts` 朗读:Windows 走常驻 PowerShell + SAPI,macOS/Linux 走命令行合成器
//! - `commands` Tauri IPC 面

mod commands;
mod db;
mod error;
mod fs;
mod indexer;
mod links;
mod search;
mod tts;
mod watcher;

use std::sync::Arc;
use tauri::Manager;

/// 应用数据目录(库索引与阅读进度的存放位置)
fn data_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().inspect(|d| {
        let _ = std::fs::create_dir_all(d);
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 数据库放在应用数据目录,路径形如 %APPDATA%/com.windmd.app/windmd.db
            let db = match data_dir(app.handle()) {
                Some(dir) => db::Db::open(&dir.join("windmd.db"))
                    .or_else(|_| db::Db::open_in_memory())
                    .expect("打开数据库失败"),
                None => db::Db::open_in_memory().expect("打开内存库失败"),
            };
            app.manage(commands::AppState::new(Arc::new(db)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_vault,
            commands::list_files,
            commands::read_file,
            commands::write_file,
            commands::create_file,
            commands::delete_file,
            commands::rename_file,
            commands::search,
            commands::get_meta,
            commands::set_meta,
            commands::recent_files,
            commands::starred_files,
            commands::get_links,
            commands::list_tags,
            commands::docs_by_tag,
            commands::tts_voices,
            commands::tts_say,
            commands::tts_pause,
            commands::tts_resume,
            commands::tts_cancel,
            commands::tts_supports_pause,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}