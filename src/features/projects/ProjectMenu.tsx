import { useEffect, useRef } from 'react';
import { AppWindow, FolderOpen, FolderX, X } from 'lucide-react';
import type { Project, RecentProject } from '../../lib/backend';

interface ListProps {
  items: RecentProject[];
  current: string | null;
  disabled: boolean;
  onOpen: (root: string) => void;
  onOpenHere?: (root: string) => void;
  onForget: (root: string) => void;
}

/** 最近项目列表；当前标签的项目不重复展示，目录已不存在的项目只允许移除。 */
export function RecentList({
  items,
  current,
  disabled,
  onOpen,
  onOpenHere,
  onForget,
}: ListProps) {
  const visible = items.filter((item) => item.root !== current);
  if (!visible.length) return <p className="recent-empty">暂无最近项目</p>;
  return (
    <ul className="recent-list" aria-label="最近项目">
      {visible.map((item) => (
        <li
          key={item.root}
          className={item.available ? undefined : 'unavailable'}
        >
          <button
            className="recent-open"
            disabled={disabled || !item.available}
            title={item.available ? item.root : `${item.root}（目录不存在）`}
            onClick={() => onOpen(item.root)}
          >
            <FolderOpen size={14} />
            <span>
              <strong>{item.name}</strong>
              <small>{item.available ? item.root : '目录不存在'}</small>
            </span>
          </button>
          {onOpenHere && item.available && (
            <button
              className="icon-button"
              title="在当前标签打开"
              aria-label={`在当前标签打开 ${item.name}`}
              disabled={disabled}
              onClick={() => onOpenHere(item.root)}
            >
              <AppWindow size={13} />
            </button>
          )}
          <button
            className="icon-button"
            title="从最近项目移除"
            aria-label={`从最近项目移除 ${item.name}`}
            onClick={() => onForget(item.root)}
          >
            <X size={13} />
          </button>
        </li>
      ))}
    </ul>
  );
}

interface MenuProps {
  project: Project | null;
  recent: RecentProject[];
  disabled: boolean;
  mod: string;
  onChoose: () => void;
  onNewWindow: () => void;
  onCloseProject: () => void;
  onOpen: (root: string) => void;
  onOpenHere: (root: string) => void;
  onForget: (root: string) => void;
  onClose: () => void;
}

/** 工具栏项目菜单：打开、新建项目标签、关闭项目及最近项目。 */
export function ProjectMenu({
  project,
  recent,
  disabled,
  mod,
  onChoose,
  onNewWindow,
  onCloseProject,
  onOpen,
  onOpenHere,
  onForget,
  onClose,
}: MenuProps) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    container.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);
  return (
    <div
      className="menu-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="popover project-menu"
        role="dialog"
        aria-label="项目"
        ref={container}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <div className="menu-actions">
          <button
            title="选择本地文件夹，在新的项目标签中打开"
            disabled={disabled}
            onClick={onChoose}
          >
            <FolderOpen size={14} />
            <span>打开文件夹…</span>
            <kbd>{mod} O</kbd>
          </button>
          <button title="打开一个空白的项目标签" onClick={onNewWindow}>
            <AppWindow size={14} />
            <span>新建项目标签</span>
            <kbd>{mod} ⇧ N</kbd>
          </button>
          {project && (
            <button
              title="关闭当前项目，回到欢迎页"
              disabled={disabled}
              onClick={onCloseProject}
            >
              <FolderX size={14} />
              <span>关闭项目</span>
            </button>
          )}
        </div>
        <p className="menu-label">最近项目</p>
        <RecentList
          items={recent}
          current={project?.root ?? null}
          disabled={disabled}
          onOpen={onOpen}
          onOpenHere={project ? onOpenHere : undefined}
          onForget={onForget}
        />
        <p className="menu-hint">
          {project
            ? '已有项目时在新项目标签打开；点击右侧图标替换当前项目。'
            : '项目将在当前标签打开。'}
        </p>
      </div>
    </div>
  );
}
