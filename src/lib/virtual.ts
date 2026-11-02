import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

/** 视口外额外渲染的行数，快速滚动时减少空白。 */
const OVERSCAN = 12;

/**
 * 长列表虚拟化：只渲染滚动容器视口附近的行。
 * 行按实际高度测量（需挂上 measure 与 data-index），estimateSize 接近真实高度可减少滚动跳动；
 * 滚动容器内列表之前不能有其他内容，列表之后的提示可直接跟在后面。
 */
export function useVirtualRows<T extends HTMLElement>(
  count: number,
  estimateSize: (index: number) => number,
  getItemKey: (index: number) => string,
) {
  const scrollRef = useRef<T>(null);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    overscan: OVERSCAN,
    // React 19 不允许在渲染期间同步刷新，滚动时使用普通更新。
    useFlushSync: false,
  });
  const items = virtualizer.getVirtualItems();
  // 用上下留白代替绝对定位，行保持原有的文档流布局与样式。
  const spacer = {
    paddingTop: items.length ? items[0].start : 0,
    paddingBottom: items.length
      ? virtualizer.getTotalSize() - items[items.length - 1].end
      : 0,
  };
  return { scrollRef, items, spacer, measure: virtualizer.measureElement };
}
