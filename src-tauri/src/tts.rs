//! 朗读(TTS)后端。
//!
//! 平台策略:
//! - **Windows**:常驻 `powershell.exe` 子进程 + `System.Speech`(SAPI)。
//!   WebView2 不提供 `speechSynthesis`,系统音色是唯一可靠通道。
//!   子进程以行协议交互(stdin 下命令 / stdout 回状态):
//!   命令侧由主线程逐行读取,异步朗读的"播完"信号走 `SpeakCompleted` 事件,
//!   这样一句未播完时仍能接收暂停/继续/停止。
//! - **macOS / Linux**:退化为逐句拉起 `say` / `espeak-ng`,
//!   支持开始与停止(杀进程),不支持暂停/继续。
//!
//! 前端以「逐句」为粒度调用 [`Speaker::say`]:一句播完才返回,
//! 因此暂停/继续/停止都能精确落在句边界上,也不会把长文本播到一半截断。

use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// 一个可用音色
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Voice {
    pub name: String,
    /// BCP-47 语言标记,如 `zh-CN`;部分平台解析不到时为空
    pub culture: String,
    /// `Female` / `Male` / `Neutral`;未知时为空
    pub gender: String,
}

/// 单句朗读的结果
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SayOutcome {
    /// 正常播完
    Finished,
    /// 被停止/取消(句中途中断)
    Cancelled,
}

/// 朗读参数
#[derive(Debug, Clone, Default)]
pub struct SpeakOptions {
    /// SAPI 语速,`-10..=10`
    pub rate: Option<i32>,
    /// SAPI 音量,`0..=100`
    pub volume: Option<i32>,
    /// 音色名
    pub voice: Option<String>,
}

/* ================================================================
 * 行协议
 * ================================================================ */

/// 子进程回传的一行
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Line {
    /// 进程启动握手
    Ready,
    /// 命令被接受(可带负载,如音色列表)
    Ok(String),
    /// 一句朗读结束(播完或被取消,二者都由 SAPI 事件回报)
    Done,
    /// 命令执行失败
    Err(String),
    /// 无关输出(PowerShell 横幅、警告等)
    Noise(String),
}

/// 解析一行输出;无法识别的内容一律当噪声丢弃
pub fn parse_line(raw: &str) -> Line {
    let line = raw.trim();
    if line.is_empty() {
        return Line::Noise(raw.to_string());
    }
    if let Some(rest) = line.strip_prefix("OK") {
        return Line::Ok(rest.trim().to_string());
    }
    match line {
        "READY" => Line::Ready,
        "DONE" => Line::Done,
        _ if line.starts_with("ERR ") => Line::Err(line[4..].trim().to_string()),
        _ => Line::Noise(raw.to_string()),
    }
}

/// 构造 `SET` 命令行。音色名走 base64,避免空格与 `;` 破坏分隔。
pub fn build_set_line(opts: &SpeakOptions) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(r) = opts.rate {
        parts.push(format!("rate={}", r.clamp(-10, 10)));
    }
    if let Some(v) = opts.volume {
        parts.push(format!("volume={}", v.clamp(0, 100)));
    }
    if let Some(v) = opts.voice.as_deref().filter(|s| !s.is_empty()) {
        parts.push(format!("voice={}", b64_encode(v.as_bytes())));
    }
    format!("SET {}", parts.join(";")).trim_end().to_string()
}

/// 解析音色列表负载:`名字|语言|性别;名字|语言|性别`
pub fn parse_voices_payload(payload: &str) -> Vec<Voice> {
    payload
        .split(';')
        .filter(|s| !s.trim().is_empty())
        .map(|item| {
            let mut it = item.split('|');
            Voice {
                name: it.next().unwrap_or("").trim().to_string(),
                culture: it.next().unwrap_or("").trim().to_string(),
                gender: it.next().unwrap_or("").trim().to_string(),
            }
        })
        .filter(|v| !v.name.is_empty())
        .collect()
}

