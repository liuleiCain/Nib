import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { EditorState } from '@codemirror/state';
import { Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { redo, undo } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsLeftRight,
  Command,
  Ellipsis,
  FileCode2,
  Files,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitCompare,
  Keyboard,
  LoaderCircle,
  PanelLeft,
  PenLine,
  RotateCw,
  Save,
  Search,
  Settings2,
  Trash2,
  Undo2,
  WrapText,
  X,
} from 'lucide-react';
import type {
  ChangeKind,
  FileChange,
  FileChanges,
  GitStatus,
  Project,
  ProjectTabs,
  RecentProject,
} from '../lib/backend';
import { backend, desktop, errorCode, errorMessage } from '../lib/backend';
import { Editor } from '../features/editor/Editor';
import type { Tab } from '../features/editor/model';
import {
  createTab,
  diffChange,
  encode,
  formatSize,
  isDirty,
  languageName,
  serialize,
} from '../features/editor/model';
import type {
  TreeChanges,
  TreeReveal,
  TreeTarget,
} from '../features/explorer/Explorer';
import { Explorer } from '../features/explorer/Explorer';
import type { MenuItem, TreeShortcut } from '../features/explorer/ContextMenu';
import { ContextMenu } from '../features/explorer/ContextMenu';
import type { NameRequest } from '../features/explorer/NameDialog';
import { NameDialog } from '../features/explorer/NameDialog';
import { ProjectMenu, RecentList } from '../features/projects/ProjectMenu';
import { CommitPanel } from '../features/git/CommitPanel';
import type { DiffTab } from '../features/git/DiffView';
import { DiffView } from '../features/git/DiffView';
import { setHeadDoc } from '../features/git/changes';
import { Text } from '@codemirror/state';

type Decision = 'save' | 'discard' | 'cancel';
/**
 * unsaved：未保存内容的保存/放弃确认；其余为单一操作的确认，确认时返回 save：
 * restore 恢复已删除文件、rollback 回滚变更、delete 移到废纸篓。
 */
type PromptKind = 'unsaved' | 'restore' | 'rollback' | 'delete';
interface Prompt {
  kind: PromptKind;
  paths: string[];
  /** 附加的风险说明。 */
  note?: string;
  resolve: (decision: Decision) => void;
}

/** 单一操作确认框的文字。 */
const confirmations: Record<
  Exclude<PromptKind, 'unsaved'>,
  { title: string; description: string; confirm: string }
> = {
  restore: {
    title: '恢复已删除的文件？',
    description:
      '将从 HEAD 恢复以下文件（git checkout HEAD -- 路径），该文件的暂存状态也会恢复为 HEAD。不会覆盖任何现有文件。',
    confirm: '恢复文件',
  },
  rollback: {
    title: '回滚以下变更？',
    description: '回滚后暂存区和工作区都恢复为 HEAD 版本。',
    confirm: '回滚',
  },
  delete: {
    title: '移到废纸篓？',
    description: '以下文件或目录将移到系统废纸篓，可从废纸篓找回。',
    confirm: '移到废纸篓',
  },
};
interface PaletteCommand {
  label: string;
  detail: string;
  action: () => void;
  disabled?: boolean;
}

const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const mod = mac ? '⌘' : 'Ctrl';
const baseName = (path: string) => path.split('/').pop() ?? path;
/** 停止输入后自动保存的等待时间。 */
const AUTO_SAVE_DELAY = 1000;
/** 文件变化后刷新 Git 状态的等待时间；连续写入只刷新一次。 */
const GIT_REFRESH_DELAY = 400;
/** Diff 标签的标识前缀，与文件标签共用一个标签栏；文件路径不会含 NUL，不会与文件标签冲突。 */
const DIFF_PREFIX = '\0diff/';

