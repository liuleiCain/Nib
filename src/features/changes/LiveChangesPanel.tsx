import { useEffect, useState } from 'react';
import { FileCode2, LoaderCircle, Radio, RotateCw } from 'lucide-react';
import type { GitStatus } from '../../lib/backend';
import { changeStyle } from '../git/CommitPanel';
import type { LiveFile } from './useLiveChanges';
import { useVirtualRows } from '../../lib/virtual';

interface Props {
  files: LiveFile[];
  selected: string | null;
  status: GitStatus | null;
  loading: boolean;
  error: string | null;
  rescan: boolean;
  onSelect: (path: string) => void;
  onRefresh: () => void;
}

/** 实时文件列表只展示当前状态，选择的文件在同一个预览标签中显示。 */
export function LiveChangesPanel({
  files,
  selected,
  status,
  loading,
  error,
  rescan,
  onSelect,
  onRefresh,
}: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const repository = status?.kind === 'repository';
  const { scrollRef, items, spacer, measure } = useVirtualRows<HTMLDivElement>(
    files.length,
    () => 48,
    (index) => files[index].path,
  );
  return (
    <div className="live-panel">
      <div className="live-panel-heading">
        <span>
          <Radio size={14} /> 实时变更{' '}
          <span className="live-total">{files.length}</span>
        </span>
        <button
          className="icon-button"
          aria-label="刷新实时变更"
          title="刷新实时变更"
          onClick={onRefresh}
          disabled={loading && !status}
          aria-busy={loading}
        >
          {loading && !status ? (
            <LoaderCircle size={13} className="spin" />
          ) : (
            <RotateCw size={13} />
          )}
        </button>
      </div>
      <div className="live-options">
        <p>
          {repository
            ? 'HEAD → 当前磁盘 · 包含已有未提交修改'
            : '显示打开项目后变化的文件及最新磁盘内容'}
        </p>
      </div>
      {error && (
        <p className="live-warning" role="alert">
          {error}
        </p>
      )}
      {status?.kind === 'unavailable' && (
        <p className="live-warning">Git 不可用，仅预览磁盘内容。</p>
      )}
      {((repository && status.truncated) || (!repository && rescan)) && (
        <p className="live-warning">
          {repository
            ? '变更过多，当前列表仅显示部分文件。'
            : '收到批量变化，文件列表可能不完整；仍会更新当前预览。'}
        </p>
      )}
      <div
        ref={scrollRef}
        className="live-file-list"
        aria-label="实时变化的文件"
      >
        <div style={spacer}>
          {items.map((item) => {
            const file = files[item.index];
            const slash = file.path.lastIndexOf('/');
            const recent =
              file.updatedAt !== null && now - file.updatedAt < 2000;
            return (
              <button
                key={item.key}
                ref={measure}
                data-index={item.index}
                className={`live-file ${selected === file.path ? 'selected' : ''} ${recent ? 'recent' : ''}`}
                onClick={() => onSelect(file.path)}
                title={`${file.path} · ${changeStyle[file.kind].label}${file.original ? ` · 原路径 ${file.original}` : ''}`}
                aria-pressed={selected === file.path}
              >
                <FileCode2 size={14} className={`git-${file.kind}`} />
                <span className="live-file-label">
                  <span className={`live-file-name git-${file.kind}`}>
                    {file.path.slice(slash + 1)}
                  </span>
                  <span className="live-file-directory">
                    {slash < 0 ? '项目根目录' : file.path.slice(0, slash)}
                  </span>
                </span>
                <span className="live-file-meta">
                  <span className={`git-${file.kind}`}>
                    {changeStyle[file.kind].letter}
                  </span>
                  {file.updatedAt !== null && (
                    <time dateTime={new Date(file.updatedAt).toISOString()}>
                      {new Date(file.updatedAt).toLocaleTimeString('zh-CN', {
                        hour12: false,
                      })}
                    </time>
                  )}
                </span>
                {recent && (
                  <span className="live-update-dot" aria-label="刚刚更新" />
                )}
              </button>
            );
          })}
        </div>
        {!files.length && (
          <div className="git-empty">
            <Radio size={24} strokeWidth={1.3} />
            <p>
              {loading && !status
                ? '正在读取变更…'
                : repository
                  ? '当前没有文件变更'
                  : '等待文件变化'}
            </p>
            <span>外部工具或编辑器保存文件后，这里会自动更新。</span>
          </div>
        )}
      </div>
      <div className="live-panel-footer">
        <span className="version-dot" /> 自动监听磁盘变化
      </div>
    </div>
  );
}
