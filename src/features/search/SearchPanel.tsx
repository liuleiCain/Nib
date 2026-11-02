import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Eye,
  LoaderCircle,
  Regex,
  Search,
  WholeWord,
} from 'lucide-react';
import type {
  SearchMatch,
  SearchOptions,
  SearchResult,
} from '../../lib/backend';
import { backend, errorCode, errorMessage } from '../../lib/backend';
import { useVirtualRows } from '../../lib/virtual';

interface Props {
  projectId: number;
  /** 每次变化时聚焦搜索框并全选；seed 不为空时用它替换搜索内容。 */
  focus: { key: number; seed: string | null };
  onOpen: (path: string, match: SearchMatch) => void;
}

/** 停止输入后开始搜索的等待时间。 */
const SEARCH_DELAY = 300;

const toggles: {
  key: keyof SearchOptions;
  label: string;
  icon: typeof Regex;
}[] = [
  { key: 'caseSensitive', label: '区分大小写', icon: CaseSensitive },
  { key: 'wholeWord', label: '全词匹配', icon: WholeWord },
  { key: 'regex', label: '正则表达式', icon: Regex },
  { key: 'includeIgnored', label: '包含被 .gitignore 忽略的文件', icon: Eye },
];

type SearchFile = SearchResult['files'][number];

/** 拍平后的搜索结果行：文件标题或匹配处；文件以 NUL 开头的路径为 key，匹配用“路径:行:列”。 */
type Row =
  | { kind: 'file'; key: string; file: SearchFile; open: boolean }
  | { kind: 'match'; key: string; file: SearchFile; match: SearchMatch };

const baseName = (path: string) => path.split('/').pop() ?? path;
const dirName = (path: string) => {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
};

/**
 * 项目搜索（Cmd/Ctrl+Shift+F）：停止输入后在后台搜索，结果按文件分组，点击跳转到匹配位置。
 * 新的输入会取消进行中的搜索，也可手动停止；搜索的是磁盘内容，不含未保存的编辑。
 */
export function SearchPanel({ projectId, focus, onOpen }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<SearchOptions>({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    includeIgnored: false,
  });
  const [result, setResult] = useState<SearchResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [selected, setSelected] = useState<string | null>(null);
  const request = useRef(0);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (focus.seed) setQuery(focus.seed);
    window.setTimeout(() => {
      input.current?.focus();
      input.current?.select();
    }, 0);
  }, [focus]);

  // 卸载时停止进行中的搜索。
  useEffect(
    () => () => {
      request.current++;
      if (timer.current !== null) window.clearTimeout(timer.current);
      void backend.cancelSearch().catch(() => {});
    },
    [],
  );

  async function run(text: string, current: SearchOptions) {
    const id = ++request.current;
    if (!text) {
      setResult(null);
      setError(null);
      setRunning(false);
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const next = await backend.searchText(projectId, text, current);
      if (id !== request.current) return;
      setResult(next);
      setCollapsed(new Set());
    } catch (failure) {
      if (id !== request.current || errorCode(failure) === 'CANCELLED') return;
      setResult(null);
      setError(errorMessage(failure));
    } finally {
      if (id === request.current) setRunning(false);
    }
  }

  // 输入变化时立即作废并停止旧请求，避免它在等待新搜索期间回填结果。
  useEffect(() => {
    request.current++;
    void backend.cancelSearch().catch(() => {});
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void run(query, options);
    }, SEARCH_DELAY);
  }, [query, options, projectId]);

  function stop() {
    request.current++;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setRunning(false);
    void backend.cancelSearch().catch(() => {});
  }

  function toggle(path: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const fileCount = result?.files.length ?? 0;

  const rows = useMemo(() => {
    const list: Row[] = [];
    for (const file of result?.files ?? []) {
      const open = !collapsed.has(file.path);
      list.push({ kind: 'file', key: `\0${file.path}`, file, open });
      if (open)
        for (const match of file.matches)
          list.push({
            kind: 'match',
            key: `${file.path}:${match.line}:${match.column}`,
            file,
            match,
          });
    }
    return list;
  }, [result, collapsed]);

  const { scrollRef, items, spacer, measure } = useVirtualRows<HTMLDivElement>(
    rows.length,
    (index) => (rows[index].kind === 'file' ? 24 : 22),
    (index) => rows[index].key,
  );

  return (
    <div className="search-panel">
      <div className="search-box">
        <Search size={13} />
        <input
          ref={input}
          aria-label="在项目中搜索"
          placeholder="在项目中搜索"
          value={query}
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (timer.current !== null) window.clearTimeout(timer.current);
              timer.current = null;
              void run(query, options);
            } else if (event.key === 'Escape' && running) {
              event.preventDefault();
              stop();
            }
          }}
        />
        {toggles.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            className={`icon-button ${options[key] ? 'active' : ''}`}
            title={label}
            aria-label={label}
            aria-pressed={options[key]}
            onClick={() =>
              setOptions((previous) => ({ ...previous, [key]: !previous[key] }))
            }
          >
            <Icon size={14} />
          </button>
        ))}
      </div>

      <div className="search-summary">
        {running ? (
          <>
            <LoaderCircle size={12} className="spin" />
            <span>正在搜索…</span>
            <button className="text-button" onClick={stop}>
              <CircleStop size={12} /> 停止
            </button>
          </>
        ) : error ? (
          <span className="search-error">{error}</span>
        ) : result ? (
          <span>
            {result.total
              ? `${fileCount} 个文件中有 ${result.total.toLocaleString()} 处结果`
              : '没有结果'}
            {result.truncated && '，结果过多，只显示前一部分'}
            {result.skipped > 0 &&
              `；${result.skipped} 个过大或非 UTF-8 的文件未搜索`}
          </span>
        ) : (
          <span>输入后自动搜索，按 .gitignore 排除忽略的文件</span>
        )}
      </div>

      <div
        ref={scrollRef}
        className="search-results"
        role="tree"
        aria-label="搜索结果"
      >
        <div style={spacer}>
          {items.map((item) => {
            const row = rows[item.index];
            return (
              <div
                key={item.key}
                ref={measure}
                data-index={item.index}
                role="none"
              >
                {row.kind === 'file' ? (
                  <button
                    className="search-file-title"
                    title={row.file.path}
                    onClick={() => toggle(row.file.path)}
                  >
                    {row.open ? (
                      <ChevronDown size={12} />
                    ) : (
                      <ChevronRight size={12} />
                    )}
                    <span className="search-file-name">
                      {baseName(row.file.path)}
                    </span>
                    <span className="search-file-dir">
                      {dirName(row.file.path)}
                    </span>
                    <span className="change-count">
                      {row.file.matches.length}
                      {row.file.truncated ? '+' : ''}
                    </span>
                  </button>
                ) : (
                  <button
                    className={`search-match ${selected === row.key ? 'selected' : ''}`}
                    title={`${row.file.path}:${row.match.line}`}
                    onClick={() => {
                      setSelected(row.key);
                      onOpen(row.file.path, row.match);
                    }}
                  >
                    <span className="search-line">{row.match.line}</span>
                    <span className="search-preview">
                      {row.match.before}
                      <mark>{row.match.matched}</mark>
                      {row.match.after}
                    </span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <p className="search-note">搜索磁盘上的内容，不含未保存的编辑。</p>
    </div>
  );
}
