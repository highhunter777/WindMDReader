//! 文件系统访问:库目录管理、文件树、读写、原子写入、回收站删除。
//!
//! 所有路径均为「相对库根」的字符串,统一用 `/` 分隔,
//! 与前端 `FileEntry.path` 约定一致(见 src/types/index.ts)。

use crate::error::{AppError, Result};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

/// 支持的文档扩展名
pub fn is_markdown(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md")
        || lower.ends_with(".markdown")
        || lower.ends_with(".txt")
        || lower.ends_with(".mdown")
}

/// 去扩展名,作为文档标题
pub fn strip_ext(name: &str) -> &str {
    for ext in ["markdown", "mdown", "md", "txt"] {
        let suffix = format!(".{ext}");
        if name.to_ascii_lowercase().ends_with(&suffix) {
            return &name[..name.len() - suffix.len()];
        }
    }
    name
}

/// 把库根 + 相对路径拼成绝对路径,并阻止越界访问。
///
/// `relative` 来自前端,属于不可信输入 —— 必须拒绝 `..`、绝对路径与盘符,
/// 否则可能读写库目录之外的文件。
pub fn resolve(root: &Path, relative: &str) -> Result<PathBuf> {
    // UNC 路径(`\\server\share`)必须先拦 —— 它以反斜杠开头,
    // 会被下面的 trim_start_matches 剥成 `server\share` 变成普通相对路径。
    if relative.starts_with("\\\\") {
        return Err(AppError::InvalidPath(relative.to_string()));
    }

    // 允许前端传 `/a.md` 这类带前导斜杠的相对路径
    let rel = relative.trim_start_matches(['/', '\\']);
    if rel.is_empty() {
        return Ok(root.to_path_buf());
    }

    // 剥完仍是绝对路径,说明原本是盘符路径(如 `C:\x`),必须拒绝
    let candidate = Path::new(rel);
    if candidate.is_absolute() || candidate.has_root() {
        return Err(AppError::InvalidPath(relative.to_string()));
    }

    for comp in candidate.components() {
        match comp {
            Component::Normal(_) | Component::CurDir => {}
            // ParentDir 可能逃出库根(其余已被上面的 is_absolute 拦掉)
            Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => {
                return Err(AppError::InvalidPath(relative.to_string()));
            }
        }
    }
    Ok(root.join(candidate))
}

/// 绝对路径转相对库根的字符串
pub fn relativize(root: &Path, abs: &Path) -> Option<String> {
    let rel = abs.strip_prefix(root).ok()?;
    Some(rel.to_string_lossy().replace('\\', "/"))
}

