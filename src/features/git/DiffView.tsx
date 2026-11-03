import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  MergeView,
  getChunks,
  goToNextChunk,
  goToPreviousChunk,
  getOriginalDoc,
  originalDocChangeEffect,
  unifiedMergeView,
} from '@codemirror/merge';
import { ChangeSet, Compartment, EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import {
  ChevronDown,
  ChevronUp,
  Columns2,
  FileCode2,
  LoaderCircle,
  Rows2,
  Undo2,
} from 'lucide-react';
import type { DiffSources, Side } from '../../lib/backend';
import {
  diffChange,
  editorHighlight,
  editorTheme,
  language,
} from '../editor/model';

/** 主区打开的一个 Diff 标签。 */
export interface DiffTab {
  /** 标签标识：工作区 Diff 为路径，提交 Diff 为 哈希 + NUL + 路径。 */
  key: string;
  path: string;
  original: string | null;
  /** 数据加载完成前为空。 */
  sources: DiffSources | null;
  error: string | null;
  /** 每次读取递增，内容通过事务同步到现有视图。 */
  version: number;
  /** 提交中的历史变更（与第一个父提交比较）；为空时比较 HEAD 与工作区。 */
  commit: { hash: string; parent: string | null; subject: string } | null;
}

interface Props {
  diff: DiffTab;
  unified: boolean;
  onToggleUnified: () => void;
  onOpenFile: (path: string) => void;
  /** 从 HEAD 恢复已删除的文件，由上层确认后执行。 */
  onRestore: () => void;
  /** 回滚一处变更：before、after 为回滚前后的工作区全文，写入失败返回 false。 */
  onRevert: (before: string, after: string) => Promise<boolean>;
  /** 实时观察时禁用所有写盘操作。 */
  readOnly?: boolean;
  /** 非 Git 项目仅展示最新内容，不将全文误标为新增。 */
  preview?: boolean;
  /** 实时变更的「跳到最新」：预览为该文件时定位最近写入的位置，每个 key 只执行一次。 */
  jump?: { path: string; key: number } | null;
}

/** 大于该字符数时折叠未变化行、降低差异精度，避免长时间计算。 */
const LARGE = 300_000;

/** 无法以文本对比的一侧的说明；文本和不存在（按空文本比较）返回空。 */
const sideLabel = (side: Side): string | null => {
  switch (side.kind) {
    case 'binary':
      return '二进制文件，不显示内容差异。';
    case 'tooLarge':
      return '文件超过 5 MiB，不显示内容差异。';
    case 'unsupported':
      return side.message;
    default:
      return null;
  }
};

/** 左右对比时两栏之间的回滚按钮。 */
const revertButton = () => {
  const button = document.createElement('button');
  button.className = 'diff-revert';
  button.textContent = '»';
  button.title = '回滚此处变更';
  button.setAttribute('aria-label', '回滚此处变更');
  return button;
};

/** 统一视图中变更块右上角的按钮：只提供回滚，不提供“接受”。 */
const chunkControl = (
  type: 'accept' | 'reject',
  action: (event: MouseEvent) => void,
) => {
  if (type === 'accept') return document.createElement('span');
  const button = document.createElement('button');
  button.className = 'diff-revert';
  button.textContent = '回滚';
  button.title = '回滚此处变更';
  button.onmousedown = action;
  return button;
};

/**
 * HEAD 与工作区的对比视图；默认左右两栏，可切换为统一视图。
 * 内容只读，每处变更可单独回滚为 HEAD 版本，由上层写入文件。
 */
export function DiffView({
  diff,
  unified,
  onToggleUnified,
  onOpenFile,
  onRestore,
  onRevert,
  readOnly = false,
  preview = false,
  jump = null,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const syntax = useRef(new Compartment());
  const editors = useRef<EditorView[]>([]);
  const navigate = useRef<((direction: 1 | -1) => void) | null>(null);
  const revertRef = useRef(onRevert);
  revertRef.current = onRevert;
  // 回滚后会按新内容重建视图，记住滚动位置避免跳回顶部。
  const scroll = useRef<{ key: string; top: number } | null>(null);
  const [count, setCount] = useState(0);
  const [lines, setLines] = useState({ added: 0, removed: 0 });
  const synchronize = useRef<(() => void) | null>(null);
  // 回滚写入失败时递增，按原内容重建视图。
  const [reset, setReset] = useState(0);
  const sources = diff.sources;
  const base = sources?.base.kind === 'text' ? sources.base.content : '';
  const current =
    sources?.current.kind === 'text' ? sources.current.content : '';
  // 一侧为二进制、超限或不支持时不显示文本对比，避免误导；新增、删除时空的一侧按空文本比较。
  const notice = sources
    ? preview && sources.current.kind === 'missing'
      ? '文件已从磁盘删除。'
      : (sideLabel(sources.current) ?? sideLabel(sources.base))
    : null;
  const comparable = Boolean(sources) && !notice && !diff.error;
  // 历史提交只读；文件已删除时没有可写入的工作区文件，不提供回滚。
  const revertible =
    !readOnly && !diff.commit && sources?.current.kind === 'text';
  const commit = diff.commit;
  const large = base.length + current.length > LARGE;
  const content = useRef({ base, current, jump, path: diff.path });
  content.current = { base, current, jump, path: diff.path };
  // 已执行的跳转，视图重建（回滚、切换视图）后不再重复定位。
  const jumped = useRef<number | null>(null);
  const pendingJump = () => {
    const next = content.current.jump;
    return next !== null && next.key !== jumped.current;
  };

  useLayoutEffect(() => {
    const parent = host.current;
    if (!parent || !comparable) return;
    let disposed = false;
    let cleanup = () => {};
    const shared: Extension[] = [
      lineNumbers(),
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      editorTheme,
      syntaxHighlighting(editorHighlight),
      syntax.current.of([]),
      EditorState.tabSize.of(4),
    ];
    const scrollKey = `${diff.path}:${unified}:${preview}`;
    let chunkCount = () => 0;
    let chunks = () =>
      [] as readonly {
        fromA: number;
        toA: number;
        fromB: number;
        toB: number;
      }[];
    // 视图先显示回滚结果，写入失败或被拒绝时重建为原内容。
    const revertListener = EditorView.updateListener.of((update) => {
      if (!update.transactions.some((tr) => tr.isUserEvent('revert'))) return;
      setCount(chunkCount());
      void revertRef
        .current(update.startState.doc.toString(), update.state.doc.toString())
        .then((saved) => {
          if (!saved && !disposed) setReset((value) => value + 1);
        });
    });
    const restore = (scroller: HTMLElement) => {
      const saved = scroll.current;
      if (saved?.key === scrollKey && !pendingJump())
        requestAnimationFrame(() => {
          if (!disposed && !pendingJump()) scroller.scrollTop = saved.top;
        });
    };
    const collapse = { margin: 3, minSize: 8 };
    const diffConfig = { scanLimit: large ? 200 : 2000, timeout: 1500 };
    let left: EditorView | null = null;
    let right: EditorView;
    let scroller: HTMLElement;
    if (unified || preview) {
      const view = new EditorView({
        parent,
        state: EditorState.create({
          doc: content.current.current,
          extensions: [
            shared,
            revertListener,
            preview
              ? []
              : unifiedMergeView({
                  original: content.current.base,
                  mergeControls: revertible ? chunkControl : false,
                  gutter: true,
                  syntaxHighlightDeletions: !large,
                  collapseUnchanged: collapse,
                  diffConfig,
                }),
          ],
        }),
      });
      chunkCount = () => getChunks(view.state)?.chunks.length ?? 0;
      chunks = () => getChunks(view.state)?.chunks ?? [];
      right = view;
      scroller = view.scrollDOM;
      setCount(chunkCount());
      restore(view.scrollDOM);
      navigate.current = (direction) => {
        (direction > 0 ? goToNextChunk : goToPreviousChunk)(view);
        view.focus();
      };
      cleanup = () => {
        scroll.current = {
          key: `${displayedPath}:${unified}:${preview}`,
          top: view.scrollDOM.scrollTop,
        };
        view.destroy();
      };
    } else {
      const view = new MergeView({
        parent,
        a: { doc: content.current.base, extensions: shared },
        b: {
          doc: content.current.current,
          extensions: [shared, revertListener],
        },
        gutter: true,
        revertControls: revertible ? 'a-to-b' : undefined,
        renderRevertControl: revertButton,
        collapseUnchanged: collapse,
        diffConfig,
      });
      chunkCount = () => view.chunks.length;
      chunks = () => view.chunks;
      left = view.a;
      right = view.b;
      scroller = parent;
      setCount(chunkCount());
      restore(parent);
      navigate.current = (direction) => {
        (direction > 0 ? goToNextChunk : goToPreviousChunk)(view.b);
        view.b.focus();
      };
      cleanup = () => {
        scroll.current = {
          key: `${displayedPath}:${unified}:${preview}`,
          top: parent.scrollTop,
        };
        view.destroy();
      };
    }
    editors.current = left ? [left, right] : [right];
    let displayedPath = content.current.path;
    let lastPosition: number | null = null;
    /** 按最小替换区间更新文本，保留选区；收到跳转请求时定位最近写入的位置。 */
    synchronize.current = () => {
      const next = content.current;
      const changedFile = displayedPath !== next.path;
      displayedPath = next.path;
      if (changedFile) lastPosition = null;
      const top = scroller.scrollTop;
      const leftDoc =
        left?.state.doc ?? (preview ? null : getOriginalDoc(right.state));
      const leftChange = leftDoc ? diffChange(leftDoc, next.base) : null;
      const rightChange = diffChange(right.state.doc, next.current);
      if (leftChange && left) left.dispatch({ changes: leftChange });
      const effects =
        leftChange && !left && !preview
          ? originalDocChangeEffect(
              right.state,
              ChangeSet.of(leftChange, getOriginalDoc(right.state).length),
            )
          : null;
      let changedPosition: number | null = null;
      if (rightChange)
        right.state
          .changes(rightChange)
          .iterChangedRanges((_fromA, _toA, fromB) => {
            changedPosition = fromB;
          });
      if (rightChange || effects)
        right.dispatch({
          changes: rightChange ?? [],
          effects: effects ?? [],
        });
      const updated = chunks();
      lastPosition = changedPosition ?? lastPosition ?? updated[0]?.fromB ?? 0;
      setCount(chunkCount());
      const lineCount = (doc: EditorState['doc'], from: number, to: number) => {
        const text = doc.sliceString(
          Math.min(from, doc.length),
          Math.min(to, doc.length),
        );
        return text
          ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
          : 0;
      };
      const originalDoc =
        left?.state.doc ??
        (preview ? right.state.doc : getOriginalDoc(right.state));
      const nextLines = updated.reduce(
        (total, chunk) => ({
          added:
            total.added + lineCount(right.state.doc, chunk.fromB, chunk.toB),
          removed:
            total.removed + lineCount(originalDoc, chunk.fromA, chunk.toA),
        }),
        { added: 0, removed: 0 },
      );
      setLines((previous) =>
        previous.added === nextLines.added &&
        previous.removed === nextLines.removed
          ? previous
          : nextLines,
      );
      if (next.jump && next.jump.path === next.path && pendingJump()) {
        jumped.current = next.jump.key;
        const position = Math.min(lastPosition, right.state.doc.length);
        right.dispatch({
          effects: EditorView.scrollIntoView(position, { y: 'center' }),
        });
      } else if (changedFile) {
        right.dispatch({ selection: { anchor: 0 } });
        if (left) left.dispatch({ selection: { anchor: 0 } });
        scroller.scrollTop = 0;
      } else if (rightChange || leftChange) scroller.scrollTop = top;
    };
    synchronize.current();
    return () => {
      disposed = true;
      navigate.current = null;
      synchronize.current = null;
      editors.current = [];
      cleanup();
    };
  }, [reset, unified, comparable, revertible, large, preview]);

  // 路径变化只重配语言，不销毁代码视图；异步语言加载不得写入已切换的文件。
  useEffect(() => {
    if (!comparable || large) return;
    let disposed = false;
    void language(diff.path).then((extension) => {
      if (disposed) return;
      for (const view of editors.current)
        view.dispatch({ effects: syntax.current.reconfigure(extension) });
    });
    return () => {
      disposed = true;
    };
  }, [diff.path, reset, unified, comparable, revertible, large, preview]);

  useLayoutEffect(() => {
    synchronize.current?.();
  }, [base, current, diff.path, diff.version, jump]);

  // F7 / Shift+F7 跳到下一处或上一处变更，与 GoLand 一致。
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key !== 'F7') return;
      event.preventDefault();
      navigate.current?.(event.shiftKey ? -1 : 1);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  const added = sources?.base.kind === 'missing';
  const deleted = sources?.current.kind === 'missing';

  return (
    <div className="diff-view">
      <div className="diff-toolbar">
        <span className="diff-sides">
          <span>
            {added
              ? preview
                ? '最新磁盘内容'
                : '（新文件）'
              : `${commit ? (commit.parent?.slice(0, 7) ?? '') : 'HEAD'}${diff.original ? ` · ${diff.original}` : ''}`}
          </span>
          <span title={commit?.subject}>
            {preview
              ? diff.path
              : deleted
                ? '（已删除）'
                : commit
                  ? `${commit.hash.slice(0, 7)} · ${commit.subject}`
                  : '工作区'}
          </span>
        </span>
        {comparable && !preview && (
          <span className="diff-count">
            {count} 处变更 <span className="live-added">+{lines.added}</span>{' '}
            <span className="live-removed">−{lines.removed}</span>
          </span>
        )}
        <span className="diff-actions">
          <button
            className="icon-button"
            title="上一处变更 (⇧F7)"
            aria-label="上一处变更"
            disabled={!comparable || preview}
            onClick={() => navigate.current?.(-1)}
          >
            <ChevronUp size={15} />
          </button>
          <button
            className="icon-button"
            title="下一处变更 (F7)"
            aria-label="下一处变更"
            disabled={!comparable || preview}
            onClick={() => navigate.current?.(1)}
          >
            <ChevronDown size={15} />
          </button>
          <button
            className="icon-button"
            title={unified ? '切换为左右对比' : '切换为统一视图'}
            aria-label={unified ? '切换为左右对比' : '切换为统一视图'}
            onClick={onToggleUnified}
            disabled={preview}
          >
            {unified ? <Columns2 size={14} /> : <Rows2 size={14} />}
          </button>
          {commit ? null : deleted ? (
            readOnly ? null : (
              <button
                className="secondary-button"
                onClick={onRestore}
                title="从 HEAD 恢复此文件"
              >
                <Undo2 size={13} /> 恢复文件
              </button>
            )
          ) : (
            <button
              className="secondary-button"
              onClick={() => onOpenFile(diff.path)}
              title="在编辑器中打开文件"
            >
              <FileCode2 size={13} /> 编辑文件
            </button>
          )}
        </span>
      </div>
      {diff.error ? (
        <div className="diff-message error">{diff.error}</div>
      ) : !sources ? (
        <div className="diff-message">
          <LoaderCircle size={14} className="spin" /> 正在读取变更…
        </div>
      ) : notice ? (
        <div className="diff-message">{notice}</div>
      ) : (
        <div
          ref={host}
          key={`${reset}:${unified}:${preview}:${revertible}:${large}`}
          className={`diff-host ${unified || preview ? 'unified' : 'split'}`}
        />
      )}
    </div>
  );
}