/// 解析 `espeak-ng --voices` / `say -v '?'` 这类"按行分列"的音色清单。
///
/// 前两列分别是语言标记与音色名,其余列丢弃;无法切出两列的行被跳过。
// Windows 走 SAPI 的管道格式,这里只服务其他平台与测试。
#[cfg_attr(target_os = "windows", allow(dead_code))]
pub fn parse_voice_table(output: &str) -> Vec<Voice> {
    let mut out: Vec<Voice> = Vec::new();
    for line in output.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 2 {
            continue;
        }
        // 表头(GB 注册语言 / Name / Gender)跳过
        if cols[0].eq_ignore_ascii_case("language") || cols[1].eq_ignore_ascii_case("name") {
            continue;
        }
        out.push(Voice {
            culture: cols[0].to_string(),
            name: cols[1].to_string(),
            gender: String::new(),
        });
    }
    out
}

/* ================================================================
 * base64(不引第三方依赖,仅用于跨行协议传递非 ASCII 文本)
 * ================================================================ */

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn b64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// 解码仅在非 Windows 平台之外的地方直接用到(Windows 侧解码发生在 PowerShell 里),
/// 但协议成对,连同 [`b64_encode`] 一起保留并由测试覆盖往返。
#[cfg_attr(target_os = "windows", allow(dead_code))]
pub fn b64_decode(input: &str) -> Option<Vec<u8>> {
    let mut acc: u32 = 0;
    let mut bits = 0;
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    for c in input.bytes() {
        if c == b'=' {
            break;
        }
        let v = B64.iter().position(|&x| x == c)? as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/* ================================================================
 * 朗读器
 * ================================================================ */

/// 朗读器。多句之间复用同一子进程,避免每句都付一次启动开销
/// (PowerShell 冷启动约 0.3~1s)。
pub struct Speaker {
    /// 是否有句子在等结束(`say` 阻塞期间为真)
    speaking: AtomicBool,
    /// 已发出取消,等该句的 `DONE` 回来时判定为 Cancelled
    cancel_pending: AtomicBool,
    /// 该平台是否支持暂停/继续
    pause_capable: bool,

    /* --- Windows:常驻宿主 --- */
    #[cfg(target_os = "windows")]
    current: Mutex<Option<Arc<host::Session>>>,
    /// 停止时的瞬时提示信息(仅 Windows 需要读 stderr)
    #[cfg(target_os = "windows")]
    stderr_tail: Arc<Mutex<String>>,

    /* --- macOS / Linux:一次性进程 --- */
    #[cfg(not(target_os = "windows"))]
    synth: Mutex<Option<Child>>,
}

impl Speaker {
    pub fn new() -> Self {
        Speaker {
            speaking: AtomicBool::new(false),
            cancel_pending: AtomicBool::new(false),
            pause_capable: cfg!(target_os = "windows"),
            #[cfg(target_os = "windows")]
            current: Mutex::new(None),
            #[cfg(target_os = "windows")]
            stderr_tail: Arc::new(Mutex::new(String::new())),
            #[cfg(not(target_os = "windows"))]
            synth: Mutex::new(None),
        }
    }

    pub fn pause_capable(&self) -> bool {
        self.pause_capable
    }

    /// 朗读一句并阻塞到结束。
    ///
    /// 期间可从其他线程调用 [`Speaker::pause`] / [`Speaker::resume`] /
    /// [`Speaker::cancel`]。
    pub fn say(&self, text: &str, opts: &SpeakOptions) -> Result<SayOutcome> {
        let clean = text.trim();
        if clean.is_empty() {
            return Ok(SayOutcome::Finished);
        }
        // 参数每次都带上:前端可能中途调了语速
        self.configure(opts)?;
        self.speaking.store(true, Ordering::SeqCst);
        self.cancel_pending.store(false, Ordering::SeqCst);
        let out = self.say_inner(clean, opts);
        self.speaking.store(false, Ordering::SeqCst);
        out
    }

    /// 暂停;返回是否真的进入了暂停态(不支持的平台返回 false)
    pub fn pause(&self) -> Result<bool> {
        if !self.pause_capable {
            return Ok(false);
        }
        let s = self.session()?;
        s.write_line("PAUSE")?;
        Ok(true)
    }

    pub fn resume(&self) -> Result<bool> {
        if !self.pause_capable {
            return Ok(false);
        }
        let s = self.session()?;
        s.write_line("RESUME")?;
        Ok(true)
    }

    /// 停止。正在播的句子会中断,`say` 以 Cancelled 返回。
    ///
    /// 注意 SAPI 没有 `Stop()`,取消异步播报必须用 `SpeakAsyncCancelAll`。
    pub fn cancel(&self) -> Result<()> {
        // 先确保会话就绪再判断"是否有句在等":会话首次建立要拉起 PowerShell
        // (约 1s),若在此之前就判断,冷启动窗口里的停止会被漏记,
        // 结果是这一句照常播完、返回 Finished 而不是 Cancelled。
        #[cfg(target_os = "windows")]
        let session = self.session()?;
        // 只有确有句子在等结束时才标记,否则会把下一句误判为取消
        if self.speaking.load(Ordering::SeqCst) {
            self.cancel_pending.store(true, Ordering::SeqCst);
        }
        #[cfg(target_os = "windows")]
        {
            session.write_line("CANCEL")?;
        }
        #[cfg(not(target_os = "windows"))]
        {
            self.kill_synth()?;
        }
        Ok(())
    }

    /// 应用音色/语速/音量(每次开始朗读前调一次)
    pub fn configure(&self, opts: &SpeakOptions) -> Result<()> {
        #[cfg(target_os = "windows")]
        {
            let s = self.session()?;
            if let Err(e) = s.write_line(&build_set_line(opts)) {
                self.drop_session();
                return Err(e);
            }
            match s.read_ack() {
                Ok(_) => Ok(()),
                Err(e) => {
                    self.drop_session();
                    Err(e)
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            // 一次性进程模型:参数随每次拉起的命令传,无需单独设置
            let _ = opts;
            Ok(())
        }
    }

    /// 可用音色列表
    pub fn voices(&self) -> Result<Vec<Voice>> {
        #[cfg(target_os = "windows")]
        {
            let s = self.session()?;
            if let Err(e) = s.write_line("VOICES") {
                self.drop_session();
                return Err(e);
            }
            let out = match s.read_ack() {
                Ok(Line::Ok(payload)) => Ok(parse_voices_payload(&payload)),
                Ok(_) => Ok(Vec::new()),
                Err(e) => Err(e),
            };
            if out.is_err() {
                self.drop_session();
            }
            out
        }
        #[cfg(not(target_os = "windows"))]
        {
            let out = Command::new(voice_list_cmd())
                .arg(voice_list_arg())
                .output()
                .map_err(|e| AppError::Io(format!("枚举音色失败: {e}")))?;
            Ok(parse_voice_table(&String::from_utf8_lossy(&out.stdout)))
        }
    }
}

impl Default for Speaker {
    fn default() -> Self {
        Self::new()
    }
}

/* ---------------- Windows 实现 ---------------- */

#[cfg(target_os = "windows")]
mod host {
    use super::*;

    pub struct Session {
        pub stdin: Mutex<ChildStdin>,
        pub stdout: Mutex<BufReader<ChildStdout>>,
        child: Mutex<Option<Child>>,
        stderr_tail: Arc<Mutex<String>>,
        _script: ScriptFile,
    }

    /// 临时脚本文件的清理句柄
    struct ScriptFile(std::path::PathBuf);

    impl Drop for ScriptFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    impl Session {
        pub fn write_line(&self, line: &str) -> Result<()> {
            let mut w = self
                .stdin
                .lock()
                .map_err(|_| AppError::Io("朗读进程输入锁已损坏".into()))?;
            writeln!(w, "{line}")?;
            w.flush()?;
            Ok(())
        }

        /// 读一行;`None` 表示噪声(PowerShell 横幅等),调用方继续读。
        ///
        /// 进程退出(EOF)时带上 stderr 尾部返回错误。
        pub fn next_line(&self) -> Result<Option<Line>> {
            let mut r = self
                .stdout
                .lock()
                .map_err(|_| AppError::Io("朗读进程输出锁已损坏".into()))?;
            loop {
                let mut buf = String::new();
                let n = r.read_line(&mut buf)?;
                if n == 0 {
                    let tail = self
                        .stderr_tail
                        .lock()
                        .map(|s| s.trim().to_string())
                        .unwrap_or_default();
                    return Err(AppError::Io(if tail.is_empty() {
                        "朗读进程意外退出".to_string()
                    } else {
                        tail
                    }));
                }
                return Ok(match parse_line(&buf) {
                    Line::Noise(_) => None,
                    other => Some(other),
                });
            }
        }

        /// 读到握手/确认行为止。途中遇 `ERR` 直接上抛。
        pub fn read_ack(&self) -> Result<Line> {
            loop {
                match self.next_line()? {
                    None => continue,
                    Some(Line::Err(msg)) => return Err(AppError::Io(msg)),
                    Some(other) => return Ok(other),
                }
            }
        }

        pub fn kill(&self) {
            if let Ok(mut slot) = self.child.lock() {
                if let Some(mut c) = slot.take() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
            }
        }
    }

    /// 拉起常驻宿主进程并完成握手
    pub fn spawn(stderr_sink: &Arc<Mutex<String>>) -> Result<Session> {
        use std::fs::OpenOptions;

        let path = std::env::temp_dir().join(format!("windmd-tts-{}.ps1", std::process::id()));
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&path)
            .map_err(|e| AppError::Io(format!("写入朗读脚本失败: {e}")))?
            .write_all(HOST_SCRIPT.as_bytes())?;

        let mut child = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                let _ = std::fs::remove_file(&path);
                AppError::Io(format!("启动 PowerShell 朗读失败: {e}"))
            })?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::Io("朗读进程无 stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AppError::Io("朗读进程无 stderr".into()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::Io("朗读进程无 stdin".into()))?;

        // stderr 必须持续消费,否则管道写满会把子进程卡死
        let sink = stderr_sink.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            let mut keep = String::new();
            for line in reader.lines().map_while(|l| l.ok()) {
                keep.push_str(&line);
                keep.push('\n');
                if keep.len() > 2048 {
                    keep = keep[keep.len() - 2048..].to_string();
                }
            }
            if let Ok(mut w) = sink.lock() {
                *w = keep;
            }
        });

        let session = Session {
            stdin: Mutex::new(stdin),
            stdout: Mutex::new(BufReader::new(stdout)),
            child: Mutex::new(Some(child)),
            stderr_tail: stderr_sink.clone(),
            _script: ScriptFile(path),
        };
        // 握手:脚本没起来会立刻 EOF,把 stderr 尾部带出去便于定位
        session.read_ack()?;
        Ok(session)
    }
}

