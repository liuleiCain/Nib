import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  getChunks,
  getOriginalDoc,
  originalDocChangeEffect,
  unifiedMergeView,
} from '@codemirror/merge';
import { ChangeSet, Compartment, EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import {
  ArrowDown,
  ArrowUp,
  Columns2,
  FileCode2,
  Link2,
  Link2Off,
  LoaderCircle,
  Rows2,
  Undo2,
} from 'lucide-react';
import type { CommitFile, DiffSources, Side } from '../../lib/backend';
import {
  diffChange,
  editorHighlight,
  editorTheme,
  language,
} from '../editor/model';
import { sideBySide } from './sideBySide';
import type { SideBySide } from './sideBySide';

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
  /** 历史提交的文件顺序，跨文件导航时沿用当前提交。 */
  files?: CommitFile[];
  /** 跨文件导航的落点；普通打开默认定位首处变更。 */
  reveal?: 'first' | 'last';
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
  /** 首次显示一个文件的差异时定位第一处变更，后续刷新保留阅读位置。 */
  revealFirstChange?: boolean;
  /** 文件内到达边界时，按当前变更列表继续前后导航。 */
  navigation?: {
    previous: boolean;
    next: boolean;
    onFile: (direction: 1 | -1) => void;
  };
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

/** 统一视图中变更块右上角的按钮：只提供回滚，不提供“接受”。 */
const chunkControl = (
  type: 'accept' | 'reject',
  action: (event: MouseEvent) => void,
) => {
  if (type === 'accept') return document.createElement('span');
  const button = document.createElement('button');
  button.className = 'diff-revert';
  button.type = 'button';
  button.title = '回滚此处变更';
  button.setAttribute('aria-label', '回滚此处变更');
  // CodeMirror 的控件使用原生 DOM，沿用界面 Undo2 图标的形状。
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({
    width: '14',
    height: '14',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }))
    icon.setAttribute(name, value);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11');
  icon.append(path);
  button.append(icon);
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
  revealFirstChange = false,
  navigation,
  jump = null,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const syntax = useRef(new Compartment());
  const editors = useRef<EditorView[]>([]);
  const navigate = useRef<((direction: 1 | -1) => void) | null>(null);
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  const [available, setAvailable] = useState({
    key: diff.key,
    previous: false,
    next: false,
  });
  // 切换对比模式或开发模式重建视图时，保留当前变更及其边界状态。
  const position = useRef<{
    key: string;
    base: string;
    current: string;
    head: number;
    index: number;
  } | null>(null);
  const revertRef = useRef(onRevert);
  revertRef.current = onRevert;
  // 回滚后会按新内容重建视图，记住滚动位置避免跳回顶部。
  const scroll = useRef<{ key: string; top: number } | null>(null);
  const [count, setCount] = useState(0);
  const [lines, setLines] = useState({ added: 0, removed: 0 });
  const synchronize = useRef<(() => void) | null>(null);
  // 回滚写入失败时递增，按原内容重建视图。
  const [reset, setReset] = useState(0);
  // 左右对比时两侧是否同步滚动；关闭后可分别滚动，连接带仍标出对应位置。
  const [sync, setSync] = useState(true);
  const split = useRef<SideBySide | null>(null);
  const syncRef = useRef(sync);
  syncRef.current = sync;
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
  const content = useRef({
    base,
    current,
    jump,
    path: diff.path,
    key: diff.key,
    reveal: diff.reveal,
  });
  content.current = {
    base,
    current,
    jump,
    path: diff.path,
    key: diff.key,
    reveal: diff.reveal,
  };
  // 提交哈希也属于文件身份，查看同一路径的不同版本时分别定位。
  const revealed = useRef<string | null>(null);
  // 已执行的跳转，视图重建（回滚、切换视图）后不再重复定位。
  const jumped = useRef<number | null>(null);
  const pendingJump = () => {
    const next = content.current.jump;
    return next !== null && next.key !== jumped.current;
  };

  useLayoutEffect(() => {
    const parent = host.current;
    if (!parent || !comparable) return;
    const savedPosition = position.current;
    let initializing = true;
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
      EditorView.updateListener.of((update) => {
        if (update.selectionSet) updateNavigation(update.view);
      }),
    ];
    const scrollKey = `${diff.key}:${unified}:${preview}`;
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
      cursor = null;
      updateNavigation(update.view);
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
    let cursor: { view: EditorView; head: number; index: number } | null = null;
    let targets = { previous: -1, next: -1 };
    /** 两种视图共用非循环导航；手动点击任意一侧后按该侧光标重新计算。 */
    function updateNavigation(view: EditorView = right) {
      const list = chunks();
      const head = view.state.selection.main.head;
      const side = view === left ? 'A' : 'B';
      const start = (index: number) =>
        Math.min(
          list[index][side === 'A' ? 'fromA' : 'fromB'],
          view.state.doc.length,
        );
      const end = (index: number) =>
        Math.min(
          list[index][side === 'A' ? 'toA' : 'toB'],
          view.state.doc.length,
        );
      const index =
        cursor?.view === view &&
        cursor.head === head &&
        cursor.index < list.length
          ? cursor.index
          : list.findIndex((_, index) =>
              start(index) === end(index)
                ? head === start(index)
                : head >= start(index) && head < end(index),
            );
      position.current = {
        key: content.current.key,
        base: content.current.base,
        current: content.current.current,
        head:
          view === left && index >= 0
            ? Math.min(list[index].fromB, right.state.doc.length)
            : right.state.selection.main.head,
        index,
      };
      let previous = index >= 0 ? index - 1 : list.length - 1;
      if (index < 0)
        while (previous >= 0 && start(previous) >= head) previous--;
      const next =
        index >= 0
          ? index + 1
          : list.findIndex((_, index) => start(index) > head);
      targets = { previous, next: next < list.length ? next : -1 };
      setAvailable((old) => {
        const next = {
          key: content.current.key,
          previous: targets.previous >= 0,
          next: targets.next >= 0,
        };
        return old.key === next.key &&
          old.previous === next.previous &&
          old.next === next.next
          ? old
          : next;
      });
    }
    /** 显式记录块序号，保证同一文档位置上的纯删除块也能逐个经过。 */
    function revealChunk(index: number) {
      const chunk = chunks()[index];
      if (!chunk) return;
      const position = Math.min(chunk.fromB, right.state.doc.length);
      cursor = { view: right, head: position, index };
      if (split.current) split.current.reveal(index);
      else
        right.dispatch({
          selection: { anchor: position },
          effects: EditorView.scrollIntoView(position, { y: 'center' }),
        });
      updateNavigation();
    }
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
      cleanup = () => {
        scroll.current = {
          key: `${displayedKey}:${unified}:${preview}`,
          top: view.scrollDOM.scrollTop,
        };
        view.destroy();
      };
    } else {
      const view = sideBySide({
        parent,
        base: content.current.base,
        current: content.current.current,
        extensions: shared,
        currentExtensions: revertListener,
        revertible,
        highlight: !large,
        diffConfig,
        sync: syncRef.current,
      });
      split.current = view;
      chunkCount = () => view.chunks().length;
      chunks = () => view.chunks();
      left = view.a;
      right = view.b;
      scroller = view.b.scrollDOM;
      setCount(chunkCount());
      restore(view.b.scrollDOM);
      cleanup = () => {
        scroll.current = {
          key: `${displayedKey}:${unified}:${preview}`,
          top: view.b.scrollDOM.scrollTop,
        };
        split.current = null;
        view.destroy();
      };
    }
    editors.current = left ? [left, right] : [right];
    navigate.current = (direction) => {
      const index = direction > 0 ? targets.next : targets.previous;
      if (index >= 0) {
        revealChunk(index);
        right.focus();
      } else {
        const files = navigationRef.current;
        if (direction > 0 ? files?.next : files?.previous)
          files?.onFile(direction);
      }
    };
    let displayedKey = content.current.key;
    let lastPosition: number | null = null;
    /** 按最小替换区间更新文本，保留选区；收到跳转请求时定位最近写入的位置。 */
    synchronize.current = () => {
      const next = content.current;
      const changedFile = displayedKey !== next.key;
      displayedKey = next.key;
      if (changedFile) lastPosition = null;
      const top = scroller.scrollTop;
      const leftDoc =
        left?.state.doc ?? (preview ? null : getOriginalDoc(right.state));
      const leftChange = leftDoc ? diffChange(leftDoc, next.base) : null;
      const rightChange = diffChange(right.state.doc, next.current);
      if (changedFile || leftChange || rightChange) cursor = null;
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
      } else if (revealFirstChange && revealed.current !== next.key) {
        revealed.current = next.key;
        revealChunk(next.reveal === 'last' ? updated.length - 1 : 0);
      } else if (
        initializing &&
        savedPosition?.key === next.key &&
        savedPosition.base === next.base &&
        savedPosition.current === next.current
      ) {
        if (savedPosition.index >= 0) revealChunk(savedPosition.index);
        else right.dispatch({ selection: { anchor: savedPosition.head } });
      } else if (changedFile) {
        right.dispatch({ selection: { anchor: 0 } });
        if (left) left.dispatch({ selection: { anchor: 0 } });
        scroller.scrollTop = 0;
      } else if (rightChange || leftChange) scroller.scrollTop = top;
      initializing = false;
      updateNavigation();
    };
    synchronize.current();
    return () => {
      disposed = true;
      navigate.current = null;
      synchronize.current = null;
      editors.current = [];
      cleanup();
    };
  }, [
    reset,
    unified,
    comparable,
    revertible,
    large,
    preview,
    revealFirstChange,
  ]);

  // 语法解析由 CodeMirror 按视口增量处理，不随差异计算的降级一起关闭。
  // 路径变化只重配语言；异步加载不得写入已切换的文件。
  useEffect(() => {
    if (!comparable) return;
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
  }, [base, current, diff.path, diff.key, diff.version, jump]);

  useEffect(() => {
    split.current?.setSync(sync);
  }, [sync]);

  const previous =
    Boolean(navigation?.previous) ||
    (comparable && available.key === diff.key && available.previous);
  const next =
    Boolean(navigation?.next) ||
    (comparable && available.key === diff.key && available.next);
  const ready = !preview && Boolean(sources || diff.error);
  const move = useRef<(direction: 1 | -1) => void>(() => {});
  move.current = (direction) => {
    if (!ready || !(direction > 0 ? next : previous)) return;
    if (comparable) navigate.current?.(direction);
    else navigation?.onFile(direction);
  };

  // F7 / Shift+F7 跳到下一处或上一处变更，与 GoLand 一致。
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key !== 'F7') return;
      event.preventDefault();
      move.current(event.shiftKey ? -1 : 1);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  const added = sources?.base.kind === 'missing';
  const deleted = sources?.current.kind === 'missing';

  return (
    <div className="diff-view">
      <div className="diff-toolbar">
        {!preview && (
          <span className="diff-navigation" role="group" aria-label="变更导航">
            <button
              className="icon-button"
              title="上一处变更 (⇧F7)"
              aria-label="上一处变更"
              disabled={!ready || !previous}
              onClick={() => move.current(-1)}
            >
              <ArrowUp size={16} />
            </button>
            <button
              className="icon-button"
              title="下一处变更 (F7)"
              aria-label="下一处变更"
              disabled={!ready || !next}
              onClick={() => move.current(1)}
            >
              <ArrowDown size={16} />
            </button>
          </span>
        )}
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
          {!unified && !preview && (
            <button
              className={`icon-button ${sync ? 'active' : ''}`}
              title={
                sync
                  ? '同步滚动已开启，点击后左右两侧可分别滚动'
                  : '左右两侧分别滚动，点击开启同步滚动'
              }
              aria-label="同步滚动"
              aria-pressed={sync}
              disabled={!comparable}
              onClick={() => setSync((value) => !value)}
            >
              {sync ? <Link2 size={14} /> : <Link2Off size={14} />}
            </button>
          )}
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
          className={`diff-host ${unified || preview ? 'unified' : 'split side-by-side'}`}
        />
      )}
    </div>
  );
}
