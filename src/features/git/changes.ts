import { Chunk } from '@codemirror/merge';
import type { Extension } from '@codemirror/state';
import {
  Prec,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Text,
} from '@codemirror/state';
import type { BlockInfo, Tooltip } from '@codemirror/view';
import {
  EditorView,
  GutterMarker,
  ViewPlugin,
  gutter,
  keymap,
  showTooltip,
} from '@codemirror/view';

/** 超过该字符数不计算行变更，避免大文件输入卡顿。 */
const MAX_CHARS = 1024 * 1024;

/** 设置 HEAD 版本；null 表示文件未被 Git 跟踪或不在仓库中，不显示标记。 */
export const setHeadDoc = StateEffect.define<Text | null>();

interface LineChanges {
  head: Text | null;
  chunks: readonly Chunk[];
}

function build(head: Text | null, doc: Text): readonly Chunk[] {
  if (!head || head.length > MAX_CHARS || doc.length > MAX_CHARS) return [];
  return Chunk.build(head, doc, { scanLimit: 500, timeout: 50 });
}

/** 当前文档相对 HEAD 的变更块，编辑时增量更新。 */
const lineChanges = StateField.define<LineChanges>({
  create: () => ({ head: null, chunks: [] }),
  update(value, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(setHeadDoc))
        return {
          head: effect.value,
          chunks: build(effect.value, transaction.state.doc),
        };
    if (!transaction.docChanged || !value.head) return value;
    if (
      transaction.state.doc.length > MAX_CHARS ||
      value.head.length > MAX_CHARS
    )
      return { head: value.head, chunks: [] };
    return {
      head: value.head,
      chunks: Chunk.updateB(
        value.chunks,
        value.head,
        transaction.state.doc,
        transaction.changes,
        { scanLimit: 500, timeout: 50 },
      ),
    };
  },
});

/** 修改标记虚线的周期（3px 线段 + 2px 间隔），与下方主题保持一致。 */
const DASH = 5;

/**
 * 每行一个标记：只在变更块的首尾留出间隙，块内相邻行连成一条；
 * phase 为该行顶部在文档中的偏移对虚线周期取余，跨行时虚线保持连续。
 */
class ChangeMarker extends GutterMarker {
  constructor(
    readonly kind: 'added' | 'modified' | 'deleted',
    readonly first = true,
    readonly last = true,
    readonly phase = 0,
  ) {
    super();
  }
  eq(other: ChangeMarker) {
    return (
      other.kind === this.kind &&
      other.first === this.first &&
      other.last === this.last &&
      other.phase === this.phase
    );
  }
  toDOM() {
    const element = document.createElement('div');
    element.className = `cm-git-${this.kind}`;
    if (this.kind !== 'deleted') {
      element.style.top = this.first ? '1px' : '0';
      element.style.bottom = this.last ? '1px' : '0';
      // 背景从元素顶部开始绘制，按文档位置平移，使各行拼接成同一段虚线。
      if (this.kind === 'modified')
        element.style.backgroundPositionY = `${-(this.phase + (this.first ? 1 : 0))}px`;
    }
    element.title = labels[this.kind];
    return element;
  }
}

const labels = {
  added: '新增行，点击查看或回滚',
  modified: '修改行，点击查看或回滚',
  deleted: '此处有删除的行，点击查看或回滚',
};

const markers = {
  added: new ChangeMarker('added'),
  deleted: new ChangeMarker('deleted'),
};

/** 弹窗最多预览的 HEAD 行数与每行字符数。 */
const PREVIEW_LINES = 12;
const PREVIEW_CHARS = 200;

/** 打开或关闭变更块弹窗；null 表示关闭。 */
const setPopup = StateEffect.define<Chunk | null>();

interface Popup {
  chunk: Chunk;
  tooltip: Tooltip;
}

/** 点击行号旁标记打开的变更块弹窗；文档或 HEAD 版本变化时自动关闭。 */
const popupField = StateField.define<Popup | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setPopup)) {
        const chunk = effect.value;
        if (!chunk || chunk === value?.chunk) return null;
        const pos = transaction.state.doc.lineAt(
          Math.min(chunk.fromB, transaction.state.doc.length),
        ).from;
        return {
          chunk,
          tooltip: {
            pos,
            above: true,
            create: (view) => popupView(view, chunk),
          },
        };
      }
      if (effect.is(setHeadDoc)) return null;
    }
    return transaction.docChanged ? null : value;
  },
  provide: (field) =>
    showTooltip.from(field, (value) => value?.tooltip ?? null),
});

