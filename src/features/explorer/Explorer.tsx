import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  Folder,
  FolderOpen,
  Link2,
  LoaderCircle,
  RotateCw,
} from 'lucide-react';
import { backend, errorCode, errorMessage } from '../../lib/backend';
import { changeStyle } from '../git/CommitPanel';
import type { TreeShortcut } from './ContextMenu';
import { shortcut } from './ContextMenu';
import type {
  ChangeKind,
  Directory,
  FileEntry,
  Project,
} from '../../lib/backend';

/** 文件树中被操作的条目；项目根目录的 path 为空字符串。 */
export interface TreeTarget {
  path: string;
  isDir: boolean;
}

/** 展开到指定目录的请求；key 递增触发。 */
export interface TreeReveal {
  key: number;
  path: string;
}

/** 外部文件变化通知；key 递增触发刷新，paths 为空表示刷新全部已加载目录。 */
export interface TreeChanges {
  key: number;
  paths: string[] | null;
}

interface Props {
  project: Project;
  selected: string | null;
  changes: TreeChanges;
  /** 变更文件的 Git 状态，用于文件名着色。 */
  gitKinds: Map<string, ChangeKind>;
  /** 含已跟踪变更的目录。 */
  gitDirs: Set<string>;
  /** 右键菜单作用的条目，高亮显示。 */
  marked: string | null;
  reveal: TreeReveal;
  /** 挂载时展开的目录（不含项目根目录）。 */
  initialExpanded: string[];
  /** 展开的目录变化后回调，不含项目根目录。 */
  onExpanded: (paths: string[]) => void;
  onOpen: (path: string) => void;
  onContextMenu: (target: TreeTarget, x: number, y: number) => void;
  onShortcut: (target: TreeTarget, shortcut: TreeShortcut) => void;
}

interface Branch {
  directory?: Directory;
  error?: string;
  loading?: boolean;
}

