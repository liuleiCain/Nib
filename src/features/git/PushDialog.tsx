import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpFromLine,
  LoaderCircle,
  TriangleAlert,
} from 'lucide-react';
import type {
  CommitDetail,
  CommitFile,
  CommitSummary,
  Outgoing,
} from '../../lib/backend';
import { backend, errorMessage } from '../../lib/backend';
import { useVirtualRows } from '../../lib/virtual';
import { changeStyle } from './CommitPanel';
import type { DiffTab } from './DiffView';
import { DiffView } from './DiffView';

interface Props {
  projectId: number;
  /** 确认推送：remote 仅在没有上游时传入，head 为预览时的 HEAD 提交。 */
  onPush: (remote: string | null, head: string) => void;
  onClose: () => void;
}

const baseName = (path: string) => path.split('/').pop() ?? path;
const dirName = (path: string) => {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
};
const fullTime = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false });

/** 推送确认框右侧的变更文件列表，最多 5,000 项只渲染可见部分；按提交重新挂载，切换提交时回到顶部。 */
function CommitFiles({
  detail,
  onOpen,
}: {
  detail: CommitDetail;
  onOpen: (file: CommitFile) => void;
}) {
  const { scrollRef, items, spacer, measure } = useVirtualRows<HTMLDivElement>(
    detail.files.length,
    () => 26,
    (index) => detail.files[index].path,
  );
  return (
    <div ref={scrollRef} className="push-file-scroll">
      {!detail.files.length && (
        <p className="push-note">此提交未改动项目目录内的文件。</p>
      )}
      <div style={spacer}>
        {items.map((item) => {
          const file = detail.files[item.index];
          const style = changeStyle[file.kind];
          return (
            <div
              key={item.key}
              ref={measure}
              data-index={item.index}
              className="change-row"
            >
              <button
                className={`change-name git-${file.kind}`}
                title={`${file.original ? `${file.original} → ` : ''}${file.path} · ${style.label}，点击查看 Diff`}
                onClick={() => onOpen(file)}
              >
                <span className="change-file">{baseName(file.path)}</span>
                {dirName(file.path) && (
                  <span className="change-dir">{dirName(file.path)}</span>
                )}
                {file.original && (
                  <span className="change-dir">
                    ← {baseName(file.original)}
                  </span>
                )}
              </button>
              <span
                className={`change-letter git-${file.kind}`}
                title={style.label}
              >
                {style.letter}
              </span>
            </div>
          );
        })}
      </div>
      {detail.truncated && (
        <p className="push-note">变更文件过多，只显示前 5,000 个。</p>
      )}
    </div>
  );
}

/**
 * 推送确认框，参照 GoLand：上方为“本地分支 → 远程分支”，左侧列出待推送的提交，
 * 右侧为选中提交的变更文件，点击文件在右侧显示只读 Diff。没有上游时可选择远程仓库。
 */