/** 变更块覆盖的当前文档行数；纯删除块为 0。 */
function linesB(doc: Text, chunk: Chunk) {
  if (chunk.fromB === chunk.toB) return 0;
  const end = Math.max(chunk.fromB, chunk.endB);
  return doc.lineAt(end).number - doc.lineAt(chunk.fromB).number + 1;
}

/** 变更块覆盖的 HEAD 行数；纯新增块为 0。 */
function linesA(head: Text, chunk: Chunk) {
  if (chunk.fromA === chunk.toA) return 0;
  const end = Math.max(chunk.fromA, chunk.endA);
  return head.lineAt(end).number - head.lineAt(chunk.fromA).number + 1;
}

/** 用 HEAD 内容替换该变更块，作为普通编辑进入撤销栈。 */
function revert(view: EditorView, chunk: Chunk) {
  const { state } = view;
  const head = state.field(lineChanges).head;
  if (!head) return;
  let insert = head.sliceString(
    chunk.fromA,
    Math.max(chunk.fromA, chunk.toA - 1),
  );
  if (chunk.fromA !== chunk.toA && chunk.toB <= state.doc.length)
    insert += state.lineBreak;
  view.dispatch({
    changes: {
      from: chunk.fromB,
      to: Math.min(state.doc.length, chunk.toB),
      insert,
    },
    userEvent: 'revert',
  });
}

function popupView(view: EditorView, chunk: Chunk) {
  const head = view.state.field(lineChanges).head ?? Text.empty;
  const removed = linesA(head, chunk);
  const added = linesB(view.state.doc, chunk);
  const dom = document.createElement('div');
  dom.className = 'cm-git-popup';
  const bar = document.createElement('div');
  bar.className = 'cm-git-popup-bar';
  const summary = document.createElement('span');
  summary.textContent = !removed
    ? `新增 ${added} 行`
    : !added
      ? `删除了 ${removed} 行`
      : `修改 ${added} 行（原 ${removed} 行）`;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '回滚';
  const readOnly =
    view.state.readOnly || !view.state.facet(EditorView.editable);
  button.disabled = readOnly;
  button.title = readOnly ? '当前文件不可编辑' : '恢复为 HEAD 中的内容';
  // 阻止按下时抢走焦点，点击后焦点留在编辑器。
  button.onmousedown = (event) => event.preventDefault();
  button.onclick = () => {
    revert(view, chunk);
    view.focus();
  };
  bar.append(summary, button);
  dom.append(bar);
  if (removed) {
    const preview = document.createElement('pre');
    preview.className = 'cm-git-popup-head';
    const first = head.lineAt(chunk.fromA).number;
    const shown = Math.min(removed, PREVIEW_LINES);
    const lines: string[] = [];
    for (let offset = 0; offset < shown; offset++) {
      const text = head.line(first + offset).text;
      lines.push(
        text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text,
      );
    }
    if (removed > shown) lines.push(`… 另有 ${removed - shown} 行`);
    preview.textContent = lines.join('\n');
    preview.title = 'HEAD 中的原内容';
    dom.append(preview);
  }
  return { dom };
}

/** 点击行所在的变更块；删除标记位于被删内容之后那一行。 */
function chunkAt(view: EditorView, line: BlockInfo) {
  const { doc } = view.state;
  for (const chunk of view.state.field(lineChanges).chunks) {
    const from = doc.lineAt(Math.min(chunk.fromB, doc.length)).from;
    if (chunk.fromB === chunk.toB) {
      if (from === line.from) return chunk;
      continue;
    }
    const to = doc.lineAt(Math.max(chunk.fromB, chunk.endB)).to;
    if (line.from >= from && line.from <= to) return chunk;
  }
  return null;
}

/** 弹窗外按下鼠标时关闭弹窗。 */
const popupDismiss = ViewPlugin.define((view) => {
  const listener = (event: MouseEvent) => {
    if (!view.state.field(popupField)) return;
    const target = event.target as Element | null;
    if (target?.closest('.cm-git-popup, .cm-git-gutter')) return;
    view.dispatch({ effects: setPopup.of(null) });
  };
  document.addEventListener('mousedown', listener, true);
  return {
    destroy: () => document.removeEventListener('mousedown', listener, true),
  };
});

const popupKeys = Prec.highest(
  keymap.of([
    {
      key: 'Escape',
      run: (view) => {
        if (!view.state.field(popupField)) return false;
        view.dispatch({ effects: setPopup.of(null) });
        return true;
      },
    },
  ]),
);