#[cfg(target_os = "windows")]
impl Speaker {
    fn session(&self) -> Result<Arc<host::Session>> {
        let mut slot = self
            .current
            .lock()
            .map_err(|_| AppError::Io("朗读状态锁已损坏".into()))?;
        if let Some(s) = slot.as_ref() {
            return Ok(s.clone());
        }
        let s = Arc::new(host::spawn(&self.stderr_tail)?);
        *slot = Some(s.clone());
        Ok(s)
    }

    /// 丢弃当前会话(进程已死时用,下次调用重新拉起)
    fn drop_session(&self) {
        if let Ok(mut slot) = self.current.lock() {
            if let Some(s) = slot.take() {
                s.kill();
            }
        }
    }

    fn say_inner(&self, text: &str, _opts: &SpeakOptions) -> Result<SayOutcome> {
        let s = self.session()?;
        let line = format!("SAY {}", b64_encode(text.as_bytes()));
        if let Err(e) = s.write_line(&line) {
            self.drop_session();
            return Err(e);
        }
        // 先等 SAY 被接受
        if let Err(e) = s.read_ack() {
            self.drop_session();
            return Err(e);
        }
        // 再等这一句结束。宿主脚本每读到一条命令才检查一次"上一句是否播完",
        // 所以由这里发 PING 驱动检查;DONE 会排在本次 PING 的 OK 之前到达。
        loop {
            if let Err(e) = s.write_line("PING") {
                self.drop_session();
                return Err(e);
            }
            let mut done = false;
            loop {
                match s.next_line() {
                    Err(e) => {
                        self.drop_session();
                        return Err(e);
                    }
                    Ok(None) => continue,
                    Ok(Some(Line::Done)) => done = true,
                    Ok(Some(Line::Err(msg))) => {
                        self.drop_session();
                        return Err(AppError::Io(msg));
                    }
                    // 本次 PING 的确认行
                    Ok(Some(_)) => break,
                }
            }
            if done {
                return Ok(if self.cancel_pending.swap(false, Ordering::SeqCst) {
                    SayOutcome::Cancelled
                } else {
                    SayOutcome::Finished
                });
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }
}

/// 等待句子结束时的轮询间隔。宿主脚本每条命令才检查一次完成状态,
/// 25ms 已足够跟手(对 60fps 的界面无感知)。
#[cfg(target_os = "windows")]
const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(25);

impl Drop for Speaker {
    fn drop(&mut self) {
        #[cfg(target_os = "windows")]
        {
            if let Ok(mut slot) = self.current.lock() {
                if let Some(s) = slot.take() {
                    let _ = s.write_line("QUIT");
                    s.kill();
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = self.kill_synth();
        }
    }
}

/* ---------------- macOS / Linux 实现 ---------------- */

#[cfg(target_os = "macos")]
fn synth_binary() -> &'static str {
    "say"
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn synth_binary() -> &'static str {
    "espeak-ng"
}

#[cfg(target_os = "macos")]
fn voice_list_arg() -> &'static str {
    "-v"
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn voice_list_arg() -> &'static str {
    "--voices"
}

#[cfg(target_os = "macos")]
fn voice_list_cmd() -> &'static str {
    // say 的音色清单靠 `-v '?'` 触发
    "say"
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn voice_list_cmd() -> &'static str {
    "espeak-ng"
}

#[cfg(not(target_os = "windows"))]
impl Speaker {
    fn synth_command(&self, text: &str, opts: &SpeakOptions) -> Command {
        let mut cmd = Command::new(synth_binary());
        if let Some(v) = opts.voice.as_deref().filter(|s| !s.is_empty()) {
            cmd.arg(voice_arg()).arg(v);
        }
        if let Some(r) = opts.rate {
            cmd.arg(rate_arg()).arg(rate_value(r).to_string());
        }
        cmd.arg(text);
        cmd
    }

