import { Chunk } from '@codemirror/merge';
import type { DiffConfig } from '@codemirror/merge';
import {
  ChangeSet,
  EditorState,
  RangeSet,
  StateEffect,
  StateField,
} from '@codemirror/state';
import type { Extension, Range, Text, Transaction } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutter } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';

/** 变更块类型：左侧为空是新增，右侧为空是删除，其余为修改。 */
type Kind = 'inserted' | 'deleted' | 'modified';

const kindOf = (chunk: Chunk): Kind =>
  chunk.fromA === chunk.toA
    ? 'inserted'
    : chunk.fromB === chunk.toB
      ? 'deleted'
      : 'modified';

const lineDeco = {
  inserted: Decoration.line({ class: 'cm-diff-line cm-diff-inserted' }),
  deleted: Decoration.line({ class: 'cm-diff-line cm-diff-deleted' }),
  modified: Decoration.line({ class: 'cm-diff-line cm-diff-modified' }),
};
const textDeco = Decoration.mark({ class: 'cm-diff-text' });

class KindMarker extends GutterMarker {
  constructor(readonly kind: Kind) {
    super();
    this.elementClass = `cm-diff-gutter-${kind}`;
  }
  eq(other: KindMarker) {
    return other.kind === this.kind;
  }
}
const gutterMarkers = {
  inserted: new KindMarker('inserted'),
  deleted: new KindMarker('deleted'),
  modified: new KindMarker('modified'),
};

