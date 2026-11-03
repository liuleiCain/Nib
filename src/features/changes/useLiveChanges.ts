import { useEffect, useMemo, useRef, useState } from 'react';
import type { DiffTab } from '../git/DiffView';
import type {
  FileChange,
  FileChanges,
  GitStatus,
  Project,
} from '../../lib/backend';
import { backend, errorCode, errorMessage } from '../../lib/backend';

/** 只保留文件的最新变化标记，不记录内容历史。 */
export interface LiveFile extends FileChange {
  sequence: number;
  updatedAt: number | null;
}

const MAX_FILES = 5000;

/** 一次「跳到最新」请求：预览加载到该文件后定位最近写入的位置，只执行一次。 */
export interface LiveJump {
  path: string;
  key: number;
}

/** 当前项目的实时文件列表、选中文件和磁盘预览；项目切换后丢弃迟到结果。 */
export function useLiveChanges(
  project: Project | null,
  status: GitStatus | null,
  visible: boolean,
) {
  const [observed, setObserved] = useState(new Map<string, LiveFile>());
  const [selected, setSelected] = useState<string | null>(null);
  const [jump, setJump] = useState<LiveJump | null>(null);
  const [diff, setDiff] = useState<DiffTab | null>(null);
  const [rescan, setRescan] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const sequence = useRef(0);
  const currentProject = useRef(project?.id);
  currentProject.current = project?.id;

  useEffect(() => {
    setObserved(new Map());
    setSelected(null);
    setJump(null);
    setDiff(null);
    setRescan(false);
  }, [project?.id]);

  /** 事件仅作为失效通知，列表状态以 Git 或重新读取的文件元数据为准。 */
  async function record(changes: FileChanges) {
    if (!project || project.id !== changes.projectId) return;
    const id = project.id;
    const nextSequence = ++sequence.current;
    const updatedAt = Date.now();
    if (changes.rescan) setRescan(true);
    if (
      changes.rescan ||
      changes.git ||
      (selected &&
        changes.paths.some(
          (path) => path === selected || selected.startsWith(`${path}/`),
        ))
    )
      setRefresh((value) => value + 1);
    const paths = changes.paths.filter(Boolean);
    if (!paths.length) return;
    let files: FileChange[];
    if (status?.kind === 'repository') {
      files = paths.map((path) => ({
        path,
        original: null,
        kind: 'modified',
        submodule: false,
      }));
    } else {
      try {
        const affected = new Set(paths);
        for (const path of observed.keys())
          if (
            changes.rescan ||
            paths.some((parent) => path.startsWith(`${parent}/`))
          )
            affected.add(path);
        files = await backend.inspectFiles(id, [...affected]);
      } catch {
        if (currentProject.current === id) setRescan(true);
        return;
      }
    }
    if (currentProject.current !== id) return;
    setObserved((previous) => {
      const next = new Map(previous);
      for (const file of files) {
        if (file.kind === 'deleted' && !previous.has(file.path)) continue;
        if ((next.get(file.path)?.sequence ?? 0) > nextSequence) continue;
        next.delete(file.path);
        next.set(file.path, { ...file, sequence: nextSequence, updatedAt });
      }
      while (next.size > MAX_FILES) next.delete(next.keys().next().value!);
      return next;
    });
  }

  const files = useMemo<LiveFile[]>(() => {
    const entries =
      status?.kind === 'repository'
        ? status.files.map((file) => ({
            ...file,
            sequence: observed.get(file.path)?.sequence ?? 0,
            updatedAt: observed.get(file.path)?.updatedAt ?? null,
          }))
        : [...observed.values()];
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }, [status, observed]);
  const latest = files.reduce<LiveFile | null>(
    // 同批事件没有可靠的写入先后，优先留在当前文件，避免路径排序改变时来回跳转。
    (result, file) =>
      !result ||
      file.sequence > result.sequence ||
      (file.sequence === result.sequence && file.path === selected)
        ? file
        : result,
    null,
  );

  useEffect(() => {
    if (visible && !selected && files.length) setSelected(files[0].path);
  }, [visible, files, selected]);

  const file = files.find((entry) => entry.path === selected);
  const original = file?.original ?? null;
  const repository = status?.kind === 'repository';
  const sourceVersion = useRef(0);
  const selectedSequence = selected
    ? observed.get(selected)?.sequence
    : undefined;
  useEffect(() => {
    sourceVersion.current++;
  }, [status, selectedSequence, refresh]);

  // 每个预览串行读取；连续事件只标记待更新，避免并发读取的旧结果覆盖新结果。
  useEffect(() => {
    if (!project || !visible || !selected) return;
    let disposed = false;
    let running = false;
    let loadedVersion = -1;
    const id = project.id;
    const path = selected;
    // 目标文件读取完成前保留上一个预览，不用加载画面替换代码区。
    async function load() {
      if (running || disposed || loadedVersion === sourceVersion.current)
        return;
      running = true;
      const version = sourceVersion.current;
      try {
        const sources = repository
          ? await backend.gitDiff(id, path, original)
          : await backend
              .readFile(id, path)
              .then((document) => ({
                base: { kind: 'missing' as const },
                current:
                  document.truncated || document.size > 5 * 1024 * 1024
                    ? { kind: 'tooLarge' as const }
                    : { kind: 'text' as const, content: document.content },
              }))
              .catch((error: unknown) => {
                if (errorCode(error) === 'NOT_FOUND')
                  return {
                    base: { kind: 'missing' as const },
                    current: { kind: 'missing' as const },
                  };
                throw error;
              });
        if (!disposed && currentProject.current === id)
          setDiff((previous) => {
            if (
              previous?.path === path &&
              !previous.error &&
              JSON.stringify(previous.sources) === JSON.stringify(sources)
            )
              return previous;
            return {
              key: path,
              path,
              original,
              sources,
              error: null,
              version: (previous?.version ?? 0) + 1,
              commit: null,
            };
          });
      } catch (error) {
        if (!disposed && currentProject.current === id)
          setDiff({
            key: path,
            path,
            original,
            sources: null,
            error: errorMessage(error),
            version,
            commit: null,
          });
      } finally {
        loadedVersion = version;
        running = false;
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 200);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [project?.id, visible, selected, original, repository]);

  return {
    files,
    selected,
    /** 打开面板后观测到过变化时才能跳到最新。 */
    canJump: Boolean(latest?.sequence),
    jump,
    diff,
    displayed: diff?.path ?? selected,
    loading: selected !== null && diff?.path !== selected,
    preview: !repository,
    rescan,
    record,
    select(path: string) {
      // 手动选择后作废尚未执行的跳转，避免之后回到该文件时意外定位。
      setJump(null);
      setSelected(path);
    },
    /** 选中最近变化的文件并定位写入位置，之后不再自动切换。 */
    jumpToLatest() {
      if (!latest?.sequence) return;
      setSelected(latest.path);
      setJump((previous) => ({
        path: latest.path,
        key: (previous?.key ?? 0) + 1,
      }));
    },
  };
}