/// 文件修改时间(毫秒时间戳)
fn mtime_of(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub struct Fs {
    root: PathBuf,
}

impl Fs {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Fs { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 列出某目录的直接子项(不递归)
    pub fn list(&self, dir: &str) -> Result<Vec<FileEntry>> {
        let target = resolve(&self.root, dir)?;
        if !target.exists() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for entry in fs::read_dir(&target)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(rel) = relativize(&self.root, &entry.path()) else {
                continue;
            };
            let md = entry.metadata().ok();
            let is_dir = md.as_ref().is_some_and(|m| m.is_dir());

            out.push(FileEntry {
                path: rel,
                name,
                is_dir,
                kind: if is_dir { "dir" } else { "file" }.to_string(),
                size: md.as_ref().map(|m| m.len() as i64).unwrap_or(0),
                mtime: md.as_ref().map(mtime_of).unwrap_or(0),
            });
        }
        // 目录在前,同类按名称自然排序
        out.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(out)
    }

    pub fn read(&self, path: &str) -> Result<OpenFile> {
        let abs = resolve(&self.root, path)?;
        let content = fs::read_to_string(&abs)
            .map_err(|e| AppError::Io(format!("读取 {path} 失败: {e}")))?;
        let mtime = fs::metadata(&abs).ok().as_ref().map(mtime_of).unwrap_or(0);
        Ok(OpenFile {
            path: path.to_string(),
            size: content.len() as i64,
            content,
            mtime,
        })
    }

    /// 原子写入:先写临时文件再 rename,避免写到一半崩溃导致文件损坏
    pub fn write(&self, path: &str, content: &str) -> Result<()> {
        let abs = resolve(&self.root, path)?;
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = abs.with_extension("mdtmp");
        fs::write(&tmp, content).map_err(|e| AppError::Io(format!("写入失败: {e}")))?;
        if let Err(e) = fs::rename(&tmp, &abs) {
            let _ = fs::remove_file(&tmp);
            return Err(AppError::Io(format!("替换文件失败: {e}")));
        }
        Ok(())
    }

    pub fn create(&self, path: &str) -> Result<()> {
        let abs = resolve(&self.root, path)?;
        if abs.exists() {
            return Err(AppError::AlreadyExists(path.to_string()));
        }
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent)?;
        }
        let title = abs
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        fs::write(&abs, format!("# {}\n\n", strip_ext(&title)))?;
        Ok(())
    }

    pub fn rename(&self, from: &str, to: &str) -> Result<()> {
        let src = resolve(&self.root, from)?;
        let dst = resolve(&self.root, to)?;
        if !src.exists() {
            return Err(AppError::NotFound(from.to_string()));
        }
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(&src, &dst).map_err(|e| AppError::Io(format!("重命名失败: {e}")))
    }

    /// 删除到系统回收站。回收站不可用时退回直接删除。
    pub fn delete(&self, path: &str) -> Result<()> {
        let abs = resolve(&self.root, path)?;
        if !abs.exists() {
            return Err(AppError::NotFound(path.to_string()));
        }
        if try_recycle(&abs).is_ok() {
            return Ok(());
        }
        if abs.is_dir() {
            fs::remove_dir_all(&abs)
        } else {
            fs::remove_file(&abs)
        }
        .map_err(|e| AppError::Io(format!("删除失败: {e}")))
    }

    /// 统计库内文档数量
    pub fn count_markdown(&self) -> usize {
        walkdir::WalkDir::new(&self.root)
            .into_iter()
            .filter_map(std::result::Result::ok)
            .filter(|e| e.file_type().is_file())
            .filter(|e| is_markdown(&e.file_name().to_string_lossy()))
            .count()
    }
}

/// 送 Windows 回收站;非 Windows 或调用失败时返回 Err,由调用方退回直接删除
#[cfg(windows)]
fn try_recycle(abs: &Path) -> std::result::Result<(), ()> {
    let target = abs.to_string_lossy().replace('\'', "''");
    let ps = format!(
        "Add-Type -AssemblyName Microsoft.VisualBasic; \
         [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('{target}','OnlyErrorDialogs','SendToRecycleBin')"
    );
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
        .status()
        .map_err(|_| ())
        .and_then(|s| if s.success() { Ok(()) } else { Err(()) })
}

#[cfg(not(windows))]
fn try_recycle(_abs: &Path) -> std::result::Result<(), ()> {
    Err(())
}

