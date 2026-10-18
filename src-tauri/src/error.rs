//! 统一错误类型,序列化后前端可读。

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("文件不存在: {0}")]
    NotFound(String),

    #[error("文件已存在: {0}")]
    AlreadyExists(String),

    #[error("路径不合法: {0}")]
    InvalidPath(String),

    #[error("未选择库目录")]
    NoVault,

    #[error("数据库错误: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("{0}")]
    Io(String),
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl AppError {
    /// 前端 `Console.error(e)` 直接打印,这里给出简短可读信息。
    pub fn code(&self) -> &'static str {
        match self {
            AppError::NotFound(_) => "NOT_FOUND",
            AppError::AlreadyExists(_) => "ALREADY_EXISTS",
            AppError::InvalidPath(_) => "INVALID_PATH",
            AppError::NoVault => "NO_VAULT",
            AppError::Db(_) => "DB_ERROR",
            AppError::Io(_) => "IO_ERROR",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

pub type Result<T> = std::result::Result<T, AppError>;