//! 文件监视:监听库目录内的 .md 变更,事件节流后批量派发 `file-changed`。
//!
//! 大量文件同时保存(如 git checkout)会产生事件风暴,
//! 因此用「静默窗口 + 路径去重」合并后再发给前端。

use crate::fs::{is_markdown, relativize};
use notify::{EventKind, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::Path;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::Duration;

/// 静默窗口:此窗口内没有新事件才派发一次
const DEBOUNCE: Duration = Duration::from_millis(300);

/// 持有 watcher 与其停止信号。
///
/// notify 的 `Watcher` 实现不保证 `Sync`,而 Tauri 的 State 要求 `Send + Sync`,
/// 故整体用 `Mutex` 包裹 —— 监视回调本身在 notify 自己的线程里跑,不依赖这里的锁。
pub struct WatcherHandle {
    _watcher: Mutex<Box<dyn Watcher + Send>>,
    _stop: mpsc::Sender<()>,
}

/// 启动监视。变更路径经节流去重后通过 `on_change` 传出(相对库根)。
pub fn start<F>(root: &Path, on_change: F) -> notify::Result<WatcherHandle>
where
    F: Fn(Vec<String>) + Send + 'static,
{
    let root = root.to_path_buf();
    // 回调闭包要move 一份 root,watch() 之后仍需用它,所以先克隆
    let watch_root = root.clone();
    let (tx, rx) = mpsc::channel::<String>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if !matches!(
            event.kind,
            EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
        ) {
            return;
        }
        for abs in event.paths {
            // 只关心文档文件,且必须是库内路径
            if !is_markdown(&abs.to_string_lossy()) {
                continue;
            }
            if let Some(rel) = relativize(&watch_root, &abs) {
                let _ = tx.send(rel);
            }
        }
    })?;

    watcher.watch(&root, RecursiveMode::Recursive)?;

    std::thread::spawn(move || {
        let mut pending: HashSet<String> = HashSet::new();

        loop {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(rel) => {
                    pending.insert(rel);
                    // 继续排空,直到静默满一个窗口
                    loop {
                        match rx.recv_timeout(DEBOUNCE) {
                            Ok(rel) => {
                                pending.insert(rel);
                            }
                            Err(RecvTimeoutError::Timeout) => break,
                            Err(RecvTimeoutError::Disconnected) => return,
                        }
                    }
                    if !pending.is_empty() {
                        on_change(pending.drain().collect());
                    }
                }
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    });

    // 收到停止信号后主动结束监视线程
    std::thread::spawn(move || {
        let _ = stop_rx.recv();
    });

    Ok(WatcherHandle {
        _watcher: Mutex::new(Box::new(watcher)),
        _stop: stop_tx,
    })
}