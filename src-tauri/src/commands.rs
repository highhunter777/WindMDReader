//! Tauri commands —— 前端 `src/ipc/tauri.ts` 通过 invoke 调用。
//!
//! 参数命名约定:Tauri 2 默认把 JS 侧的 camelCase 键映射为 Rust 的 snake_case,
//! 因此 `readProgress` 对应 `read_progress`。若对不上,前端会拿到 null。

use crate::db::{Db, DocRow};
use crate::error::{AppError, Result};
use crate::fs::{is_markdown, relativize, strip_ext, Fs};
use crate::{indexer, search, tts, watcher};
use serde::Serialize;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, State};

/// 全局应用状态。
///
/// `fs` 与监视器需在 command 中被替换(打开新库时),而 Tauri 的 `State`
/// 只提供不可变引用,故用 `Mutex` 包裹。
pub struct AppState {
    db: Arc<Db>,
    tts: Arc<tts::Speaker>,
    inner: Mutex<Inner>,
    /// 文件关联送来的绝对路径,等前端启动后取走
    pending_open: Mutex<Option<String>>,
}

struct Inner {
    fs: Option<Fs>,
    /// 保持在 alive 即维持监视;None 表示尚未打开库
    _watch: Option<watcher::WatcherHandle>,
}

impl AppState {
    pub fn new(db: Arc<Db>) -> Self {
        AppState {
            db,
            tts: Arc::new(tts::Speaker::new()),
            inner: Mutex::new(Inner {
                fs: None,
                _watch: None,
            }),
            pending_open: Mutex::new(None),
        }
    }

    /// 记录待打开文件(后到的覆盖先到的:一次只展示一篇)
    pub fn set_pending_open(&self, path: String) {
        if let Ok(mut p) = self.pending_open.lock() {
            *p = Some(path);
        }
    }

    /// 取走待打开文件;取后清空,避免前端重复打开
    pub fn take_pending_open(&self) -> Option<String> {
        self.pending_open.lock().ok().and_then(|mut p| p.take())
    }

    fn db(&self) -> &Arc<Db> {
        &self.db
    }

    /// 朗读器(朗读句会阻塞到结束,故内部自己串行化,这里只取共享句柄)
    fn speaker(&self) -> &Arc<tts::Speaker> {
        &self.tts
    }

    /// 取库引用;未打开库时返回 NoVault
    fn require_fs(&self) -> Result<MutexGuard<'_, Inner>> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| AppError::Io("状态锁已损坏".into()))?;
        if guard.fs.is_none() {
            return Err(AppError::NoVault);
        }
        Ok(guard)
    }

    /// 取库引用但不要求已打开库(打开流程自身用)
    fn lock(&self) -> Result<MutexGuard<'_, Inner>> {
        self.inner
            .lock()
            .map_err(|_| AppError::Io("状态锁已损坏".into()))
    }
}

/* ---------- 与前端类型对应的序列化结构 ---------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub name: String,
    pub root: String,
    pub file_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMeta {
    pub path: String,
    pub title: String,
    pub size: i64,
    pub mtime: i64,
    pub read_progress: f64,
    pub starred: bool,
}

#[derive(serde::Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MetaPatch {
    pub read_progress: Option<f64>,
    pub starred: Option<bool>,
}

/// 一个出链目标:归一化目标 + 是否已能解析到库内文档
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkTarget {
    /// 归一化目标(去扩展名与 #锚点)
    pub target: String,
    /// 解析到的文档路径;None 表示目标文件尚未创建
    pub resolved_path: Option<String>,
}

/// 某文档的双链视图:出链 + 反链
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocLinks {
    pub outgoing: Vec<LinkTarget>,
    pub backlinks: Vec<DocumentMeta>,
}

/// 标签聚合项
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagEntry {
    pub tag: String,
    pub count: usize,
}

/// 朗读参数(前端可选地只传其中一两项)
#[derive(serde::Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpeakOptions {
    /// SAPI 语速,-10..=10
    pub rate: Option<i32>,
    /// SAPI 音量,0..=100
    pub volume: Option<i32>,
    /// 音色名
    pub voice: Option<String>,
}

impl From<SpeakOptions> for tts::SpeakOptions {
    fn from(v: SpeakOptions) -> Self {
        tts::SpeakOptions {
            rate: v.rate,
            volume: v.volume,
            voice: v.voice,
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/* ---------- commands ---------- */

