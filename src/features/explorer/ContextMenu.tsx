import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** 菜单项；separator 为分隔线。 */
export type MenuItem =
  | 'separator'
  | {
      label: string;
      /** 快捷键提示，只填写实际可用的快捷键。 */
      hint?: string;
      danger?: boolean;
      action: () => void;
    };

/** 文件树和提交面板中的快捷键操作。 */
export type TreeShortcut =
  'rename' | 'delete' | 'rollback' | 'diff' | 'add' | 'open';

const mac = /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * 与 GoLand 一致的快捷键：⇧F6 重命名、⌘⌫ 删除、⌥⌘Z 回滚、⌘D 查看变更、
 * ⌥⌘A 加入版本控制、F4 打开文件。
 */
export function shortcut(event: React.KeyboardEvent): TreeShortcut | null {
  const mod = mac ? event.metaKey : event.ctrlKey;
  if (event.key === 'F6' && event.shiftKey) return 'rename';
  if (event.key === 'F4' && !event.shiftKey && !mod) return 'open';
  if (
    (mac && event.metaKey && event.key === 'Backspace') ||
    (!mac && event.key === 'Delete')
  )
    return 'delete';
  if (mod && event.altKey && event.code === 'KeyZ') return 'rollback';
  if (mod && event.altKey && event.code === 'KeyA') return 'add';
  if (mod && !event.altKey && !event.shiftKey && event.code === 'KeyD')
    return 'diff';
  return null;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/** 文件树右键菜单：限制在窗口内显示，方向键切换，Esc 或点击外部关闭。 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const menu = container.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
    });
    menu.querySelector<HTMLButtonElement>('button')?.focus();
  }, [x, y]);

  useEffect(() => {
    const outside = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener('mousedown', outside, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', outside, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  function move(step: 1 | -1) {
    const buttons = [
      ...container.current!.querySelectorAll<HTMLButtonElement>('button'),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(index + step + buttons.length) % buttons.length]?.focus();
  }

  return (
    <div
      ref={container}
      className="context-menu"
      role="menu"
      style={position}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          move(event.key === 'ArrowDown' ? 1 : -1);
        } else if (event.key === 'Tab') {
          event.preventDefault();
          move(event.shiftKey ? -1 : 1);
        }
      }}
    >
      {items.map((item, index) =>
        item === 'separator' ? (
          <div key={index} className="context-separator" role="separator" />
        ) : (
          <button
            key={index}
            role="menuitem"
            className={item.danger ? 'danger' : undefined}
            onClick={() => {
              onClose();
              item.action();
            }}
          >
            <span>{item.label}</span>
            {item.hint && <kbd>{item.hint}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}
