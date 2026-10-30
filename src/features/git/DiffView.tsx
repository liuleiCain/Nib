import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  MergeView,
  getChunks,
  goToNextChunk,
  goToPreviousChunk,
  unifiedMergeView,
} from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
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
import { editorHighlight, editorTheme, language } from '../editor/model';

/** 主区打开的一个 Diff 标签。 */
export interface DiffTab {
  /** 标签标识：工作区 Diff 为路径，提交 Diff 为 哈希 + NUL + 路径。 */
  key: string;
  path: string;
  original: string | null;
  /** 数据加载完成前为空。 */
  sources: DiffSources | null;
  error: string | null;
  /** 每次刷新递增，视图据此重建。 */
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
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const navigate = useRef<((direction: 1 | -1) => void) | null>(null);
  const revertRef = useRef(onRevert);
  revertRef.current = onRevert;
  // 回滚后会按新内容重建视图，记住滚动位置避免跳回顶部。
  const scroll = useRef<{ key: string; top: number } | null>(null);
  const [count, setCount] = useState(0);
  // 回滚写入失败时递增，按原内容重建视图。
  const [reset, setReset] = useState(0);
  const sources = diff.sources;
  const base = sources?.base.kind === 'text' ? sources.base.content : '';
  const current =
    sources?.current.kind === 'text' ? sources.current.content : '';
  // 一侧为二进制、超限或不支持时不显示文本对比，避免误导；新增、删除时空的一侧按空文本比较。
  const notice = sources
    ? (sideLabel(sources.current) ?? sideLabel(sources.base))
    : null;
  const comparable = Boolean(sources) && !notice;
  // 历史提交只读；文件已删除时没有可写入的工作区文件，不提供回滚。
  const revertible = !diff.commit && sources?.current.kind === 'text';
  const commit = diff.commit;

  useLayoutEffect(() => {
    const parent = host.current;
    if (!parent || !comparable) return;
    let disposed = false;
    let cleanup = () => {};
    void (async () => {
      const syntax = await language(diff.path);
      if (disposed) return;
      const large = base.length + current.length > LARGE;
      const shared: Extension[] = [
        lineNumbers(),
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        editorTheme,
        syntaxHighlighting(editorHighlight),
        large ? [] : syntax,
        EditorState.tabSize.of(4),
      ];
      const scrollKey = `${diff.path}:${unified}`;
      let chunkCount = () => 0;
      // 视图先显示回滚结果，写入失败或被拒绝时重建为原内容。
      const revertListener = EditorView.updateListener.of((update) => {
        if (!update.transactions.some((tr) => tr.isUserEvent('revert'))) return;
        setCount(chunkCount());
        void revertRef
          .current(
            update.startState.doc.toString(),
            update.state.doc.toString(),
          )
          .then((saved) => {
            if (!saved && !disposed) setReset((value) => value + 1);
          });
      });
      const restore = (scroller: HTMLElement) => {
        const saved = scroll.current;
        if (saved?.key === scrollKey)
          requestAnimationFrame(() => (scroller.scrollTop = saved.top));
      };
      const collapse = { margin: 3, minSize: 8 };
      const diffConfig = { scanLimit: large ? 200 : 2000, timeout: 1500 };
      if (unified) {
        const view = new EditorView({
          parent,
          state: EditorState.create({
            doc: current,
            extensions: [
              shared,
              revertListener,
              unifiedMergeView({
                original: base,
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
        setCount(chunkCount());
        restore(view.scrollDOM);
        navigate.current = (direction) => {
          (direction > 0 ? goToNextChunk : goToPreviousChunk)(view);
          view.focus();
        };
        cleanup = () => {
          scroll.current = { key: scrollKey, top: view.scrollDOM.scrollTop };
          view.destroy();
        };
      } else {
        const view = new MergeView({
          parent,
          a: { doc: base, extensions: shared },
          b: { doc: current, extensions: [shared, revertListener] },
          gutter: true,
          revertControls: revertible ? 'a-to-b' : undefined,
          renderRevertControl: revertButton,
          collapseUnchanged: collapse,
          diffConfig,
        });
        chunkCount = () => view.chunks.length;
        setCount(chunkCount());
        restore(parent);
        navigate.current = (direction) => {
          (direction > 0 ? goToNextChunk : goToPreviousChunk)(view.b);
          view.b.focus();
        };
        cleanup = () => {
          scroll.current = { key: scrollKey, top: parent.scrollTop };
          view.destroy();
        };
      }
    })();
    return () => {
      disposed = true;
      navigate.current = null;
      cleanup();
    };
  }, [
    diff.path,
    diff.version,
    reset,
    unified,
    comparable,
    revertible,
    base,
    current,
  ]);

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
              ? '（新文件）'
              : `${commit ? (commit.parent?.slice(0, 7) ?? '') : 'HEAD'}${diff.original ? ` · ${diff.original}` : ''}`}
          </span>
          <span title={commit?.subject}>
            {deleted
              ? '（已删除）'
              : commit
                ? `${commit.hash.slice(0, 7)} · ${commit.subject}`
                : '工作区'}
          </span>
        </span>
        {comparable && <span className="diff-count">{count} 处变更</span>}
        <span className="diff-actions">
          <button
            className="icon-button"
            title="上一处变更 (⇧F7)"
            aria-label="上一处变更"
            disabled={!comparable}
            onClick={() => navigate.current?.(-1)}
          >
            <ChevronUp size={15} />
          </button>
          <button
            className="icon-button"
            title="下一处变更 (F7)"
            aria-label="下一处变更"
            disabled={!comparable}
            onClick={() => navigate.current?.(1)}
          >
            <ChevronDown size={15} />
          </button>
          <button
            className="icon-button"
            title={unified ? '切换为左右对比' : '切换为统一视图'}
            aria-label={unified ? '切换为左右对比' : '切换为统一视图'}
            onClick={onToggleUnified}
          >
            {unified ? <Columns2 size={14} /> : <Rows2 size={14} />}
          </button>
          {commit ? null : deleted ? (
            <button
              className="secondary-button"
              onClick={onRestore}
              title="从 HEAD 恢复此文件"
            >
              <Undo2 size={13} /> 恢复文件
            </button>
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
          key={`${diff.version}:${reset}:${unified}`}
          className={`diff-host ${unified ? 'unified' : 'split'}`}
        />
      )}
    </div>
  );
}