fn vault_info(root: &std::path::Path, fs: &Fs) -> VaultInfo {
    VaultInfo {
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| root.to_string_lossy().to_string()),
        root: root.to_string_lossy().to_string(),
        file_count: fs.count_markdown(),
    }
}

/// 打开(或切换到)一个库目录。为空时弹系统对话框选择。
///
/// **幂等**:无路径且库已打开时直接返回当前库信息,不弹框。
/// 前端组件重挂载会幂等调用本命令;若每次都弹模态框,会抢走焦点、
/// 吞掉用户随后的输入(如新建文件时的键入),表现为"操作无效"。
#[tauri::command]
pub fn open_vault(app: tauri::AppHandle, state: State<'_, AppState>, path: Option<String>) -> Result<VaultInfo> {
    let has_path = path.as_deref().is_some_and(|p| !p.is_empty());
    if !has_path {
        let guard = state.lock()?;
        if let Some(fs) = guard.fs.as_ref() {
            return Ok(vault_info(fs.root(), fs));
        }
    }

    let chosen = match path.filter(|p| !p.is_empty()) {
        Some(p) => p,
        None => pick_folder(&app)?,
    };
    open_root(&app, &state, std::path::PathBuf::from(chosen))
}

/// 打开(或切换)库根,重建索引并开启监视。
/// `open_vault` 与文件关联的 `open_path` 共用。
fn open_root(app: &tauri::AppHandle, state: &AppState, root: std::path::PathBuf) -> Result<VaultInfo> {
    if !root.is_dir() {
        return Err(AppError::InvalidPath(root.to_string_lossy().to_string()));
    }

    let fs = Fs::new(root.clone());
    let info = vault_info(&root, &fs);

    let db = state.db().clone();
    let _ = indexer::reindex_all(&fs, &db);
    let _ = indexer::prune_missing(&fs, &db);

    let app_for_watch = app.clone();
    let watch = watcher::start(&root, move |paths| {
        // 变更后增量重建索引,再通知前端
        let Some(tauri_state) = app_for_watch.try_state::<AppState>() else {
            return;
        };
        let Ok(inner) = tauri_state.lock() else { return };
        let Some(fs) = inner.fs.as_ref() else { return };
        for p in &paths {
            indexer::index_one(fs, &tauri_state.db, p);
        }
        drop(inner);
        let _ = app_for_watch.emit("file-changed", paths);
    })
    .ok();

    let mut guard = state.lock()?;
    guard.fs = Some(fs);
    guard._watch = watch;

    Ok(info)
}