/** 主窗口协调工作区、编辑状态和用户确认，磁盘操作统一交给后台。 */
export function App() {
  const [project, setProject] = useState<Project | null>(null);
  const projectRef = useRef<Project | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const tabsRef = useRef<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [saving, setSaving] = useState(new Set<string>());
  const saves = useRef(new Map<string, Promise<boolean>>());
  const pendingFiles = useRef(new Set<string>());
  const desiredFile = useRef<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const promptRef = useRef<Prompt | null>(null);
  const [sidebar, setSidebar] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(248);
  const [wrap, setWrap] = useState(false);
  const [fontSize, setFontSize] = useState(13);
  const [palette, setPalette] = useState(false);
  const [query, setQuery] = useState('');
  const [commandIndex, setCommandIndex] = useState(0);
  const [settings, setSettings] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [projectMenu, setProjectMenu] = useState(false);
  const restoring = useRef(false);
  const started = useRef(false);
  const [autoSave, setAutoSave] = useState(true);
  const autoSaveRef = useRef(true);
  const autoSaveTimer = useRef<number | null>(null);
  const [treeChanges, setTreeChanges] = useState<TreeChanges>({
    key: 0,
    paths: null,
  });
  // 正在与磁盘同步的标签，及同步期间又收到变化需重读的标签。
  const syncing = useRef(new Set<string>());
  const resync = useRef(new Set<string>());
  const applyingDisk = useRef(false);
  const viewRef = useRef<EditorView | null>(null);
  const paletteRef = useRef<HTMLInputElement>(null);
  // Git：侧边栏视图、仓库状态、勾选的文件、提交信息与 Diff 标签。
  const [panel, setPanel] = useState<'files' | 'commit'>('files');
  const [git, setGit] = useState<GitStatus | null>(null);
  const gitRef = useRef<GitStatus | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const gitRequest = useRef(0);
  const gitTimer = useRef<number | null>(null);
  // 等待刷新的变化文件；null 表示整体变化。
  const pendingGitPaths = useRef<string[] | null>([]);
  const [checked, setChecked] = useState(new Set<string>());
  // 用户手动勾选或取消的文件；其余按默认：已跟踪的变更勾选，未跟踪文件不勾选，与 GoLand 一致。
  const choices = useRef(new Map<string, boolean>());
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const commitInput = useRef<HTMLTextAreaElement>(null);
  const [diffs, setDiffs] = useState<DiffTab[]>([]);
  const diffsRef = useRef<DiffTab[]>([]);
  const [unified, setUnified] = useState(false);
  // 文件树右键菜单、名称输入框，以及新建后需要展开的目录。
  const [menu, setMenu] = useState<{
    items: () => MenuItem[];
    /** 文件树中高亮的条目。 */
    marked: string | null;
    x: number;
    y: number;
  } | null>(null);
  const [naming, setNamingState] = useState<NameRequest | null>(null);
  const namingRef = useRef<NameRequest | null>(null);
  const [treeReveal, setTreeReveal] = useState<TreeReveal>({
    key: 0,
    path: '',
  });
  const selected = tabs.find((tab) => tab.path === active);
  const selectedDiff = active?.startsWith(DIFF_PREFIX)
    ? diffs.find((diff) => DIFF_PREFIX + diff.path === active)
    : undefined;
  const dirtyCount = tabs.filter(isDirty).length;
  const repository = git?.kind === 'repository' ? git : null;
  const gitKinds = new Map<string, ChangeKind>(
    repository?.files.map((file) => [file.path, file.kind]) ?? [],
  );
  const gitDirs = new Set<string>();
  for (const file of repository?.files ?? [])
    if (file.kind !== 'untracked')
      for (
        let slash = file.path.lastIndexOf('/');
        slash > 0;
        slash = file.path.lastIndexOf('/', slash - 1)
      )
        gitDirs.add(file.path.slice(0, slash));
  const operations = useRef({
    openProject: () => {},
    newWindow: () => {},
    save: () => {},
    close: () => {},
    palette: () => {},
    autoSave: () => {},
    filesChanged: (_changes: FileChanges) => {},
    commitPanel: () => {},
    gitRefresh: () => {},
    addToVcs: () => {},
  });

  function updateTabs(next: Tab[]) {
    tabsRef.current = next;
    setTabs([...next]);
  }
  function activate(path: string | null) {
    activeRef.current = path;
    setActive(path);
  }
  function notify(text: string, error = true) {
    setNotice({ text, error });
  }

  function ask(
    paths: string[],
    kind: PromptKind = 'unsaved',
    note?: string,
  ): Promise<Decision> {
    if (promptRef.current) return Promise.resolve('cancel');
    return new Promise((resolve) => {
      const next = { kind, paths, note, resolve };
      promptRef.current = next;
      setPrompt(next);
    });
  }

  function decide(decision: Decision) {
    const current = promptRef.current;
    promptRef.current = null;
    setPrompt(null);
    current?.resolve(decision);
  }

  /** 保存标签；自动保存不弹成功提示，失败后暂停该标签的自动保存直到手动保存或重新加载。 */
  async function saveTab(tab: Tab, auto = false): Promise<boolean> {
    const existing = saves.current.get(tab.path);
    if (existing) return existing;
    const workspace = projectRef.current;
    if (!workspace) return false;
    if (!isDirty(tab)) return true;
    const snapshot = tab.state.doc;
    const promise = (async () => {
      setSaving((previous) => new Set(previous).add(tab.path));
      try {
        const revision = await backend.saveFile(
          workspace.id,
          tab.path,
          serialize(tab),
          tab.revision,
        );
        if (projectRef.current?.id !== workspace.id) return false;
        tab.revision = revision;
        tab.savedDoc = snapshot;
        tab.paused = false;
        updateTabs(tabsRef.current);
        if (!auto) notify(`已保存 ${baseName(tab.path)}`, false);
        return true;
      } catch (error) {
        if (projectRef.current?.id !== workspace.id) return false;
        tab.paused = true;
        updateTabs(tabsRef.current);
        notify(
          `${baseName(tab.path)}：${errorMessage(error)}${auto ? ' 已暂停该文件的自动保存。' : ''}`,
        );
        return false;
      } finally {
        saves.current.delete(tab.path);
        setSaving((previous) => {
          const next = new Set(previous);
          next.delete(tab.path);
          return next;
        });
      }
    })();
    saves.current.set(tab.path, promise);
    return promise;
  }

  async function mayDiscard(candidates: Tab[]): Promise<boolean> {
    for (const tab of candidates) {
      const pending = saves.current.get(tab.path);
      if (pending && !(await pending)) return false;
    }
    // 开启自动保存时先静默保存，只有暂停或保存失败的文件才需要用户确认。
    if (autoSaveRef.current)
      for (const tab of candidates)
        if (isDirty(tab) && !tab.paused) await saveTab(tab, true);
    const dirty = candidates.filter(isDirty);
    if (!dirty.length) return true;
    const decision = await ask(dirty.map((tab) => tab.path));
    if (decision === 'cancel') return false;
    if (decision === 'discard') return true;
    for (const tab of dirty) if (!(await saveTab(tab))) return false;
    // 原生对话框等异步操作期间仍可能有编辑，不能关闭新修改。
    return candidates.every((tab) => !isDirty(tab));
  }

  /** 停止输入后自动保存；暂停的、冲突的或正在同步的标签跳过。 */
  function autoSaveAll() {
    if (!autoSaveRef.current || promptRef.current) return;
    for (const tab of tabsRef.current)
      if (isDirty(tab) && !tab.paused && !syncing.current.has(tab.path))
        void saveTab(tab, true);
  }

  function scheduleAutoSave() {
    if (autoSaveTimer.current !== null)
      window.clearTimeout(autoSaveTimer.current);
    if (!autoSaveRef.current) return;
    autoSaveTimer.current = window.setTimeout(() => {
      autoSaveTimer.current = null;
      autoSaveAll();
    }, AUTO_SAVE_DELAY);
  }

  /**
   * 外部修改后让标签与磁盘一致。
   *
   * 无未保存编辑时就地替换为磁盘内容，保留光标、滚动和撤销历史；有未保存编辑且磁盘也变化时
   * 标记冲突并暂停自动保存，由用户选择重新加载或手动保存（保存仍会因版本冲突停止，不覆盖外部修改）。
   */
  async function syncTab(path: string) {
    const workspace = projectRef.current;
    if (!workspace) return;
    // 正在保存或同步时先排队，完成后再读一次，避免读到自己写入一半的结果。
    if (syncing.current.has(path) || saves.current.has(path)) {
      resync.current.add(path);
      const pending = saves.current.get(path);
      if (pending)
        void pending.then(() => {
          if (resync.current.delete(path)) void syncTab(path);
        });
      return;
    }
    syncing.current.add(path);
    try {
      const document = await backend.readFile(workspace.id, path);
      const tab = tabsRef.current.find((item) => item.path === path);
      if (!tab || projectRef.current?.id !== workspace.id) return;
      // 自己保存产生的事件：磁盘版本未变，无需处理。
      if (document.revision === tab.revision) {
        if (tab.paused && !isDirty(tab)) {
          tab.paused = false;
          updateTabs(tabsRef.current);
        }
        return;
      }
      if (isDirty(tab)) {
        // 编辑内容恰好与磁盘一致，直接接受新版本。
        if (tab.state.doc.toString() === document.content) {
          tab.revision = document.revision;
          tab.savedDoc = tab.state.doc;
          tab.paused = false;
          updateTabs(tabsRef.current);
          return;
        }
        if (!tab.paused) {
          tab.paused = true;
          updateTabs(tabsRef.current);
          notify(
            `${baseName(path)} 已被外部修改，与未保存的编辑冲突。已暂停自动保存，可重新加载磁盘版本。`,
          );
        }
        return;
      }
      // 文件跨过可编辑上限时只读状态改变，重新建立标签状态。
      if (document.truncated !== tab.truncated) {
        const replacement = await createTab(path, document);
        replacement.scroll = tab.scroll;
        if (projectRef.current?.id !== workspace.id) return;
        updateTabs(
          tabsRef.current.map((item) => (item === tab ? replacement : item)),
        );
        void loadHead(path);
        return;
      }
      applyDisk(tab, document);
    } catch (error) {
      const tab = tabsRef.current.find((item) => item.path === path);
      if (!tab || projectRef.current?.id !== workspace.id) return;
      const missing = errorCode(error) === 'NOT_FOUND';
      // 与 GoLand 一致：文件被删除（如切换分支、git rm）后，没有未保存编辑的标签直接关闭。
      if (missing && !isDirty(tab)) {
        removeTabs(new Set([path]));
        return;
      }
      // 有未保存编辑，或文件改为不可编辑：保留编辑内容，暂停自动保存，避免重新写回。
      if (!tab.paused) {
        tab.paused = true;
        updateTabs(tabsRef.current);
        notify(
          missing
            ? `${baseName(path)} 已从磁盘删除，未保存的编辑仍保留在标签中，已暂停自动保存。可复制所需内容，或恢复文件后手动保存。`
            : `${baseName(path)}：${errorMessage(error)} 已暂停该文件的自动保存。`,
        );
      }
    } finally {
      syncing.current.delete(path);
      if (resync.current.delete(path)) void syncTab(path);
    }
  }

  /** 用磁盘内容就地更新干净标签；当前标签通过视图更新，非当前标签直接更新状态。 */
  function applyDisk(
    tab: Tab,
    document: Awaited<ReturnType<typeof backend.readFile>>,
  ) {
    const change = diffChange(tab.state.doc, document.content);
    const view = viewRef.current;
    if (change) {
      // 外部写入不进入撤销历史，避免撤销时把 AI 写入的内容退回。
      const spec = {
        changes: change,
        annotations: Transaction.addToHistory.of(false),
      };
      if (view && activeRef.current === tab.path && view.state === tab.state) {
        // 标记为磁盘同步，editorChange 不会因此触发自动保存。
        applyingDisk.current = true;
        try {
          view.dispatch(spec);
        } finally {
          applyingDisk.current = false;
        }
        tab.state = view.state;
      } else {
        tab.state = tab.state.update(spec).state;
      }
    }
    tab.savedDoc = tab.state.doc;
    tab.revision = document.revision;
    tab.newline = document.newline;
    tab.hasBom = document.hasBom;
    tab.paused = false;
    updateTabs(tabsRef.current);
  }

  /** 后台推送一批文件变化：刷新文件树、同步受影响的已打开标签，并刷新 Git 状态。 */
  function filesChanged(changes: FileChanges) {
    const workspace = projectRef.current;
    if (!workspace || changes.projectId !== workspace.id) return;
    if (changes.rescan || changes.paths.length)
      setTreeChanges((previous) => ({
        key: previous.key + 1,
        paths: changes.rescan ? null : changes.paths,
      }));
    const changed = new Set(changes.paths);
    for (const tab of tabsRef.current)
      if (changes.rescan || changed.has(tab.path)) void syncTab(tab.path);
    scheduleGitRefresh(changes.git || changes.rescan ? null : changes.paths);
  }

  /**
   * 刷新 Git 状态。只处理最新一次请求的结果，项目切换后丢弃迟到的响应。
   *
   * changed 为本次变化的文件；为空表示 HEAD、索引等整体变化，需重新读取所有已打开标签的 HEAD 版本。
   */
  async function refreshGit(changed: string[] | null = null) {
    const workspace = projectRef.current;
    if (!desktop || !workspace) return;
    const request = ++gitRequest.current;
    setGitLoading(true);
    try {
      const next = await backend.gitStatus(workspace.id);
      if (
        request !== gitRequest.current ||
        projectRef.current?.id !== workspace.id
      )
        return;
      const previous = gitRef.current;
      gitRef.current = next;
      setGit(next);
      setGitError(null);
      syncChecked(next);
      // HEAD 改变（提交、切换分支）后全部重读；否则只重读状态类型变化的文件（如新文件被加入版本库）。
      const kinds = (status: GitStatus | null) =>
        new Map(
          status?.kind === 'repository'
            ? status.files.map((file) => [file.path, file.kind])
            : [],
        );
      const before = kinds(previous);
      const after = kinds(next);
      const headChanged =
        previous?.kind !== next.kind ||
        (previous?.kind === 'repository' &&
          next.kind === 'repository' &&
          previous.head !== next.head);
      for (const tab of tabsRef.current)
        if (headChanged || before.get(tab.path) !== after.get(tab.path))
          void loadHead(tab.path);
      refreshDiffs(changed);
    } catch (error) {
      if (
        request === gitRequest.current &&
        projectRef.current?.id === workspace.id
      )
        setGitError(errorMessage(error));
    } finally {
      if (request === gitRequest.current) setGitLoading(false);
    }
  }

  function scheduleGitRefresh(changed: string[] | null) {
    pendingGitPaths.current =
      changed === null || pendingGitPaths.current === null
        ? null
        : [...pendingGitPaths.current, ...changed];
    if (gitTimer.current !== null) window.clearTimeout(gitTimer.current);
    gitTimer.current = window.setTimeout(() => {
      gitTimer.current = null;
      const paths = pendingGitPaths.current;
      pendingGitPaths.current = [];
      void refreshGit(paths);
    }, GIT_REFRESH_DELAY);
  }

  /** 按用户的选择和默认规则重算勾选；已消失的变更移出。 */
  function syncChecked(next: GitStatus) {
    const files = next.kind === 'repository' ? next.files : [];
    const paths = new Set(files.map((file) => file.path));
    for (const path of choices.current.keys())
      if (!paths.has(path)) choices.current.delete(path);
    setChecked(
      new Set(
        files
          .filter(
            (file) =>
              choices.current.get(file.path) ?? file.kind !== 'untracked',
          )
          .map((file) => file.path),
      ),
    );
  }

  function check(paths: string[], value: boolean) {
    for (const path of paths) choices.current.set(path, value);
    setChecked((previous) => {
      const next = new Set(previous);
      for (const path of paths) {
        if (value) next.add(path);
        else next.delete(path);
      }
      return next;
    });
  }

  /**
   * 读取标签的 HEAD 版本，供行号旁标记比较。
   *
   * HEAD 中没有该文件时：已加入版本库的新文件整篇标为新增；未跟踪或被忽略的文件不显示标记。
   */
  async function loadHead(path: string) {
    const workspace = projectRef.current;
    const status = gitRef.current;
    if (!workspace || path.startsWith(DIFF_PREFIX)) return;
    let head: Text | null = null;
    if (status?.kind === 'repository') {
      const change = status.files.find((file) => file.path === path);
      try {
        const side = await backend.gitHeadFile(
          workspace.id,
          change?.original ?? path,
        );
        if (side.kind === 'text') head = Text.of(side.content.split('\n'));
        else if (side.kind === 'missing' && change?.kind === 'added')
          head = Text.empty;
      } catch {
        head = null;
      }
    }
    if (projectRef.current?.id !== workspace.id) return;
    const tab = tabsRef.current.find((item) => item.path === path);
    if (!tab) return;
    const effect = { effects: setHeadDoc.of(head) };
    const view = viewRef.current;
    if (view && activeRef.current === path && view.state === tab.state) {
      view.dispatch(effect);
      tab.state = view.state;
    } else tab.state = tab.state.update(effect).state;
    updateTabs(tabsRef.current);
  }

  function updateDiffs(next: DiffTab[]) {
    diffsRef.current = next;
    setDiffs(next);
  }

  /** 读取 Diff 内容；只更新仍打开的同一 Diff 标签。 */
  async function loadDiff(path: string, original: string | null) {
    const workspace = projectRef.current;
    if (!workspace) return;
    try {
      const sources = await backend.gitDiff(workspace.id, path, original);
      if (projectRef.current?.id !== workspace.id) return;
      // 内容未变化时保持视图，不打断滚动位置。
      const text = JSON.stringify(sources);
      updateDiffs(
        diffsRef.current.map((diff) =>
          diff.path !== path
            ? diff
            : !diff.error && JSON.stringify(diff.sources) === text
              ? diff
              : { ...diff, sources, error: null, version: diff.version + 1 },
        ),
      );
    } catch (error) {
      if (projectRef.current?.id !== workspace.id) return;
      updateDiffs(
        diffsRef.current.map((diff) =>
          diff.path === path ? { ...diff, error: errorMessage(error) } : diff,
        ),
      );
    }
  }

  /** 在主区打开或切换到文件的 Diff 标签。 */
  function openDiff(change: FileChange) {
    if (busyRef.current || promptRef.current) return;
    const existing = diffsRef.current.find((diff) => diff.path === change.path);
    if (!existing)
      updateDiffs([
        ...diffsRef.current,
        {
          path: change.path,
          original: change.original,
          sources: null,
          error: null,
          version: 0,
        },
      ]);
    activate(DIFF_PREFIX + change.path);
    setOpening(null);
    void loadDiff(change.path, change.original);
  }

  /**
   * 在 Diff 中回滚一处变更并写回文件；before、after 为回滚前后的工作区全文。
   *
   * 文件已打开时改动标签再保存，可在编辑器中撤销；未打开时按磁盘版本直接保存。
   * 工作区内容与 Diff 不一致（未保存编辑、外部修改）时拒绝，避免覆盖其他改动。
   */
  async function revertChunk(
    path: string,
    before: string,
    after: string,
  ): Promise<boolean> {
    const workspace = projectRef.current;
    const name = baseName(path);
    if (!workspace) return false;
    if (busyRef.current || promptRef.current) {
      notify(`正在进行其他操作，${name} 未回滚。`);
      return false;
    }
    const tab = tabsRef.current.find((item) => item.path === path);
    if (tab) {
      if (saves.current.has(path) || syncing.current.has(path)) {
        notify(`${name} 正在保存或同步，请稍后再回滚。`);
        return false;
      }
      if (isDirty(tab)) {
        notify(`${name} 有未保存的编辑，请先保存后再回滚。`);
        return false;
      }
      if (tab.state.doc.toString() !== before) {
        notify(`${name} 已在磁盘上变化，请等待 Diff 刷新后再回滚。`);
        return false;
      }
      const change = diffChange(tab.state.doc, after);
      if (change) {
        const spec = { changes: change, userEvent: 'input.revert' };
        const view = viewRef.current;
        if (view && activeRef.current === path && view.state === tab.state) {
          view.dispatch(spec);
          tab.state = view.state;
        } else tab.state = tab.state.update(spec).state;
        updateTabs(tabsRef.current);
      }
      return saveTab(tab, true);
    }
    try {
      const document = await backend.readFile(workspace.id, path);
      if (projectRef.current?.id !== workspace.id) return false;
      if (document.truncated || document.content !== before) {
        notify(`${name} 已在磁盘上变化，请等待 Diff 刷新后再回滚。`);
        return false;
      }
      await backend.saveFile(
        workspace.id,
        path,
        encode(after, document.newline, document.hasBom),
        document.revision,
      );
      return true;
    } catch (error) {
      if (projectRef.current?.id === workspace.id)
        notify(`${name}：${errorMessage(error)}`);
      return false;
    }
  }

  /** 文件或 HEAD 变化后刷新已打开的 Diff；变更已消失的文件保持当前内容。 */
  function refreshDiffs(changed: string[] | null) {
    const status = gitRef.current;
    for (const diff of diffsRef.current) {
      if (changed && !changed.includes(diff.path)) continue;
      const change =
        status?.kind === 'repository'
          ? status.files.find((file) => file.path === diff.path)
          : undefined;
      void loadDiff(diff.path, change?.original ?? diff.original);
    }
  }

  function closeDiff(path: string) {
    const old = diffsRef.current;
    const next = old.filter((diff) => diff.path !== path);
    if (activeRef.current === DIFF_PREFIX + path) {
      const index = old.findIndex((diff) => diff.path === path);
      const neighbour = next[Math.min(index, next.length - 1)];
      activate(
        neighbour
          ? DIFF_PREFIX + neighbour.path
          : (tabsRef.current[tabsRef.current.length - 1]?.path ?? null),
      );
    }
    updateDiffs(next);
  }

  /**
   * 确认后从 HEAD 恢复已删除的文件，与 GoLand 的 Rollback 一致。
   * 后台持锁后会再次确认文件不存在，不会覆盖现有内容。
   */
  async function restoreFile(path: string) {
    const workspace = projectRef.current;
    if (!workspace || busyRef.current || promptRef.current) return;
    if ((await ask([path], 'restore')) !== 'save') return;
    if (projectRef.current?.id !== workspace.id || busyRef.current) return;
    busyRef.current = true;
    setBusy('恢复文件');
    try {
      await backend.gitRestore(workspace.id, path);
      if (projectRef.current?.id === workspace.id)
        notify(`已从 HEAD 恢复 ${baseName(path)}`, false);
    } catch (error) {
      if (projectRef.current?.id === workspace.id)
        notify(`恢复失败：${errorMessage(error)}`);
    } finally {
      busyRef.current = false;
      setBusy(null);
      if (projectRef.current?.id === workspace.id) void refreshGit(null);
    }
  }

  /**
   * 将未跟踪文件加入版本控制（git add），与 GoLand 的“添加到 VCS”一致；只登记，不提交。
   * 加入后文件变为新增，默认勾选；内容仍以提交时的工作区为准。
   */
  async function addToVcs(paths: string[]) {
    const workspace = projectRef.current;
    if (!workspace || !paths.length || busyRef.current || promptRef.current)
      return;
    busyRef.current = true;
    setBusy('加入版本控制');
    try {
      await backend.gitAdd(workspace.id, paths);
      if (projectRef.current?.id === workspace.id)
        notify(
          paths.length === 1
            ? `已将 ${baseName(paths[0])} 加入版本控制`
            : `已将 ${paths.length} 个文件加入版本控制`,
          false,
        );
    } catch (error) {
      if (projectRef.current?.id === workspace.id)
        notify(`加入版本控制失败：${errorMessage(error)}`);
    } finally {
      busyRef.current = false;
      setBusy(null);
      if (projectRef.current?.id === workspace.id) void refreshGit(null);
    }
  }

  /** 当前编辑器中的文件未跟踪时加入版本控制。 */
  function addCurrentToVcs() {
    const path = activeRef.current;
    const status = gitRef.current;
    if (!path || status?.kind !== 'repository') return;
    if (
      status.files.some(
        (file) => file.path === path && file.kind === 'untracked',
      )
    )
      void addToVcs([path]);
  }

  function closeMenu() {
    setMenu(null);
  }

  function setNaming(request: NameRequest | null) {
    namingRef.current = request;
    setNamingState(request);
  }

  /** 项目内的路径前缀判断：path 等于 base，或位于 base 目录之内。 */
  function within(path: string, base: string) {
    return base === '' || path === base || path.startsWith(`${base}/`);
  }

  /** 目标下（目录含其中所有文件）的 Git 变更；未跟踪与其他变更分开。 */
  function changesUnder(target: TreeTarget) {
    const files =
      gitRef.current?.kind === 'repository'
        ? gitRef.current.files.filter((file) =>
            target.isDir
              ? within(file.path, target.path)
              : file.path === target.path,
          )
        : [];
    return {
      changed: files.filter((file) => file.kind !== 'untracked'),
      untracked: files.filter((file) => file.kind === 'untracked'),
    };
  }

  /** 右键菜单与快捷键共用的前置检查：没有进行中的操作和确认框。 */
  function idle() {
    return (
      Boolean(projectRef.current) &&
      !busyRef.current &&
      !promptRef.current &&
      !namingRef.current
    );
  }

  /**
   * 暂停这些标签的磁盘同步和自动保存，直到 release；改名、删除、回滚期间
   * 监听事件可能先于命令结果到达，避免把标签误判为被删除或冲突。
   */
  function hold(paths: string[]) {
    for (const path of paths) syncing.current.add(path);
    return () => {
      for (const path of paths) {
        syncing.current.delete(path);
        resync.current.delete(path);
      }
    };
  }

  /**
   * 在后台执行文件或 Git 写操作，期间锁定界面；完成后刷新文件树和 Git 状态。
   * held 中的标签在操作期间暂停同步，成功时返回 true。
   */
  async function runEntryAction(
    label: string,
    action: (projectId: number) => Promise<string | void>,
    held: string[] = [],
  ): Promise<boolean> {
    const workspace = projectRef.current;
    if (!workspace || !idle()) return false;
    busyRef.current = true;
    setBusy(label);
    const release = hold(held);
    try {
      const message = await action(workspace.id);
      if (projectRef.current?.id !== workspace.id) return false;
      if (message) notify(message, false);
      return true;
    } catch (error) {
      if (projectRef.current?.id === workspace.id)
        notify(`${label}失败：${errorMessage(error)}`);
      return false;
    } finally {
      release();
      busyRef.current = false;
      setBusy(null);
      if (projectRef.current?.id === workspace.id) {
        setTreeChanges((previous) => ({ key: previous.key + 1, paths: null }));
        void refreshGit(null);
      }
    }
  }

  /** 新建文件或目录；文件建好后直接打开。 */
  function createEntry(target: TreeTarget, directory: boolean) {
    if (!idle()) return;
    const parent = target.isDir
      ? target.path
      : target.path.slice(0, Math.max(0, target.path.lastIndexOf('/')));
    setNaming({
      title: `${directory ? '新建目录' : '新建文件'}${parent ? ` · ${parent}` : ''}`,
      initial: '',
      confirm: '新建',
      submit: async (name) => {
        const workspace = projectRef.current;
        if (!workspace) return null;
        try {
          const path = await backend.createEntry(
            workspace.id,
            parent,
            name,
            directory,
          );
          if (projectRef.current?.id !== workspace.id) return null;
          setTreeChanges((previous) => ({
            key: previous.key + 1,
            paths: [path],
          }));
          setTreeReveal((previous) => ({
            key: previous.key + 1,
            path: parent,
          }));
          if (!directory) void openFile(path);
          scheduleGitRefresh(null);
          return null;
        } catch (error) {
          return errorMessage(error);
        }
      },
    });
  }

  /**
   * 重命名文件或目录；已跟踪的条目用 git mv。打开的标签和 Diff 跟随新路径，
   * 有未保存编辑的标签先保存，避免改名后写回旧路径。
   */
  function renameEntry(target: TreeTarget) {
    if (!idle() || !target.path) return;
    const affected = tabsRef.current.filter((tab) =>
      within(tab.path, target.path),
    );
    setNaming({
      title: target.isDir ? '重命名目录' : '重命名文件',
      initial: baseName(target.path),
      confirm: '重命名',
      submit: async (name) => {
        const workspace = projectRef.current;
        if (!workspace) return null;
        if (name === baseName(target.path)) return null;
        for (const tab of affected)
          if (isDirty(tab) && !(await saveTab(tab)))
            return `${baseName(tab.path)} 保存失败，未重命名。`;
        if (affected.some(isDirty)) return '保存期间又有新的编辑，请稍后重试。';
        const release = hold(affected.map((tab) => tab.path));
        try {
          const path = await backend.renameEntry(
            workspace.id,
            target.path,
            name,
          );
          if (projectRef.current?.id !== workspace.id) return null;
          movePaths(target.path, path);
          setTreeChanges((previous) => ({
            key: previous.key + 1,
            paths: null,
          }));
          scheduleGitRefresh(null);
          return null;
        } catch (error) {
          return errorMessage(error);
        } finally {
          release();
        }
      },
    });
  }

  /** 改名后把打开的标签、当前标签和 Diff 标签移到新路径，保留编辑状态与撤销历史。 */
  function movePaths(from: string, to: string) {
    const rename = (path: string) =>
      within(path, from) ? to + path.slice(from.length) : path;
    for (const tab of tabsRef.current) tab.path = rename(tab.path);
    updateTabs(tabsRef.current);
    updateDiffs(
      diffsRef.current.map((diff) =>
        within(diff.path, from) ? { ...diff, path: rename(diff.path) } : diff,
      ),
    );
    const current = activeRef.current;
    if (current?.startsWith(DIFF_PREFIX))
      activate(DIFF_PREFIX + rename(current.slice(DIFF_PREFIX.length)));
    else if (current) activate(rename(current));
  }

  /** 移到废纸篓；关闭其中已打开的标签，有未保存编辑时在确认框中提示。 */
  async function deleteEntry(target: TreeTarget) {
    if (!idle() || !target.path) return;
    const affected = tabsRef.current.filter((tab) =>
      within(tab.path, target.path),
    );
    const dirty = affected.filter(isDirty).length;
    const decision = await ask(
      [target.path + (target.isDir ? '/' : '')],
      'delete',
      dirty
        ? `其中 ${dirty} 个已打开的文件有未保存的编辑，删除后这些编辑将丢失。`
        : undefined,
    );
    if (decision !== 'save') return;
    await runEntryAction(
      '移到废纸篓',
      async (projectId) => {
        await backend.trashEntry(projectId, target.path);
        if (projectRef.current?.id !== projectId) return;
        removeTabs(new Set(affected.map((tab) => tab.path)));
        for (const diff of diffsRef.current)
          if (within(diff.path, target.path)) closeDiff(diff.path);
        return `已将 ${baseName(target.path)} 移到废纸篓`;
      },
      affected.map((tab) => tab.path),
    );
  }

  /**
   * 回滚目标下的已跟踪变更，与 GoLand 的 Rollback 一致：修改与删除恢复为 HEAD，
   * 重命名恢复原路径，新增取消加入版本控制。会丢弃修改，确认框列出受影响的文件。
   */
  function rollbackEntry(target: TreeTarget) {
    return rollbackChanges(changesUnder(target).changed);
  }

  /** 回滚给定的变更；冲突和子模块不能回滚。 */
  async function rollbackChanges(changed: FileChange[]) {
    if (!idle()) return;
    const files = changed.filter(
      (file) => file.kind !== 'conflicted' && !file.submodule,
    );
    if (!files.length) {
      notify(
        changed.length
          ? '冲突文件和子模块请在终端处理。'
          : '没有可回滚的变更。',
      );
      return;
    }
    const discarding = files.filter((file) => file.kind !== 'added').length;
    const notes = [
      discarding ? `${discarding} 个文件的修改将被丢弃，无法撤销。` : '',
      files.some((file) => file.kind === 'added')
        ? '新增的文件只取消加入版本控制，文件保留。'
        : '',
      files.some((file) => file.kind === 'renamed')
        ? '重命名会恢复为原来的文件名。'
        : '',
      tabsRef.current.some(
        (tab) => isDirty(tab) && files.some((file) => file.path === tab.path),
      )
        ? '已打开文件中未保存的编辑也会丢失。'
        : '',
    ].filter(Boolean);
    const decision = await ask(
      files.map((file) =>
        file.original ? `${file.original} → ${file.path}` : file.path,
      ),
      'rollback',
      notes.join(''),
    );
    if (decision !== 'save') return;
    const reverted = files
      .filter((file) => file.kind !== 'added')
      .map((file) => file.path);
    const done = await runEntryAction(
      '回滚',
      async (projectId) => {
        await backend.gitRollback(
          projectId,
          files.map((file) => file.path),
        );
        return files.length === 1
          ? `已回滚 ${baseName(files[0].path)}`
          : `已回滚 ${files.length} 个文件`;
      },
      reverted,
    );
    if (!done) return;
    // 用户已确认丢弃：标签中的未保存编辑作废，按磁盘内容同步；重命名的新路径已移除，干净标签会关闭。
    for (const tab of tabsRef.current) {
      if (!reverted.includes(tab.path)) continue;
      tab.savedDoc = tab.state.doc;
      tab.paused = false;
      void syncTab(tab.path);
    }
    updateTabs(tabsRef.current);
  }

  /** 把目标下的未跟踪文件加入版本控制。 */
  function addEntryToVcs(target: TreeTarget) {
    const paths = changesUnder(target).untracked.map((file) => file.path);
    if (paths.length) void addToVcs(paths);
  }

  /** 把未跟踪的文件或目录写入 .gitignore。 */
  function ignoreEntry(target: TreeTarget) {
    if (!target.path) return;
    void runEntryAction('添加到 .gitignore', async (projectId) => {
      await backend.gitIgnore(projectId, [target.path]);
      return `已将 ${baseName(target.path)} 添加到 .gitignore`;
    });
  }

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify(`已复制${label}`, false);
    } catch (error) {
      notify(`复制失败：${errorMessage(error)}`);
    }
  }

  function revealEntry(target: TreeTarget) {
    const workspace = projectRef.current;
    if (!workspace) return;
    backend
      .revealEntry(workspace.id, target.path)
      .catch((error) => notify(errorMessage(error)));
  }

  /** 查看文件的 Diff；只对有变更的文件生效。 */
  function diffEntry(target: TreeTarget) {
    const change = changesUnder(target).changed.find(
      (file) => file.path === target.path,
    );
    if (change && !target.isDir) openDiff(change);
  }

  /** 提交面板中可回滚的变更：排除冲突和子模块。 */
  const revertibleOf = (files: FileChange[]) =>
    files.filter((file) => file.kind !== 'conflicted' && !file.submodule);

  /**
   * 提交面板中文件行的右键菜单，按该文件的 Git 状态生成，与 GoLand 的变更列表一致。
   * 已删除的文件不提供重命名、删除、在访达中显示。
   */
  function changeMenu(file: FileChange): MenuItem[] {
    const deleted = file.kind === 'deleted';
    const target = { path: file.path, isDir: false };
    const items: MenuItem[] = [
      {
        label: '查看变更',
        hint: mac ? '⌘D' : 'Ctrl D',
        action: () => openDiff(file),
      },
    ];
    if (!deleted)
      items.push({
        label: '打开文件',
        hint: 'F4',
        action: () => void openFile(file.path),
      });
    items.push('separator');
    if (file.kind === 'untracked') {
      items.push(
        {
          label: '加入版本控制',
          hint: mac ? '⌥⌘A' : 'Ctrl Alt A',
          action: () => void addToVcs([file.path]),
        },
        { label: '添加到 .gitignore', action: () => ignoreEntry(target) },
      );
    } else if (deleted && !file.submodule) {
      items.push({
        label: '从 HEAD 恢复…',
        action: () => void restoreFile(file.path),
      });
    } else if (revertibleOf([file]).length) {
      items.push({
        label: '回滚…',
        hint: mac ? '⌥⌘Z' : 'Ctrl Alt Z',
        danger: true,
        action: () => void rollbackChanges([file]),
      });
    }
    items.push(
      'separator',
      {
        label: '复制路径',
        action: () =>
          void copyText(`${project?.root ?? ''}/${file.path}`, '路径'),
      },
      {
        label: '复制相对路径',
        action: () => void copyText(file.path, '相对路径'),
      },
    );
    if (!deleted)
      items.push(
        {
          label: mac ? '在访达中显示' : '在文件管理器中显示',
          action: () => revealEntry(target),
        },
        'separator',
        { label: '重命名…', hint: '⇧F6', action: () => renameEntry(target) },
        {
          label: '删除…',
          hint: mac ? '⌘⌫' : 'Delete',
          danger: true,
          action: () => void deleteEntry(target),
        },
      );
    return items.filter(
      (item, index, all) =>
        item !== 'separator' ||
        (index > 0 && index < all.length - 1 && all[index - 1] !== 'separator'),
    );
  }

  /** 提交面板中分组或目录行的右键菜单：作用于其中列出的文件。 */
  function changesMenu(files: FileChange[]): MenuItem[] {
    const revertible = revertibleOf(files);
    const untracked = files.filter((file) => file.kind === 'untracked');
    const items: MenuItem[] = [];
    if (revertible.length)
      items.push({
        label: `回滚 ${revertible.length} 个变更…`,
        danger: true,
        action: () => void rollbackChanges(revertible),
      });
    if (untracked.length)
      items.push({
        label: `加入版本控制（${untracked.length} 个文件）`,
        action: () => void addToVcs(untracked.map((file) => file.path)),
      });
    items.push({
      label: '刷新',
      action: () => void refreshGit(null),
    });
    return items;
  }

  /** 提交面板中文件行的快捷键，与右键菜单的操作一致。 */
  function changeShortcut(file: FileChange, shortcut: TreeShortcut) {
    const target = { path: file.path, isDir: false };
    const deleted = file.kind === 'deleted';
    if (shortcut === 'diff') openDiff(file);
    else if (shortcut === 'open' && !deleted) void openFile(file.path);
    else if (shortcut === 'add' && file.kind === 'untracked')
      void addToVcs([file.path]);
    else if (shortcut === 'rollback' && file.kind !== 'untracked') {
      if (deleted && !file.submodule) void restoreFile(file.path);
      else void rollbackChanges([file]);
    } else if (shortcut === 'rename' && !deleted) renameEntry(target);
    else if (shortcut === 'delete' && !deleted) void deleteEntry(target);
  }

  /** 按条目类型与 Git 状态生成右键菜单，只列出当前可执行的操作。 */
  function entryMenu(target: TreeTarget): MenuItem[] {
    const root = target.path === '';
    const absolute = project
      ? `${project.root}${root ? '' : `/${target.path}`}`
      : '';
    const repository = gitRef.current?.kind === 'repository';
    const { changed, untracked } = changesUnder(target);
    const conflicted = changed.some((file) => file.kind === 'conflicted');
    const revertible = revertibleOf(changed).length > 0;
    const fileUntracked = !target.isDir && untracked.length > 0;
    // 目录下全部是未跟踪文件时整个目录可以忽略；混有已跟踪文件时写入规则无效。
    const ignorable =
      !root &&
      (fileUntracked ||
        (target.isDir && untracked.length > 0 && !changed.length));
    const items: MenuItem[] = [
      { label: '新建文件…', action: () => createEntry(target, false) },
      { label: '新建目录…', action: () => createEntry(target, true) },
      'separator',
      { label: '复制路径', action: () => void copyText(absolute, '路径') },
    ];
    if (!root)
      items.push({
        label: '复制相对路径',
        action: () => void copyText(target.path, '相对路径'),
      });
    items.push({
      label: mac ? '在访达中显示' : '在文件管理器中显示',
      action: () => revealEntry(target),
    });
    if (!root)
      items.push(
        'separator',
        { label: '重命名…', hint: '⇧F6', action: () => renameEntry(target) },
        {
          label: '删除…',
          hint: mac ? '⌘⌫' : 'Delete',
          danger: true,
          action: () => void deleteEntry(target),
        },
      );
    // 项目根目录不提供 Git 操作，避免一次回滚整个项目。
    if (repository && !root) {
      const git: MenuItem[] = [];
      if (!target.isDir && changed.length && !conflicted)
        git.push({
          label: '查看变更',
          hint: mac ? '⌘D' : 'Ctrl D',
          action: () => diffEntry(target),
        });
      if (revertible)
        git.push({
          label: target.isDir
            ? `回滚 ${revertibleOf(changed).length} 个变更…`
            : '回滚…',
          hint: target.isDir ? undefined : mac ? '⌥⌘Z' : 'Ctrl Alt Z',
          danger: true,
          action: () => void rollbackEntry(target),
        });
      if (untracked.length)
        git.push({
          label: target.isDir
            ? `加入版本控制（${untracked.length} 个文件）`
            : '加入版本控制',
          hint: target.isDir ? undefined : mac ? '⌥⌘A' : 'Ctrl Alt A',
          action: () => addEntryToVcs(target),
        });
      if (ignorable)
        git.push({
          label: '添加到 .gitignore',
          action: () => ignoreEntry(target),
        });
      if (git.length) items.push('separator', ...git);
    }
    if (root)
      items.push('separator', {
        label: '刷新',
        action: () =>
          setTreeChanges((previous) => ({
            key: previous.key + 1,
            paths: null,
          })),
      });
    return items;
  }

  /** 文件树中的快捷键。 */
  function entryShortcut(target: TreeTarget, shortcut: TreeShortcut) {
    if (shortcut === 'rename') renameEntry(target);
    else if (shortcut === 'delete') void deleteEntry(target);
    else if (shortcut === 'diff') diffEntry(target);
    else if (shortcut === 'add') addEntryToVcs(target);
    else if (shortcut === 'open' && !target.isDir) void openFile(target.path);
    else if (
      shortcut === 'rollback' &&
      target.path &&
      changesUnder(target).changed.length
    )
      void rollbackEntry(target);
  }

  /** 切到提交面板；开启自动保存时先保存编辑，让变更列表与编辑器一致。 */
  function showCommitPanel() {
    setSidebar(true);
    setPanel('commit');
    autoSaveAll();
    void refreshGit(null);
    window.setTimeout(() => commitInput.current?.focus(), 0);
  }

  /**
   * 只提交勾选的文件。提交前先保存这些文件的未保存编辑，与 GoLand 一致；
   * 保存失败时停止提交，避免提交的内容与编辑器所见不一致。
   */
  async function commit() {
    const workspace = projectRef.current;
    const status = gitRef.current;
    if (!workspace || status?.kind !== 'repository' || busyRef.current) return;
    const files = status.files.filter((file) => checked.has(file.path));
    const message = commitMessage.trim();
    if (!files.length || !message) return;
    busyRef.current = true;
    setBusy('提交');
    setCommitting(true);
    try {
      const paths = new Set(files.map((file) => file.path));
      for (const tab of tabsRef.current)
        if (paths.has(tab.path) && isDirty(tab) && !(await saveTab(tab)))
          return;
      // 重命名需要同时提交原路径，否则 Git 只会记录新增。
      const pathspecs = files.flatMap((file) =>
        file.original ? [file.path, file.original] : [file.path],
      );
      const untracked = files
        .filter((file) => file.kind === 'untracked')
        .map((file) => file.path);
      const result = await backend.gitCommit(
        workspace.id,
        message,
        pathspecs,
        untracked,
      );
      if (projectRef.current?.id !== workspace.id) return;
      setCommitMessage('');
      choices.current.clear();
      notify(`已提交 ${result.hash} · ${result.summary}`, false);
      await refreshGit(null);
    } catch (error) {
      // 失败时保留提交信息和勾选，便于修正后重试。
      notify(`提交失败：${errorMessage(error)}`);
      void refreshGit(null);
    } finally {
      busyRef.current = false;
      setBusy(null);
      setCommitting(false);
    }
  }

  function refreshRecent() {
    if (!desktop) return;
    backend
      .recentProjects()
      .then(setRecent)
      .catch((error) => notify(errorMessage(error)));
  }

  function setWindowTitle(next: Project | null) {
    void getCurrentWindow()
      .setTitle(next ? `${next.name} — Nib` : 'Nib')
      .catch((error) => notify(errorMessage(error)));
  }

  /** 记录当前项目的标签，恢复期间不覆盖上次的记录。 */
  function persistTabs() {
    const workspace = projectRef.current;
    if (!desktop || !workspace || restoring.current) return;
    backend
      .saveTabs(
        workspace.id,
        tabsRef.current.map((tab) => tab.path),
        activeRef.current?.startsWith(DIFF_PREFIX) ? null : activeRef.current,
      )
      .catch((error) => {
        if (projectRef.current?.id === workspace.id)
          notify(`标签记录保存失败：${errorMessage(error)}`);
      });
  }

  /** 按上次顺序重新读取标签；单个文件失败时跳过并汇总提示。 */
  async function restoreTabs(workspace: Project, saved: ProjectTabs) {
    if (!saved.tabs.length) return;
    restoring.current = true;
    setOpening(saved.active ?? saved.tabs[0]);
    const failed: string[] = [];
    try {
      for (const path of saved.tabs.slice(0, 30)) {
        try {
          const tab = await createTab(
            path,
            await backend.readFile(workspace.id, path),
          );
          if (projectRef.current?.id !== workspace.id) return;
          if (tabsRef.current.some((item) => item.path === path)) continue;
          updateTabs([...tabsRef.current, tab]);
          void loadHead(path);
          if (!activeRef.current || path === saved.active) activate(path);
        } catch {
          if (projectRef.current?.id !== workspace.id) return;
          failed.push(baseName(path));
        }
      }
      if (failed.length)
        notify(
          `${failed.length} 个上次打开的文件无法恢复：${failed.join('、')}`,
        );
    } finally {
      if (projectRef.current?.id === workspace.id) {
        restoring.current = false;
        setOpening(null);
        persistTabs();
      }
    }
  }

  /** 切换或关闭项目时清空上一个项目的 Git 状态和 Diff 标签。 */
  function resetGit() {
    gitRequest.current++;
    if (gitTimer.current !== null) window.clearTimeout(gitTimer.current);
    gitTimer.current = null;
    pendingGitPaths.current = [];
    gitRef.current = null;
    setGit(null);
    setGitError(null);
    setGitLoading(false);
    setChecked(new Set());
    choices.current.clear();
    setCommitMessage('');
    updateDiffs([]);
  }

  /** 在当前窗口打开项目；调用方负责处理当前项目的未保存内容。 */
  async function loadProject(path: string) {
    const result = await backend.openProject(path);
    if (result.kind === 'focused') return;
    const next = result.project;
    desiredFile.current = null;
    restoring.current = false;
    projectRef.current = next;
    setProject(next);
    resetGit();
    updateTabs([]);
    activate(null);
    setOpening(null);
    setNotice(result.warning ? { text: result.warning, error: true } : null);
    setSidebar(true);
    setWindowTitle(next);
    refreshRecent();
    void refreshGit(null);
    await restoreTabs(next, result.tabs);
  }

  /** 已有项目时在新项目标签打开，空标签直接在当前标签打开。 */
  async function openRecent(root: string, here = false) {
    if (!desktop || busyRef.current || promptRef.current) return;
    setProjectMenu(false);
    busyRef.current = true;
    setBusy('打开项目');
    try {
      if (projectRef.current && !here) {
        await backend.openProjectWindow(root);
      } else if (await mayDiscard(tabsRef.current)) {
        await loadProject(root);
      }
    } catch (error) {
      notify(errorMessage(error));
      refreshRecent();
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  async function openProject() {
    if (!desktop || busyRef.current || promptRef.current) return;
    setProjectMenu(false);
    const path = await open({
      directory: true,
      multiple: false,
      title: '选择 Nib 项目文件夹',
    }).catch((error) => {
      notify(errorMessage(error));
      return null;
    });
    if (typeof path === 'string') await openRecent(path);
  }

  async function closeProject() {
    if (!desktop || busyRef.current || promptRef.current) return;
    setProjectMenu(false);
    busyRef.current = true;
    setBusy('关闭项目');
    try {
      if (!(await mayDiscard(tabsRef.current))) return;
      await backend.closeProject();
      desiredFile.current = null;
      restoring.current = false;
      projectRef.current = null;
      setProject(null);
      resetGit();
      updateTabs([]);
      activate(null);
      setOpening(null);
      setNotice(null);
      setWindowTitle(null);
      refreshRecent();
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  function newWindow() {
    if (!desktop) return;
    setProjectMenu(false);
    backend.newWindow().catch((error) => notify(errorMessage(error)));
  }

  async function forgetProject(root: string) {
    try {
      await backend.forgetProject(root);
    } catch (error) {
      notify(errorMessage(error));
    }
    refreshRecent();
  }

  async function openFile(path: string) {
    const workspace = projectRef.current;
    if (!workspace || busyRef.current || promptRef.current) return;
    desiredFile.current = path;
    const existing = tabsRef.current.find((tab) => tab.path === path);
    if (existing) {
      activate(path);
      setOpening(null);
      return;
    }
    const key = `${workspace.id}:${path}`;
    if (pendingFiles.current.has(key)) {
      setOpening(path);
      return;
    }
    if (tabsRef.current.length + pendingFiles.current.size >= 30) {
      notify('阶段一最多打开 30 个文件，请先关闭部分标签。');
      desiredFile.current = null;
      setOpening(null);
      return;
    }
    pendingFiles.current.add(key);
    setOpening(path);
    try {
      const document = await backend.readFile(workspace.id, path);
      const tab = await createTab(path, document);
      if (projectRef.current?.id !== workspace.id) return;
      updateTabs([...tabsRef.current, tab]);
      void loadHead(path);
      if (desiredFile.current === path) activate(path);
    } catch (error) {
      if (projectRef.current?.id === workspace.id)
        notify(`${baseName(path)}：${errorMessage(error)}`);
    } finally {
      pendingFiles.current.delete(key);
      if (
        projectRef.current?.id === workspace.id &&
        desiredFile.current === path
      )
        setOpening(null);
    }
  }

  async function closeTabs(candidates: Tab[]) {
    if (busyRef.current || promptRef.current || !candidates.length) return;
    busyRef.current = true;
    setBusy('关闭文件');
    try {
      if (!(await mayDiscard(candidates))) return;
      removeTabs(new Set(candidates.map((tab) => tab.path)));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  /** 移除标签，不做未保存确认；关闭的是当前标签时切换到相邻标签或最后一个 Diff。 */
  function removeTabs(remove: Set<string>) {
    const old = tabsRef.current;
    const next = old.filter((tab) => !remove.has(tab.path));
    if (activeRef.current && remove.has(activeRef.current)) {
      const index = old.findIndex((tab) => tab.path === activeRef.current);
      activate(
        next[Math.min(index, next.length - 1)]?.path ??
          (diffsRef.current.length
            ? DIFF_PREFIX + diffsRef.current[diffsRef.current.length - 1].path
            : null),
      );
    }
    updateTabs(next);
  }

  async function reloadFile() {
    const tab = tabsRef.current.find((item) => item.path === activeRef.current);
    const workspace = projectRef.current;
    if (!tab || !workspace || busyRef.current) return;
    busyRef.current = true;
    setBusy('重新加载');
    try {
      if (!(await mayDiscard([tab]))) return;
      const replacement = await createTab(
        tab.path,
        await backend.readFile(workspace.id, tab.path),
      );
      if (workspace.id === projectRef.current?.id) {
        updateTabs(
          tabsRef.current.map((item) => (item === tab ? replacement : item)),
        );
        void loadHead(tab.path);
        notify('已重新加载磁盘版本', false);
      }
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  function editorChange(path: string, state: EditorState) {
    const tab = tabsRef.current.find((item) => item.path === path);
    if (tab) {
      const edited = !applyingDisk.current && !tab.state.doc.eq(state.doc);
      tab.state = state;
      updateTabs(tabsRef.current);
      if (edited) scheduleAutoSave();
    }
  }

  function showPalette() {
    setQuery('');
    setCommandIndex(0);
    setSettings(false);
    setPalette(true);
  }

  const commands: PaletteCommand[] = [
    {
      label: '打开文件夹',
      detail: `${mod} O`,
      action: () => void openProject(),
      disabled: !desktop,
    },
    {
      label: '新建项目标签',
      detail: `${mod} ⇧ N`,
      action: newWindow,
      disabled: !desktop,
    },
    {
      label: '最近项目',
      detail: '项目',
      action: () => {
        refreshRecent();
        setProjectMenu(true);
      },
      disabled: !desktop,
    },
    {
      label: '关闭项目',
      detail: '项目',
      action: () => void closeProject(),
      disabled: !project,
    },
    {
      label: '提交',
      detail: `${mod} K`,
      action: showCommitPanel,
      disabled: !project,
    },
    {
      label: '刷新 Git 状态',
      detail: 'Git',
      action: () => void refreshGit(null),
      disabled: !project,
    },
    {
      label: '将当前文件加入版本控制',
      detail: mac ? '⌥⌘A' : 'Ctrl Alt A',
      action: addCurrentToVcs,
      disabled: !selected || gitKinds.get(selected.path) !== 'untracked',
    },
    {
      label: '查看当前文件的变更',
      detail: 'Git Diff',
      action: () => {
        const change = repository?.files.find(
          (file) => file.path === selected?.path,
        );
        if (change) openDiff(change);
      },
      disabled: !selected || !gitKinds.has(selected.path),
    },
    {
      label: '保存当前文件',
      detail: `${mod} S`,
      action: () => {
        if (selected) void saveTab(selected);
      },
      disabled: !selected,
    },
    {
      label: '保存全部文件',
      detail: `${mod} ⇧ S`,
      action: () => {
        void (async () => {
          for (const tab of tabsRef.current)
            if (isDirty(tab) && !(await saveTab(tab))) break;
        })();
      },
      disabled: !dirtyCount,
    },
    {
      label: '在当前文件中查找 / 替换',
      detail: `${mod} F`,
      action: () => {
        if (viewRef.current) openSearchPanel(viewRef.current);
      },
      disabled: !selected,
    },
    {
      label: '撤销',
      detail: `${mod} Z`,
      action: () => {
        if (viewRef.current) undo(viewRef.current);
      },
      disabled: !selected,
    },
    {
      label: '重做',
      detail: `${mod} ⇧ Z`,
      action: () => {
        if (viewRef.current) redo(viewRef.current);
      },
      disabled: !selected,
    },
    {
      label: '重新加载磁盘版本',
      detail: '外部修改',
      action: () => void reloadFile(),
      disabled: !selected,
    },
    {
      label: '关闭当前标签页',
      detail: `${mod} W`,
      action: () => {
        if (selected) void closeTabs([selected]);
      },
      disabled: !selected,
    },
    {
      label: '关闭其他标签页',
      detail: '标签页',
      action: () =>
        void closeTabs(
          tabsRef.current.filter((tab) => tab.path !== activeRef.current),
        ),
      disabled: tabs.length < 2,
    },
    {
      label: '切换侧边栏',
      detail: `${mod} B`,
      action: () => setSidebar((value) => !value),
    },
    {
      label: '切换自动保存',
      detail: autoSave ? '已启用' : '未启用',
      action: () => setAutoSave((value) => !value),
    },
    {
      label: '切换自动换行',
      detail: wrap ? '已启用' : '未启用',
      action: () => setWrap((value) => !value),
    },
    {
      label: '编辑器显示设置',
      detail: '字体大小 / 换行',
      action: () => setSettings(true),
    },
  ];
  const filtered = commands.filter(
    (item) =>
      item.label.includes(query.trim()) ||
      item.detail.toLowerCase().includes(query.trim().toLowerCase()),
  );

  operations.current = {
    openProject: () => void openProject(),
    newWindow,
    save: () => {
      const tab = tabsRef.current.find(
        (item) => item.path === activeRef.current,
      );
      if (tab && !promptRef.current) void saveTab(tab);
    },
    close: () => {
      const current = activeRef.current;
      if (current?.startsWith(DIFF_PREFIX)) {
        closeDiff(current.slice(DIFF_PREFIX.length));
        return;
      }
      const tab = tabsRef.current.find((item) => item.path === current);
      if (tab) void closeTabs([tab]);
    },
    palette: showPalette,
    autoSave: autoSaveAll,
    filesChanged,
    commitPanel: showCommitPanel,
    gitRefresh: () => void refreshGit(null),
    addToVcs: addCurrentToVcs,
  };

  // 切换标签时自动保存离开的文件。
  const previousActive = useRef<string | null>(null);
  useEffect(() => {
    const left = previousActive.current;
    previousActive.current = active;
    if (!left || left === active || !autoSaveRef.current) return;
    const tab = tabsRef.current.find((item) => item.path === left);
    if (tab && isDirty(tab) && !tab.paused) void saveTab(tab, true);
  }, [active]);

  // 关闭自动保存时取消等待中的保存；窗口卸载时清理计时器。
  useEffect(() => {
    autoSaveRef.current = autoSave;
    if (!autoSave && autoSaveTimer.current !== null) {
      window.clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }
    if (autoSave) autoSaveAll();
  }, [autoSave]);
  useEffect(
    () => () => {
      if (autoSaveTimer.current !== null)
        window.clearTimeout(autoSaveTimer.current);
    },
    [],
  );

  // 不显示 WebView 自带的右键菜单（只有“重新加载”等无关项）；输入框和编辑器保留系统的剪切、复制、粘贴菜单。
  useEffect(() => {
    const listener = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('input, textarea, [contenteditable="true"]'))
        event.preventDefault();
    };
    window.addEventListener('contextmenu', listener);
    return () => window.removeEventListener('contextmenu', listener);
  }, []);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.isComposing || !(mac ? event.metaKey : event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (promptRef.current || namingRef.current) {
        if (['s', 'w', 'o', 'p', 'b', 'n', 'k'].includes(key))
          event.preventDefault();
        return;
      }
      if (key === 's') {
        event.preventDefault();
        if (event.shiftKey) {
          void (async () => {
            for (const tab of tabsRef.current)
              if (isDirty(tab) && !(await saveTab(tab))) break;
          })();
        } else operations.current.save();
      } else if (key === 'o') {
        event.preventDefault();
        operations.current.openProject();
      } else if (key === 'n' && event.shiftKey) {
        event.preventDefault();
        operations.current.newWindow();
      } else if (key === 'w') {
        event.preventDefault();
        operations.current.close();
      } else if (key === 'b') {
        event.preventDefault();
        setSidebar((value) => !value);
      } else if (
        event.code === 'KeyA' &&
        event.altKey &&
        !event.shiftKey &&
        // 文件树获得焦点时由文件树处理，作用于选中的条目。
        !(event.target as HTMLElement | null)?.closest?.('.file-tree')
      ) {
        // 当前文件加入版本控制，与 GoLand 的 ⌥⌘A 一致。
        event.preventDefault();
        operations.current.addToVcs();
      } else if (key === 'k' && !event.shiftKey) {
        // 打开提交面板，与 GoLand 的 ⌘K 一致。
        event.preventDefault();
        operations.current.commitPanel();
      } else if (key === 'p' && event.shiftKey) {
        event.preventDefault();
        operations.current.palette();
      } else if (['=', '+', '-'].includes(key)) {
        event.preventDefault();
        setFontSize((size) =>
          Math.max(10, Math.min(24, size + (key === '-' ? -1 : 1))),
        );
      } else if (key === '0') {
        event.preventDefault();
        setFontSize(13);
      }
    };
    window.addEventListener('keydown', listener, true);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (tabsRef.current.some(isDirty) || saves.current.size)
        event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('keydown', listener, true);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, []);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    const listeners: (() => void)[] = [];
    const requestClose = () => {
      if (disposed || busyRef.current || promptRef.current) return;
      busyRef.current = true;
      setBusy('关闭窗口');
      void (async () => {
        try {
          if (await mayDiscard(tabsRef.current))
            await getCurrentWindow().destroy();
          // 用户返回编辑时退出流程中止，已关闭的窗口不再计入下次恢复。
          else await backend.cancelQuit();
        } catch (error) {
          notify(errorMessage(error));
        } finally {
          busyRef.current = false;
          setBusy(null);
        }
      })();
    };
    for (const subscription of [
      getCurrentWindow().onCloseRequested((event) => {
        event.preventDefault();
        requestClose();
      }),
      listen('nib://request-close', requestClose),
      // 后台只把本窗口项目的文件变化发给本窗口。
      getCurrentWebviewWindow().listen<FileChanges>(
        'nib://files-changed',
        ({ payload }) => operations.current.filesChanged(payload),
      ),
      // 其他窗口可能更新了最近项目，窗口获得焦点时重新读取；失去焦点时自动保存，与 GoLand 一致。
      getCurrentWindow().onFocusChanged(({ payload }) => {
        if (payload) {
          refreshRecent();
          // 项目是仓库子目录时监听不到 .git 变化，回到窗口时补一次刷新。
          operations.current.gitRefresh();
        } else operations.current.autoSave();
      }),
    ]) {
      void subscription
        .then((stop) => {
          if (disposed) stop();
          else listeners.push(stop);
        })
        .catch((error) => notify(errorMessage(error)));
    }
    return () => {
      disposed = true;
      listeners.forEach((stop) => stop());
    };
  }, []);

  // 窗口加载后打开创建时指定的项目，开发环境重复执行副作用时只打开一次。
  useEffect(() => {
    if (!desktop || started.current) return;
    started.current = true;
    refreshRecent();
    void (async () => {
      busyRef.current = true;
      setBusy('打开项目');
      try {
        const root = await backend.windowStartup();
        if (root) await loadProject(root);
      } catch (error) {
        notify(errorMessage(error));
        refreshRecent();
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    })();
  }, []);

  // 标签增减或切换后记录当前项目的标签，编辑内容变化不触发写入。
  const tabKey = tabs.map((tab) => tab.path).join('\n');
  useEffect(() => {
    persistTabs();
  }, [project?.id, tabKey, active]);

  useEffect(() => {
    if (palette) paletteRef.current?.focus();
    if (!palette && !settings && !prompt && !projectMenu)
      viewRef.current?.focus();
  }, [palette, settings, prompt, projectMenu]);

  const selection = selected?.state.selection.main;
  const line =
    selected && selection
      ? selected.state.doc.lineAt(selection.head)
      : undefined;

  return (
    <main
      className="app"
      style={
        {
          '--sidebar-width': `${sidebarWidth}px`,
          '--editor-size': `${fontSize}px`,
        } as CSSProperties
      }
    >
      <header className="toolbar">
        <div className="brand">
          <PenLine size={19} strokeWidth={1.7} />
          <strong>Nib</strong>
        </div>
        <span className="toolbar-divider" />
        <button
          className="workspace-button"
          onClick={() => {
            refreshRecent();
            setProjectMenu((value) => !value);
          }}
          disabled={!desktop}
          title={project ? project.root : '项目'}
          aria-haspopup="dialog"
          aria-expanded={projectMenu}
        >
          <FolderOpen size={14} />
          <span>{project?.name ?? '打开项目'}</span>
          <ChevronDown size={12} />
        </button>
        <div className="toolbar-center">
          <button className="command-trigger" onClick={showPalette}>
            <Search size={13} />
            <span>搜索命令…</span>
            <kbd>{mod} ⇧ P</kbd>
          </button>
        </div>
        <button
          className="icon-button"
          onClick={() => setSidebar((value) => !value)}
          title={`切换侧边栏 (${mod}+B)`}
          aria-label="切换侧边栏"
        >
          <PanelLeft size={16} />
        </button>
        <button
          className={`icon-button ${settings ? 'active' : ''}`}
          onClick={() => setSettings((value) => !value)}
          title="显示设置"
          aria-label="显示设置"
        >
          <Settings2 size={16} />
        </button>
      </header>

      <div className="workbench">
        {sidebar && (
          <>
            <aside className="sidebar">
              <div className="sidebar-heading">
                <div
                  className="sidebar-tabs"
                  role="tablist"
                  aria-label="侧边栏"
                >
                  <button
                    role="tab"
                    aria-selected={panel === 'files'}
                    className={panel === 'files' ? 'active' : ''}
                    onClick={() => setPanel('files')}
                  >
                    <Files size={14} /> 文件
                  </button>
                  <button
                    role="tab"
                    aria-selected={panel === 'commit'}
                    className={panel === 'commit' ? 'active' : ''}
                    onClick={showCommitPanel}
                    disabled={!project}
                    title={`提交 (${mod}+K)`}
                  >
                    <GitCommitHorizontal size={14} /> 提交
                    {Boolean(repository?.files.length) && (
                      <span className="sidebar-badge">
                        {repository!.files.length}
                      </span>
                    )}
                  </button>
                </div>
                <button
                  className="icon-button"
                  title="打开文件夹"
                  aria-label="打开文件夹"
                  onClick={() => void openProject()}
                  disabled={!desktop || Boolean(busy)}
                >
                  <FolderOpen size={15} />
                </button>
              </div>
              {project && panel === 'commit' ? (
                <CommitPanel
                  status={git}
                  loading={gitLoading}
                  error={gitError}
                  checked={checked}
                  onCheck={check}
                  message={commitMessage}
                  onMessage={setCommitMessage}
                  committing={committing}
                  unsaved={
                    tabs.filter((tab) => checked.has(tab.path) && isDirty(tab))
                      .length
                  }
                  unsavedOther={
                    tabs.filter((tab) => !checked.has(tab.path) && isDirty(tab))
                      .length
                  }
                  selected={selectedDiff?.path ?? null}
                  onOpenDiff={openDiff}
                  onRestore={(path) => void restoreFile(path)}
                  onAdd={(paths) => void addToVcs(paths)}
                  onFileMenu={(file, x, y) => {
                    if (idle())
                      setMenu({
                        items: () => changeMenu(file),
                        marked: null,
                        x,
                        y,
                      });
                  }}
                  onGroupMenu={(files, x, y) => {
                    if (idle())
                      setMenu({
                        items: () => changesMenu(files),
                        marked: null,
                        x,
                        y,
                      });
                  }}
                  onShortcut={(file, shortcut) => {
                    if (idle()) changeShortcut(file, shortcut);
                  }}
                  onRefresh={() => void refreshGit(null)}
                  onCommit={() => void commit()}
                  inputRef={commitInput}
                />
              ) : project ? (
                <Explorer
                  key={project.id}
                  project={project}
                  selected={active}
                  changes={treeChanges}
                  gitKinds={gitKinds}
                  gitDirs={gitDirs}
                  marked={menu?.marked ?? null}
                  reveal={treeReveal}
                  onOpen={(path) => void openFile(path)}
                  onContextMenu={(target, x, y) => {
                    if (idle())
                      setMenu({
                        items: () => entryMenu(target),
                        marked: target.path,
                        x,
                        y,
                      });
                  }}
                  onShortcut={(target, shortcut) => {
                    if (idle()) entryShortcut(target, shortcut);
                  }}
                />
              ) : (
                <div className="sidebar-empty">
                  <FolderOpen size={25} strokeWidth={1.2} />
                  <p>从一个文件夹开始</p>
                  <span>你的项目，触手可及。</span>
                  <button
                    className="secondary-button"
                    onClick={() => void openProject()}
                    disabled={!desktop}
                  >
                    打开文件夹 <kbd>{mod} O</kbd>
                  </button>
                </div>
              )}
              <div className="sidebar-bottom">
                <span className="version-dot" />
                <span>Nib 0.1</span>
                <span className="phase-label">阶段二</span>
              </div>
            </aside>
            <div
              className="sidebar-resizer"
              role="separator"
              aria-label="侧边栏宽度"
              aria-orientation="vertical"
              aria-valuenow={sidebarWidth}
              aria-valuemin={180}
              aria-valuemax={420}
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault();
                  setSidebarWidth((size) =>
                    Math.max(
                      180,
                      Math.min(
                        420,
                        size + (event.key === 'ArrowLeft' ? -10 : 10),
                      ),
                    ),
                  );
                }
              }}
              onPointerDown={(event) => {
                const target = event.currentTarget;
                target.setPointerCapture(event.pointerId);
                const move = (pointer: PointerEvent) =>
                  setSidebarWidth(
                    Math.max(180, Math.min(420, pointer.clientX)),
                  );
                const stop = () => {
                  target.removeEventListener('pointermove', move);
                  target.removeEventListener('pointerup', stop);
                  target.removeEventListener('pointercancel', stop);
                };
                target.addEventListener('pointermove', move);
                target.addEventListener('pointerup', stop);
                target.addEventListener('pointercancel', stop);
              }}
            />
          </>
        )}

        <section className="editor-area" aria-label="编辑区">
          <div className="tab-bar">
            <div className="tab-list" role="tablist" aria-label="已打开文件">
              {tabs.map((tab) => (
                <div
                  key={tab.path}
                  className={`tab ${active === tab.path ? 'active' : ''}`}
                >
                  <button
                    role="tab"
                    aria-selected={active === tab.path}
                    title={`${tab.path}${isDirty(tab) ? ' · 未保存' : ''}`}
                    onClick={() => {
                      desiredFile.current = null;
                      activate(tab.path);
                      setOpening(null);
                    }}
                    onMouseDown={(event) => {
                      if (event.button === 1) {
                        event.preventDefault();
                        void closeTabs([tab]);
                      }
                    }}
                  >
                    <FileCode2 size={13} />
                    <span>{baseName(tab.path)}</span>
                    {isDirty(tab) && (
                      <span
                        className={`dirty-dot ${tab.paused ? 'paused' : ''}`}
                        aria-label={
                          tab.paused ? '未保存，自动保存已暂停' : '未保存'
                        }
                      />
                    )}
                  </button>
                  <button
                    className="tab-close"
                    aria-label={`关闭 ${baseName(tab.path)}`}
                    title="关闭文件"
                    onClick={() => void closeTabs([tab])}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              {diffs.map((diff) => (
                <div
                  key={DIFF_PREFIX + diff.path}
                  className={`tab diff-tab ${active === DIFF_PREFIX + diff.path ? 'active' : ''}`}
                >
                  <button
                    role="tab"
                    aria-selected={active === DIFF_PREFIX + diff.path}
                    title={`${diff.path} 的变更`}
                    onClick={() => {
                      desiredFile.current = null;
                      activate(DIFF_PREFIX + diff.path);
                      setOpening(null);
                    }}
                    onMouseDown={(event) => {
                      if (event.button === 1) {
                        event.preventDefault();
                        closeDiff(diff.path);
                      }
                    }}
                  >
                    <GitCompare size={13} />
                    <span>{baseName(diff.path)}</span>
                  </button>
                  <button
                    className="tab-close"
                    aria-label={`关闭 ${baseName(diff.path)} 的变更`}
                    title="关闭变更"
                    onClick={() => closeDiff(diff.path)}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              {!tabs.length && !diffs.length && (
                <span className="tab-placeholder">工作区</span>
              )}
            </div>
            <div className="tab-actions">
              <button
                className="icon-button"
                disabled={!selected || saving.has(selected.path)}
                onClick={() => selected && void saveTab(selected)}
                title={`保存 (${mod}+S)`}
                aria-label="保存"
              >
                {selected && saving.has(selected.path) ? (
                  <LoaderCircle size={14} className="spin" />
                ) : (
                  <Save size={14} />
                )}
              </button>
              <button
                className="icon-button"
                title="更多编辑操作"
                aria-label="更多编辑操作"
                onClick={showPalette}
              >
                <Ellipsis size={17} />
              </button>
            </div>
          </div>

          {selected && (
            <div className="breadcrumbs">
              <span>{project?.name}</span>
              {selected.path.split('/').map((part, index) => (
                <span key={`${part}:${index}`}>
                  <ChevronRight size={11} />
                  {part}
                </span>
              ))}
              {gitKinds.has(selected.path) && (
                <button
                  className={`breadcrumb-git git-${gitKinds.get(selected.path)}`}
                  title="查看变更"
                  onClick={() => {
                    const change = repository?.files.find(
                      (file) => file.path === selected.path,
                    );
                    if (change) openDiff(change);
                  }}
                >
                  <GitCompare size={11} />
                  查看变更
                </button>
              )}
              {selected.truncated && (
                <span className="unsaved-label">
                  {`只读预览 · 文件 ${formatSize(selected.size)}，超过 20 MiB，仅显示开头 5 MiB`}
                </span>
              )}
              {isDirty(selected) && (
                <span className="unsaved-label">
                  {selected.paused
                    ? '自动保存已暂停 · 外部已修改或保存失败'
                    : '未保存到磁盘'}
                </span>
              )}
            </div>
          )}

          <div className="editor-content">
            <Editor
              tab={selected}
              wrap={wrap}
              locked={Boolean(busy) || Boolean(prompt)}
              onChange={editorChange}
              viewRef={viewRef}
            />
            {selectedDiff && (
              <div className="diff-layer">
                <DiffView
                  diff={selectedDiff}
                  unified={unified}
                  onToggleUnified={() => setUnified((value) => !value)}
                  onOpenFile={(path) => void openFile(path)}
                  onRestore={() => void restoreFile(selectedDiff.path)}
                  onRevert={(before, after) =>
                    revertChunk(selectedDiff.path, before, after)
                  }
                />
              </div>
            )}
            {!selected && !selectedDiff && (
              <div className="welcome">
                <div className="welcome-inner">
                  <div className="welcome-mark">
                    <PenLine size={36} strokeWidth={1.1} />
                  </div>
                  <p className="eyebrow">LESS NOISE. MORE CODE.</p>
                  <h1>
                    轻巧落笔，
                    <br />
                    <span>专注代码。</span>
                  </h1>
                  <p className="welcome-description">
                    一个安静的编辑空间。
                    <br />
                    打开项目，让想法从这里开始。
                  </p>
                  <button
                    className="primary-button"
                    onClick={() => void openProject()}
                    disabled={!desktop || Boolean(busy)}
                  >
                    <FolderOpen size={15} />{' '}
                    {project ? '在新标签打开文件夹' : '打开文件夹'}
                    <ArrowRight size={15} />
                  </button>
                  {project && (
                    <p className="project-hint">
                      从左侧文件树选择文件开始编辑。
                    </p>
                  )}
                  {desktop && !project && (
                    <div className="welcome-recent">
                      <p className="menu-label">最近项目</p>
                      <RecentList
                        items={recent}
                        current={null}
                        disabled={Boolean(busy)}
                        onOpen={(root) => void openRecent(root)}
                        onForget={(root) => void forgetProject(root)}
                      />
                    </div>
                  )}
                  {!desktop && (
                    <p className="browser-hint">
                      这是浏览器预览。运行 <code>npm run desktop</code>
                      <br />
                      即可在桌面窗口中打开和编辑真实文件。
                    </p>
                  )}
                  <div className="welcome-shortcuts">
                    <div>
                      <span>
                        <FolderOpen size={13} /> 打开项目
                      </span>
                      <kbd>{mod} O</kbd>
                    </div>
                    <div>
                      <span>
                        <Command size={13} /> 命令面板
                      </span>
                      <kbd>{mod} ⇧ P</kbd>
                    </div>
                    <div>
                      <span>
                        <PanelLeft size={13} /> 切换侧边栏
                      </span>
                      <kbd>{mod} B</kbd>
                    </div>
                  </div>
                </div>
                <div className="welcome-watermark">Nib</div>
                <div className="welcome-footer">
                  <span>为专注而设计</span>
                  <span>本地文件 · 原生窗口 · 轻量编辑</span>
                </div>
              </div>
            )}
            {opening && (
              <div className="loading-indicator">
                <LoaderCircle size={13} className="spin" /> 正在打开{' '}
                {baseName(opening)}…
              </div>
            )}
          </div>
        </section>
      </div>

      <footer className="status-bar">
        <div>
          <span className="status-ready">
            <span className="version-dot" />
            {busy ?? (saving.size ? '正在保存' : '就绪')}
          </span>
          {dirtyCount > 0 && (
            <span className="status-unsaved">{dirtyCount} 个未保存</span>
          )}
        </div>
        <div className="status-git">
          {repository ? (
            <button
              onClick={showCommitPanel}
              title={`${repository.root}${repository.upstream ? ` · 上游 ${repository.upstream}` : ''}`}
            >
              <GitBranch size={12} />
              {repository.branch ??
                `游离 ${repository.head?.slice(0, 7) ?? ''}`}
              {repository.upstream && (
                <span>
                  ↑{repository.ahead} ↓{repository.behind}
                </span>
              )}
              {repository.operation && (
                <span className="status-operation">
                  {repository.operation}中
                </span>
              )}
            </button>
          ) : (
            project &&
            git && (
              <span className="status-muted">
                {git.kind === 'notRepository' ? '非 Git 项目' : 'Git 不可用'}
              </span>
            )
          )}
        </div>
        <div>
          {selected && (
            <>
              <span>
                {line
                  ? `行 ${line.number}，列 ${(selection?.head ?? 0) - line.from + 1}`
                  : ''}
              </span>
              <span>
                {languageName(selected.path)}
                {selected.state.doc.length > 1024 * 1024 ? ' · 简化模式' : ''}
              </span>
              <span>UTF-8{selected.hasBom ? ' BOM' : ''}</span>
              <span>{selected.newline}</span>
            </>
          )}
          <button
            className={wrap ? 'status-active' : ''}
            onClick={() => setWrap((value) => !value)}
            title="切换自动换行"
            aria-label="切换自动换行"
            aria-pressed={wrap}
          >
            <WrapText size={13} />
          </button>
          <button
            onClick={showPalette}
            title="命令与快捷键"
            aria-label="命令与快捷键"
          >
            <Keyboard size={14} />
          </button>
        </div>
      </footer>

      {notice && (
        <div
          className={`notice ${notice.error ? 'error' : ''}`}
          role={notice.error ? 'alert' : 'status'}
        >
          <span>
            {notice.error ? (
              <ChevronsLeftRight size={15} />
            ) : (
              <Check size={15} />
            )}
          </span>
          <p>{notice.text}</p>
          {notice.error && selected && (
            <button
              title="重新加载磁盘文件"
              aria-label="重新加载磁盘文件"
              onClick={() => void reloadFile()}
            >
              <RotateCw size={14} />
            </button>
          )}
          <button
            title="关闭提示"
            aria-label="关闭提示"
            onClick={() => setNotice(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {settings && (
        <div
          className="popover settings"
          role="dialog"
          aria-label="编辑器显示设置"
          onKeyDown={(event) => {
            if (event.key === 'Escape') setSettings(false);
          }}
        >
          <div className="popover-title">
            编辑器显示
            <button
              className="icon-button"
              aria-label="关闭设置"
              onClick={() => setSettings(false)}
            >
              <X size={14} />
            </button>
          </div>
          <label>
            字号{' '}
            <div>
              <button
                onClick={() => setFontSize((size) => Math.max(10, size - 1))}
                aria-label="减小字号"
              >
                −
              </button>
              <span>{fontSize} px</span>
              <button
                onClick={() => setFontSize((size) => Math.min(24, size + 1))}
                aria-label="增大字号"
              >
                +
              </button>
            </div>
          </label>
          <label>
            自动换行{' '}
            <input
              type="checkbox"
              checked={wrap}
              onChange={(event) => setWrap(event.target.checked)}
            />
          </label>
          <label>
            自动保存{' '}
            <input
              type="checkbox"
              checked={autoSave}
              onChange={(event) => setAutoSave(event.target.checked)}
            />
          </label>
          <p>当前会话生效 · {mod} + / − 调整字号</p>
        </div>
      )}

      {palette && (
        <div
          className="modal-backdrop palette-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPalette(false);
          }}
        >
          <section
            className="command-palette"
            role="dialog"
            aria-modal="true"
            aria-label="命令面板"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setPalette(false);
              } else if (event.key === 'Tab') {
                event.preventDefault();
                paletteRef.current?.focus();
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                setCommandIndex((index) =>
                  Math.min(filtered.length - 1, index + 1),
                );
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setCommandIndex((index) => Math.max(0, index - 1));
              } else if (
                event.key === 'Enter' &&
                !event.nativeEvent.isComposing
              ) {
                const command = filtered[commandIndex];
                if (command && !command.disabled) {
                  setPalette(false);
                  command.action();
                }
              }
            }}
          >
            <div className="palette-input">
              <Search size={17} />
              <input
                ref={paletteRef}
                placeholder="输入命令…"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setCommandIndex(0);
                }}
                role="combobox"
                aria-expanded="true"
                aria-controls="command-results"
                aria-autocomplete="list"
                aria-activedescendant={
                  filtered.length ? `command-${commandIndex}` : undefined
                }
              />
              <kbd>esc</kbd>
            </div>
            <div
              className="palette-results"
              role="listbox"
              id="command-results"
            >
              {filtered.map((command, index) => (
                <button
                  id={`command-${index}`}
                  role="option"
                  aria-selected={index === commandIndex}
                  className={index === commandIndex ? 'highlighted' : ''}
                  key={command.label}
                  disabled={command.disabled}
                  onMouseEnter={() => setCommandIndex(index)}
                  onClick={() => {
                    setPalette(false);
                    command.action();
                  }}
                >
                  <span>{command.label}</span>
                  <kbd>{command.detail}</kbd>
                </button>
              ))}
              {!filtered.length && (
                <p className="palette-empty">没有匹配的命令</p>
              )}
            </div>
            <footer>
              <span>↑ ↓ 选择</span>
              <span>↵ 执行</span>
              <span>esc 关闭</span>
            </footer>
          </section>
        </div>
      )}

      {projectMenu && (
        <ProjectMenu
          project={project}
          recent={recent}
          disabled={Boolean(busy)}
          mod={mod}
          onChoose={() => void openProject()}
          onNewWindow={newWindow}
          onCloseProject={() => void closeProject()}
          onOpen={(root) => void openRecent(root)}
          onOpenHere={(root) => void openRecent(root, true)}
          onForget={(root) => void forgetProject(root)}
          onClose={() => setProjectMenu(false)}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items()}
          onClose={closeMenu}
        />
      )}
      {naming && !prompt && (
        <NameDialog request={naming} onClose={() => setNaming(null)} />
      )}
      {prompt && (
        <UnsavedDialog
          kind={prompt.kind}
          paths={prompt.paths}
          note={prompt.note}
          onDecide={decide}
        />
      )}
    </main>
  );
}

/**
 * 危险操作前的确认框，锁定键盘焦点。未保存内容提供保存、放弃与返回三种选择；
 * 恢复、回滚、删除只提供确认与取消，默认聚焦在取消上。
 */
function UnsavedDialog({
  kind,
  paths,
  note,
  onDecide,
}: {
  kind: PromptKind;
  paths: string[];
  note?: string;
  onDecide: (decision: Decision) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    container.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);
  return (
    <div className="modal-backdrop">
      <div
        className="unsaved-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="unsaved-title"
        aria-describedby="unsaved-description"
        ref={container}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onDecide('cancel');
          }
          if (event.key === 'Tab') {
            const buttons = [...container.current!.querySelectorAll('button')];
            const first = buttons[0];
            const last = buttons[buttons.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div className="dialog-icon">
          {kind === 'unsaved' ? (
            <ArrowDownToLine size={22} />
          ) : kind === 'delete' ? (
            <Trash2 size={22} />
          ) : (
            <Undo2 size={22} />
          )}
        </div>
        <h2 id="unsaved-title">
          {kind === 'unsaved' ? '保存这次修改？' : confirmations[kind].title}
        </h2>
        <p id="unsaved-description">
          {kind === 'unsaved'
            ? '以下文件的修改尚未保存到磁盘。放弃后将无法恢复。'
            : confirmations[kind].description}
          {note && <strong className="dialog-note">{note}</strong>}
        </p>
        <ul>
          {paths.map((path) => (
            <li key={path}>
              <FileCode2 size={14} />
              <span>{path}</span>
            </li>
          ))}
        </ul>
        {kind === 'unsaved' ? (
          <div className="dialog-actions">
            <button
              className="secondary-button"
              onClick={() => onDecide('cancel')}
            >
              返回编辑
            </button>
            <button
              className="text-button danger"
              onClick={() => onDecide('discard')}
            >
              放弃修改
            </button>
            <button className="primary-button" onClick={() => onDecide('save')}>
              保存并继续
            </button>
          </div>
        ) : (
          <div className="dialog-actions">
            <button
              className="secondary-button"
              onClick={() => onDecide('cancel')}
            >
              取消
            </button>
            <button
              className={
                kind === 'restore' ? 'primary-button' : 'danger-button'
              }
              onClick={() => onDecide('save')}
            >
              {confirmations[kind].confirm}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
