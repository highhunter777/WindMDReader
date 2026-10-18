/**
 * markdown-it-task-lists 的类型声明。
 * 该插件未提供 @types 包,这里按其实际 API 补齐最小声明。
 */
declare module 'markdown-it-task-lists' {
  import type MarkdownIt from 'markdown-it';

  interface TaskListOptions {
    /** 任务列表渲染为只读复选框 */
    enabled?: boolean;
    /** 是否用 <label> 包裹 */
    label?: boolean;
    /** label 放在 checkbox 之后 */
    labelAfter?: boolean;
  }

  const plugin: (md: MarkdownIt, options?: TaskListOptions) => void;
  export default plugin;
}