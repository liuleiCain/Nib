/**
 * 全局延时悬浮提示：接管页面中所有带 title 的元素，悬停约 1 秒后显示统一样式的说明；
 * 没有 title 的按钮使用 aria-label，覆盖只有图标的按钮。
 * 悬停期间把 title 暂存到 data-tip，避免系统原生提示同时出现；离开后还原。
 * 禁用的按钮在部分 WebView 中不派发指针事件，此时仍由系统原生提示显示 title。
 */
const DELAY = 1000;
/** 刚隐藏一处提示后移到相邻元素，缩短等待，便于连续浏览工具栏。 */
const WARM_DELAY = 150;
const WARM_WINDOW = 500;
const GAP = 6;
const MARGIN = 6;

let tip: HTMLDivElement | null = null;
let target: HTMLElement | null = null;
let timer = 0;
let hiddenAt = 0;
let visible = false;
/** 最近一次按键是 Tab 时，键盘聚焦也显示提示；鼠标点击产生的聚焦不显示。 */
let tabbing = false;

function findTarget(node: EventTarget | null): HTMLElement | null {
  return node instanceof Element
    ? node.closest<HTMLElement>('[title], [data-tip], button[aria-label]')
    : null;
}

/** 移走 title 防止原生提示；React 更新过 title 时以新值为准。 */
function claim(element: HTMLElement): string {
  const title = element.getAttribute('title');
  if (title !== null) {
    element.dataset.tip = title;
    element.removeAttribute('title');
  }
  return element.dataset.tip ?? element.getAttribute('aria-label') ?? '';
}

function release(element: HTMLElement) {
  const saved = element.dataset.tip;
  if (saved === undefined) return;
  delete element.dataset.tip;
  if (!element.hasAttribute('title')) element.setAttribute('title', saved);
}

function hide() {
  if (!visible || !tip) return;
  tip.hidden = true;
  visible = false;
  hiddenAt = Date.now();
}

function leave() {
  window.clearTimeout(timer);
  if (target) release(target);
  target = null;
  hide();
}

function enter(element: HTMLElement) {
  target = element;
  claim(element);
  const warm = Date.now() - hiddenAt < WARM_WINDOW;
  timer = window.setTimeout(show, warm ? WARM_DELAY : DELAY);
}

function show() {
  if (!target?.isConnected) return leave();
  const text = claim(target).trim();
  if (!text) return;
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'app-tooltip';
    tip.setAttribute('role', 'tooltip');
    document.body.append(tip);
  }
  tip.textContent = text;
  tip.style.left = '0px';
  tip.style.top = '0px';
  tip.hidden = false;
  // 默认显示在元素下方，空间不足时改到上方，并保持在窗口内。
  const rect = target.getBoundingClientRect();
  const box = tip.getBoundingClientRect();
  let top = rect.bottom + GAP;
  if (top + box.height > window.innerHeight - MARGIN) {
    top = Math.max(MARGIN, rect.top - GAP - box.height);
  }
  const left = Math.min(
    Math.max(MARGIN, rect.left + rect.width / 2 - box.width / 2),
    Math.max(MARGIN, window.innerWidth - box.width - MARGIN),
  );
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  visible = true;
}

/** 在应用启动时调用一次，以事件委托覆盖之后渲染的所有元素。 */
export function installTooltips() {
  document.addEventListener('pointerover', (event) => {
    if (event.pointerType === 'touch') return;
    const next = findTarget(event.target);
    if (next === target) return;
    leave();
    if (next) enter(next);
  });
  // 指针移出窗口时没有新的 pointerover。
  document.addEventListener('pointerout', (event) => {
    if (!event.relatedTarget) leave();
  });
  document.addEventListener(
    'pointerdown',
    () => {
      tabbing = false;
      leave();
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (event) => {
      tabbing = event.key === 'Tab';
      leave();
    },
    true,
  );
  document.addEventListener('focusin', (event) => {
    if (!tabbing) return;
    const next = findTarget(event.target);
    if (!next || next === target) return;
    leave();
    enter(next);
  });
  document.addEventListener('focusout', (event) => {
    if (target && findTarget(event.target) === target) leave();
  });
  document.addEventListener('scroll', leave, true);
  document.addEventListener('wheel', leave, { capture: true, passive: true });
  window.addEventListener('blur', leave);
}
