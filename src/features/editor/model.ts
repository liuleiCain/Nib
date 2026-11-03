import type { ChangeSpec, Extension, Text } from '@codemirror/state';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { indentWithTab } from '@codemirror/commands';
import {
  HighlightStyle,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { Document } from '../../lib/backend';
import { gitChanges } from '../git/changes';

/** 标签保存独立的编辑器状态，切换时保留撤销历史、选区和滚动位置。 */
export interface Tab {
  path: string;
  state: EditorState;
  savedDoc: Text;
  revision: string;
  newline: Document['newline'];
  hasBom: boolean;
  scroll: { top: number; left: number };
  /** 外部修改与未保存编辑冲突、文件无法读取或自动保存失败时暂停自动保存，避免覆盖外部修改。 */
  paused: boolean;
  /** 超大文件只读预览：只含开头部分，禁止编辑和保存。 */
  truncated: boolean;
  /** 磁盘文件总字节数。 */
  size: number;
}

export const wrapCompartment = new Compartment();
export const editableCompartment = new Compartment();
export const indentCompartment = new Compartment();

/** 缩进宽度：Tab 显示宽度与自动缩进的空格数一致。 */
export function indentation(size: number): Extension {
  return [EditorState.tabSize.of(size), indentUnit.of(' '.repeat(size))];
}

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#b6a0d6' },
  { tag: [tags.string, tags.regexp], color: '#a8c99c' },
  { tag: [tags.number, tags.bool, tags.null], color: '#d3ad83' },
  { tag: tags.comment, color: '#747e86', fontStyle: 'italic' },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: '#d4c594',
  },
  { tag: [tags.typeName, tags.className], color: '#8bbfcd' },
  { tag: [tags.propertyName, tags.attributeName], color: '#b8c8d4' },
  { tag: tags.heading, color: '#8cc5b5', fontWeight: 'bold' },
  { tag: tags.link, color: '#8bbfcd', textDecoration: 'underline' },
]);

const theme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: '#1c2024', color: '#cbd1d5' },
    '.cm-scroller': {
      fontFamily: 'var(--editor-font)',
      fontSize: 'var(--editor-size)',
      lineHeight: '1.75',
    },
    '.cm-content': { padding: '16px 0', caretColor: '#9dcbbd' },
    '.cm-line': { padding: '0 24px 0 16px' },
    '.cm-gutters': {
      backgroundColor: '#1c2024',
      color: '#59636d',
      border: 'none',
      minWidth: '52px',
    },
    '.cm-gutterElement': { padding: '0 12px 0 12px' },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: '#b3bdc5',
    },
    '.cm-activeLine': { backgroundColor: '#ffffff04' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection':
      { backgroundColor: '#415b5860' },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#9dcbbd' },
    '.cm-panels': { color: '#cbd1d5', backgroundColor: '#23292e' },
    '.cm-panels-top': { borderBottom: '1px solid #333b42' },
    '.cm-search': { padding: '10px 16px', fontFamily: 'var(--ui-font)' },
    '.cm-textfield': {
      backgroundColor: '#181c20',
      border: '1px solid #3b454c',
      borderRadius: '3px',
    },
    '.cm-button': {
      color: '#cbd1d5',
      backgroundImage: 'none',
      backgroundColor: '#30383e',
      border: '1px solid #465057',
      borderRadius: '3px',
    },
    '.cm-tooltip': { backgroundColor: '#282e34', border: '1px solid #40494f' },
    '.cm-matchingBracket': {
      backgroundColor: '#8cc5b52a',
      outline: '1px solid #8cc5b54a',
    },
    '.cm-searchMatch': { backgroundColor: '#bca66c35' },
    '.cm-searchMatch-selected': { backgroundColor: '#8cc5b555' },
  },
  { dark: true },
);

/** 根据文件后缀展示语言名称，未知类型仍按纯文本编辑。 */
export function languageName(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  return (
    (
      {
        go: 'Go',
        rs: 'Rust',
        js: 'JavaScript',
        jsx: 'JavaScript',
        ts: 'TypeScript',
        tsx: 'TypeScript',
        json: 'JSON',
        md: 'Markdown',
        markdown: 'Markdown',
        yaml: 'YAML',
        yml: 'YAML',
      } as Record<string, string>
    )[extension ?? ''] ?? '纯文本'
  );
}

/** CodeMirror 内置界面（查找替换、折叠、合并视图）的中文文案。 */
const phrases = EditorState.phrases.of({
  Find: '查找',
  Replace: '替换',
  next: '下一个',
  previous: '上一个',
  all: '全部选中',
  'match case': '区分大小写',
  regexp: '正则',
  'by word': '全词',
  replace: '替换',
  'replace all': '全部替换',
  close: '关闭',
  'current match': '当前匹配',
  'on line': '位于第',
  'replaced match on line $': '已替换第 $ 行的匹配',
  'replaced $ matches': '已替换 $ 处匹配',
  'Go to line': '跳转到行',
  go: '跳转',
  'Fold line': '折叠',
  'Unfold line': '展开',
  'folded code': '已折叠的代码',
  unfold: '展开',
  'Folded lines': '已折叠行',
  'Unfolded lines': '已展开行',
  to: '至',
  '$ unchanged lines': '$ 行未变化',
  'Revert this chunk': '回滚此处变更',
  'Selection deleted': '已删除选中内容',
});

