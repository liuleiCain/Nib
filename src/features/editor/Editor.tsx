import { useLayoutEffect, useRef } from 'react';
import { EditorView } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import type { Tab } from './model';
import {
  editableCompartment,
  indentCompartment,
  indentation,
  wrapCompartment,
} from './model';

/** 打开文件后要定位的位置；行号从 1 开始，列与长度按 UTF-16 计算。key 变化时重新定位。 */
export interface Reveal {
  path: string;
  line: number;
  column: number;
  length: number;
  key: number;
}

interface Props {
  tab: Tab | undefined;
  wrap: boolean;
  /** 缩进宽度。 */
  indent: number;
  locked: boolean;
  reveal: Reveal | null;
  onChange: (path: string, state: EditorState) => void;
  viewRef: React.RefObject<EditorView | null>;
}

/** 整个窗口复用一个视图，各标签的状态与撤销栈独立保留。 */
export function Editor({
  tab,
  wrap,
  indent,
  locked,
  reveal,
  onChange,
  viewRef,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const callback = useRef(onChange);
  callback.current = onChange;
  const currentTab = useRef(tab);
  const switching = useRef(false);
  const revealed = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      dispatchTransactions(transactions, target) {
        target.update(transactions);
        if (!switching.current && currentTab.current) {
          callback.current(currentTab.current.path, target.state);
        }
      },
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [viewRef]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const previous = currentTab.current;
    const changed = previous?.path !== tab?.path || previous !== tab;
    if (previous && previous.path !== tab?.path) {
      previous.scroll = {
        top: view.scrollDOM.scrollTop,
        left: view.scrollDOM.scrollLeft,
      };
    }
    currentTab.current = tab;
    if (!tab) return;
    switching.current = true;
    if (view.state !== tab.state) view.setState(tab.state);
    const extension = wrap ? EditorView.lineWrapping : [];
    if (
      Boolean(wrapCompartment.get(view.state) === EditorView.lineWrapping) !==
      wrap
    ) {
      view.dispatch({ effects: wrapCompartment.reconfigure(extension) });
      tab.state = view.state;
    }
    if (view.state.tabSize !== indent) {
      view.dispatch({
        effects: indentCompartment.reconfigure(indentation(indent)),
      });
      tab.state = view.state;
    }
    if (view.state.facet(EditorView.editable) === locked) {
      view.dispatch({
        effects: editableCompartment.reconfigure(
          EditorView.editable.of(!locked),
        ),
      });
      tab.state = view.state;
    }
    switching.current = false;
    if (changed) {
      view.scrollDOM.scrollTop = tab.scroll.top;
      view.scrollDOM.scrollLeft = tab.scroll.left;
      view.focus();
    }
  }, [tab, wrap, indent, locked, viewRef]);

  // 在切换标签、恢复滚动位置之后选中并滚动到目标位置；同一次定位只执行一次。
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (
      !view ||
      !tab ||
      !reveal ||
      reveal.path !== tab.path ||
      revealed.current === reveal.key
    )
      return;
    revealed.current = reveal.key;
    // 文件可能在搜索后被编辑，行列超出时收缩到行尾。
    const doc = view.state.doc;
    const line = doc.line(Math.min(Math.max(1, reveal.line), doc.lines));
    const from = Math.min(line.from + reveal.column, line.to);
    const to = Math.min(from + reveal.length, line.to);
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
    });
    view.focus();
  }, [reveal, tab, viewRef]);

  return (
    <div
      ref={host}
      className="editor-host"
      style={{ display: tab ? undefined : 'none' }}
      aria-label="代码编辑器"
    />
  );
}
