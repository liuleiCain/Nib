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
import { backend, errorMessage } from '../../lib/backend';
import type { Directory, FileEntry, Project } from '../../lib/backend';

/** 外部文件变化通知；key 递增触发刷新，paths 为空表示刷新全部已加载目录。 */
export interface TreeChanges {
  key: number;
  paths: string[] | null;
}

interface Props {
  project: Project;
  selected: string | null;
  changes: TreeChanges;
  onOpen: (path: string) => void;
}

interface Branch {
  directory?: Directory;
  error?: string;
  loading?: boolean;
}

/** 每次只读取展开目录；外部变化时只重读受影响的已加载目录，项目切换后丢弃迟到的响应。 */
export function Explorer({ project, selected, changes, onOpen }: Props) {
  const [branches, setBranches] = useState<Record<string, Branch>>({});
  const [expanded, setExpanded] = useState(new Set(['']));
  const generation = useRef(0);
  const requests = useRef(new Set<string>());
  const stale = useRef(new Set<string>());

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
      if (generation.current === current)
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
    void load('');
    return () => {
      generation.current++;
      requests.current.clear();
      stale.current.clear();
    };
    // 此组件按项目 id 重新挂载，防止跨项目共享目录缓存。
  }, []);

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
              className={`tree-row ${selected === entry.path ? 'selected' : ''}`}
              style={{ paddingLeft: 12 + depth * 14 }}
              title={entry.path}
              onClick={() => toggle(entry)}
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
              <span>{entry.name}</span>
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
      <div className="project-tree-header">
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
      <div className="file-tree" role="tree" aria-label="项目文件">
        {directory('', 0)}
      </div>
      <div className="explorer-note">按需加载 · 隐藏构建与依赖目录</div>
    </>
  );
}
