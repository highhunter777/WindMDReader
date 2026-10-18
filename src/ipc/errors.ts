/**
 * 后端错误的可读化。
 *
 * 踩过的坑:Rust 的 `AppError` 自己实现了 `Serialize`,序列化成
 * `{ code, message }` 这个**普通对象**(见 src-tauri/src/error.rs),
 * 经 invoke reject 到前端后既不是字符串也不是 `Error`。
 * 直接 `String(e)` 得到的就是 `"[object Object]"` —— 这行曾经显示在
 * 文件树的错误条上,而且因为后续刷新成功也不清除,会一直挂在界面上。
 *
 * 这里统一把错误变成人能读的文案。
 */

/** Rust `AppError` 序列化后的形状(只声明用到的字段) */
interface SerializedAppError {
  code?: unknown;
  message?: unknown;
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const { code, message } = e as SerializedAppError;
    if (typeof message === 'string' && message) return message;
    // message 缺失时至少给出错误码,总比 "[object Object]" 有用
    if (typeof code === 'string' && code) return code;
    // 连 code 都没有:说明后端给了没见过的结构,
    // 宁可给一句"未知错误"也不要再吐一个 [object Object]
    return '未知错误';
  }
  return String(e);
}