    fn kill_synth(&self) -> Result<()> {
        let taken = self
            .synth
            .lock()
            .ok()
            .and_then(|mut slot| slot.take());
        if let Some(mut child) = taken {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }

    fn say_inner(&self, text: &str, opts: &SpeakOptions) -> Result<SayOutcome> {
        let mut child = self
            .synth_command(text, opts)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| AppError::Io(format!("启动语音合成器失败: {e}")))?;
        // 登记句柄,让 cancel() 能杀掉它
        if let Ok(mut slot) = self.synth.lock() {
            *slot = Some(child);
        } else {
            let _ = child.kill();
            return Err(AppError::Io("朗读状态锁已损坏".into()));
        }
        let status = {
            let slot = self.synth.lock();
            let mut guard = slot.map_err(|_| AppError::Io("朗读状态锁已损坏".into()))?;
            let child = guard
                .as_mut()
                .ok_or_else(|| AppError::Io("朗读进程句柄丢失".into()))?;
            let r = child.wait();
            *guard = None;
            r
        };
        status?;
        Ok(if self.cancel_pending.swap(false, Ordering::SeqCst) {
            SayOutcome::Cancelled
        } else {
            SayOutcome::Finished
        })
    }
}

/// 语速换算:统一以 SAPI 的 `-10..=10` 为输入,换到各平台的原生单位。
#[cfg(target_os = "macos")]
fn rate_value(rate: i32) -> i32 {
    (175.0 * (1.0 + rate.clamp(-10, 10) as f64 * 0.1)).round() as i32
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn rate_value(rate: i32) -> i32 {
    (175.0 + rate.clamp(-10, 10) as f64 * 17.5).round().clamp(80.0, 450.0) as i32
}

#[cfg(target_os = "macos")]
fn voice_arg() -> &'static str {
    "-v"
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn voice_arg() -> &'static str {
    "-v"
}

#[cfg(target_os = "macos")]
fn rate_arg() -> &'static str {
    "-r"
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn rate_arg() -> &'static str {
    "-s"
}