/**
 * 行号旁的变更标记：新增为绿色实心条，修改为黄色虚线条，删除位置为灰色三角。
 * 形状本身即可区分三种变更，色盲用户不依赖颜色也能识别。
 */
const changeGutter = gutter({
  class: 'cm-git-gutter',
  markers(view) {
    const builder = new RangeSetBuilder<GutterMarker>();
    const { doc } = view.state;
    for (const chunk of view.state.field(lineChanges).chunks) {
      if (chunk.fromB === chunk.toB) {
        // 删除：标在被删内容之后的那一行开头。
        const at = Math.min(chunk.fromB, doc.length);
        builder.add(doc.lineAt(at).from, doc.lineAt(at).from, markers.deleted);
        continue;
      }
      const kind = chunk.fromA === chunk.toA ? 'added' : 'modified';
      const first = doc.lineAt(Math.min(chunk.fromB, doc.length)).number;
      const last = doc.lineAt(Math.max(chunk.fromB, chunk.endB)).number;
      for (let number = first; number <= last; number++) {
        const line = doc.line(number);
        // 行高可能是小数（如 22.75px），保留小数相位，接缝处才不会错开。
        const phase =
          kind === 'modified' ? view.lineBlockAt(line.from).top % DASH : 0;
        builder.add(
          line.from,
          line.from,
          new ChangeMarker(kind, number === first, number === last, phase),
        );
      }
    }
    return builder.finish();
  },
  // 虚线相位取决于行的纵向位置，换行或字号变化导致行高改变时也要重算。
  lineMarkerChange: (update) =>
    update.startState.field(lineChanges) !== update.state.field(lineChanges) ||
    update.heightChanged,
  initialSpacer: () => markers.added,
  domEventHandlers: {
    mousedown(view, line, event) {
      if ((event as MouseEvent).button !== 0) return false;
      const chunk = chunkAt(view, line);
      if (!chunk && !view.state.field(popupField)) return false;
      view.dispatch({ effects: setPopup.of(chunk) });
      return true;
    },
  },
});

const changeTheme = EditorView.theme({
  '.cm-git-gutter': { width: '4px', marginRight: '2px' },
  '.cm-git-gutter .cm-gutterElement': { padding: '0', position: 'relative' },
  '.cm-git-added, .cm-git-modified, .cm-git-deleted': { cursor: 'pointer' },
  '.cm-git-gutter .cm-gutterElement:hover > div': { filter: 'brightness(1.3)' },
  '.cm-tooltip.cm-git-popup': {
    minWidth: '220px',
    maxWidth: 'min(640px, 80vw)',
    fontFamily: 'var(--ui-font)',
    fontSize: '12px',
    color: 'var(--text)',
  },
  '.cm-git-popup-bar': {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    justifyContent: 'space-between',
    padding: '5px 6px 5px 10px',
  },
  '.cm-git-popup-bar > span': { color: 'var(--muted)' },
  '.cm-git-popup-bar > button': {
    color: '#d1ddd8',
    background: '#2f373d',
    border: '1px solid #3a444b',
    borderRadius: '3px',
    padding: '2px 10px',
    font: 'inherit',
    cursor: 'pointer',
  },
  '.cm-git-popup-bar > button:hover:not(:disabled)': { background: '#3a444b' },
  '.cm-git-popup-bar > button:disabled': { opacity: '0.5', cursor: 'default' },
  '.cm-git-popup-head': {
    margin: '0',
    padding: '6px 10px',
    maxHeight: '240px',
    overflow: 'auto',
    borderTop: '1px solid #40494f',
    fontFamily: 'var(--editor-font)',
    fontSize: '12px',
    whiteSpace: 'pre',
    color: 'var(--diff-deleted)',
    background: '#e0884f12',
  },
  '.cm-git-added, .cm-git-modified': {
    position: 'absolute',
    left: '0',
    right: '0',
    borderRadius: '1px',
  },
  '.cm-git-added': { background: 'var(--git-added)' },
  '.cm-git-modified': {
    background:
      'repeating-linear-gradient(to bottom, var(--git-modified) 0 3px, transparent 3px 5px)',
  },
  '.cm-git-deleted': {
    position: 'absolute',
    top: '-5px',
    left: '0',
    width: '0',
    height: '0',
    borderTop: '5px solid transparent',
    borderBottom: '5px solid transparent',
    borderLeft: '6px solid var(--git-untracked)',
  },
});

/** 编辑器 Git 变更标记扩展。 */
export const gitChanges: Extension = [
  lineChanges,
  popupField,
  popupDismiss,
  popupKeys,
  changeGutter,
  changeTheme,
];