/// 取走启动时文件关联送来的路径(取后清空)
#[tauri::command]
pub fn take_open_file(state: State<'_, AppState>) -> Option<String> {
    state.take_pending_open()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPathResult {
    pub vault: VaultInfo,
    /// 目标文件相对库根的路径
    pub path: String,
}

/// 打开系统送来的绝对文件路径:以所在目录为库,并定位到该文件。
#[tauri::command]
pub fn open_path(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<OpenPathResult> {
    let abs = normalize_abs(&path)?;
    let parent = abs
        .parent()
        .ok_or_else(|| AppError::InvalidPath(path.clone()))?
        .to_path_buf();

    // 文件就在当前库里(最常见:应用已开着):不重复重建索引
    {
        let guard = state.lock()?;
        if let Some(fs) = guard.fs.as_ref() {
            if same_dir(fs.root(), &parent) {
                if let Some(rel) = relativize(fs.root(), &abs) {
                    return Ok(OpenPathResult {
                        vault: vault_info(fs.root(), fs),
                        path: rel,
                    });
                }
            }
        }
    }

    let info = open_root(&app, &state, parent)?;
    let rel = relativize(std::path::Path::new(&info.root), &abs)
        .ok_or(AppError::InvalidPath(path))?;
    Ok(OpenPathResult { vault: info, path: rel })
}

/// 文件关联给的是绝对路径;`canonicalize` 同时完成存在性校验。
///
/// Windows 会返回 `\\?\C:\...` 前缀,必须去掉 —— 否则之后拼库根/相对化
/// 会得到带扩展前缀的路径,和常规路径对不上。
fn normalize_abs(path: &str) -> Result<std::path::PathBuf> {
    let p = std::path::PathBuf::from(path);
    if !p.is_absolute() {
        return Err(AppError::InvalidPath(path.to_string()));
    }
    let canonical = std::fs::canonicalize(&p).map_err(|_| AppError::NotFound(path.to_string()))?;
    if !canonical.is_file()
        || !canonical
            .file_name()
            .is_some_and(|n| is_markdown(&n.to_string_lossy()))
    {
        return Err(AppError::InvalidPath(path.to_string()));
    }
    Ok(strip_verbatim(canonical))
}

#[cfg(windows)]
fn strip_verbatim(p: std::path::PathBuf) -> std::path::PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return std::path::PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return std::path::PathBuf::from(rest);
    }
    p
}

#[cfg(not(windows))]
fn strip_verbatim(p: std::path::PathBuf) -> std::path::PathBuf {
    p
}

