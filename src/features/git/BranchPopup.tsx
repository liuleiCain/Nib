import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronRight,
  Cloud,
  GitBranch,
  GitBranchPlus,
  LoaderCircle,
  RefreshCw,
  Search,
} from 'lucide-react';
import type { Branches, LocalBranch, RemoteBranch } from '../../lib/backend';
import { backend, errorMessage } from '../../lib/backend';

/** 分支弹窗中选择的操作，由上层执行（含保存编辑、确认和刷新）。 */
export type BranchAction =
  | { kind: 'fetch' }
  | { kind: 'pull' }
  | { kind: 'push' }
  /** start 为起点分支的完整引用名，为空时从当前 HEAD 新建；label 为显示名。 */
  | { kind: 'create'; start: string | null; label: string | null }
  | { kind: 'switch'; name: string }
  | { kind: 'checkout'; remote: string; branch: string }
  | { kind: 'rename'; name: string }
  | { kind: 'delete'; name: string }
  | { kind: 'deleteRemote'; remote: string; branch: string }
  /** target 为目标分支的完整引用名，label 为其显示名。 */
  | { kind: 'merge'; target: string; label: string }
  | { kind: 'rebase'; target: string; label: string };

interface Props {
  projectId: number;
  /** 弹窗锚点，通常是点击位置；空间不足时向上展开。 */
  x: number;
  y: number;
  /** 正在进行的 Fetch、Pull 或 Push，期间禁用这三个操作。 */
  remoteTask: string | null;
  onClose: () => void;
  onAction: (action: BranchAction) => void;
}

/** 每组最多渲染的分支数，更多时提示用搜索缩小范围。 */
const SHOWN = 200;

type Target =
  | { kind: 'local'; branch: LocalBranch }
  | { kind: 'remote'; branch: RemoteBranch };

interface MenuEntry {
  label: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  action: BranchAction;
}

/**
 * 分支弹窗，参照 GoLand 的分支菜单：顶部搜索、Fetch / Pull / Push、从当前分支新建；
 * 下面是本地分支与远程分支，点击、右键、回车或 → 打开该分支的操作菜单。
 */