/* ---------- 与前端类型对应的序列化结构 ---------- */

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub kind: String,
    pub size: i64,
    pub mtime: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenFile {
    pub path: String,
    pub content: String,
    pub mtime: i64,
    pub size: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 各测试用独立临时目录,互不干扰
    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("windmd-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn 识别文档扩展名() {
        assert!(is_markdown("a.md"));
        assert!(is_markdown("a.MD"));
        assert!(is_markdown("a.markdown"));
        assert!(is_markdown("a.txt"));
        assert!(!is_markdown("a.png"));
        assert!(!is_markdown("a.rs"));
    }

    #[test]
    fn 去掉扩展名() {
        assert_eq!(strip_ext("笔记.md"), "笔记");
        assert_eq!(strip_ext("readme.markdown"), "readme");
        assert_eq!(strip_ext("a.txt"), "a");
        assert_eq!(strip_ext("无扩展名"), "无扩展名");
    }

    #[test]
    fn 路径越界被拒绝() {
        let root = Path::new("/tmp/vault");
        // 这些都必须被拒绝,否则可能读写库外的文件
        for bad in ["../secret", "a/../../secret", "..", "a/b/../../.."] {
            assert!(resolve(root, bad).is_err(), "应拒绝越界路径: {bad}");
        }
    }

    #[test]
    fn 盘符与unc路径被拒绝() {
        // 这些绝对路径必须被拒绝,否则可能读写库外的文件
        assert!(resolve(Path::new("/tmp/vault"), "C:\\Windows\\system.ini").is_err());
        assert!(resolve(Path::new("/tmp/vault"), "\\\\server\\share\\a.md").is_err());
    }

    #[test]
    fn 正常路径可解析() {
        let root = Path::new("/tmp/vault");
        assert_eq!(resolve(root, "a.md").unwrap(), root.join("a.md"));
        assert_eq!(resolve(root, "sub/a.md").unwrap(), root.join("sub/a.md"));
        // 前导斜杠等价于相对路径
        assert_eq!(resolve(root, "/a.md").unwrap(), root.join("a.md"));
        // 空路径视为根
        assert_eq!(resolve(root, "").unwrap(), root);
    }

    #[test]
    fn 绝对路径转相对() {
        let root = Path::new("/tmp/vault");
        assert_eq!(
            relativize(root, Path::new("/tmp/vault/a.md")).as_deref(),
            Some("a.md")
        );
        assert_eq!(
            relativize(root, Path::new("/tmp/vault/sub/b.md")).as_deref(),
            Some("sub/b.md")
        );
        // 库外路径无法 relativize
        assert_eq!(relativize(root, Path::new("/tmp/other/a.md")), None);
    }

    #[test]
    fn 写入后可读回() {
        let dir = tmp_dir("rw");
        let fsx = Fs::new(&dir);
        fsx.write("a.md", "# 内容").unwrap();
        let f = fsx.read("a.md").unwrap();
        assert_eq!(f.content, "# 内容");
        assert_eq!(f.path, "a.md");
        assert!(f.size > 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 写入时自动创建父目录() {
        let dir = tmp_dir("nested");
        let fsx = Fs::new(&dir);
        fsx.write("a/b/c.md", "深层").unwrap();
        assert_eq!(fsx.read("a/b/c.md").unwrap().content, "深层");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 原子写入不留临时文件() {
        let dir = tmp_dir("atomic");
        let fsx = Fs::new(&dir);
        fsx.write("a.md", "x").unwrap();
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(std::result::Result::ok)
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("tmp"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件: {leftovers:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 创建文件带标题占位() {
        let dir = tmp_dir("create");
        let fsx = Fs::new(&dir);
        fsx.create("新笔记.md").unwrap();
        assert!(fsx.read("新笔记.md").unwrap().content.contains("# 新笔记"));
        // 重复创建报错
        assert!(fsx.create("新笔记.md").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 重命名保留内容() {
        let dir = tmp_dir("rename");
        let fsx = Fs::new(&dir);
        fsx.write("a.md", "内容").unwrap();
        fsx.rename("a.md", "b.md").unwrap();
        assert!(fsx.read("a.md").is_err());
        assert_eq!(fsx.read("b.md").unwrap().content, "内容");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 读取不存在的文件报错() {
        let dir = tmp_dir("missing");
        let fsx = Fs::new(&dir);
        assert!(fsx.read("nope.md").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 列出目录含子项() {
        let dir = tmp_dir("list");
        let fsx = Fs::new(&dir);
        fsx.write("a.md", "1").unwrap();
        fsx.create("sub.md").unwrap();
        let names: Vec<_> = fsx
            .list("/")
            .unwrap()
            .iter()
            .map(|e| e.name.clone())
            .collect();
        assert!(names.contains(&"a.md".to_string()));
        assert!(names.contains(&"sub.md".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 列出目录时目录在前() {
        let dir = tmp_dir("order");
        fs::create_dir_all(dir.join("zdir")).unwrap();
        fs::write(dir.join("b.md"), "x").unwrap();
        let entries = Fs::new(&dir).list("/").unwrap();
        assert!(entries[0].is_dir);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 统计文档数量() {
        let dir = tmp_dir("count");
        let fsx = Fs::new(&dir);
        fsx.write("a.md", "1").unwrap();
        fsx.write("b.md", "2").unwrap();
        fsx.write("c.txt", "3").unwrap();
        fs::write(dir.join("d.png"), "x").unwrap();
        assert_eq!(fsx.count_markdown(), 3);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 列出不存在的目录返回空() {
        let dir = tmp_dir("empty");
        assert!(Fs::new(&dir).list("nope").unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}