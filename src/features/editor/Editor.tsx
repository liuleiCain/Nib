import { useLayoutEffect, useRef } from 'react';
import { EditorView } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import type { Tab } from './model';
import { editableCompartment, wrapCompartment } from './model';

interface Props {
  tab: Tab | undefined;
  wrap: boolean;
  locked: boolean;
  onChange: (path: string, state: EditorState) => void;
  viewRef: React.RefObject<EditorView | null>;
}

/** 整个窗口复用一个视图，各标签的状态与撤销栈独立保留。 */
export function Editor({ tab, wrap, locked, onChange, viewRef }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const callback = useRef(onChange);
  callback.current = onChange;
  const currentTab = useRef(tab);
  const switching = useRef(false);

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
  }, [tab, wrap, locked, viewRef]);

  return (
    <div
      ref={host}
      className="editor-host"
      style={{ display: tab ? undefined : 'none' }}
      aria-label="代码编辑器"
    />
  );
}
