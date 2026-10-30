import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  History,
  LoaderCircle,
  RotateCw,
} from 'lucide-react';
import type {
  CommitDetail,
  CommitFile,
  CommitSummary,
} from '../../lib/backend';
import { backend, errorMessage } from '../../lib/backend';
import { changeStyle } from './CommitPanel';

interface Props {
  projectId: number;
  /** HEAD、分支或远程引用变化时改变，重新读取第一页。 */
  version: string;
  /** 当前打开的提交 Diff 标签标识（哈希 + NUL + 路径）。 */
  selected: string | null;
  onOpenFile: (commit: CommitSummary, file: CommitFile) => void;
  onCopy: (text: string) => void;
}

const baseName = (path: string) => path.split('/').pop() ?? path;
const dirName = (path: string) => {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
};

/** 最近的时间显示为相对时间，其余显示日期。 */
function relativeTime(seconds: number) {
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(seconds * 1000).toLocaleDateString('zh-CN');
}

const fullTime = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false });

/**
 * 侧边栏提交记录：当前分支涉及项目目录的提交，分页加载；
 * 展开提交查看完整信息与变更文件，点击文件打开该提交的 Diff。
 */
export function LogPanel({
  projectId,
  version,
  selected,
  onOpenFile,
  onCopy,
}: Props) {
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // 提交内容不会改变，详情按哈希缓存。
  const [details, setDetails] = useState(
    new Map<string, CommitDetail | string>(),
  );
  const request = useRef(0);
  // 已加载的提交，下一页从这里继续。
  const loaded = useRef<CommitSummary[]>([]);

  /** 读取一页；reset 时从第一页开始，丢弃之前未完成的请求。 */
  async function load(reset: boolean) {
    const current = ++request.current;
    setLoading(true);
    try {
      const page = await backend.gitLog(
        projectId,
        reset ? 0 : loaded.current.length,
      );
      if (current !== request.current) return;
      const next = reset ? page.commits : [...loaded.current, ...page.commits];
      loaded.current = next;
      setCommits(next);
      setMore(page.more);
      setError(null);
    } catch (failure) {
      if (current === request.current) setError(errorMessage(failure));
    } finally {
      if (current === request.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load(true);
  }, [projectId, version]);

  async function toggle(commit: CommitSummary) {
    if (expanded === commit.hash) {
      setExpanded(null);
      return;
    }
    setExpanded(commit.hash);
    if (details.has(commit.hash)) return;
    let detail: CommitDetail | string;
    try {
      detail = await backend.gitCommitDetail(projectId, commit.hash);
    } catch (failure) {
      detail = errorMessage(failure);
    }
    setDetails((previous) => new Map(previous).set(commit.hash, detail));
  }

  function detailView(commit: CommitSummary) {
    const detail = details.get(commit.hash);
    if (detail === undefined)
      return (
        <p className="log-detail-message">
          <LoaderCircle size={12} className="spin" /> 正在读取提交…
        </p>
      );
    if (typeof detail === 'string')
      return <p className="log-detail-message error">{detail}</p>;
    return (
      <div className="log-detail">
        <pre className="log-message">{detail.message}</pre>
        <p className="log-meta-line">
          {detail.author} &lt;{detail.email}&gt; · {fullTime(detail.time)}
        </p>
        {(detail.committer !== detail.author ||
          detail.commitTime !== detail.time) && (
          <p className="log-meta-line">
            提交者 {detail.committer} · {fullTime(detail.commitTime)}
          </p>
        )}
        <p className="log-meta-line">
          <button
            className="log-hash"
            title="复制完整哈希"
            onClick={() => onCopy(detail.hash)}
          >
            {detail.hash.slice(0, 12)} <Copy size={10} />
          </button>
          {detail.parents.length > 1 &&
            ` · 合并提交，与第一个父提交 ${detail.parents[0].slice(0, 7)} 比较`}
        </p>
        <div className="log-files">
          {!detail.files.length && (
            <p className="log-detail-message">此提交未改动项目目录内的文件。</p>
          )}
          {detail.files.map((file) => {
            const style = changeStyle[file.kind];
            const key = `${commit.hash}\0${file.path}`;
            return (
              <div
                key={file.path}
                className={`change-row ${selected === key ? 'selected' : ''}`}
                style={{ paddingLeft: 24 }}
              >
                <button
                  className={`change-name git-${file.kind}`}
                  title={`${file.original ? `${file.original} → ` : ''}${file.path} · ${style.label}`}
                  onClick={() => onOpenFile(commit, file)}
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
          {detail.truncated && (
            <p className="log-detail-message">
              变更文件过多，只显示前 5,000 个。
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="commit-panel">
      <div className="commit-toolbar">
        <span className="commit-branch">
          <History size={13} />
          当前分支的提交
        </span>
        <button
          className="icon-button"
          title="刷新"
          aria-label="刷新提交记录"
          onClick={() => void load(true)}
        >
          {loading ? (
            <LoaderCircle size={13} className="spin" />
          ) : (
            <RotateCw size={13} />
          )}
        </button>
      </div>
      <div className="change-list" aria-label="提交记录">
        {!commits.length && !loading && !error && (
          <p className="change-empty">尚无提交</p>
        )}
        {commits.map((commit) => {
          const open = expanded === commit.hash;
          return (
            <div key={commit.hash} className="log-item">
              <button
                className={`log-row ${open ? 'open' : ''}`}
                aria-expanded={open}
                onClick={() => void toggle(commit)}
                title={commit.subject}
              >
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span className="log-main">
                  <span className="log-subject">
                    {commit.subject || '（无提交信息）'}
                  </span>
                  <span className="log-sub">
                    <span className="log-short">{commit.hash.slice(0, 7)}</span>
                    <span>{commit.author}</span>
                    <span>{relativeTime(commit.time)}</span>
                  </span>
                  {commit.refs.length > 0 && (
                    <span className="log-refs">
                      {commit.refs.map((item) => (
                        <span
                          key={`${item.kind}:${item.name}`}
                          className={`log-ref ${item.kind}`}
                        >
                          {item.name}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              </button>
              {open && detailView(commit)}
            </div>
          );
        })}
        {more && (
          <button
            className="log-more"
            disabled={loading}
            onClick={() => void load(false)}
          >
            {loading ? <LoaderCircle size={12} className="spin" /> : null}
            加载更早的提交
          </button>
        )}
        {error && <p className="change-error">{error}</p>}
      </div>
    </div>
  );
}