/* ================================================================
 * Windows 宿主脚本
 * ================================================================ */

/// 常驻宿主脚本。约定:
/// - 命令按行从 stdin 读:`PING` / `VOICES` / `SET …` / `SAY <base64>` /
///   `PAUSE` / `RESUME` / `CANCEL` / `QUIT`
/// - 每条命令回 `OK`(可带负载);`SAY` 真正结束时在**下一条命令到来时**回 `DONE`
///
/// 为什么不用 `SpeakCompleted` 事件:事件队列要等 PowerShell 引擎空闲才派发,
/// 而这里主线程永远阻塞在读 stdin,实测事件里的输出压根不会发出来。
/// 改用 `SpeakAsync` 返回的 Task 的 `IsCompleted` 判定 —— 主线程每读到一条命令
/// 就检查一次,「什么时候问」的问题就交给 Rust 侧发 `PING` 驱动。
///
/// 另外三处实测踩坑:
/// 1. SAPI 的 `SpeechSynthesizer` **没有 `Stop()`**,取消异步播报用
///    `SpeakAsyncCancelAll()`(取消同样会让 Task 完成)。
/// 2. `SET` 的键值切分必须限制为两段(`-split '=', 2`):音色名走 base64,
///    结尾的 `=` 是补位符,不能当分隔符。
/// 3. `Register-ObjectEvent` 自身会往 stdout 打一行作业列表 —— 索性不用它,
///    也就不必去抑制。
#[cfg(target_os = "windows")]
pub const HOST_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$syn = New-Object System.Speech.Synthesis.SpeechSynthesizer
$task = $null

