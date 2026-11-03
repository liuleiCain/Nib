import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MergeView } from '@codemirror/merge';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import { basicSetup } from 'codemirror';
import { LoaderCircle, RotateCw } from 'lucide-react';
import type { Document } from '../../lib/backend';
import { backend, errorMessage } from '../../lib/backend';
import {
  diffChange,
  editorHighlight,
  editorTheme,
  indentation,
  language,
} from './model';

interface Props {
  projectId: number;
  path: string;
  initial: string;
  version: number;
  indent: number;
  wrap: boolean;
  /** 右侧编辑同步到原标签，返回、关闭或异常退出时仍可恢复。 */
  onEdit: (content: string) => void;
  /** 使用磁盘版本或按该磁盘版本保存合并结果，版本变化时拒绝操作。 */
  onResolve: (disk: Document, content: string, save: boolean) => Promise<void>;
  onClose: () => void;
}

/** 外部修改冲突的双栏对比；刷新磁盘侧时保留合并草稿、选区及撤销历史。 */
export function ConflictDialog({
  projectId,
  path,
  initial,
  version,
  indent,
  wrap,
  onEdit,
  onResolve,
  onClose,
}: Props) {
  const container = useRef<HTMLElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const merge = useRef<MergeView | null>(null);
  const draft = useRef(initial);
  const callbacks = useRef({ onEdit, onResolve, onClose });
  callbacks.current = { onEdit, onResolve, onClose };
  const [disk, setDisk] = useState<Document | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [changed, setChanged] = useState(false);
  const revision = useRef<string | null>(null);
  const syntax = useRef(new Compartment());
  const editing = useRef(new Compartment());

  useEffect(() => {
    let current = true;
    setLoading(true);
    backend.readFile(projectId, path).then(
      (document) => {
        if (!current) return;
        if (document.truncated || document.size > 5 * 1024 * 1024) {
          setReadError(
            '磁盘文件超过 5 MiB，无法在此对比。你的编辑仍保留在原标签中。',
          );
          setDisk(null);
        } else {
          if (revision.current && revision.current !== document.revision)
            setChanged(true);
          revision.current = document.revision;
          setDisk(document);
          setReadError(null);
        }
        setLoading(false);
      },
      (failure) => {
        if (!current) return;
        setDisk(null);
        setReadError(`${errorMessage(failure)} 你的编辑仍保留在原标签中。`);
        setLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [projectId, path, version, refresh]);

  useLayoutEffect(() => {
    if (!host.current) return;
    const shared = [
      basicSetup,
      editorTheme,
      syntaxHighlighting(editorHighlight),
      indentation(indent),
      wrap ? EditorView.lineWrapping : [],
    ];
    const view = new MergeView({
      parent: host.current,
      a: {
        doc: '',
        extensions: [
          shared,
          syntax.current.of([]),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ 'aria-label': '最新磁盘内容' }),
        ],
      },
      b: {
        doc: draft.current,
        extensions: [
          shared,
          syntax.current.of([]),
          editing.current.of(EditorView.editable.of(true)),
          EditorView.contentAttributes.of({ 'aria-label': '合并结果' }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            draft.current = update.state.doc.toString();
            callbacks.current.onEdit(draft.current);
          }),
        ],
      },
      gutter: true,
      revertControls: 'a-to-b',
      renderRevertControl: () => {
        const button = document.createElement('button');
        button.className = 'diff-revert';
        button.textContent = '»';
        button.title = '采用此处磁盘内容';
        button.setAttribute('aria-label', '采用此处磁盘内容');
        return button;
      },
      diffConfig: { scanLimit: 500, timeout: 1000 },
    });
    merge.current = view;
    container.current
      ?.querySelector<HTMLButtonElement>('[data-close]')
      ?.focus();
    return () => {
      merge.current = null;
      view.destroy();
    };
  }, [indent, wrap]);

  useEffect(() => {
    const view = merge.current;
    if (!view) return;
    const change = diffChange(view.a.state.doc, disk?.content ?? '');
    if (change)
      view.a.dispatch({
        changes: change,
        annotations: Transaction.addToHistory.of(false),
      });
    view.reconfigure({
      revertControls: disk && !loading && !working ? 'a-to-b' : undefined,
    });
    view.b.dispatch({
      effects: editing.current.reconfigure([
        EditorView.editable.of(!working),
        EditorState.readOnly.of(working),
      ]),
    });
  }, [disk, loading, working, indent, wrap]);

  useEffect(() => {
    let current = true;
    if (initial.length < 1024 * 1024 && (disk?.size ?? 0) < 1024 * 1024)
      void language(path).then((extension) => {
        if (!current || !merge.current) return;
        for (const view of [merge.current.a, merge.current.b])
          view.dispatch({ effects: syntax.current.reconfigure(extension) });
      });
    return () => {
      current = false;
    };
  }, [path, disk?.size, indent, wrap]);

  /** 磁盘在点击后又变化时由上层拒绝；保留草稿并重新读取，供用户再次确认。 */
  async function resolve(save: boolean) {
    if (!disk || loading || working) return;
    setWorking(true);
    merge.current?.b.dispatch({
      effects: editing.current.reconfigure([
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
      ]),
    });
    setError(null);
    try {
      await callbacks.current.onResolve(
        disk,
        save ? draft.current : disk.content,
        save,
      );
      callbacks.current.onClose();
    } catch (failure) {
      setError(errorMessage(failure));
      setRefresh((value) => value + 1);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <section
        ref={container}
        className="conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conflict-title"
        aria-describedby="conflict-description"
        onKeyDownCapture={(event) => {
          if (working) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            if (!working) onClose();
          }
          if (
            event.key === 'Tab' &&
            (event.target as HTMLElement).closest('.cm-content')
          )
            return;
          if (event.key === 'Tab') {
            const elements = [
              ...container.current!.querySelectorAll<HTMLElement>(
                'button:not(:disabled), [contenteditable="true"]',
              ),
            ];
            const first = elements[0];
            const last = elements[elements.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <h2 id="conflict-title">
          处理外部修改 <span>{path}</span>
        </h2>
        <p id="conflict-description">
          左侧为最新磁盘内容，右侧可编辑或按块采用磁盘内容。返回时保留右侧编辑，自动保存继续暂停。
        </p>
        <div className="conflict-headings">
          <span>最新磁盘内容 · 只读</span>
          <span>合并结果 · 可编辑</span>
        </div>
        <div className="conflict-comparison diff-host split" ref={host} />
        <div className="conflict-notice" role="status">
          {loading ? (
            <>
              <LoaderCircle size={12} className="spin" /> 正在读取磁盘内容…
            </>
          ) : error || readError ? (
            <span className="error">{error ?? readError}</span>
          ) : changed ? (
            '磁盘内容已更新，右侧编辑已保留，请核对后再保存。'
          ) : (
            '处理期间已暂停此文件的自动保存。'
          )}
        </div>
        <div className="dialog-actions">
          <button
            className="icon-button"
            title="重新读取磁盘内容"
            aria-label="重新读取磁盘内容"
            disabled={loading || working}
            onClick={() => {
              setError(null);
              setRefresh((value) => value + 1);
            }}
          >
            <RotateCw size={14} />
          </button>
          <button
            className="secondary-button"
            data-close
            title="不写入磁盘，保留右侧草稿回到编辑器"
            disabled={working}
            onClick={onClose}
          >
            保留编辑并返回
          </button>
          <button
            className="secondary-button"
            title="放弃草稿，标签改为磁盘上的最新内容"
            disabled={!disk || loading || working}
            onClick={() => void resolve(false)}
          >
            使用磁盘版本
          </button>
          <button
            className="primary-button"
            title="把右侧合并结果写入磁盘"
            disabled={!disk || loading || working}
            onClick={() => void resolve(true)}
          >
            {working ? '正在处理…' : '保存合并结果'}
          </button>
        </div>
      </section>
    </div>
  );
}