export function PushDialog({ projectId, onPush, onClose }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [remote, setRemote] = useState<string | null>(null);
  const [data, setData] = useState<Outgoing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // 提交内容不会改变，详情按哈希缓存。
  const [details, setDetails] = useState(
    new Map<string, CommitDetail | string>(),
  );
  // 右侧显示的文件 Diff；为空时显示文件列表。
  const [diff, setDiff] = useState<DiffTab | null>(null);
  const [unified, setUnified] = useState(false);
  const diffRequest = useRef(0);

  useEffect(() => {
    let current = true;
    setData(null);
    setError(null);
    backend
      .gitOutgoing(projectId, remote)
      .then((next) => {
        if (!current) return;
        setData(next);
        setSelected(next.commits[0]?.hash ?? null);
      })
      .catch((failure) => current && setError(errorMessage(failure)));
    return () => {
      current = false;
    };
  }, [projectId, remote]);

  useEffect(() => {
    if (!selected || details.has(selected)) return;
    let current = true;
    const hash = selected;
    backend
      .gitCommitDetail(projectId, hash)
      .catch((failure): string => errorMessage(failure))
      .then(
        (detail) =>
          current &&
          setDetails((previous) => new Map(previous).set(hash, detail)),
      );
    return () => {
      current = false;
    };
  }, [projectId, selected, details]);

  // 打开时聚焦取消按钮，避免回车误推送。
  useEffect(() => {
    container.current
      ?.querySelector<HTMLButtonElement>('.secondary-button')
      ?.focus();
  }, []);

  const commit = data?.commits.find((item) => item.hash === selected) ?? null;
  const detail = selected ? details.get(selected) : undefined;
  const target = data
    ? (data.upstream ?? `${data.remote}/${data.branch}`)
    : null;
  // 发布新分支或设置上游时，即使远程已有全部提交也需要允许推送。
  const ready = Boolean(
    data && (data.total || data.newBranch || !data.upstream),
  );

  /** 在右侧读取并显示文件在该提交中的 Diff（与第一个父提交比较）。 */
  async function openFile(item: CommitSummary, file: CommitFile) {
    const current = ++diffRequest.current;
    const next: DiffTab = {
      key: `${item.hash}\0${file.path}`,
      path: file.path,
      original: file.original,
      sources: null,
      error: null,
      version: 0,
      commit: {
        hash: item.hash,
        parent: item.parents[0] ?? null,
        subject: item.subject,
      },
    };
    setDiff(next);
    try {
      const sources = await backend.gitCommitDiff(
        projectId,
        item.hash,
        file.path,
        file.original,
      );
      if (current === diffRequest.current)
        setDiff({ ...next, sources, version: 1 });
    } catch (failure) {
      if (current === diffRequest.current)
        setDiff({ ...next, error: errorMessage(failure) });
    }
  }

  function select(hash: string) {
    diffRequest.current++;
    setDiff(null);
    setSelected(hash);
  }

  /** 方向键在提交之间切换。 */
  function step(direction: 1 | -1) {
    if (!data?.commits.length) return;
    const index = data.commits.findIndex((item) => item.hash === selected);
    const next =
      data.commits[
        Math.max(0, Math.min(data.commits.length - 1, index + direction))
      ];
    select(next.hash);
    container.current
      ?.querySelector<HTMLElement>(`[data-hash="${next.hash}"]`)
      ?.focus();
  }

  function filesView() {
    if (!commit) return null;
    if (diff)
      return (
        <div className="push-diff">
          <button
            className="text-button push-back"
            onClick={() => {
              diffRequest.current++;
              setDiff(null);
            }}
          >
            <ArrowLeft size={12} /> 返回文件列表
          </button>
          <DiffView
            diff={diff}
            unified={unified}
            onToggleUnified={() => setUnified((value) => !value)}
            onOpenFile={() => {}}
            onRestore={() => {}}
            onRevert={async () => false}
          />
        </div>
      );
    if (detail === undefined)
      return (
        <p className="push-note">
          <LoaderCircle size={12} className="spin" /> 正在读取提交…
        </p>
      );
    if (typeof detail === 'string')
      return <p className="push-note error">{detail}</p>;
    return (
      <>
        <section className="push-description" aria-label="提交说明">
          <div className="push-section-heading">提交说明</div>
          <pre className="push-message" tabIndex={0} aria-label="提交说明内容">
            {detail.message}
          </pre>
          <p className="push-meta">
            {detail.author} · {fullTime(detail.time)} ·{' '}
            {detail.hash.slice(0, 12)}
            {detail.parents.length > 1 && ' · 合并提交，与第一个父提交比较'}
          </p>
        </section>
        <div className="push-file-list" aria-label="提交中的文件">
          <div className="push-section-heading">
            变更文件 · {detail.files.length}
            {detail.truncated ? '+' : ''}
          </div>
          <CommitFiles
            key={detail.hash}
            detail={detail}
            onOpen={(file) => void openFile(commit, file)}
          />
        </div>
      </>
    );
  }

  return (
    <div className="modal-backdrop">
      <div
        ref={container}
        className="unsaved-dialog push-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="push-title"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          // 正在看 Diff 时先回到文件列表。
          if (diff) {
            diffRequest.current++;
            setDiff(null);
          } else onClose();
        }}
      >
        <h2 id="push-title">
          <ArrowUpFromLine size={16} /> 推送提交
        </h2>
        <div className="push-target">
          <span className="push-branch">{data?.branch ?? '…'}</span>
          <span aria-hidden="true">→</span>
          {data && !data.upstream && data.remotes.length > 1 ? (
            <label>
              <select
                aria-label="推送到的远程仓库"
                value={data.remote}
                onChange={(event) => setRemote(event.target.value)}
              >
                {data.remotes.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <span className="push-branch">/{data.branch}</span>
            </label>
          ) : (
            <span className="push-branch">{target ?? '…'}</span>
          )}
          {data?.newBranch && <span className="push-tag">新分支</span>}
          {data && !data.upstream && (
            <span className="push-hint">推送后设为上游</span>
          )}
        </div>
        <div className="push-body">
          <div
            className="push-commits"
            role="listbox"
            aria-label="待推送的提交"
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                step(event.key === 'ArrowDown' ? 1 : -1);
              }
            }}
          >
            {!data && !error && (
              <p className="push-note">
                <LoaderCircle size={12} className="spin" />{' '}
                正在读取待推送的提交…
              </p>
            )}
            {error && <p className="push-note error">{error}</p>}
            {data && !data.total && (
              <p className="push-note">
                {data.newBranch
                  ? `没有额外的新提交，推送将发布当前分支到 ${target}。`
                  : !data.upstream
                    ? `没有需要推送的新提交，推送后将 ${target} 设为上游。`
                    : `没有需要推送的提交，${target} 已包含当前分支的所有提交。`}
              </p>
            )}
            {data?.commits.map((item) => (
              <button
                key={item.hash}
                data-hash={item.hash}
                role="option"
                aria-selected={item.hash === selected}
                className={`log-row ${item.hash === selected ? 'open' : ''}`}
                title={item.subject}
                onClick={() => select(item.hash)}
              >
                <span className="log-main">
                  <span className="log-subject">
                    {item.subject || '（无提交信息）'}
                  </span>
                  <span className="log-sub">
                    <span className="log-short">{item.hash.slice(0, 7)}</span>
                    <span>{item.author}</span>
                    <span>{fullTime(item.time)}</span>
                  </span>
                </span>
              </button>
            ))}
            {data && data.total > data.commits.length && (
              <p className="push-note">
                共 {data.total} 个提交，只列出最新的 {data.commits.length} 个。
              </p>
            )}
          </div>
          <div className="push-files" aria-label="提交详情">
            {filesView()}
          </div>
        </div>
        <p className="push-footnote">
          {data?.newBranch ? (
            <>
              <TriangleAlert size={11} />
              {`本地没有 ${target} 的记录，按 ${data.remote} 上已获取的分支计算；远程可能已有其中部分提交。`}
            </>
          ) : (
            '按上次获取（Fetch）时的远程记录计算；推送被拒绝时请先拉取。Nib 不提供强制推送。'
          )}
        </p>
        <div className="dialog-actions">
          <button className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button
            className="primary-button"
            disabled={!ready}
            onClick={() =>
              data && onPush(data.upstream ? null : data.remote, data.head)
            }
          >
            推送{data?.total ? ` ${data.total} 个提交` : ready ? '分支' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