function Emit([string]$line) {
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
}

Emit 'READY'

while ($true) {
  # 先收割上一句:Task 结束(播完或被取消)即 DONE
  if ($null -ne $task -and $task.IsCompleted) {
    $task = $null
    Emit 'DONE'
  }

  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq 'QUIT') { break }

  $sp = $line.IndexOf(' ')
  if ($sp -lt 0) { $cmd = $line; $arg = '' } else { $cmd = $line.Substring(0, $sp); $arg = $line.Substring($sp + 1) }
  switch ($cmd) {
    'PING'  { Emit 'OK' }
    'VOICES' {
      $sb = New-Object System.Text.StringBuilder
      $first = $true
      foreach ($v in $syn.GetInstalledVoices()) {
        if (-not $v.Enabled) { continue }
        if (-not $first) { [void]$sb.Append(';') }
        [void]$sb.Append($v.VoiceInfo.Name).Append('|').Append($v.VoiceInfo.Culture.Name).Append('|').Append($v.VoiceInfo.Gender)
        $first = $false
      }
      Emit ('OK ' + $sb.ToString())
    }
    'SET' {
      foreach ($kv in $arg.Split(';')) {
        $p = $kv -split '=', 2
        if ($p.Length -lt 2) { continue }
        switch ($p[0]) {
          'rate'   { $syn.Rate = [int]$p[1] }
          'volume' { $syn.Volume = [int]$p[1] }
          'voice'  {
            $name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1]))
            try { $syn.SelectVoice($name) } catch { }
          }
        }
      }
      Emit 'OK'
    }
    'SAY' {
      $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($arg))
      if ([string]::IsNullOrWhiteSpace($text)) { Emit 'OK' }
      else {
        $task = $syn.SpeakAsync($text)
        Emit 'OK'
      }
    }
    'PAUSE'  { $syn.Pause();  Emit 'OK' }
    'RESUME' { $syn.Resume(); Emit 'OK' }
    'CANCEL' { $syn.SpeakAsyncCancelAll(); Emit 'OK' }
    default  { Emit ('ERR 未知命令 ' + $cmd) }
  }
}

$syn.Dispose()
"#;

#[cfg(test)]
mod tests {
    use super::*;

    /* ---------- 行协议 ---------- */