export function BranchPopup({
  projectId,
  x,
  y,
  remoteTask,
  onClose,
  onAction,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const [data, setData] = useState<Branches | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  // 打开的分支操作菜单：目标分支、所在行和菜单位置。
  const [flyout, setFlyout] = useState<{
    target: Target;
    row: HTMLElement;
    left: number;
    top: number;
  } | null>(null);

  useEffect(() => {
    let current = true;
    backend
      .gitBranches(projectId)
      .then((next) => current && setData(next))
      .catch((failure) => current && setError(errorMessage(failure)));
    return () => {
      current = false;
    };
  }, [projectId]);

  // 只在打开时聚焦搜索框，之后的重新渲染不抢走焦点。
  useEffect(() => {
    filterRef.current?.focus();
  }, []);

  // 内容加载后高度变化，重新限制在窗口内；搜索时保持位置不跳动。
  useLayoutEffect(() => {
    const popup = container.current;
    if (!popup) return;
    const { width, height } = popup.getBoundingClientRect();
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      top:
        y + height + 4 > window.innerHeight
          ? Math.max(4, y - height - 4)
          : y + 4,
    });
  }, [x, y, data, error]);

  // 操作菜单默认在行右侧，空间不足时放到左侧。
  useLayoutEffect(() => {
    const menu = flyoutRef.current;
    if (!menu || !flyout) return;
    const rect = flyout.row.getBoundingClientRect();
    const { width, height } = menu.getBoundingClientRect();
    const left =
      rect.right + width + 4 <= window.innerWidth
        ? rect.right + 2
        : Math.max(4, rect.left - width - 2);
    const top = Math.max(
      4,
      Math.min(rect.top, window.innerHeight - height - 4),
    );
    if (left !== flyout.left || top !== flyout.top)
      setFlyout({ ...flyout, left, top });
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [flyout]);

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

  function run(action: BranchAction) {
    onClose();
    onAction(action);
  }

  function open(target: Target, row: HTMLElement) {
    const rect = row.getBoundingClientRect();
    setFlyout({ target, row, left: rect.right + 2, top: rect.top });
  }

  function closeFlyout() {
    const row = flyout?.row;
    setFlyout(null);
    row?.focus();
  }

  /** 在弹窗或操作菜单内用方向键切换。 */
  function move(scope: HTMLElement, step: 1 | -1) {
    const buttons = [
      ...scope.querySelectorAll<HTMLElement>(
        '.branch-filter input, :scope > button:not(:disabled), .branch-scroll button:not(:disabled)',
      ),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    buttons[(index + step + buttons.length) % buttons.length]?.focus();
  }

  const current = data?.local.find((branch) => branch.current);
  const remote = Boolean(remoteTask);
  const query = filter.trim().toLowerCase();
  const local = (data?.local ?? []).filter((branch) =>
    branch.name.toLowerCase().includes(query),
  );
  const remotes = (data?.remoteBranches ?? []).filter((branch) =>
    branch.name.toLowerCase().includes(query),
  );

  /** 把目标分支合并到当前分支、把当前分支变基到目标分支，与 GoLand 的分支菜单一致。 */
  function integrations(ref: string, label: string): MenuEntry[] {
    const head = data?.current ?? '当前 HEAD';
    return [
      {
        label: `将 ${label} 合并到 ${head}`,
        action: { kind: 'merge', target: ref, label },
      },
      {
        label: `将 ${head} 变基到 ${label}…`,
        action: { kind: 'rebase', target: ref, label },
      },
    ];
  }

  function entries(target: Target): MenuEntry[] {
    if (target.kind === 'remote') {
      const { remote: name, branch } = target.branch;
      return [
        {
          label: '检出为本地分支',
          hint: `跟踪 ${target.branch.name}`,
          action: { kind: 'checkout', remote: name, branch },
        },
        {
          label: `从 ${target.branch.name} 新建分支…`,
          action: {
            kind: 'create',
            start: `refs/remotes/${target.branch.name}`,
            label: target.branch.name,
          },
        },
        ...integrations(
          `refs/remotes/${target.branch.name}`,
          target.branch.name,
        ),
        {
          label: '删除远程分支…',
          danger: true,
          disabled: remote,
          action: { kind: 'deleteRemote', remote: name, branch },
        },
      ];
    }
    const { name } = target.branch;
    if (target.branch.current)
      return [
        {
          label: `从 ${name} 新建分支…`,
          action: { kind: 'create', start: null, label: name },
        },
        {
          label: '拉取 (Pull)',
          hint: '仅快进',
          disabled: remote,
          action: { kind: 'pull' },
        },
        {
          label: '推送 (Push)',
          hint: target.branch.upstream ?? '设置上游',
          disabled: remote,
          action: { kind: 'push' },
        },
        { label: '重命名…', action: { kind: 'rename', name } },
      ];
    return [
      { label: '切换到此分支', action: { kind: 'switch', name } },
      {
        label: `从 ${name} 新建分支…`,
        action: { kind: 'create', start: `refs/heads/${name}`, label: name },
      },
      ...integrations(`refs/heads/${name}`, name),
      { label: '重命名…', action: { kind: 'rename', name } },
      {
        label: '删除…',
        danger: true,
        action: { kind: 'delete', name },
      },
    ];
  }

  function row(target: Target, key: string) {
    const isLocal = target.kind === 'local';
    const branch = target.branch;
    const currentRow = isLocal && target.branch.current;
    const opened =
      flyout?.target.kind === target.kind &&
      flyout.target.branch.name === branch.name;
    const status = isLocal
      ? target.branch.gone
        ? '上游已删除'
        : target.branch.upstream
          ? `${target.branch.ahead ? `↑${target.branch.ahead} ` : ''}${target.branch.behind ? `↓${target.branch.behind} ` : ''}${target.branch.upstream}`
          : ''
      : '';
    return (
      <button
        key={key}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={opened}
        className={`${currentRow ? 'current' : ''} ${opened ? 'opened' : ''}`}
        title={currentRow ? `${branch.name}（当前分支）` : branch.name}
        onClick={(event) => open(target, event.currentTarget)}
        onContextMenu={(event) => {
          event.preventDefault();
          open(target, event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            open(target, event.currentTarget);
          }
        }}
      >
        {currentRow ? (
          <Check size={13} />
        ) : isLocal ? (
          <GitBranch size={13} />
        ) : (
          <Cloud size={13} />
        )}
        <span className="branch-name">{branch.name}</span>
        {status && <kbd>{status}</kbd>}
        <ChevronRight size={12} className="branch-more" />
      </button>
    );
  }

  return (
    <div
      ref={container}
      className="context-menu branch-popup"
      role="menu"
      style={position}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (flyout) {
          if (event.key === 'Escape' || event.key === 'ArrowLeft') {
            event.preventDefault();
            event.stopPropagation();
            closeFlyout();
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const buttons = [
              ...flyoutRef.current!.querySelectorAll<HTMLButtonElement>(
                'button:not(:disabled)',
              ),
            ];
            const index = buttons.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const step = event.key === 'ArrowDown' ? 1 : -1;
            buttons[(index + step + buttons.length) % buttons.length]?.focus();
          }
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          move(container.current!, event.key === 'ArrowDown' ? 1 : -1);
        }
      }}
    >
      <label className="branch-filter">
        <Search size={12} />
        <input
          ref={filterRef}
          aria-label="搜索分支"
          placeholder="搜索分支"
          value={filter}
          spellCheck={false}
          onChange={(event) => {
            setFilter(event.target.value);
            setFlyout(null);
          }}
          onKeyDown={(event) => {
            // 回车打开第一个匹配分支的操作菜单。
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
            event.preventDefault();
            const first = container.current?.querySelector<HTMLElement>(
              '.branch-scroll button[aria-haspopup]',
            );
            first?.click();
          }}
        />
      </label>
      <button
        role="menuitem"
        disabled={remote}
        onClick={() => run({ kind: 'fetch' })}
      >
        <RefreshCw size={13} />
        <span>获取 (Fetch)</span>
        <kbd>所有远程</kbd>
      </button>
      <button
        role="menuitem"
        disabled={remote}
        onClick={() => run({ kind: 'pull' })}
      >
        <ArrowDownToLine size={13} />
        <span>拉取 (Pull)</span>
        <kbd>仅快进</kbd>
      </button>
      <button
        role="menuitem"
        disabled={remote}
        onClick={() => run({ kind: 'push' })}
      >
        <ArrowUpFromLine size={13} />
        <span>推送 (Push)</span>
        {current?.upstream && <kbd>{current.upstream}</kbd>}
      </button>
      <button
        role="menuitem"
        onClick={() =>
          run({ kind: 'create', start: null, label: data?.current ?? null })
        }
      >
        <GitBranchPlus size={13} />
        <span>从当前分支新建分支…</span>
        {data?.current && <kbd>{data.current}</kbd>}
      </button>
      {remoteTask && (
        <p className="branch-note">
          <LoaderCircle size={11} className="spin" /> 正在{remoteTask}…
        </p>
      )}
      <div className="branch-scroll" onScroll={() => flyout && setFlyout(null)}>
        <div className="context-separator" role="separator" />
        <p className="menu-label">本地分支</p>
        {!data && !error && (
          <p className="branch-note">
            <LoaderCircle size={11} className="spin" /> 正在读取分支…
          </p>
        )}
        {error && <p className="branch-note error">{error}</p>}
        {data && !data.local.length && (
          <p className="branch-note">
            {data.current ? `${data.current}（尚无提交）` : '没有本地分支'}
          </p>
        )}
        {data && data.local.length > 0 && !local.length && (
          <p className="branch-note">没有匹配的本地分支</p>
        )}
        {local
          .slice(0, SHOWN)
          .map((branch) =>
            row({ kind: 'local', branch }, `local:${branch.name}`),
          )}
        {local.length > SHOWN && (
          <p className="branch-note">
            另有 {local.length - SHOWN} 个，请输入名称搜索
          </p>
        )}
        {data && (
          <>
            <div className="context-separator" role="separator" />
            <p className="menu-label">远程分支</p>
            {!data.remoteBranches.length && (
              <p className="branch-note">
                {data.remotes.length
                  ? '没有远程分支记录，可先获取（Fetch）'
                  : '未配置远程仓库'}
              </p>
            )}
            {data.remoteBranches.length > 0 && !remotes.length && (
              <p className="branch-note">没有匹配的远程分支</p>
            )}
            {remotes
              .slice(0, SHOWN)
              .map((branch) =>
                row({ kind: 'remote', branch }, `remote:${branch.name}`),
              )}
            {(remotes.length > SHOWN || data.remoteTruncated) && (
              <p className="branch-note">
                {remotes.length > SHOWN
                  ? `另有 ${remotes.length - SHOWN} 个，请输入名称搜索`
                  : '远程分支过多，只读取了前 2,000 个'}
              </p>
            )}
            {data.remotes.length > 0 && (
              <>
                <div className="context-separator" role="separator" />
                <p className="menu-label">远程仓库</p>
                {data.remotes.map((item) => (
                  <p key={item.name} className="branch-remote" title={item.url}>
                    <span>{item.name}</span>
                    <span>{item.url}</span>
                  </p>
                ))}
              </>
            )}
          </>
        )}
      </div>
      {flyout && (
        <div
          ref={flyoutRef}
          className="context-menu branch-flyout"
          role="menu"
          aria-label={`${flyout.target.branch.name} 的操作`}
          style={{ left: flyout.left, top: flyout.top }}
        >
          {entries(flyout.target).map((entry) => (
            <button
              key={entry.label}
              role="menuitem"
              className={entry.danger ? 'danger' : undefined}
              disabled={entry.disabled}
              onClick={() => run(entry.action)}
            >
              <span>{entry.label}</span>
              {entry.hint && <kbd>{entry.hint}</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