/** 每次只读取展开目录；外部变化时只重读受影响的已加载目录，项目切换后丢弃迟到的响应。 */
export function Explorer({
  project,
  selected,
  changes,
  gitKinds,
  gitDirs,
  marked,
  reveal,
  initialExpanded,
  onExpanded,
  onOpen,
  onContextMenu,
  onShortcut,
}: Props) {
  const [branches, setBranches] = useState<Record<string, Branch>>({});
  const [expanded, setExpanded] = useState(
    () => new Set(['', ...initialExpanded]),
  );
  const generation = useRef(0);
  const requests = useRef(new Set<string>());
  const stale = useRef(new Set<string>());
  const mounted = useRef(false);

  async function load(path: string) {
    // 读取期间又有变化时，完成后再读一次，保证显示最新内容。
    if (requests.current.has(path)) {
      stale.current.add(path);
      return;
    }
    requests.current.add(path);
    const current = generation.current;
    setBranches((previous) => ({
      ...previous,
      [path]: { ...previous[path], error: undefined, loading: true },
    }));
    try {
      const directory = await backend.listDirectory(project.id, path);
      if (generation.current === current)
        setBranches((previous) => ({ ...previous, [path]: { directory } }));
    } catch (error) {
      if (generation.current !== current) return;
      // 目录已不存在时不再记为展开，避免恢复记录中残留失效路径。
      if (path && errorCode(error) === 'NOT_FOUND') {
        setBranches(({ [path]: _, ...rest }) => rest);
        setExpanded((previous) => {
          const next = new Set(previous);
          next.delete(path);
          return next;
        });
      } else
        setBranches((previous) => ({
          ...previous,
          [path]: { error: errorMessage(error) },
        }));
    } finally {
      if (generation.current === current) {
        requests.current.delete(path);
        if (stale.current.delete(path)) void load(path);
      }
    }
  }

  useEffect(() => {
    for (const path of expanded) void load(path);
    return () => {
      generation.current++;
      requests.current.clear();
      stale.current.clear();
    };
    // 此组件按项目 id 重新挂载，防止跨项目共享目录缓存。
  }, []);

  // 挂载后展开状态每次变化都通知上层记录。
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    onExpanded([...expanded].filter(Boolean));
  }, [expanded]);

  // 变化路径的父目录和自身若已加载则重读；折叠目录的缓存也一并更新。
  useEffect(() => {
    if (!changes.key) return;
    const loaded = Object.keys(branches);
    const targets = new Set<string>();
    if (changes.paths === null) loaded.forEach((path) => targets.add(path));
    else
      for (const path of changes.paths) {
        const slash = path.lastIndexOf('/');
        targets.add(slash < 0 ? '' : path.slice(0, slash));
        targets.add(path);
      }
    for (const path of targets) if (path in branches) void load(path);
  }, [changes.key]);

  // 新建条目后展开所在目录及其上级目录。
  useEffect(() => {
    if (!reveal.key) return;
    const parts = reveal.path.split('/').filter(Boolean);
    const paths = parts.map((_, index) => parts.slice(0, index + 1).join('/'));
    setExpanded((previous) => new Set([...previous, ...paths]));
    for (const path of ['', ...paths]) void load(path);
  }, [reveal.key]);

  function toggle(entry: FileEntry) {
    if (!entry.isDir) {
      onOpen(entry.path);
      return;
    }
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
    if (!branches[entry.path]?.directory) void load(entry.path);
  }

  function directory(path: string, depth: number): React.ReactNode {
    const branch = branches[path];
    // 刷新期间保留已有列表，避免实时刷新时文件树闪烁。
    if (!branch || (branch.loading && !branch.directory))
      return (
        <div className="tree-message" style={{ paddingLeft: 18 + depth * 14 }}>
          <LoaderCircle size={13} className="spin" /> 读取中…
        </div>
      );
    if (branch.error)
      return (
        <div className="tree-error">
          <span>{branch.error}</span>
          <button onClick={() => void load(path)}>重试</button>
        </div>
      );
    const entries = branch.directory?.entries ?? [];
    return (
      <>
        {entries.length === 0 && (
          <div
            className="tree-message"
            style={{ paddingLeft: 18 + depth * 14 }}
          >
            空文件夹
          </div>
        )}
        {entries.map((entry) => (
          <div key={entry.path} role="none">
            <button
              role="treeitem"
              aria-expanded={entry.isDir ? expanded.has(entry.path) : undefined}
              aria-selected={selected === entry.path}
              aria-level={depth + 1}
              className={`tree-row ${selected === entry.path ? 'selected' : ''} ${marked === entry.path ? 'marked' : ''}`}
              style={{ paddingLeft: 12 + depth * 14 }}
              title={entry.path}
              onClick={() => toggle(entry)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onContextMenu(entry, event.clientX, event.clientY);
              }}
              onKeyDown={(event) => {
                const action = shortcut(event);
                if (!action) return;
                event.preventDefault();
                event.stopPropagation();
                onShortcut(entry, action);
              }}
            >
              {entry.isDir ? (
                expanded.has(entry.path) ? (
                  <ChevronDown size={13} />
                ) : (
                  <ChevronRight size={13} />
                )
              ) : (
                <span className="tree-indent" />
              )}
              {entry.isDir ? (
                expanded.has(entry.path) ? (
                  <FolderOpen size={15} className="folder-icon" />
                ) : (
                  <Folder size={15} className="folder-icon" />
                )
              ) : entry.isSymlink ? (
                <Link2 size={14} />
              ) : /\.(go|rs|[jt]sx?|json|ya?ml)$/.test(entry.name) ? (
                <FileCode2 size={14} className="code-icon" />
              ) : (
                <File size={14} />
              )}
              <span
                className={
                  entry.isDir
                    ? gitDirs.has(entry.path)
                      ? 'git-dir'
                      : undefined
                    : gitKinds.has(entry.path)
                      ? `git-${gitKinds.get(entry.path)}`
                      : undefined
                }
              >
                {entry.name}
              </span>
              {!entry.isDir && gitKinds.has(entry.path) && (
                // 字母与颜色同时标示状态，不依赖颜色辨认。
                <span
                  className={`tree-git git-${gitKinds.get(entry.path)}`}
                  title={changeStyle[gitKinds.get(entry.path)!].label}
                >
                  {changeStyle[gitKinds.get(entry.path)!].letter}
                </span>
              )}
            </button>
            {entry.isDir && expanded.has(entry.path) && (
              <div role="group">{directory(entry.path, depth + 1)}</div>
            )}
          </div>
        ))}
        {Boolean(branch.directory?.skippedNames) && (
          <p className="tree-message">
            已跳过 {branch.directory?.skippedNames} 个非 Unicode 文件名
          </p>
        )}
      </>
    );
  }

  return (
    <>
      <div
        className="project-tree-header"
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu(
            { path: '', isDir: true },
            event.clientX,
            event.clientY,
          );
        }}
      >
        <span>
          <ChevronDown size={13} /> {project.name}
        </span>
        <button
          className="icon-button"
          title="刷新已展开目录"
          aria-label="刷新已展开目录"
          onClick={() => {
            for (const path of expanded) void load(path);
          }}
        >
          <RotateCw size={13} />
        </button>
      </div>
      <div
        className="file-tree"
        role="tree"
        aria-label="项目文件"
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu(
            { path: '', isDir: true },
            event.clientX,
            event.clientY,
          );
        }}
      >
        {directory('', 0)}
      </div>
      <div className="explorer-note">按需加载 · 隐藏构建与依赖目录</div>
    </>
  );
}
