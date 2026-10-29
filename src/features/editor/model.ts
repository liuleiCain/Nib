import { EditorState, Compartment } from '@codemirror/state';
import type { Extension, Text } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { Document } from '../../lib/backend';

/** 标签保存独立的编辑器状态，切换时保留撤销历史、选区和滚动位置。 */
export interface Tab {
  path: string;
  state: EditorState;
  savedDoc: Text;
  revision: string;
  newline: Document['newline'];
  hasBom: boolean;
  scroll: { top: number; left: number };
}

export const wrapCompartment = new Compartment();
export const editableCompartment = new Compartment();

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

async function language(path: string): Promise<Extension> {
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
      theme,
      syntaxHighlighting(highlight),
      syntax,
      keymap.of([indentWithTab]),
      wrapCompartment.of([]),
      editableCompartment.of(EditorView.editable.of(true)),
      EditorState.tabSize.of(4),
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
  };
}

/** 内容与最近一次成功保存的快照不同时标记为未保存。 */
export const isDirty = (tab: Tab): boolean => !tab.state.doc.eq(tab.savedDoc);

/** 保存前还原文件原有的 BOM 和换行符。 */
export function serialize(tab: Tab): string {
  const newline =
    tab.newline === 'CRLF' ? '\r\n' : tab.newline === 'CR' ? '\r' : '\n';
  return (
    (tab.hasBom ? '\uFEFF' : '') +
    tab.state.doc.toString().replaceAll('\n', newline)
  );
}