/** 一侧编辑器的行背景、行内差异与行号旁标记。 */
interface Marks {
  deco: DecorationSet;
  gutter: RangeSet<GutterMarker>;
}
const setMarks = StateEffect.define<Marks>();
const marksField = StateField.define<Marks>({
  create: () => ({ deco: Decoration.none, gutter: RangeSet.empty }),
  update(value, tr) {
    for (const effect of tr.effects)
      if (effect.is(setMarks)) return effect.value;
    return tr.docChanged
      ? {
          deco: value.deco.map(tr.changes),
          gutter: value.gutter.map(tr.changes),
        }
      : value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
});
const diffGutter = gutter({
  class: 'cm-diff-gutter',
  markers: (view) => view.state.field(marksField).gutter,
});

/** 文档内的纵向区间；本侧为空时上下相等，落在插入位置。 */
function span(view: EditorView, from: number, to: number, end: number) {
  const doc = view.state.doc;
  if (from === to) {
    const y =
      from > doc.length
        ? view.lineBlockAt(doc.length).bottom
        : view.lineBlockAt(from).top;
    return [y, y];
  }
  return [
    view.lineBlockAt(from).top,
    view.lineBlockAt(Math.min(end, doc.length)).bottom,
  ];
}

function buildMarks(
  chunks: readonly Chunk[],
  doc: Text,
  side: 'a' | 'b',
  highlight: boolean,
): Marks {
  const deco: Range<Decoration>[] = [];
  const marks: Range<GutterMarker>[] = [];
  for (const chunk of chunks) {
    const kind = kindOf(chunk);
    const from = side === 'a' ? chunk.fromA : chunk.fromB;
    const to = side === 'a' ? chunk.toA : chunk.toB;
    if (from === to) {
      // 对侧有内容、本侧为空：在对应位置画一条细线。
      const after = from > doc.length;
      const line = doc.lineAt(Math.min(from, doc.length));
      deco.push(
        Decoration.line({
          class: `cm-diff-gap-${after ? 'after' : 'before'} cm-diff-gap-${kind}`,
        }).range(line.from),
      );
      continue;
    }
    const end = Math.min(side === 'a' ? chunk.endA : chunk.endB, doc.length);
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(end).number;
    for (let number = first; number <= last; number++) {
      const start = doc.line(number).from;
      deco.push(lineDeco[kind].range(start));
      marks.push(gutterMarkers[kind].range(start));
    }
    if (!highlight || kind !== 'modified') continue;
    for (const change of chunk.changes) {
      const markFrom = from + (side === 'a' ? change.fromA : change.fromB);
      const markTo = Math.min(
        from + (side === 'a' ? change.toA : change.toB),
        doc.length,
      );
      if (markFrom < markTo) deco.push(textDeco.range(markFrom, markTo));
    }
  }
  return { deco: Decoration.set(deco, true), gutter: RangeSet.of(marks, true) };
}

/** 左右对比视图的控制接口。 */
export interface SideBySide {
  a: EditorView;
  b: EditorView;
  chunks: () => readonly Chunk[];
  /** 跳到下一处或上一处变更，到末尾后循环。 */
  navigate: (direction: 1 | -1) => void;
  setSync: (sync: boolean) => void;
  destroy: () => void;
}

interface Config {
  parent: HTMLElement;
  base: string;
  current: string;
  /** 两侧共用的编辑器扩展。 */
  extensions: Extension;
  /** 只加在右侧的扩展。 */
  currentExtensions: Extension;
  /** 是否在中间显示回滚按钮（右侧改回左侧内容）。 */
  revertible: boolean;
  highlight: boolean;
  diffConfig: DiffConfig;
  sync: boolean;
}

const SVG = 'http://www.w3.org/2000/svg';

/** 测量阶段确定的滚动位置，写入阶段直接应用，避免交错读取布局。 */
interface ScrollPosition {
  element: HTMLElement;
  top: number;
  left: number;
}

/** 连接栏的位置与同步滚动后两侧文档顶部相对它的偏移。 */
interface Geometry {
  box: DOMRect;
  offsetA: number;
  offsetB: number;
  scroll: ScrollPosition | null;
}

/**
 * 参照 GoLand 的左右对比：两侧各自滚动，中间用与变更同色的连接带标出对应区域。
 * 同步滚动时以变更块边界为锚点换算位置，未变化的区域逐行对齐。
 */
export function sideBySide(config: Config): SideBySide {
  const { parent, highlight, revertible } = config;
  const paneA = document.createElement('div');
  const paneB = document.createElement('div');
  paneA.className = paneB.className = 'diff-pane';
  const connector = document.createElement('div');
  connector.className = 'diff-connector';
  const svg = document.createElementNS(SVG, 'svg');
  const buttons = document.createElement('div');
  buttons.className = 'diff-connector-buttons';
  connector.append(svg, buttons);
  parent.append(paneA, connector, paneB);

  let chunks: readonly Chunk[] = [];
  let sync = config.sync;
  let cursor = -1;
  let cursorAt = -1;
  // 一帧内的滚动事件只保留最后的驱动侧，由同一测量周期完成同步与绘制。
  let pendingSource: EditorView | null = null;
  // 连接带随 CodeMirror 的测量周期重绘，与编辑器自身的布局读写合并，避免每帧多次排版。
  const bandMeasure = {
    key: 'diff-bands',
    read: (): Geometry => {
      const box = connector.getBoundingClientRect();
      const geometry: Geometry = {
        box,
        offsetA: a.documentTop - box.top,
        offsetB: b.documentTop - box.top,
        scroll: null,
      };
      const source = pendingSource;
      pendingSource = null;
      if (sync && source) geometry.scroll = follow(source, geometry);
      return geometry;
    },
    write: (geometry: Geometry) => {
      if (geometry.scroll) scrollTo(geometry.scroll);
      draw(geometry);
    },
  };
  const schedule = () => b.requestMeasure(bandMeasure);
  const redraw = EditorView.updateListener.of((update) => {
    if (update.geometryChanged || update.viewportChanged || update.docChanged)
      schedule();
  });
  const sideExtensions = [marksField, diffGutter, redraw];

  /** 文档变化时重算变更块，并同时更新两侧标记。 */
  const dispatch = (trs: readonly Transaction[], target: EditorView) => {
    if (!trs.some((tr) => tr.docChanged)) return target.update(trs);
    const last = trs[trs.length - 1];
    const other = target === a ? b : a;
    const changes = trs.reduce(
      (all, tr) => all.compose(tr.changes),
      ChangeSet.empty(trs[0].startState.doc.length),
    );
    chunks =
      target === a
        ? Chunk.updateA(
            chunks,
            last.newDoc,
            b.state.doc,
            changes,
            config.diffConfig,
          )
        : Chunk.updateB(
            chunks,
            a.state.doc,
            last.newDoc,
            changes,
            config.diffConfig,
          );
    const side = (view: EditorView) => (view === a ? 'a' : 'b');
    target.update([
      ...trs,
      last.state.update({
        effects: setMarks.of(
          buildMarks(chunks, last.newDoc, side(target), highlight),
        ),
      }),
    ]);
    other.update([
      other.state.update({
        effects: setMarks.of(
          buildMarks(chunks, other.state.doc, side(other), highlight),
        ),
      }),
    ]);
    schedule();
  };

  const a: EditorView = new EditorView({
    parent: paneA,
    state: EditorState.create({
      doc: config.base,
      extensions: [config.extensions, sideExtensions],
    }),
    dispatchTransactions: (trs) => dispatch(trs, a),
  });
  const b: EditorView = new EditorView({
    parent: paneB,
    state: EditorState.create({
      doc: config.current,
      extensions: [config.extensions, config.currentExtensions, sideExtensions],
    }),
    dispatchTransactions: (trs) => dispatch(trs, b),
  });
  chunks = Chunk.build(a.state.doc, b.state.doc, config.diffConfig);
  a.dispatch({
    effects: setMarks.of(buildMarks(chunks, a.state.doc, 'a', highlight)),
  });
  b.dispatch({
    effects: setMarks.of(buildMarks(chunks, b.state.doc, 'b', highlight)),
  });

  // 中间的回滚按钮按变更块序号复用，滚动重绘时不打断点击和键盘焦点。
  const buttonCache = new Map<number, HTMLButtonElement>();
  buttons.addEventListener('click', (event) => {
    const target = (event.target as Element).closest<HTMLElement>(
      '[data-chunk]',
    );
    const chunk = target && chunks[Number(target.dataset.chunk)];
    if (!chunk) return;
    let insert = a.state.sliceDoc(
      chunk.fromA,
      Math.max(chunk.fromA, chunk.toA - 1),
    );
    if (chunk.fromA !== chunk.toA && chunk.toB <= b.state.doc.length)
      insert += b.state.lineBreak;
    b.dispatch({
      changes: {
        from: chunk.fromB,
        to: Math.min(b.state.doc.length, chunk.toB),
        insert,
      },
      userEvent: 'revert',
    });
  });

  // 连接带路径按顺序复用，滚动时不必每帧重建节点。
  const paths: SVGPathElement[] = [];
  function draw({ box, offsetA, offsetB }: Geometry) {
    const width = box.width;
    let count = 0;
    const used = new Set<number>();
    // 两侧块的底边均在视口上方时，连接带也不可见；二分跳过屏幕外的前缀。
    let low = 0;
    let high = chunks.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const chunk = chunks[middle];
      const bottomA = span(a, chunk.fromA, chunk.toA, chunk.endA)[1];
      const bottomB = span(b, chunk.fromB, chunk.toB, chunk.endB)[1];
      if (offsetA + bottomA < 0 && offsetB + bottomB < 0) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < chunks.length; index++) {
      const chunk = chunks[index];
      const [topA, bottomA] = span(a, chunk.fromA, chunk.toA, chunk.endA);
      const [topB, bottomB] = span(b, chunk.fromB, chunk.toB, chunk.endB);
      const y1 = offsetA + topA;
      const y2 = offsetA + bottomA;
      const y3 = offsetB + topB;
      const y4 = offsetB + bottomB;
      if (y2 < 0 && y4 < 0) continue;
      if (y1 > box.height && y3 > box.height) break;
      const kind = kindOf(chunk);
      const middle = width / 2;
      let path = paths[count];
      if (!path) {
        path = document.createElementNS(SVG, 'path');
        svg.append(path);
        paths.push(path);
      }
      count++;
      path.setAttribute(
        'd',
        `M0 ${y1} C${middle} ${y1} ${middle} ${y3} ${width} ${y3} L${width} ${y4} C${middle} ${y4} ${middle} ${y2} 0 ${y2} Z`,
      );
      const className = `diff-band diff-band-${kind}`;
      if (path.getAttribute('class') !== className)
        path.setAttribute('class', className);
      if (!revertible) continue;
      used.add(index);
      let button = buttonCache.get(index);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'diff-revert';
        button.textContent = '»';
        button.title = '回滚此处变更';
        button.setAttribute('aria-label', '回滚此处变更');
        button.dataset.chunk = String(index);
        buttonCache.set(index, button);
        buttons.append(button);
      }
      button.style.top = `${(y1 + y2) / 2 - 9}px`;
    }
    for (const extra of paths.splice(count)) extra.remove();
    for (const [index, button] of buttonCache)
      if (!used.has(index)) {
        button.remove();
        buttonCache.delete(index);
      }
  }

  /** 以变更块边界为锚点，把一侧的文档纵坐标换算到另一侧。 */
  function mapY(y: number, from: EditorView) {
    // 锚点按需读取当前行高树，不再在行高变化后重建全文件坐标缓存。
    const last = chunks.length * 2 + 1;
    const point = (index: number): [number, number] => {
      if (index === 0) return [0, 0];
      if (index === last)
        return [
          a.lineBlockAt(a.state.doc.length).bottom,
          b.lineBlockAt(b.state.doc.length).bottom,
        ];
      const chunk = chunks[(index - 1) >> 1];
      const edge = index % 2 === 1 ? 0 : 1;
      return [
        span(a, chunk.fromA, chunk.toA, chunk.endA)[edge],
        span(b, chunk.fromB, chunk.toB, chunk.endB)[edge],
      ];
    };
    const source = from === a ? 0 : 1;
    const target = 1 - source;
    // 二分查找 y 所在的锚点区间，区间内按比例换算。
    let low = 1;
    let high = last;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (point(middle)[source] < y) low = middle + 1;
      else high = middle;
    }
    const previous = point(low - 1);
    const next = point(low);
    const range = next[source] - previous[source];
    const ratio =
      range > 0 ? Math.min(Math.max((y - previous[source]) / range, 0), 1) : 1;
    return previous[target] + ratio * (next[target] - previous[target]);
  }

  // 程序设置的滚动位置，用于忽略由它触发的滚动事件，避免两侧相互推动。
  const expected = new Map<HTMLElement, { top: number; left: number }>();
  /** 只写入测量阶段算好的位置，滚动范围与当前位置均在写入前读取。 */
  function scrollTo({ element, top, left }: ScrollPosition) {
    expected.set(element, { top, left });
    element.scrollTop = top;
    element.scrollLeft = left;
  }
  /** 测量另一侧对齐到视口中线的位置，并让连接带使用同步后的偏移。 */
  function follow(
    source: EditorView,
    geometry: Geometry,
  ): ScrollPosition | null {
    const target = source === a ? b : a;
    const from = source.scrollDOM;
    const to = target.scrollDOM;
    const sourceOffset = source === a ? geometry.offsetA : geometry.offsetB;
    const targetOffset = target === a ? geometry.offsetA : geometry.offsetB;
    const center =
      from.getBoundingClientRect().top +
      from.clientHeight / 2 -
      geometry.box.top -
      sourceOffset;
    const oldTop = to.scrollTop;
    const padding =
      geometry.box.top + targetOffset - to.getBoundingClientRect().top + oldTop;
    const top = Math.min(
      Math.max(mapY(center, source) + padding - to.clientHeight / 2, 0),
      Math.max(0, to.scrollHeight - to.clientHeight),
    );
    const left = Math.min(
      Math.max(from.scrollLeft, 0),
      Math.max(0, to.scrollWidth - to.clientWidth),
    );
    if (Math.abs(oldTop - top) < 1 && Math.abs(to.scrollLeft - left) < 1)
      return null;
    if (target === a) geometry.offsetA += oldTop - top;
    else geometry.offsetB += oldTop - top;
    return { element: to, top, left };
  }

  // 最近一次用户输入所在的一侧。只由它带动另一侧，另一侧自身的位置修正
  // （如行高重新测量）不会反推正在滚动的一侧。
  let driver: EditorView | null = null;
  let driverAt = 0;
  let holding = false;
  const engage = (view: EditorView) => {
    driver = view;
    driverAt = performance.now();
  };
  const driving = () =>
    driver !== null && (holding || performance.now() - driverAt < 300);

  const onScroll = (source: EditorView) => () => {
    schedule();
    const element = source.scrollDOM;
    const wanted = expected.get(element);
    expected.delete(element);
    if (
      wanted &&
      Math.abs(element.scrollTop - wanted.top) < 1 &&
      Math.abs(element.scrollLeft - wanted.left) < 1
    )
      return;
    if (!sync) return;
    pendingSource = driving() && driver !== source ? driver : source;
  };

  // 保留浏览器原生滚动与触控板惯性，监听器只记录驱动侧，不拦截输入。
  const wheelOn = (view: EditorView) => (event: WheelEvent) => {
    if (!event.ctrlKey) engage(view);
  };
  const wheelA = wheelOn(a);
  const wheelB = wheelOn(b);
  a.scrollDOM.addEventListener('wheel', wheelA, { passive: true });
  b.scrollDOM.addEventListener('wheel', wheelB, { passive: true });
  // 拖动滚动条、键盘翻页等原生滚动：记录操作的一侧，按住期间一直由它带动。
  const pressA = () => {
    engage(a);
    holding = true;
  };
  const pressB = () => {
    engage(b);
    holding = true;
  };
  const release = () => {
    if (holding) driverAt = performance.now();
    holding = false;
  };
  const keyA = () => {
    engage(a);
  };
  const keyB = () => {
    engage(b);
  };
  a.dom.addEventListener('pointerdown', pressA, true);
  b.dom.addEventListener('pointerdown', pressB, true);
  a.dom.addEventListener('keydown', keyA, true);
  b.dom.addEventListener('keydown', keyB, true);
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  const scrollA = onScroll(a);
  const scrollB = onScroll(b);
  a.scrollDOM.addEventListener('scroll', scrollA);
  b.scrollDOM.addEventListener('scroll', scrollB);
  // 在中间连接带上滚动时滚动右侧。
  const wheel = (event: WheelEvent) => {
    if (event.ctrlKey) return;
    event.preventDefault();
    engage(b);
    const unit =
      event.deltaMode === 1
        ? b.defaultLineHeight
        : event.deltaMode === 2
          ? b.scrollDOM.clientHeight
          : 1;
    const horizontal = event.shiftKey && !event.deltaX;
    b.scrollDOM.scrollBy({
      top: horizontal ? 0 : event.deltaY * unit,
      left: (horizontal ? event.deltaY : event.deltaX) * unit,
      behavior: 'instant',
    });
  };
  connector.addEventListener('wheel', wheel, { passive: false });
  const resize = new ResizeObserver(() => {
    schedule();
  });
  resize.observe(parent);
  schedule();

  return {
    a,
    b,
    chunks: () => chunks,
    navigate(direction) {
      if (!chunks.length) return;
      const head = b.state.selection.main.head;
      // 刚跳转过时按序号前后移动；光标被移走后按光标位置查找。
      let index: number;
      if (cursor >= 0 && cursor < chunks.length && head === cursorAt)
        index = (cursor + direction + chunks.length) % chunks.length;
      else if (direction > 0) {
        // 下一个：起点在光标之后的第一个变更块。
        index = chunks.findIndex((chunk) => chunk.fromB > head);
        if (index < 0) index = 0;
      } else {
        // 上一个：起点在光标之前、且不包含光标的最后一个变更块。
        index = chunks.length - 1;
        while (
          index >= 0 &&
          (chunks[index].fromB >= head || chunks[index].toB > head)
        )
          index--;
        if (index < 0) index = chunks.length - 1;
      }
      const chunk = chunks[index];
      const at = Math.min(chunk.fromB, b.state.doc.length);
      cursor = index;
      cursorAt = at;
      engage(b);
      b.dispatch({
        selection: { anchor: at },
        effects: EditorView.scrollIntoView(at, { y: 'center' }),
      });
      // 不同步滚动时左侧单独定位到对应位置。
      if (!sync) {
        const atA = Math.min(chunk.fromA, a.state.doc.length);
        a.dispatch({
          selection: { anchor: atA },
          effects: EditorView.scrollIntoView(atA, { y: 'center' }),
        });
      }
      b.focus();
    },
    setSync(next) {
      sync = next;
      pendingSource = sync ? b : null;
      schedule();
    },
    destroy() {
      pendingSource = null;
      resize.disconnect();
      a.scrollDOM.removeEventListener('scroll', scrollA);
      b.scrollDOM.removeEventListener('scroll', scrollB);
      a.scrollDOM.removeEventListener('wheel', wheelA);
      b.scrollDOM.removeEventListener('wheel', wheelB);
      a.dom.removeEventListener('pointerdown', pressA, true);
      b.dom.removeEventListener('pointerdown', pressB, true);
      a.dom.removeEventListener('keydown', keyA, true);
      b.dom.removeEventListener('keydown', keyB, true);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      connector.removeEventListener('wheel', wheel);
      a.destroy();
      b.destroy();
      parent.replaceChildren();
    },
  };
}