    #[test]
    fn 解析握手与状态行() {
        assert_eq!(parse_line("READY"), Line::Ready);
        assert_eq!(parse_line("DONE"), Line::Done);
        assert_eq!(parse_line("OK"), Line::Ok(String::new()));
        assert_eq!(parse_line("OK 张三"), Line::Ok("张三".into()));
        assert_eq!(parse_line("ERR 未知命令 FOO"), Line::Err("未知命令 FOO".into()));
    }

    #[test]
    fn 无关输出归为噪声而不是错误() {
        assert!(matches!(parse_line("Windows PowerShell"), Line::Noise(_)));
        assert!(matches!(parse_line("   "), Line::Noise(_)));
    }

    #[test]
    fn 行首尾空白与回车换行被容错() {
        assert_eq!(parse_line("  DONE \r\n"), Line::Done);
        assert_eq!(parse_line("OK a|b|Female\r"), Line::Ok("a|b|Female".into()));
    }

    /* ---------- 音色表 ---------- */

    #[test]
    fn 解析多个音色() {
        let v = parse_voices_payload("Microsoft Huihui Desktop|zh-CN|Female;Microsoft Zira Desktop|en-US|Female");
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].name, "Microsoft Huihui Desktop");
        assert_eq!(v[0].culture, "zh-CN");
        assert_eq!(v[0].gender, "Female");
        assert_eq!(v[1].culture, "en-US");
    }

    #[test]
    fn 音色表为空时返回空列表() {
        assert!(parse_voices_payload("").is_empty());
        assert!(parse_voices_payload(";; ;").is_empty());
    }

    #[test]
    fn 解析按列排布的音色清单() {
        let table = "\
LANG    NAME        GENDER
zh      zh-CN       female
en      en-us       male
en-gb   en-gb       none
";
        let v = parse_voice_table(table);
        assert_eq!(v.len(), 3, "表头应被跳过");
        assert_eq!(v[0], Voice { name: "zh-CN".into(), culture: "zh".into(), gender: String::new() });
        assert_eq!(v[1].name, "en-us");
    }

    #[test]
    fn 单列或空行不计入音色() {
        assert!(parse_voice_table("").is_empty());
        assert!(parse_voice_table("only-one-column").is_empty());
    }

    /* ---------- base64 ---------- */

    #[test]
    fn base64符合标准向量() {
        assert_eq!(b64_encode(b""), "");
        assert_eq!(b64_encode(b"f"), "Zg==");
        assert_eq!(b64_encode(b"fo"), "Zm8=");
        assert_eq!(b64_encode(b"foo"), "Zm9v");
        assert_eq!(b64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64往返中文与符号() {
        for s in ["朗读测试", "hello, world!", "a=b;c|d\n换行", "😀 emoji"] {
            let enc = b64_encode(s.as_bytes());
            let dec = b64_decode(&enc).expect("解码失败");
            assert_eq!(String::from_utf8(dec).unwrap(), s);
        }
    }

    #[test]
    fn base64拒绝非法字符() {
        assert!(b64_decode("Zm9v*g==").is_none());
    }

    /* ---------- SET 命令构造 ---------- */

    #[test]
    fn set命令裁剪超范围参数() {
        let line = build_set_line(&SpeakOptions {
            rate: Some(99),
            volume: Some(-5),
            voice: None,
        });
        assert_eq!(line, "SET rate=10;volume=0");
    }

    #[test]
    fn set命令对音色做base64() {
        let line = build_set_line(&SpeakOptions {
            rate: Some(0),
            volume: Some(100),
            voice: Some("Microsoft Huihui Desktop".into()),
        });
        assert!(line.starts_with("SET rate=0;volume=100;voice="));
        let b64 = line.rsplit('=').next().unwrap();
        assert_eq!(
            b64_decode(b64).map(|b| String::from_utf8(b).unwrap()),
            Some("Microsoft Huihui Desktop".to_string())
        );
    }

    #[test]
    fn 空音色不参与设置() {
        let line = build_set_line(&SpeakOptions {
            voice: Some(String::new()),
            ..Default::default()
        });
        assert_eq!(line, "SET");
    }

    /* ---------- 宿主脚本 ---------- */

    #[cfg(target_os = "windows")]
    #[test]
    fn 宿主脚本包含必需的命令与完成判定() {
        for cmd in ["'PING'", "'VOICES'", "'SET'", "'SAY'", "'PAUSE'", "'RESUME'", "'CANCEL'", "QUIT"] {
            assert!(HOST_SCRIPT.contains(cmd), "宿主脚本缺少 {cmd}");
        }
        assert!(HOST_SCRIPT.contains("[Console]::OutputEncoding"));
        // 完成判定靠 SpeakAsync 的 Task,不是 SpeakCompleted 事件:
        // 事件要等引擎空闲才派发,而主线程一直阻塞在读 stdin。
        assert!(HOST_SCRIPT.contains("IsCompleted"));
        assert!(!HOST_SCRIPT.contains("SpeakCompleted"));
        // SAPI 没有 Stop():取消必须走 SpeakAsyncCancelAll
        assert!(HOST_SCRIPT.contains("SpeakAsyncCancelAll"));
        assert!(!HOST_SCRIPT.contains("$syn.Stop()"));
        // base64 尾部的 '=' 是补位符,切分必须限制为两段
        assert!(HOST_SCRIPT.contains("-split '=', 2"));
    }

    /* ---------- 与真实引擎的协议往返(仅 Windows) ---------- */

    #[cfg(target_os = "windows")]
    mod live {
        use super::*;

        fn opts() -> SpeakOptions {
            SpeakOptions {
                rate: Some(0),
                volume: Some(60),
                voice: None,
            }
        }

        #[test]
        fn 能枚举本机音色() {
            let sp = Speaker::new();
            let voices = sp.voices().expect("枚举音色失败");
            assert!(!voices.is_empty(), "本机应至少有一个系统音色");
            assert!(voices.iter().any(|v| v.name.contains("Microsoft")));
        }

        #[test]
        fn 朗读短句正常结束() {
            let sp = Speaker::new();
            assert_eq!(sp.say("hello", &opts()).expect("朗读失败"), SayOutcome::Finished);
        }

        #[test]
        fn 空文本不启动进程() {
            let sp = Speaker::new();
            assert_eq!(sp.say("   ", &opts()).expect("空文本应直接返回"), SayOutcome::Finished);
            // 没有句在播时执行停止不应把下一句误判为取消
            sp.cancel().expect("停止失败");
            assert_eq!(sp.say("hi", &opts()).expect("后续朗读失败"), SayOutcome::Finished);
        }

        #[test]
        fn 中文字符能经base64通道送入() {
            let sp = Speaker::new();
            assert_eq!(
                sp.say("这是一句中文朗读测试。", &opts()).expect("中文朗读失败"),
                SayOutcome::Finished
            );
        }

        #[test]
        fn 停止会使进行中的句子返回已取消() {
            let sp = Arc::new(Speaker::new());
            // 先预热:首次 say 要拉起 PowerShell(约 1s),
            // 不预热的话"停止"会落在冷启动窗口里,测不到真正的中断。
            sp.configure(&opts()).expect("预热失败");
            let worker = {
                let sp = sp.clone();
                std::thread::spawn(move || {
                    sp.say(
                        "one two three four five six seven eight nine ten eleven twelve",
                        &opts(),
                    )
                })
            };
            std::thread::sleep(std::time::Duration::from_millis(1200));
            sp.cancel().expect("停止失败");
            let out = worker.join().expect("朗读线程 panic").expect("朗读失败");
            assert_eq!(out, SayOutcome::Cancelled);
        }

        #[test]
        fn 暂停与继续可用() {
            let sp = Speaker::new();
            assert!(sp.pause().unwrap());
            assert!(sp.resume().unwrap());
            assert!(sp.say("hi", &opts()).is_ok());
        }

        #[test]
        fn 应用音色后仍能正常朗读() {
            let sp = Speaker::new();
            let name = sp.voices().expect("枚举音色失败")[0].name.clone();
            let mut o = opts();
            o.voice = Some(name);
            sp.configure(&o).expect("设置音色失败");
            assert_eq!(sp.say("ok", &o).expect("朗读失败"), SayOutcome::Finished);
        }
    }
}