/// 两个目录是否同一位置(大小写/短路径/符号链接都按系统实际解析)
fn same_dir(a: &std::path::Path, b: &std::path::Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

#[tauri::command]
pub fn list_files(state: State<'_, AppState>, dir: String) -> Result<Vec<crate::fs::FileEntry>> {
    state.require_fs()?.fs.as_ref().expect("已校验").list(&dir)
}

#[tauri::command]
pub fn read_file(state: State<'_, AppState>, path: String) -> Result<crate::fs::OpenFile> {
    state.require_fs()?.fs.as_ref().expect("已校验").read(&path)
}

#[tauri::command]
pub fn write_file(state: State<'_, AppState>, path: String, content: String) -> Result<()> {
    state.require_fs()?.fs.as_ref().expect("已校验").write(&path, &content)
}

#[tauri::command]
pub fn create_file(state: State<'_, AppState>, path: String) -> Result<()> {
    let guard = state.require_fs()?;
    let fs = guard.fs.as_ref().expect("已校验");
    fs.create(&path)?;
    // 建完立即补索引:否则要等 watcher 消抖后 getMeta 才查得到这一行,
    // 前端紧接着打开这篇时标题/元数据全是空的。与 watcher 的 index_one
    // 幂等(内容未变化则跳过),不会冲突。
    indexer::index_one(fs, state.db(), &path);
    Ok(())
}

#[tauri::command]
pub fn delete_file(state: State<'_, AppState>, path: String) -> Result<()> {
    state.require_fs()?.fs.as_ref().expect("已校验").delete(&path)
}

/// 注意:`from`/`to` 是 Rust 关键字,故关闭 non_snake_case 检查。
/// 前端传 `{ from, to }`,Tauri 原样映射。
#[tauri::command]
#[allow(non_snake_case)]
pub fn rename_file(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Result<()> {
    let guard = state.require_fs()?;
    let fs = guard.fs.as_ref().expect("已校验");
    fs.rename(&from, &to)?;
    // 同 create_file:立即索引新路径,前端重命名后随即重开时元数据不缺
    // (旧路径行由 watcher 的 index_one 清理:metadata 失败即 remove_from_index)
    indexer::index_one(fs, state.db(), &to);
    Ok(())
}

#[tauri::command]
pub fn search(state: State<'_, AppState>, query: String) -> Result<search::SearchResult> {
    search::search(state.db(), &query, 50)
}

#[tauri::command]
pub fn get_meta(state: State<'_, AppState>, path: String) -> Result<Option<DocumentMeta>> {
    Ok(state.db().get_meta(&path)?.map(to_meta))
}

#[tauri::command]
pub fn set_meta(state: State<'_, AppState>, path: String, patch: MetaPatch) -> Result<()> {
    let existing = state.db().get_meta(&path)?;
    let name = path.rsplit('/').next().unwrap_or(&path);
    let (size, mtime) = existing.as_ref().map(|d| (d.size, d.mtime)).unwrap_or((0, 0));

    state.db().upsert_meta(&DocRow {
        path: path.clone(),
        title: strip_ext(name).to_string(),
        size,
        mtime,
        // 每次 set_meta 都意味着用户读了这份文档
        last_read_at: now_ms(),
        read_progress: patch
            .read_progress
            .or_else(|| existing.as_ref().map(|d| d.read_progress))
            .unwrap_or(0.0),
        starred: patch
            .starred
            .or_else(|| existing.as_ref().map(|d| d.starred))
            .unwrap_or(false),
    })?;
    Ok(())
}

#[tauri::command]
pub fn recent_files(state: State<'_, AppState>, limit: Option<usize>) -> Result<Vec<DocumentMeta>> {
    Ok(state
        .db()
        .recent(limit.unwrap_or(20))?
        .into_iter()
        .map(to_meta)
        .collect())
}

#[tauri::command]
pub fn starred_files(state: State<'_, AppState>) -> Result<Vec<DocumentMeta>> {
    Ok(state.db().starred()?.into_iter().map(to_meta).collect())
}

/// 解析链接目标到库内文档。
/// 依次尝试:精确路径 → 补 `.md` → 按标题匹配。
fn resolve_target(db: &Db, target: &str) -> rusqlite::Result<Option<String>> {
    for candidate in [target.to_string(), format!("{target}.md")] {
        if db.get_meta(&candidate)?.is_some() {
            return Ok(Some(candidate));
        }
    }
    // 标题匹配:同名文档可放在任意目录
    Ok(db.find_by_title(target)?)
}

/// 某文档的双链视图:出链(含解析状态)与反链
#[tauri::command]
pub fn get_links(state: State<'_, AppState>, path: String) -> Result<DocLinks> {
    let db = state.db();
    let outgoing = db
        .links_from(&path)?
        .into_iter()
        .map(|target| {
            Ok(LinkTarget {
                resolved_path: resolve_target(db, &target)?,
                target,
            })
        })
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let backlinks = db
        .backlinks(&path)?
        .into_iter()
        .filter_map(|p| db.get_meta(&p).ok().flatten())
        .map(to_meta)
        .collect();
    Ok(DocLinks { outgoing, backlinks })
}

/// 全库标签聚合
#[tauri::command]
pub fn list_tags(state: State<'_, AppState>) -> Result<Vec<TagEntry>> {
    Ok(state
        .db()
        .all_tags()?
        .into_iter()
        .map(|(tag, count)| TagEntry { tag, count })
        .collect())
}

/// 按标签查文档
#[tauri::command]
pub fn docs_by_tag(state: State<'_, AppState>, tag: String) -> Result<Vec<DocumentMeta>> {
    Ok(state
        .db()
        .docs_by_tag(&tag, 200)?
        .into_iter()
        .map(to_meta)
        .collect())
}

fn to_meta(d: DocRow) -> DocumentMeta {
    DocumentMeta {
        path: d.path,
        title: d.title,
        size: d.size,
        mtime: d.mtime,
        read_progress: d.read_progress,
        starred: d.starred,
    }
}

/// 弹系统目录选择框。
///
/// 用 `blocking_pick_folder` 而非回调版:command 本身是同步的(内部要持有锁),
/// 阻塞版在此不会造成死锁 —— Tauri 在专用线程上执行 command。
/// 该 API 仅存在于 desktop target,故用 `#[cfg(desktop)]` 门控。
#[cfg(desktop)]
fn pick_folder(app: &tauri::AppHandle) -> Result<String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .ok_or(AppError::NoVault)?;
    let path = picked.into_path().map_err(|_| AppError::NoVault)?;
    Ok(path.to_string_lossy().to_string())
}

/// 非桌面平台不支持弹窗,调用方须显式传path
#[cfg(not(desktop))]
fn pick_folder(_app: &tauri::AppHandle) -> Result<String> {
    Err(AppError::NoVault)
}

/* ---------- 朗读(TTS) ---------- */

/// 列出系统可用音色。
///
/// 前端据此判断引擎是否可用:失败则退回浏览器 `speechSynthesis`
/// (桌面 WebView2 下通常没有该能力,所以正常走的是本命令)。
#[tauri::command]
pub fn tts_voices(state: State<'_, AppState>) -> Result<Vec<tts::Voice>> {
    state.speaker().voices()
}

/// 朗读一句并阻塞到结束,返回是否被中途取消。
///
/// 走阻塞线程而非直接占住 command 线程:一句短句也要几百毫秒,
/// 期间前端还需要能并发调用暂停/停止。
#[tauri::command]
pub async fn tts_say(
    state: State<'_, AppState>,
    text: String,
    options: Option<SpeakOptions>,
) -> Result<tts::SayOutcome> {
    let speaker = state.speaker().clone();
    let opts: tts::SpeakOptions = options.unwrap_or_default().into();
    tauri::async_runtime::spawn_blocking(move || speaker.say(&text, &opts))
        .await
        .map_err(|e| AppError::Io(format!("朗读任务异常终止: {e}")))?
}

/// 暂停。返回是否真的进入了暂停态(不支持暂停的平台为 false)。
#[tauri::command]
pub fn tts_pause(state: State<'_, AppState>) -> Result<bool> {
    state.speaker().pause()
}

/// 从暂停继续。返回是否真的继续了。
#[tauri::command]
pub fn tts_resume(state: State<'_, AppState>) -> Result<bool> {
    state.speaker().resume()
}

/// 停止当前朗读;进行中的那句会以 `cancelled` 结束。
#[tauri::command]
pub fn tts_cancel(state: State<'_, AppState>) -> Result<()> {
    state.speaker().cancel()
}

/// 该平台是否支持暂停/继续(前端据此禁用按钮)
#[tauri::command]
pub fn tts_supports_pause(state: State<'_, AppState>) -> bool {
    state.speaker().pause_capable()
}

#[cfg(test)]
mod path_tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("windmd-open-path-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn 绝对路径的文档可规范化() {
        let dir = tmp_dir("ok");
        let file = dir.join("a.md");
        std::fs::write(&file, "# a").unwrap();
        let got = normalize_abs(&file.to_string_lossy()).unwrap();
        assert!(got.is_file());
        assert_eq!(got.file_name().unwrap(), "a.md");
        #[cfg(windows)]
        assert!(!got.to_string_lossy().starts_with(r"\\?\"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 相对路径与非文档被拒绝() {
        let dir = tmp_dir("bad");
        let img = dir.join("a.png");
        std::fs::write(&img, "x").unwrap();
        assert!(normalize_abs("a.md").is_err());
        assert!(normalize_abs(&img.to_string_lossy()).is_err());
        assert!(normalize_abs(&dir.join("missing.md").to_string_lossy()).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 同一目录可判等() {
        let dir = tmp_dir("same");
        assert!(same_dir(&dir, &dir.join(".")));
        assert!(!same_dir(&dir, &dir.join("nested")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn 去掉windows扩展路径前缀() {
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\C:\notes\a.md")),
            PathBuf::from(r"C:\notes\a.md")
        );
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\UNC\server\share\a.md")),
            PathBuf::from(r"\\server\share\a.md")
        );
        // 普通路径原样返回
        assert_eq!(
            strip_verbatim(PathBuf::from(r"C:\notes\a.md")),
            PathBuf::from(r"C:\notes\a.md")
        );
    }
}