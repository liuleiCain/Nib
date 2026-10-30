import { useMemo, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronRight,
  FolderTree,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  List,
  LoaderCircle,
  Plus,
  RotateCw,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import type { ChangeKind, FileChange, GitStatus } from '../../lib/backend';
import type { TreeShortcut } from '../explorer/ContextMenu';
import { shortcut } from '../explorer/ContextMenu';

/** 文件状态的字母、颜色类和说明，与 GoLand 的着色习惯一致。 */
export const changeStyle: Record<
  ChangeKind,
  { letter: string; label: string }
> = {
  modified: { letter: 'M', label: '已修改' },
  added: { letter: 'A', label: '新增' },
  deleted: { letter: 'D', label: '已删除' },
  renamed: { letter: 'R', label: '重命名' },
  conflicted: { letter: 'C', label: '冲突' },
  untracked: { letter: 'U', label: '未跟踪' },
};

interface Props {
  status: GitStatus | null;
  loading: boolean;
  error: string | null;
  /** 勾选的文件路径。 */
  checked: Set<string>;
  onCheck: (paths: string[], value: boolean) => void;
  message: string;
  onMessage: (message: string) => void;
  committing: boolean;
  /** 勾选文件中尚未保存的编辑器标签数，提交前会先保存。 */
  unsaved: number;
  /** 未勾选文件中有未保存编辑的标签数，这些编辑不会参与提交。 */
  unsavedOther: number;
  selected: string | null;
  onOpenDiff: (change: FileChange) => void;
  /** 从 HEAD 恢复已删除的文件，由上层确认后执行。 */
  onRestore: (path: string) => void;
  /** 将未跟踪文件加入版本控制，不提交。 */
  onAdd: (paths: string[]) => void;
  /** 文件行的右键菜单。 */
  onFileMenu: (file: FileChange, x: number, y: number) => void;
  /** 分组标题或目录行的右键菜单，作用于其中列出的文件。 */
  onGroupMenu: (files: FileChange[], x: number, y: number) => void;
  onShortcut: (file: FileChange, shortcut: TreeShortcut) => void;
  onRefresh: () => void;
  onCommit: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  /** 正在进行的 Fetch、Pull 或 Push。 */
  remoteTask: string | null;
  /** 在锚点处打开分支弹窗。 */
  onBranches: (x: number, y: number) => void;
  onPull: () => void;
  /** 推送；未设置上游时在锚点处选择远程仓库。 */
  onPush: (x: number, y: number) => void;
  /** 把冲突文件标记为已解决。 */
  onResolve: (paths: string[]) => void;
  /** 合并或变基时：完成合并或继续变基。 */
  onContinue: () => void;
  /** 变基时跳过当前停下的提交。 */
  onSkip: () => void;
  /** 中止合并或变基。 */
  onAbort: () => void;
}

interface Group {
  key: string;
  title: string;
  files: FileChange[];
}

const baseName = (path: string) => path.split('/').pop() ?? path;
const dirName = (path: string) => {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
};

/** 侧边栏提交面板：变更列表勾选后填写提交信息，只提交勾选的文件。 */
export function CommitPanel({
  status,
  loading,
  error,
  checked,
  onCheck,
  message,
  onMessage,
  committing,
  unsaved,
  unsavedOther,
  selected,
  onOpenDiff,
  onRestore,
  onAdd,
  onFileMenu,
  onGroupMenu,
  onShortcut,
  onRefresh,
  onCommit,
  inputRef,
  remoteTask,
  onBranches,
  onPull,
  onPush,
  onResolve,
  onContinue,
  onSkip,
  onAbort,
}: Props) {
  const [tree, setTree] = useState(false);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const repository = status?.kind === 'repository' ? status : null;

  const groups: Group[] = useMemo(() => {
    const files = repository?.files ?? [];
    return [
      {
        key: 'changes',
        title: '变更',
        files: files.filter((file) => file.kind !== 'untracked'),
      },
      {
        key: 'untracked',
        title: '未跟踪文件',
        files: files.filter((file) => file.kind === 'untracked'),
      },
    ].filter((group) => group.files.length);
  }, [repository]);

  if (!status && loading)
    return (
      <div className="git-empty">
        <LoaderCircle size={16} className="spin" />
        <p>正在读取 Git 状态…</p>
      </div>
    );
  if (status?.kind === 'unavailable')
    return (
      <div className="git-empty">
        <TriangleAlert size={22} strokeWidth={1.3} />
        <p>Git 不可用</p>
        <span>{status.message}</span>
      </div>
    );
  if (status?.kind === 'notRepository')
    return (
      <div className="git-empty">
        <GitBranch size={22} strokeWidth={1.3} />
        <p>不是 Git 项目</p>
        <span>项目不在 Git 仓库内，文件仍可正常编辑。</span>
      </div>
    );
  if (!repository)
    return (
      <div className="git-empty">
        <TriangleAlert size={22} strokeWidth={1.3} />
        <p>无法读取 Git 状态</p>
        <span>{error}</span>
        <button className="secondary-button" onClick={onRefresh}>
          重试
        </button>
      </div>
    );

  const total = repository.files.length;
  const selectedCount = repository.files.filter((file) =>
    checked.has(file.path),
  ).length;
  // 合并与变基在面板中继续或中止；拣选、还原等仍需在终端处理。
  const integrating =
    repository.operation === '合并' || repository.operation === '变基';
  const conflicts = repository.files.filter(
    (file) => file.kind === 'conflicted',
  );
  const blocked = repository.operation
    ? integrating
      ? `正在${repository.operation}，完成或中止后才能普通提交。`
      : `仓库正在进行${repository.operation}，请在终端完成或中止后再提交。`
    : null;
  const canCommit =
    !committing && !blocked && selectedCount > 0 && message.trim().length > 0;

  function row(file: FileChange, depth: number, label: string) {
    const style = changeStyle[file.kind];
    return (
      <div
        key={file.path}
        className={`change-row ${selected === file.path ? 'selected' : ''}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onFileMenu(file, event.clientX, event.clientY);
        }}
        onKeyDown={(event) => {
          const action = shortcut(event);
          if (!action) return;
          event.preventDefault();
          event.stopPropagation();
          onShortcut(file, action);
        }}
      >
        <input
          type="checkbox"
          aria-label={`提交 ${file.path}`}
          checked={checked.has(file.path)}
          onChange={(event) => onCheck([file.path], event.target.checked)}
        />
        <button
          className={`change-name git-${file.kind}`}
          title={`${file.original ? `${file.original} → ` : ''}${file.path} · ${style.label}`}
          onClick={() => onOpenDiff(file)}
        >
          <span className="change-file">{label}</span>
          {!tree && dirName(file.path) && (
            <span className="change-dir">{dirName(file.path)}</span>
          )}
          {file.original && (
            <span className="change-dir">← {baseName(file.original)}</span>
          )}
        </button>
        {file.kind === 'untracked' && (
          <button
            className="change-restore"
            title="加入版本控制（不提交）"
            aria-label={`将 ${file.path} 加入版本控制`}
            onClick={() => onAdd([file.path])}
          >
            <Plus size={12} />
          </button>
        )}
        {file.kind === 'conflicted' && integrating && (
          <button
            className="change-restore"
            title="标记为已解决"
            aria-label={`将 ${file.path} 标记为已解决`}
            onClick={() => onResolve([file.path])}
          >
            <Check size={12} />
          </button>
        )}
        {file.kind === 'deleted' && (
          <button
            className="change-restore"
            title="从 HEAD 恢复此文件"
            aria-label={`恢复 ${file.path}`}
            onClick={() => onRestore(file.path)}
          >
            <Undo2 size={12} />
          </button>
        )}
        <span className={`change-letter git-${file.kind}`} title={style.label}>
          {style.letter}
        </span>
      </div>
    );
  }

  /** 按目录分组显示，单一子目录的链路合并为一行。 */
  function treeRows(files: FileChange[], prefix: string, depth: number) {
    const directories = new Map<string, FileChange[]>();
    const leaves: FileChange[] = [];
    for (const file of files) {
      const rest = file.path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) leaves.push(file);
      else {
        const name = rest.slice(0, slash);
        directories.set(name, [...(directories.get(name) ?? []), file]);
      }
    }
    const nodes: React.ReactNode[] = [];
    for (const [name, children] of [...directories].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      let label = name;
      let path = `${prefix}${name}/`;
      // 合并只有一个子目录且没有文件的链路，例如 src/features/git。
      for (;;) {
        const next = new Set(
          children.map((file) => file.path.slice(path.length).split('/')),
        );
        const parts = [...next];
        if (
          parts.length &&
          parts.every((segments) => segments.length > 1) &&
          new Set(parts.map((segments) => segments[0])).size === 1
        ) {
          label += `/${parts[0][0]}`;
          path += `${parts[0][0]}/`;
        } else break;
      }
      const key = `dir:${path}`;
      const open = !collapsed.has(key);
      nodes.push(
        <div key={key}>
          <button
            className="change-folder"
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => toggle(key)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onGroupMenu(children, event.clientX, event.clientY);
            }}
          >
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>{label}</span>
            <span className="change-count">{children.length}</span>
          </button>
          {open && treeRows(children, path, depth + 1)}
        </div>,
      );
    }
    for (const file of leaves.sort((a, b) => a.path.localeCompare(b.path)))
      nodes.push(row(file, depth, baseName(file.path)));
    return nodes;
  }

  function toggle(key: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="commit-panel">
      <div className="commit-toolbar">
        <button
          className="commit-branch"
          title={`分支与远程操作 · ${repository.root}`}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            onBranches(rect.left, rect.bottom);
          }}
        >
          <GitBranch size={13} />
          {repository.branch ?? `游离 ${repository.head?.slice(0, 7) ?? ''}`}
          {Boolean(repository.ahead) && <span>↑{repository.ahead}</span>}
          {Boolean(repository.behind) && <span>↓{repository.behind}</span>}
          <ChevronDown size={11} />
        </button>
        <button
          className="icon-button"
          title={`拉取（仅快进）${repository.upstream ? ` · ${repository.upstream}` : ''}`}
          aria-label="拉取"
          disabled={Boolean(remoteTask)}
          onClick={onPull}
        >
          {remoteTask === '拉取' ? (
            <LoaderCircle size={13} className="spin" />
          ) : (
            <ArrowDownToLine size={13} />
          )}
        </button>
        <button
          className="icon-button"
          title={`推送${repository.upstream ? ` · ${repository.upstream}` : '（未设置上游）'}`}
          aria-label="推送"
          disabled={Boolean(remoteTask)}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            onPush(rect.left, rect.bottom);
          }}
        >
          {remoteTask === '推送' ? (
            <LoaderCircle size={13} className="spin" />
          ) : (
            <ArrowUpFromLine size={13} />
          )}
        </button>
        <button
          className="icon-button"
          title={tree ? '平铺显示' : '按目录分组'}
          aria-label={tree ? '平铺显示' : '按目录分组'}
          onClick={() => setTree((value) => !value)}
        >
          {tree ? <List size={14} /> : <FolderTree size={14} />}
        </button>
        <button
          className="icon-button"
          title="刷新"
          aria-label="刷新 Git 状态"
          onClick={onRefresh}
        >
          {loading ? (
            <LoaderCircle size={13} className="spin" />
          ) : (
            <RotateCw size={13} />
          )}
        </button>
      </div>

      {integrating && (
        <div className="operation-banner">
          <p>
            <GitMerge size={13} />
            {conflicts.length
              ? `正在${repository.operation}：${conflicts.length} 个文件有冲突。在编辑器中解决冲突标记后标记为已解决。`
              : `正在${repository.operation}：没有未解决的冲突，可以${repository.operation === '合并' ? '完成合并' : '继续变基'}。`}
          </p>
          <div>
            <button
              className="primary-button"
              disabled={conflicts.length > 0}
              title={
                conflicts.length
                  ? '请先解决并标记所有冲突文件'
                  : repository.operation === '合并'
                    ? '生成合并提交'
                    : '应用下一个提交'
              }
              onClick={onContinue}
            >
              {repository.operation === '合并' ? '完成合并' : '继续变基'}
            </button>
            {repository.operation === '变基' && (
              <button className="secondary-button" onClick={onSkip}>
                跳过此提交
              </button>
            )}
            <button className="text-button danger" onClick={onAbort}>
              中止{repository.operation}
            </button>
          </div>
        </div>
      )}

      <div className="change-list" role="tree" aria-label="变更文件">
        {!total && <p className="change-empty">没有变更</p>}
        {groups.map((group) => {
          const paths = group.files.map((file) => file.path);
          const count = paths.filter((path) => checked.has(path)).length;
          const open = !collapsed.has(group.key);
          return (
            <div key={group.key} className="change-group">
              <div
                className="change-group-title"
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onGroupMenu(group.files, event.clientX, event.clientY);
                }}
              >
                <button
                  aria-label={open ? '折叠' : '展开'}
                  onClick={() => toggle(group.key)}
                >
                  {open ? (
                    <ChevronDown size={12} />
                  ) : (
                    <ChevronRight size={12} />
                  )}
                </button>
                <input
                  type="checkbox"
                  aria-label={`全选${group.title}`}
                  checked={count === paths.length}
                  ref={(input) => {
                    if (input)
                      input.indeterminate = count > 0 && count < paths.length;
                  }}
                  onChange={(event) => onCheck(paths, event.target.checked)}
                />
                <span>{group.title}</span>
                {group.key === 'untracked' && (
                  <button
                    className="change-group-action"
                    title={
                      count
                        ? '将勾选的未跟踪文件加入版本控制（不提交）'
                        : '将全部未跟踪文件加入版本控制（不提交）'
                    }
                    onClick={() =>
                      onAdd(
                        count
                          ? paths.filter((path) => checked.has(path))
                          : paths,
                      )
                    }
                  >
                    <Plus size={11} />
                    {count ? `加入勾选的 ${count} 个` : '全部加入'}
                  </button>
                )}
                <span className="change-count">{paths.length} 个文件</span>
              </div>
              {open &&
                (tree
                  ? treeRows(group.files, '', 1)
                  : group.files.map((file) =>
                      row(file, 1, baseName(file.path)),
                    ))}
            </div>
          );
        })}
        {repository.truncated && (
          <p className="change-empty">变更过多，只显示前 5,000 个文件。</p>
        )}
        {error && <p className="change-error">{error}</p>}
      </div>

      <div className="commit-box">
        <textarea
          ref={inputRef}
          aria-label="提交信息"
          placeholder="提交信息"
          value={message}
          disabled={committing}
          onChange={(event) => onMessage(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              (event.metaKey || event.ctrlKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              if (canCommit) onCommit();
            }
          }}
        />
        <p className="commit-scope">
          {blocked ??
            (selectedCount
              ? `将提交 ${selectedCount} / ${total} 个文件${unsaved ? `，先保存其中 ${unsaved} 个未保存的文件` : ''}`
              : '勾选要提交的文件')}
          {unsavedOther > 0 && (
            <span className="commit-unsaved">
              另有 {unsavedOther} 个文件的编辑尚未保存到磁盘，不会参与提交。
            </span>
          )}
        </p>
        <button
          className="primary-button commit-button"
          disabled={!canCommit}
          onClick={onCommit}
          title="提交勾选的文件 (⌘↵)"
        >
          {committing ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <GitCommitHorizontal size={14} />
          )}
          提交
        </button>
      </div>
    </div>
  );
}