/** 查找面板按钮的悬浮说明，面板按钮由 CodeMirror 创建，挂载后补上 title。 */
const searchTips: Record<string, string> = {
  next: '跳到下一个匹配 (Enter)',
  prev: '跳到上一个匹配 (Shift+Enter)',
  select: '选中全部匹配',
  replace: '替换当前匹配',
  replaceAll: '替换全部匹配',
  close: '关闭查找面板 (Esc)',
};
const searchPanelTips = EditorView.updateListener.of((update) => {
  const panel = update.view.dom.querySelector('.cm-search');
  if (!panel || panel.hasAttribute('data-tips')) return;
  panel.setAttribute('data-tips', '');
  panel
    .querySelectorAll<HTMLButtonElement>('button[name]')
    .forEach((button) => {
      const tip = searchTips[button.name];
      if (tip) button.title = tip;
    });
});

/** 编辑器与 Diff 视图共用的配色和主题，包含中文界面文案。 */
const sharedTheme: Extension = [theme, phrases];
export { highlight as editorHighlight, sharedTheme as editorTheme };

/** 按文件后缀按需加载语言支持。 */
export async function language(path: string): Promise<Extension> {
  const extension = path.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'go':
      return (await import('@codemirror/lang-go')).go();
    case 'rs':
      return (await import('@codemirror/lang-rust')).rust();
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
      return (await import('@codemirror/lang-javascript')).javascript({
        typescript: extension.startsWith('ts'),
        jsx: extension.endsWith('x'),
      });
    case 'json':
      return (await import('@codemirror/lang-json')).json();
    case 'md':
    case 'markdown':
      return (await import('@codemirror/lang-markdown')).markdown();
    case 'yaml':
    case 'yml':
      return (await import('@codemirror/lang-yaml')).yaml();
    default:
      return [];
  }
}

/** 按需加载语言支持，并以磁盘文本建立独立的编辑与保存快照。 */
export async function createTab(
  path: string,
  document: Document,
): Promise<Tab> {
  // 大于 1 MiB 时禁用语法解析，其余基础编辑能力保留。
  const syntax =
    document.content.length > 1024 * 1024 ? [] : await language(path);
  const state = EditorState.create({
    doc: document.content,
    extensions: [
      basicSetup,
      sharedTheme,
      searchPanelTips,
      syntaxHighlighting(highlight),
      syntax,
      keymap.of([indentWithTab]),
      wrapCompartment.of([]),
      editableCompartment.of(EditorView.editable.of(true)),
      indentCompartment.of(indentation(4)),
      EditorState.readOnly.of(document.truncated),
      gitChanges,
    ],
  });
  return {
    path,
    state,
    savedDoc: state.doc,
    revision: document.revision,
    newline: document.newline,
    hasBom: document.hasBom,
    scroll: { top: 0, left: 0 },
    paused: false,
    truncated: document.truncated,
    size: document.size,
  };
}

/** 文件大小的可读表示。 */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

/** 磁盘新内容与当前文档的最小替换区间；未变化部分的光标、选区和滚动位置得以保留。 */
export function diffChange(doc: Text, next: string): ChangeSpec | null {
  const current = doc.toString();
  if (current === next) return null;
  const max = Math.min(current.length, next.length);
  let start = 0;
  while (start < max && current.charCodeAt(start) === next.charCodeAt(start))
    start++;
  let end = 0;
  while (
    end < max - start &&
    current.charCodeAt(current.length - 1 - end) ===
      next.charCodeAt(next.length - 1 - end)
  )
    end++;
  return {
    from: start,
    to: current.length - end,
    insert: next.slice(start, next.length - end),
  };
}

/** 内容与最近一次成功保存的快照不同时标记为未保存。 */
export const isDirty = (tab: Tab): boolean => !tab.state.doc.eq(tab.savedDoc);

/** 保存前还原文件原有的 BOM 和换行符。 */
export function serialize(tab: Tab): string {
  return encode(tab.state.doc.toString(), tab.newline, tab.hasBom);
}

/** 把内部 LF 文本还原为指定的换行符和 BOM。 */
export function encode(
  text: string,
  newline: Document['newline'],
  hasBom: boolean,
): string {
  const separator =
    newline === 'CRLF' ? '\r\n' : newline === 'CR' ? '\r' : '\n';
  return (hasBom ? '\uFEFF' : '') + text.replaceAll('\n', separator);
}
