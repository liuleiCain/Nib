import { useEffect, useMemo, useRef, useState } from 'react';
import { FileCode2, LoaderCircle, Search } from 'lucide-react';
import { backend, errorMessage } from '../../lib/backend';

interface Props {
  projectId: number;
  /** 已打开的标签，最近使用的在前；输入为空时优先列出。 */
  recent: string[];
  /** line 为 path:行号 中的行号。 */
  onOpen: (path: string, line: number | null) => void;
  onClose: () => void;
}

/** 最多展示的匹配数。 */
const SHOWN = 100;

interface Candidate {
  path: string;
  score: number;
  /** 命中字符在路径中的位置，用于高亮。 */
  positions: number[];
}

const boundary = (text: string, index: number) =>
  index === 0 ||
  '/._- '.includes(text[index - 1]) ||
  (text[index] >= 'A' &&
    text[index] <= 'Z' &&
    text[index - 1] >= 'a' &&
    text[index - 1] <= 'z');

/** 按子序列匹配打分：连续命中、词首命中加分；全部字符都须按顺序出现。 */
function subsequence(query: string, text: string, offset: number) {
  const lower = text.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let from = 0;
  for (const character of query) {
    const index = lower.indexOf(character, from);
    if (index < 0) return null;
    score += 1;
    if (
      positions.length &&
      positions[positions.length - 1] === offset + index - 1
    )
      score += 5;
    if (boundary(text, index)) score += 3;
    positions.push(offset + index);
    from = index + 1;
  }
  return { score, positions };
}

/** 优先匹配文件名，文件名不含全部字符时再匹配完整路径；路径越短越靠前。 */
function rank(query: string, path: string): Candidate | null {
  const slash = path.lastIndexOf('/') + 1;
  const name = subsequence(query, path.slice(slash), slash);
  if (name)
    return {
      path,
      score: name.score + 20 - path.length / 100,
      positions: name.positions,
    };
  const full = subsequence(query, path, 0);
  return full
    ? { path, score: full.score - path.length / 100, positions: full.positions }
    : null;
}

/** 按 UTF-16 位置高亮，与 indexOf 返回的位置一致。 */
function highlight(text: string, offset: number, positions: Set<number>) {
  const parts: React.ReactNode[] = [];
  let plain = '';
  for (let index = 0; index < text.length; index++) {
    if (positions.has(offset + index)) {
      if (plain) parts.push(plain);
      plain = '';
      parts.push(<mark key={index}>{text[index]}</mark>);
    } else plain += text[index];
  }
  if (plain) parts.push(plain);
  return parts;
}

/** 快速打开（Cmd/Ctrl+P）：按文件名模糊匹配项目文件，支持 路径:行号。 */
export function QuickOpen({ projectId, recent, onOpen, onClose }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<string[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);

  useEffect(() => {
    input.current?.focus();
    let current = true;
    backend
      .searchFiles(projectId)
      .then((list) => {
        if (!current) return;
        setFiles(list.files);
        setTruncated(list.truncated);
      })
      .catch((failure) => current && setError(errorMessage(failure)));
    return () => {
      current = false;
    };
  }, [projectId]);

  const lineMatch = /^(.*?):(\d+)$/.exec(query.trim());
  const text = (lineMatch ? lineMatch[1] : query).replace(/\s+/g, '');
  const line = lineMatch ? Number(lineMatch[2]) : null;

  const results: Candidate[] = useMemo(() => {
    // 已打开的标签始终在候选中（可能位于被忽略的目录），并略微优先。
    const open = new Set(recent);
    const pool = [
      ...recent,
      ...(files ?? []).filter((path) => !open.has(path)),
    ];
    if (!text)
      return pool
        .slice(0, SHOWN)
        .map((path) => ({ path, score: 0, positions: [] }));
    const lower = text.toLowerCase();
    const ranked: Candidate[] = [];
    for (const path of pool) {
      const candidate = rank(lower, path);
      if (candidate) {
        if (open.has(path)) candidate.score += 2;
        ranked.push(candidate);
      }
    }
    ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return ranked.slice(0, SHOWN);
  }, [files, recent, text]);

  function choose(candidate: Candidate | undefined) {
    if (!candidate) return;
    onClose();
    onOpen(candidate.path, line);
  }

  return (
    <div
      className="modal-backdrop palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="快速打开文件"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          } else if (event.key === 'Tab') {
            event.preventDefault();
            input.current?.focus();
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            setIndex((value) =>
              Math.max(0, Math.min(results.length - 1, value + 1)),
            );
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setIndex((value) => Math.max(0, value - 1));
          } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            choose(results[index]);
          }
        }}
      >
        <div className="palette-input">
          <Search size={17} />
          <input
            ref={input}
            placeholder="输入文件名，可用 路径:行号 跳转到行…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            role="combobox"
            aria-expanded="true"
            aria-controls="quick-open-results"
            aria-autocomplete="list"
            aria-activedescendant={
              results.length ? `quick-open-${index}` : undefined
            }
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-results" role="listbox" id="quick-open-results">
          {results.map((candidate, position) => {
            const slash = candidate.path.lastIndexOf('/') + 1;
            const marks = new Set(candidate.positions);
            return (
              <button
                id={`quick-open-${position}`}
                role="option"
                aria-selected={position === index}
                className={`quick-open-item ${position === index ? 'highlighted' : ''}`}
                key={candidate.path}
                title={candidate.path}
                onMouseEnter={() => setIndex(position)}
                onClick={() => choose(candidate)}
              >
                <FileCode2 size={13} />
                <span className="quick-open-name">
                  {highlight(candidate.path.slice(slash), slash, marks)}
                </span>
                {slash > 0 && (
                  <span className="quick-open-dir">
                    {highlight(candidate.path.slice(0, slash - 1), 0, marks)}
                  </span>
                )}
              </button>
            );
          })}
          {!files && !error && (
            <p className="palette-empty">
              <LoaderCircle size={13} className="spin" /> 正在读取文件列表…
            </p>
          )}
          {error && <p className="palette-empty">{error}</p>}
          {files && !results.length && (
            <p className="palette-empty">没有匹配的文件</p>
          )}
        </div>
        <footer>
          <span>↑ ↓ 选择</span>
          <span>↵ 打开</span>
          <span>esc 关闭</span>
          {truncated && <span>文件过多，只列出前 50,000 个</span>}
          {!truncated && files && <span>按 .gitignore 排除忽略的文件</span>}
        </footer>
      </section>
    </div>
  );
}
