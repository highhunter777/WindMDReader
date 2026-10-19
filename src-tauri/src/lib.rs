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

use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, Manager};

/// 应用数据目录(库索引与阅读进度的存放位置)
fn data_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().inspect(|d| {
        let _ = std::fs::create_dir_all(d);
    })
}

/// 可被文件关联唤起、且确实存在的文档
fn is_openable(path: &Path) -> bool {
    path.is_file()
        && path
            .file_name()
            .is_some_and(|n| fs::is_markdown(&n.to_string_lossy()))
}

/// 从完整命令行里挑出文档路径(第一项是可执行文件)
fn markdown_arg<I, S>(args: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: Into<PathBuf>,
{
    args.into_iter()
        .skip(1)
        .map(Into::into)
        .find(|p| is_openable(p))
}

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 文件关联/命令行送来的路径:记进待打开槽并通知前端。
///
/// 启动时前端可能还没注册监听,所以路径同时留在 `AppState` 里,
/// 由前端启动后调用 `take_open_file` 取走;运行中则靠事件即时打开。
fn queue_open(app: &tauri::AppHandle, path: PathBuf) {
    focus_main_window(app);
    if !is_openable(&path) {
        return;
    }
    let abs = path.to_string_lossy().to_string();
    if let Some(state) = app.try_state::<commands::AppState>() {
        state.set_pending_open(abs.clone());
    }
    let _ = app.emit("open-file", abs);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // 必须第一个注册:晚于其他插件时第二个实例的 setup 会先跑一遍
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // 第二个实例把文件路径转发给已开窗口后自行退出
            match markdown_arg(args) {
                Some(path) => queue_open(app, path),
                None => focus_main_window(app),
            }
        }))
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

            // Windows/Linux 双击关联文件时路径在启动参数里;
            // macOS 由下面的 RunEvent::Opened 送达
            if let Some(path) = markdown_arg(std::env::args_os()) {
                queue_open(app.handle(), path);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_vault,
            commands::open_path,
            commands::take_open_file,
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
        .build(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");

    app.run(|app_handle, event| {
        // macOS 的 Finder/浏览器通过 Opened 事件交付文件,不经过命令行
        #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
        if let tauri::RunEvent::Opened { urls } = event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    queue_open(app_handle, path);
                }
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
        let _ = (app_handle, event);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("windmd-open-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn 从命令行参数中选出文档路径() {
        let dir = tmp_dir("args");
        let a = dir.join("a.md");
        let b = dir.join("b.markdown");
        let img = dir.join("c.png");
        std::fs::write(&a, "# a").unwrap();
        std::fs::write(&b, "# b").unwrap();
        std::fs::write(&img, "x").unwrap();

        let args = vec![
            "WindMD.exe".to_string(),
            "--some-flag".to_string(),
            img.to_string_lossy().to_string(),
            a.to_string_lossy().to_string(),
            b.to_string_lossy().to_string(),
        ];
        assert_eq!(markdown_arg(args), Some(a));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 非文档与不存在的路径被忽略() {
        let dir = tmp_dir("ignore");
        let img = dir.join("c.png");
        std::fs::write(&img, "x").unwrap();
        assert_eq!(
            markdown_arg(vec!["WindMD.exe".to_string(), img.to_string_lossy().to_string()]),
            None
        );
        assert_eq!(
            markdown_arg(vec!["WindMD.exe".to_string(), dir.join("missing.md").to_string_lossy().to_string()]),
            None
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}