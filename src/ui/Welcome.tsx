/**
 * 欢迎页:无文档打开时展示(未开库 / 空库两种状态)。
 * 给用户可操作的下一步:打开库、新建文档、看快捷键。
 */
import { FilePlus2, FolderOpen, Keyboard } from 'lucide-react';
import { useStore } from '../store';
import { getBackend } from '../ipc';
import { openVaultWithPicker } from '../open-vault';
import { ACTION_META, formatCombo, type ShortcutAction } from '../renderer/shortcuts';

/** 欢迎页展示的快捷键速览(读用户当前绑定,改键后这里也跟着变) */
const CHEAT: ShortcutAction[] = [
  'find',
  'global-search',
  'scroll-top',
  'focus-line',
  'typewriter',
  'speak',
  'zen',
  'open-settings',
];

export function Welcome() {
  const vault = useStore((s) => s.vault);
  const bindings = useStore((s) => s.bindings);

  /** 在库根新建一个不重名的文档并打开 */
  const createDoc = async () => {
    try {
      const b = await getBackend();
      const list = await b.listFiles('/');
      const taken = new Set(list.map((e) => e.name));
      let name = '未命名文档.md';
      for (let i = 1; taken.has(name); i++) name = `未命名文档-${i}.md`;
      await b.createFile(name);
      const f = await b.readFile(name);
      const meta = await b.getMeta(name);
      useStore.getState().openDoc(f.path, f.content, meta);
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="welcome">
      <h1 className="welcome-title">WindMD</h1>
      <p className="welcome-sub">本地优先、高性能的 Markdown 阅读器</p>
      <p className="welcome-state">
        {vault ? '这个库还没有文档' : '还没有打开库'}
      </p>
      <div className="welcome-actions">
        <button className="welcome-btn primary" onClick={() => void openVaultWithPicker()}>
          <FolderOpen size={15} /> 打开库
        </button>
        <button className="welcome-btn" onClick={() => void createDoc()} disabled={!vault}>
          <FilePlus2 size={15} /> 新建文档
        </button>
        <button
          className="welcome-btn"
          onClick={() => document.dispatchEvent(new CustomEvent('windmd:open-settings'))}
        >
          <Keyboard size={15} /> 快捷键与设置
        </button>
      </div>
      <dl className="welcome-keys">
        {CHEAT.map((a) => (
          <div className="welcome-key-row" key={a}>
            <dt>{formatCombo(bindings[a])}</dt>
            <dd>{ACTION_META[a].name}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
