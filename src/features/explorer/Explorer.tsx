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

interface Props {
  project: Project;
  selected: string | null;
  onOpen: (path: string) => void;
}

interface Branch {
  directory?: Directory;
  error?: string;
  loading?: boolean;
}

/** 每次只读取展开目录；项目切换后丢弃迟到的响应。 */
export function Explorer({ project, selected, onOpen }: Props) {
  const [branches, setBranches] = useState<Record<string, Branch>>({});
  const [expanded, setExpanded] = useState(new Set(['']));
  const generation = useRef(0);
  const requests = useRef(new Set<string>());

  async function load(path: string) {
    if (requests.current.has(path)) return;
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
      if (generation.current === current) requests.current.delete(path);
    }
  }

  useEffect(() => {
    void load('');
    return () => {
      generation.current++;
      requests.current.clear();
    };
    // 此组件按项目 id 重新挂载，防止跨项目共享目录缓存。
  }, []);

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
    if (!branch || branch.loading)
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
