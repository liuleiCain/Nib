import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
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
  ArchiveRestore,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsLeftRight,
  Command,
  FileCode2,
  Files,
  FolderOpen,
  GitBranch,
  Server,
  GitCommitHorizontal,
  GitCompare,
  GitMerge,
  History,
  Keyboard,
  LoaderCircle,
  PanelLeft,
  PenLine,
  Radio,
  RotateCw,
  Search,
  SettingsIcon,
  Trash2,
  Undo2,
  WrapText,
  X,
} from 'lucide-react';
import type {
  ChangeKind,
  CommitFile,
  CommitSummary,
  FileChange,
  FileChanges,
  GitStatus,
  Integration,
  Project,
  ProjectTabs,
  RecentProject,
  RecoveryEntry,
  Settings,
  SidebarPanel,
  View,
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
import type { BranchAction } from '../features/git/BranchPopup';
import { BranchPopup } from '../features/git/BranchPopup';
import { CommitPanel } from '../features/git/CommitPanel';
import { LogPanel } from '../features/git/LogPanel';
import type { DiffTab } from '../features/git/DiffView';
import type { Reveal } from '../features/editor/Editor';
import { QuickOpen } from '../features/search/QuickOpen';
import { SearchPanel } from '../features/search/SearchPanel';
import { DiffView } from '../features/git/DiffView';
import { PushDialog } from '../features/git/PushDialog';
import type { SettingValues } from '../features/settings/SettingsDialog';
import {
  DEFAULT_SETTINGS,
  FONT_SIZE,
  SettingsDialog,
  cssFontFamily,
} from '../features/settings/SettingsDialog';
import { setHeadDoc } from '../features/git/changes';
import { Text } from '@codemirror/state';
import { LiveChangesPanel } from '../features/changes/LiveChangesPanel';
import { useLiveChanges } from '../features/changes/useLiveChanges';

type Decision = 'save' | 'discard' | 'cancel';
/**
 * unsaved：未保存内容的保存/放弃确认；其余为单一操作的确认，确认时返回 save：
 * restore 恢复已删除文件、rollback 回滚变更、delete 移到废纸篓。
 */
type PromptKind =
  | 'unsaved'
  | 'recover'
  | 'restore'
  | 'rollback'
  | 'delete'
  | 'deleteBranch'
  | 'forceDeleteBranch'
  | 'deleteRemoteBranch'
  | 'removeRemote'
  | 'rebase'
  | 'skipCommit'
  | 'abortOperation'
  | 'resolveMarkers';
interface Prompt {
  kind: PromptKind;
  paths: string[];
  /** 附加的风险说明。 */
  note?: string;
  resolve: (decision: Decision) => void;
}

/** 三选一确认框（save / discard / cancel）的文字。 */
const promptChoices: Record<
  'unsaved' | 'recover',
  {
    title: string;
    description: string;
    save: string;
    discard: string;
    cancel: string;
  }
> = {
  unsaved: {
    title: '保存这次修改？',
    description: '以下文件的修改尚未保存到磁盘。放弃后将无法恢复。',
    save: '保存并继续',
    discard: '放弃修改',
    cancel: '返回编辑',
  },
  recover: {
    title: '恢复上次未保存的内容？',
    description:
      'Nib 上次没有正常关闭，以下文件有未保存的编辑。恢复后作为未保存的修改放回编辑器，可撤销；放弃后无法找回；稍后处理会在下次打开项目时再次提示。',
    save: '恢复',
    discard: '放弃',
    cancel: '稍后处理',
  },
};

/** 单一操作确认框的文字。 */
const confirmations: Record<
  Exclude<PromptKind, 'unsaved' | 'recover'>,
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
  deleteBranch: {
    title: '删除本地分支？',
    description:
      '将删除以下本地分支（git branch -d），远程分支不受影响。分支有未合并的提交时会再次确认。',
    confirm: '删除分支',
  },
  forceDeleteBranch: {
    title: '分支尚未合并，仍要删除？',
    description:
      '以下分支有尚未合并到当前分支或其上游的提交，强制删除（git branch -D）后这些提交只能通过 reflog 找回。',
    confirm: '强制删除',
  },
  deleteRemoteBranch: {
    title: '删除远程分支？',
    description:
      '将从远程仓库删除以下分支（git push <远程> --delete），其他人也将无法再获取它。此操作无法在 Nib 中撤销。',
    confirm: '删除远程分支',
  },
  removeRemote: {
    title: '删除远程仓库？',
    description:
      '将删除以下远程仓库的配置（git remote remove）及本地记录的远程分支，跟踪它的本地分支会失去上游。远程服务器上的仓库不受影响，可重新添加。',
    confirm: '删除远程仓库',
  },
  rebase: {
    title: '变基当前分支？',
    description:
      '当前分支中目标分支没有的提交将依次重放到目标分支之上，这些提交会被重写为新的提交。已推送过的提交变基后无法普通推送，Nib 不提供强制推送。',
    confirm: '变基',
  },
  skipCommit: {
    title: '跳过这个提交？',
    description:
      '变基将跳过当前停下的提交（git rebase --skip），它的修改和已做的冲突解决都会丢弃，然后继续应用后面的提交。',
    confirm: '跳过提交',
  },
  abortOperation: {
    title: '中止进行中的操作？',
    description:
      '仓库将恢复到开始前的状态（git merge --abort / git rebase --abort），已做的冲突解决都会丢失。',
    confirm: '中止',
  },
  resolveMarkers: {
    title: '文件中仍有冲突标记，仍要标记为已解决？',
    description:
      '以下文件中还有 <<<<<<< … >>>>>>> 冲突标记。标记为已解决后，这些标记会作为文件内容提交。',
    confirm: '仍然标记',
  },
};
/** 确认框中列出的是分支而不是文件。 */
const branchPrompts = new Set<PromptKind>([
  'deleteBranch',
  'forceDeleteBranch',
  'deleteRemoteBranch',
  'rebase',
]);
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
/** 编辑后写入恢复数据的最长间隔。 */
const RECOVERY_DELAY = 1500;
/** 超过该长度（UTF-16 单位）的文件不写恢复数据，保证 UTF-8 编码后不超过后台的 5 MiB 上限。 */
const MAX_RECOVERY_LENGTH = 1_500_000;
/** 设置变化后写盘的等待时间，连续调整字号只写一次。 */
const SETTINGS_DELAY = 300;
/** 每个项目最多记录的展开目录数，与后台上限一致。 */
const MAX_EXPANDED = 200;
/** 编辑器字体为空时使用的内置字体。 */
const DEFAULT_EDITOR_FONT =
  "'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace";
/** 文件变化后刷新 Git 状态的等待时间；连续写入只刷新一次。 */
const GIT_REFRESH_DELAY = 400;
/** Diff 标签的标识前缀，与文件标签共用一个标签栏；文件路径不会含 NUL，不会与文件标签冲突。 */
const DIFF_PREFIX = '\0diff/';
const LIVE_TAB = '\0live';

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
  const [fontFamily, setFontFamily] = useState('');
  const [tabSize, setTabSize] = useState(4);
  // 设置读取完成前不写盘；saved 为最近一次写入或收到的设置，相同时跳过写入。
  const settingsLoaded = useRef(false);
  const savedSettings = useRef<Settings | null>(null);
  const settingsTimer = useRef<number | null>(null);
  const sidebarLoaded = useRef(false);
  const savedSidebarWidth = useRef(248);
  const [quickOpen, setQuickOpen] = useState(false);
  const [searchFocus, setSearchFocus] = useState<{
    key: number;
    seed: string | null;
  }>({ key: 0, seed: null });
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const revealKey = useRef(0);
  // 恢复数据：已写入的文档快照（与当前文档相同时不重复写入）、写入计时器和串行队列。
  const recorded = useRef(new Map<string, Text>());
  const recoveryTimer = useRef<number | null>(null);
  const recoveryQueue = useRef<Promise<void>>(Promise.resolve());
  // 项目正常关闭后停止写入，避免关闭过程中又写下已放弃的内容。
  const recoveryClosed = useRef(true);
  const recoveryFailed = useRef(false);
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
  const [panel, setPanel] = useState<SidebarPanel>('files');
  const [liveOpen, setLiveOpen] = useState(false);
  // 提交面板按目录分组显示。
  const [changeTree, setChangeTree] = useState(false);
  // 当前项目文件树展开的目录，随项目恢复。
  const [expanded, setExpanded] = useState<string[]>([]);
  // 界面偏好读取完成前不写盘，避免用默认值覆盖已保存的记录。
  const viewLoaded = useRef(false);
  const savedView = useRef('');
  const expandedTimer = useRef<number | null>(null);
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
  // 正在进行的 Fetch、Pull 或 Push，同一时间只进行一个；分支弹窗的锚点。
  const [remoteTask, setRemoteTaskState] = useState<string | null>(null);
  const remoteTaskRef = useRef<string | null>(null);
  const [branchPopup, setBranchPopup] = useState<{
    x: number;
    y: number;
  } | null>(null);
  // 远程操作后递增，让提交记录重新读取远程分支标记。
  const [refsVersion, setRefsVersion] = useState(0);
  // 文件树与标签栏共用右键菜单；名称输入框及新建后需要展开的目录。
  const [menu, setMenu] = useState<{
    items: () => MenuItem[];
    /** 文件树中高亮的条目。 */
    marked: string | null;
    x: number;
    y: number;
  } | null>(null);
  const [naming, setNamingState] = useState<NameRequest | null>(null);
  const namingRef = useRef<NameRequest | null>(null);
  // 推送确认框，打开时记录项目 id，切换项目后不再显示。
  const [pushing, setPushingState] = useState<number | null>(null);
  const pushingRef = useRef<number | null>(null);
  const [treeReveal, setTreeReveal] = useState<TreeReveal>({
    key: 0,
    path: '',
  });
  const selected = tabs.find((tab) => tab.path === active);
  const selectedDiff = active?.startsWith(DIFF_PREFIX)
    ? diffs.find((diff) => DIFF_PREFIX + diff.key === active)
    : undefined;
  const dirtyCount = tabs.filter(isDirty).length;
  const repository = git?.kind === 'repository' ? git : null;
  const live = useLiveChanges(project, git, active === LIVE_TAB);
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
    quickOpen: () => {},
    search: () => {},
    autoSave: () => {},
    filesChanged: (_changes: FileChanges) => {},
    commitPanel: () => {},
    push: () => {},
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
    void live.record(changes);
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
    // 持续写入时也定期刷新，避免尾部防抖一直推迟变更列表的更新。
    if (gitTimer.current !== null) return;
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
          diff.key !== path
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
          diff.key === path ? { ...diff, error: errorMessage(error) } : diff,
        ),
      );
    }
  }

  /** 读取提交中一个文件的 Diff；内容不会变化，只读取一次。 */
  async function loadCommitDiff(diff: DiffTab) {
    const workspace = projectRef.current;
    if (!workspace || !diff.commit) return;
    try {
      const sources = await backend.gitCommitDiff(
        workspace.id,
        diff.commit.hash,
        diff.path,
        diff.original,
      );
      if (projectRef.current?.id !== workspace.id) return;
      updateDiffs(
        diffsRef.current.map((item) =>
          item.key === diff.key
            ? { ...item, sources, error: null, version: item.version + 1 }
            : item,
        ),
      );
    } catch (error) {
      if (projectRef.current?.id !== workspace.id) return;
      updateDiffs(
        diffsRef.current.map((item) =>
          item.key === diff.key
            ? { ...item, error: errorMessage(error) }
            : item,
        ),
      );
    }
  }

  /** 打开提交中一个文件的 Diff（与第一个父提交比较），只读。 */
  function openCommitDiff(commit: CommitSummary, file: CommitFile) {
    if (busyRef.current || promptRef.current) return;
    // 文件路径不含 NUL，与工作区 Diff 的标识不会冲突。
    const key = `${commit.hash}\0${file.path}`;
    if (!diffsRef.current.some((diff) => diff.key === key)) {
      const diff: DiffTab = {
        key,
        path: file.path,
        original: file.original,
        sources: null,
        error: null,
        version: 0,
        commit: {
          hash: commit.hash,
          parent: commit.parents[0] ?? null,
          subject: commit.subject,
        },
      };
      updateDiffs([...diffsRef.current, diff]);
      void loadCommitDiff(diff);
    }
    activate(DIFF_PREFIX + key);
    setOpening(null);
  }

  /** 在主区打开或切换到文件的 Diff 标签。 */
  function openDiff(change: FileChange) {
    if (busyRef.current || promptRef.current) return;
    const existing = diffsRef.current.find((diff) => diff.key === change.path);
    if (!existing)
      updateDiffs([
        ...diffsRef.current,
        {
          key: change.path,
          path: change.path,
          original: change.original,
          sources: null,
          error: null,
          version: 0,
          commit: null,
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
      // 历史提交的内容不会变化，不随工作区刷新。
      if (diff.commit || (changed && !changed.includes(diff.path))) continue;
      const change =
        status?.kind === 'repository'
          ? status.files.find((file) => file.path === diff.path)
          : undefined;
      void loadDiff(diff.path, change?.original ?? diff.original);
    }
  }

  function closeDiff(key: string) {
    const old = diffsRef.current;
    const next = old.filter((diff) => diff.key !== key);
    if (activeRef.current === DIFF_PREFIX + key) {
      const index = old.findIndex((diff) => diff.key === key);
      const neighbour = next[Math.min(index, next.length - 1)];
      activate(
        neighbour
          ? DIFF_PREFIX + neighbour.key
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

  function setPushing(projectId: number | null) {
    pushingRef.current = projectId;
    setPushingState(projectId);
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
      !namingRef.current &&
      pushingRef.current === null
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
    // 提交 Diff 是历史内容，路径不随改名变化。
    updateDiffs(
      diffsRef.current.map((diff) =>
        !diff.commit && within(diff.path, from)
          ? { ...diff, key: rename(diff.path), path: rename(diff.path) }
          : diff,
      ),
    );
    const current = activeRef.current;
    if (current?.startsWith(DIFF_PREFIX)) {
      const key = current.slice(DIFF_PREFIX.length);
      if (!key.includes('\0')) activate(DIFF_PREFIX + rename(key));
    } else if (current) activate(rename(current));
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
          if (!diff.commit && within(diff.path, target.path))
            closeDiff(diff.key);
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
    } else if (file.kind === 'conflicted') {
      items.push({
        label: '标记为已解决',
        action: () => void resolveConflicts([file.path]),
      });
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
    const conflicted = files.filter((file) => file.kind === 'conflicted');
    const items: MenuItem[] = [];
    if (conflicted.length)
      items.push({
        label: `标记 ${conflicted.length} 个冲突文件为已解决`,
        action: () =>
          void resolveConflicts(conflicted.map((file) => file.path)),
      });
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
      if (conflicted)
        git.push({
          label: '标记冲突为已解决',
          action: () =>
            void resolveConflicts(
              changed
                .filter((file) => file.kind === 'conflicted')
                .map((file) => file.path),
            ),
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

  function setRemoteTask(task: string | null) {
    remoteTaskRef.current = task;
    setRemoteTaskState(task);
  }

  /** 切换分支、拉取前先保存所有未保存的编辑，避免 Git 改写文件后与编辑器内容冲突。 */
  async function saveAllForGit(): Promise<boolean> {
    for (const tab of tabsRef.current)
      if (isDirty(tab) && !(await saveTab(tab, true))) return false;
    return true;
  }

  /**
   * 输入名称后新建分支并切换过去。start 为起点分支的完整引用名，label 为其显示名；
   * 从当前 HEAD 新建时不改动工作区文件，从其他分支新建时先保存编辑，未提交的修改冲突时由 Git 拒绝。
   */
  function createBranch(
    start: string | null = null,
    label: string | null = null,
  ) {
    if (!idle() || gitRef.current?.kind !== 'repository') return;
    setNaming({
      title: `新建分支（从 ${label ?? '当前 HEAD'}）`,
      initial: '',
      confirm: '新建并切换',
      submit: async (name) => {
        const workspace = projectRef.current;
        if (!workspace) return null;
        if (start && !(await saveAllForGit()))
          return '有文件未能保存，已取消。请先处理保存失败的文件。';
        try {
          const branch = await backend.gitCreateBranch(
            workspace.id,
            name,
            start,
          );
          if (projectRef.current?.id !== workspace.id) return null;
          notify(`已新建并切换到分支 ${branch}`, false);
          return null;
        } catch (error) {
          return errorMessage(error);
        } finally {
          if (projectRef.current?.id === workspace.id) gitChanged(true);
        }
      },
    });
  }

  /** 分支或引用改变后刷新 Git 状态、提交记录；tree 为真时同时刷新文件树（工作区可能被切换）。 */
  function gitChanged(tree = false) {
    setRefsVersion((value) => value + 1);
    if (tree)
      setTreeChanges((previous) => ({ key: previous.key + 1, paths: null }));
    void refreshGit(null);
  }

  /** 检出远程分支为跟踪它的本地分支；同名本地分支已跟踪它时直接切换。 */
  async function checkoutRemote(remote: string, branch: string) {
    if (!idle() || !(await saveAllForGit())) return;
    await runEntryAction('检出分支', async (projectId) => {
      const local = await backend.gitCheckoutRemote(projectId, remote, branch);
      return `已切换到 ${local}（跟踪 ${remote}/${branch}）`;
    });
    setRefsVersion((value) => value + 1);
  }

  /** 重命名本地分支，上游配置保留。 */
  function renameBranch(name: string) {
    if (!idle()) return;
    setNaming({
      title: `重命名分支 ${name}`,
      initial: name,
      confirm: '重命名',
      submit: async (target) => {
        const workspace = projectRef.current;
        if (!workspace) return null;
        try {
          const next = await backend.gitRenameBranch(
            workspace.id,
            name,
            target,
          );
          if (projectRef.current?.id !== workspace.id) return null;
          if (next !== name) notify(`已将分支 ${name} 重命名为 ${next}`, false);
          return null;
        } catch (error) {
          return errorMessage(error);
        } finally {
          if (projectRef.current?.id === workspace.id) gitChanged();
        }
      },
    });
  }

  /** 确认后删除本地分支；未合并时再次确认才强制删除。 */
  async function deleteBranch(name: string) {
    const workspace = projectRef.current;
    if (!workspace || !idle()) return;
    if ((await ask([name], 'deleteBranch')) !== 'save') return;
    let unmerged: string | null = null;
    const deleted = await runEntryAction('删除分支', async (projectId) => {
      try {
        await backend.gitDeleteBranch(projectId, name, false);
        return `已删除分支 ${name}`;
      } catch (error) {
        if (errorCode(error) !== 'NOT_MERGED') throw error;
        unmerged = errorMessage(error);
      }
    });
    if (projectRef.current?.id !== workspace.id) return;
    setRefsVersion((value) => value + 1);
    if (!deleted || !unmerged) return;
    if ((await ask([name], 'forceDeleteBranch', unmerged)) !== 'save') return;
    await runEntryAction('删除分支', async (projectId) => {
      await backend.gitDeleteBranch(projectId, name, true);
      return `已强制删除分支 ${name}`;
    });
    setRefsVersion((value) => value + 1);
  }

  /** 确认后从远程仓库删除分支；与 Fetch、Push 一样不锁定编辑。 */
  async function deleteRemoteBranch(remote: string, branch: string) {
    if (!idle() || remoteTaskRef.current) return;
    if ((await ask([`${remote}/${branch}`], 'deleteRemoteBranch')) !== 'save')
      return;
    void runRemote('删除远程分支', async (projectId) => {
      await backend.gitDeleteRemoteBranch(projectId, remote, branch);
      return `已删除远程分支 ${remote}/${branch}`;
    });
  }

  /** 添加远程仓库；只写配置，添加后可获取（Fetch）或推送并设置上游。initial 为建议的名称。 */
  function addRemote(initial = '') {
    if (
      !idle() ||
      remoteTaskRef.current ||
      gitRef.current?.kind !== 'repository'
    )
      return;
    setNaming({
      title: '添加远程仓库',
      label: '名称',
      initial,
      placeholder: 'origin',
      extra: {
        label: '地址',
        initial: '',
        placeholder: 'git@github.com:用户/仓库.git 或 https://…',
      },
      confirm: '添加',
      submit: async (name, url) => {
        const workspace = projectRef.current;
        if (!workspace) return null;
        try {
          const remote = await backend.gitAddRemote(workspace.id, name, url);
          if (projectRef.current?.id !== workspace.id) return null;
          notify(`已添加远程仓库 ${remote}，可获取（Fetch）或推送`, false);
          return null;
        } catch (error) {
          return errorMessage(error);
        } finally {
          if (projectRef.current?.id === workspace.id) gitChanged();
        }
      },
    });
  }

  /** 修改远程仓库地址；列表中的地址隐藏了密码，含密码时需重新输入。 */
  function editRemote(name: string, url: string) {
    if (!idle() || remoteTaskRef.current) return;
    setNaming({
      title: `修改远程仓库 ${name} 的地址`,
      label: '地址',
      initial: url,
      confirm: '保存',
      submit: async (next) => {
        const workspace = projectRef.current;
        if (!workspace) return null;
        if (next.trim() === url) return null;
        try {
          await backend.gitSetRemoteUrl(workspace.id, name, next);
          if (projectRef.current?.id !== workspace.id) return null;
          notify(`已修改远程仓库 ${name} 的地址`, false);
          return null;
        } catch (error) {
          return errorMessage(error);
        } finally {
          if (projectRef.current?.id === workspace.id) gitChanged();
        }
      },
    });
  }

  /** 重命名远程仓库，远程分支和本地分支的上游配置随之改名。 */
  function renameRemote(name: string) {
    if (!idle() || remoteTaskRef.current) return;
    setNaming({
      title: `重命名远程仓库 ${name}`,
      initial: name,
      confirm: '重命名',
      submit: async (target) => {
        const workspace = projectRef.current;
        if (!workspace) return null;
        try {
          const next = await backend.gitRenameRemote(
            workspace.id,
            name,
            target,
          );
          if (projectRef.current?.id !== workspace.id) return null;
          if (next !== name)
            notify(`已将远程仓库 ${name} 重命名为 ${next}`, false);
          return null;
        } catch (error) {
          return errorMessage(error);
        } finally {
          if (projectRef.current?.id === workspace.id) gitChanged();
        }
      },
    });
  }

  /** 确认后删除远程仓库配置；远程服务器不受影响。 */
  async function removeRemote(name: string) {
    if (!idle() || remoteTaskRef.current) return;
    if ((await ask([name], 'removeRemote')) !== 'save') return;
    await runEntryAction('删除远程仓库', async (projectId) => {
      await backend.gitRemoveRemote(projectId, name);
      return `已删除远程仓库 ${name}`;
    });
    setRefsVersion((value) => value + 1);
  }

  /** 执行分支弹窗中选择的操作。 */
  function branchAction(action: BranchAction) {
    switch (action.kind) {
      case 'fetch':
        return fetchRemote();
      case 'pull':
        return void pullRemote();
      case 'push':
        return pushRemote();
      case 'create':
        return createBranch(action.start, action.label);
      case 'switch':
        return void switchBranch(action.name);
      case 'checkout':
        return void checkoutRemote(action.remote, action.branch);
      case 'rename':
        return renameBranch(action.name);
      case 'delete':
        return void deleteBranch(action.name);
      case 'deleteRemote':
        return void deleteRemoteBranch(action.remote, action.branch);
      case 'merge':
        return void mergeBranch(action.target, action.label);
      case 'rebase':
        return void rebaseBranch(action.target, action.label);
      case 'addRemote':
        return addRemote(action.initial);
      case 'editRemote':
        return editRemote(action.name, action.url);
      case 'renameRemote':
        return renameRemote(action.name);
      case 'removeRemote':
        return void removeRemote(action.name);
    }
  }

  /**
   * 执行合并、变基、继续或跳过，期间锁定界面。完成时提示结果；因冲突暂停时切到提交面板，
   * 列出冲突文件。save 为真时先保存所有编辑：开始合并需要干净的工作区，继续需要已保存的冲突解决。
   */
  async function integrate(
    label: string,
    done: string,
    action: (projectId: number) => Promise<Integration>,
    save = true,
  ) {
    const workspace = projectRef.current;
    if (!workspace || !idle() || (save && !(await saveAllForGit()))) return;
    let stopped: Extract<Integration, { kind: 'stopped' }> | null = null;
    const finished = await runEntryAction(label, async (projectId) => {
      const result = await action(projectId);
      if (result.kind === 'upToDate') return '已是最新，无需操作';
      if (result.kind === 'done') return `${done} · ${result.hash}`;
      stopped = result;
    });
    if (projectRef.current?.id !== workspace.id) return;
    setRefsVersion((value) => value + 1);
    const pause = stopped as Extract<Integration, { kind: 'stopped' }> | null;
    if (!finished || !pause) return;
    showCommitPanel();
    notify(
      pause.total
        ? `${label}暂停：${pause.total} 个文件有冲突（${pause.files.join('、')}${pause.total > pause.files.length ? ' 等' : ''}）。在编辑器中解决后标记为已解决，再继续；也可以中止。`
        : `${label}暂停：${pause.message ?? 'Git 未说明原因。'}`,
    );
  }

  /** 把目标分支合并到当前分支；要求没有未提交的修改。 */
  async function mergeBranch(target: string, label: string) {
    await integrate('合并', `已将 ${label} 合并到当前分支`, (projectId) =>
      backend.gitMerge(projectId, target),
    );
  }

  /** 确认后把当前分支变基到目标分支。 */
  async function rebaseBranch(target: string, label: string) {
    if (!idle() || (await ask([label], 'rebase')) !== 'save') return;
    await integrate('变基', `已将当前分支变基到 ${label}`, (projectId) =>
      backend.gitRebase(projectId, target),
    );
  }

  /** 冲突都已解决后完成合并或继续变基。 */
  async function continueOperation() {
    const operation =
      gitRef.current?.kind === 'repository' ? gitRef.current.operation : null;
    if (operation !== '合并' && operation !== '变基') return;
    await integrate(
      operation === '合并' ? '完成合并' : '继续变基',
      operation === '合并' ? '已完成合并' : '已完成变基',
      (projectId) => backend.gitContinue(projectId),
    );
  }

  /** 确认后跳过变基中停下的提交；不保存编辑，被跳过提交的修改本就会丢弃。 */
  async function skipCommit() {
    if (!idle() || (await ask([], 'skipCommit')) !== 'save') return;
    await integrate(
      '跳过提交',
      '已完成变基',
      (projectId) => backend.gitSkip(projectId),
      false,
    );
  }

  /** 确认后中止合并或变基，恢复到开始前的状态。 */
  async function abortOperation() {
    const operation =
      gitRef.current?.kind === 'repository' ? gitRef.current.operation : null;
    if (!operation || !idle() || (await ask([], 'abortOperation')) !== 'save')
      return;
    await runEntryAction(`中止${operation}`, async (projectId) => {
      await backend.gitAbort(projectId);
      return `已中止${operation}，仓库恢复到开始前的状态`;
    });
    setRefsVersion((value) => value + 1);
  }

  /** 把冲突文件标记为已解决；文件中仍有冲突标记时再次确认。 */
  async function resolveConflicts(paths: string[]) {
    const workspace = projectRef.current;
    if (!workspace || !paths.length || !idle() || !(await saveAllForGit()))
      return;
    let markers: string | null = null;
    const resolved = await runEntryAction('标记为已解决', async (projectId) => {
      try {
        await backend.gitResolve(projectId, paths, false);
      } catch (error) {
        if (errorCode(error) !== 'CONFLICT_MARKERS') throw error;
        markers = errorMessage(error);
      }
    });
    if (projectRef.current?.id !== workspace.id || !resolved || !markers)
      return;
    if ((await ask(paths, 'resolveMarkers', markers)) !== 'save') return;
    await runEntryAction('标记为已解决', (projectId) =>
      backend.gitResolve(projectId, paths, true),
    );
  }

  /** 切换到本地分支；未提交的变更与目标分支冲突时由 Git 拒绝，不会覆盖。 */
  async function switchBranch(name: string) {
    if (!idle() || !(await saveAllForGit())) return;
    await runEntryAction('切换分支', async (projectId) => {
      await backend.gitSwitchBranch(projectId, name);
      return `已切换到分支 ${name}`;
    });
  }

  /** Fetch、Push：同一时间只进行一个，不锁定编辑；完成后刷新 Git 状态和提交记录。 */
  async function runRemote(
    label: string,
    action: (projectId: number) => Promise<string>,
  ) {
    const workspace = projectRef.current;
    if (!workspace || remoteTaskRef.current) return;
    setRemoteTask(label);
    try {
      const message = await action(workspace.id);
      if (projectRef.current?.id === workspace.id) notify(message, false);
    } catch (error) {
      if (projectRef.current?.id === workspace.id)
        notify(`${label}失败：${errorMessage(error)}`);
    } finally {
      setRemoteTask(null);
      if (projectRef.current?.id === workspace.id) {
        setRefsVersion((value) => value + 1);
        void refreshGit(null);
      }
    }
  }

  function fetchRemote() {
    void runRemote('获取', async (projectId) => {
      await backend.gitFetch(projectId);
      return '已从所有远程仓库获取更新';
    });
  }

  /** 仅快进拉取当前分支的上游；会改写工作区文件，先保存编辑并锁定界面。 */
  async function pullRemote() {
    if (!idle() || remoteTaskRef.current || !(await saveAllForGit())) return;
    if (remoteTaskRef.current) return;
    setRemoteTask('拉取');
    try {
      await runEntryAction('拉取', async (projectId) => {
        const result = await backend.gitPull(projectId);
        return result.commits
          ? `已从 ${result.upstream} 快进 ${result.commits} 个提交`
          : `已是最新，与 ${result.upstream} 一致`;
      });
    } finally {
      setRemoteTask(null);
      setRefsVersion((value) => value + 1);
    }
  }

  /**
   * 推送前打开确认框，列出待推送的提交与文件；没有上游时在框内选择远程仓库，推送后设为上游。
   * 被拒绝时说明原因，不提供强制推送。
   */
  function pushRemote() {
    const workspace = projectRef.current;
    const status = gitRef.current;
    if (!workspace || status?.kind !== 'repository' || remoteTaskRef.current)
      return;
    if (!idle()) return;
    if (!status.branch) {
      notify('当前处于游离 HEAD，没有可推送的分支。');
      return;
    }
    setPushing(workspace.id);
  }

  /** 确认框中确认后推送；remote 仅在没有上游时传入，head 为确认时的 HEAD 提交。 */
  function confirmPush(remote: string | null, head: string) {
    setPushing(null);
    void runRemote('推送', async (projectId) => {
      const result = await backend.gitPush(projectId, remote, head);
      return `已推送到 ${result.upstream}`;
    });
  }

  /** 在锚点处打开分支弹窗；从状态栏打开时向上展开。 */
  function openBranches(x?: number, y?: number) {
    if (gitRef.current?.kind !== 'repository') return;
    setBranchPopup({
      x: x ?? window.innerWidth / 2 - 150,
      y: y ?? 80,
    });
  }

  function showLogPanel() {
    setSidebar(true);
    setPanel('log');
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
        activeRef.current?.startsWith('\0') ? null : activeRef.current,
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
    setLiveOpen(false);
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
    setBranchPopup(null);
    setPushing(null);
  }

  /** 切换或关闭项目时放弃上一个项目尚未写盘的展开记录。 */
  function clearExpandedTimer() {
    if (expandedTimer.current !== null)
      window.clearTimeout(expandedTimer.current);
    expandedTimer.current = null;
  }

  /** 记录文件树展开的目录，停止变化后写盘。 */
  function persistExpanded(paths: string[]) {
    setExpanded(paths);
    const workspace = projectRef.current;
    if (!desktop || !workspace) return;
    if (expandedTimer.current !== null)
      window.clearTimeout(expandedTimer.current);
    expandedTimer.current = window.setTimeout(() => {
      expandedTimer.current = null;
      backend
        .saveExpanded(workspace.id, paths.slice(0, MAX_EXPANDED))
        .catch((error) => {
          if (projectRef.current?.id === workspace.id)
            notify(`展开目录记录保存失败：${errorMessage(error)}`);
        });
    }, 400);
  }

  /** 在当前窗口打开项目；调用方负责处理当前项目的未保存内容。启动恢复时不强制显示侧边栏。 */
  async function loadProject(path: string, showSidebar = true) {
    const result = await backend.openProject(path);
    if (result.kind === 'focused') return;
    const next = result.project;
    desiredFile.current = null;
    restoring.current = false;
    recorded.current.clear();
    recoveryFailed.current = false;
    recoveryClosed.current = false;
    setQuickOpen(false);
    projectRef.current = next;
    clearExpandedTimer();
    setExpanded(result.tabs.expanded);
    setProject(next);
    resetGit();
    updateTabs([]);
    activate(null);
    setOpening(null);
    setNotice(result.warning ? { text: result.warning, error: true } : null);
    if (showSidebar) setSidebar(true);
    setWindowTitle(next);
    refreshRecent();
    void refreshGit(null);
    await restoreTabs(next, result.tabs);
    // 不等待用户选择，避免启动流程一直处于忙碌状态。
    void checkRecovery(next);
  }

  /** 已有项目时在新项目标签打开，空标签直接在当前标签打开。 */
  async function openRecent(root: string, here = false) {
    if (!desktop || busyRef.current || promptRef.current) return;
    setProjectMenu(false);
    busyRef.current = true;
    setBusy('打开项目');
    const workspace = projectRef.current;
    try {
      if (projectRef.current && !here) {
        await backend.openProjectWindow(root);
      } else if (await mayDiscard(tabsRef.current)) {
        await finishRecovery();
        await loadProject(root);
      }
    } catch (error) {
      notify(errorMessage(error));
      refreshRecent();
      if (workspace) resumeRecovery(workspace);
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
    const workspace = projectRef.current;
    try {
      if (!(await mayDiscard(tabsRef.current))) return;
      await finishRecovery();
      await backend.closeProject();
      setQuickOpen(false);
      desiredFile.current = null;
      restoring.current = false;
      projectRef.current = null;
      clearExpandedTimer();
      setExpanded([]);
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
      if (workspace) resumeRecovery(workspace);
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

  /** 按标签栏的可见顺序返回标识，普通文件、Diff 和实时预览共用关闭范围。 */
  function editorTabKeys() {
    return [
      ...tabsRef.current.map((tab) => tab.path),
      ...diffsRef.current.map((diff) => DIFF_PREFIX + diff.key),
      ...(liveOpen ? [LIVE_TAB] : []),
    ];
  }

  /** 整组确认未保存内容后再关闭，取消或保存失败时保留全部目标标签。 */
  async function closeEditorTabs(keys: string[]) {
    if (!idle() || !keys.length) return;
    const projectId = projectRef.current!.id;
    const remove = new Set(keys);
    busyRef.current = true;
    setBusy('关闭标签页');
    try {
      const candidates = tabsRef.current.filter((tab) => remove.has(tab.path));
      if (!(await mayDiscard(candidates))) return;
      if (projectRef.current?.id !== projectId) return;
      const old = editorTabKeys();
      const remaining = old.filter((key) => !remove.has(key));
      const current = activeRef.current;
      desiredFile.current = null;
      setOpening(null);
      updateTabs(tabsRef.current.filter((tab) => !remove.has(tab.path)));
      updateDiffs(
        diffsRef.current.filter((diff) => !remove.has(DIFF_PREFIX + diff.key)),
      );
      if (remove.has(LIVE_TAB)) setLiveOpen(false);
      if (current && remove.has(current)) {
        const index = old.indexOf(current);
        activate(
          old.slice(index + 1).find((key) => !remove.has(key)) ??
            old
              .slice(0, index)
              .reverse()
              .find((key) => !remove.has(key)) ??
            remaining[0] ??
            null,
        );
      }
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  /** 右键以命中的标签为基准，保持当前阅读标签不变。 */
  function showTabMenu(event: ReactMouseEvent, key: string) {
    event.preventDefault();
    if (!idle()) return;
    setMenu({
      marked: null,
      x: event.clientX,
      y: event.clientY,
      items: () => {
        const keys = editorTabKeys();
        const index = keys.indexOf(key);
        if (index < 0) return [];
        const closeItem = (label: string, targets: string[]): MenuItem => ({
          label,
          disabled: !targets.length,
          action: () => void closeEditorTabs(targets),
        });
        return [
          closeItem('关闭当前标签页', [key]),
          closeItem(
            '关闭其他标签页',
            keys.filter((item) => item !== key),
          ),
          'separator',
          closeItem('关闭左侧标签页', keys.slice(0, index)),
          closeItem('关闭右侧标签页', keys.slice(index + 1)),
          'separator',
          closeItem('关闭全部标签页', keys),
        ];
      },
    });
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
            ? DIFF_PREFIX + diffsRef.current[diffsRef.current.length - 1].key
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

  /**
   * 把未保存的标签内容写入恢复数据：有新编辑的写入，已保存、放弃或关闭的删除。
   * 写入串行执行；项目已正常关闭、确认框打开期间不写入。
   */
  function syncRecovery() {
    recoveryTimer.current = null;
    const workspace = projectRef.current;
    if (!desktop || !workspace || recoveryClosed.current) return;
    const open = new Map(tabsRef.current.map((tab) => [tab.path, tab]));
    const discard: string[] = [];
    const save: { path: string; doc: Text; revision: string }[] = [];
    for (const [path, doc] of recorded.current) {
      const tab = open.get(path);
      if (!tab || !isDirty(tab) || tab.state.doc.length > MAX_RECOVERY_LENGTH)
        discard.push(path);
      else if (tab.state.doc !== doc)
        save.push({ path, doc: tab.state.doc, revision: tab.revision });
    }
    for (const tab of tabsRef.current)
      if (
        isDirty(tab) &&
        !tab.truncated &&
        !recorded.current.has(tab.path) &&
        tab.state.doc.length <= MAX_RECOVERY_LENGTH
      )
        save.push({
          path: tab.path,
          doc: tab.state.doc,
          revision: tab.revision,
        });
    for (const path of discard) recorded.current.delete(path);
    for (const item of save) recorded.current.set(item.path, item.doc);
    if (!discard.length && !save.length) return;
    recoveryQueue.current = recoveryQueue.current.then(async () => {
      if (projectRef.current?.id !== workspace.id) return;
      if (discard.length)
        await backend.recoveryDiscard(workspace.id, discard).catch(() => {
          // 删除失败时留着记录，下次同步再删；残留的条目在恢复时会与磁盘内容比较。
        });
      for (const item of save) {
        try {
          await backend.recoverySave(
            workspace.id,
            item.path,
            item.doc.toString(),
            item.revision,
          );
          recoveryFailed.current = false;
        } catch (error) {
          if (projectRef.current?.id !== workspace.id) return;
          // 下次同步重试；连续失败只提示一次。
          if (recorded.current.get(item.path) === item.doc)
            recorded.current.delete(item.path);
          if (!recoveryFailed.current) {
            recoveryFailed.current = true;
            notify(`未保存内容的恢复数据写入失败：${errorMessage(error)}`);
          }
        }
      }
    });
  }

  /** 编辑后最多 RECOVERY_DELAY 毫秒写入一次恢复数据，持续输入时不会一直推迟。 */
  function scheduleRecovery() {
    if (recoveryTimer.current === null)
      recoveryTimer.current = window.setTimeout(syncRecovery, RECOVERY_DELAY);
  }

  /** 项目正常关闭前删除本次写入的恢复数据；用户选择“稍后处理”的条目保留。 */
  async function finishRecovery() {
    recoveryClosed.current = true;
    if (recoveryTimer.current !== null)
      window.clearTimeout(recoveryTimer.current);
    recoveryTimer.current = null;
    const workspace = projectRef.current;
    await recoveryQueue.current;
    const paths = [...recorded.current.keys()];
    recorded.current.clear();
    if (workspace && paths.length)
      await backend.recoveryDiscard(workspace.id, paths).catch(() => {});
  }

  /** 关闭或切换项目失败、仍留在当前项目时，继续写入恢复数据。 */
  function resumeRecovery(workspace: Project) {
    if (projectRef.current?.id !== workspace.id) return;
    recoveryClosed.current = false;
    syncRecovery();
  }

  /**
   * 打开项目后检查上次异常退出留下的未保存内容。与磁盘内容相同的直接删除；
   * 文件已不存在的保留并说明；其余列出供用户选择恢复、放弃或稍后处理。
   */
  async function checkRecovery(workspace: Project, manual = false) {
    let entries: RecoveryEntry[];
    try {
      entries = await backend.recoveryList(workspace.id);
    } catch (error) {
      if (projectRef.current?.id === workspace.id)
        notify(`读取恢复数据失败：${errorMessage(error)}`);
      return;
    }
    if (projectRef.current?.id !== workspace.id) return;
    const candidates: RecoveryEntry[] = [];
    const stale: string[] = [];
    const lost: string[] = [];
    for (const entry of entries) {
      // 本次已经写入的条目属于当前编辑，不是上次留下的。
      if (recorded.current.has(entry.path)) continue;
      const tab = tabsRef.current.find((item) => item.path === entry.path);
      if (tab && isDirty(tab)) continue;
      try {
        const document = await backend.readFile(workspace.id, entry.path);
        if (projectRef.current?.id !== workspace.id) return;
        if (document.truncated) lost.push(entry.path);
        else if (document.content === entry.content) stale.push(entry.path);
        else candidates.push(entry);
      } catch {
        if (projectRef.current?.id !== workspace.id) return;
        lost.push(entry.path);
      }
    }
    if (stale.length)
      await backend.recoveryDiscard(workspace.id, stale).catch(() => {});
    if (lost.length)
      notify(
        `${lost.length} 个文件有上次未保存的内容，但文件已不存在或无法编辑，无法恢复：${lost.map(baseName).join('、')}。内容仍保存在 ~/.nib/recovery 中。`,
      );
    if (!candidates.length) {
      if (manual && !lost.length) notify('没有需要恢复的未保存内容', false);
      return;
    }
    const decision = await ask(
      candidates.map((entry) => entry.path),
      'recover',
    );
    if (projectRef.current?.id !== workspace.id || decision === 'cancel')
      return;
    if (decision === 'discard') {
      await backend
        .recoveryDiscard(
          workspace.id,
          candidates.map((entry) => entry.path),
        )
        .catch((error) => notify(`删除恢复数据失败：${errorMessage(error)}`));
      return;
    }
    const changed: string[] = [];
    const failed: string[] = [];
    for (const entry of candidates) {
      const result = await applyRecovered(workspace, entry);
      if (projectRef.current?.id !== workspace.id) return;
      if (result === 'changed') changed.push(baseName(entry.path));
      else if (result === 'failed') failed.push(baseName(entry.path));
    }
    const restored = candidates.length - failed.length;
    notify(
      [
        restored ? `已恢复 ${restored} 个文件的未保存内容` : '',
        changed.length
          ? `${changed.join('、')} 在上次编辑后被外部修改，已暂停自动保存，请核对后手动保存`
          : '',
        failed.length ? `${failed.join('、')} 无法打开，恢复数据已保留` : '',
      ]
        .filter(Boolean)
        .join('。'),
      Boolean(changed.length || failed.length),
    );
  }

  /**
   * 把恢复内容作为一次编辑放回标签（可撤销），之后照常按磁盘版本检查保存冲突。
   * 文件在上次编辑后被外部修改时暂停自动保存，由用户核对。
   */
  async function applyRecovered(
    workspace: Project,
    entry: RecoveryEntry,
  ): Promise<'ok' | 'changed' | 'failed'> {
    let tab = tabsRef.current.find((item) => item.path === entry.path);
    if (!tab) {
      if (tabsRef.current.length + pendingFiles.current.size >= 30)
        return 'failed';
      try {
        const created = await createTab(
          entry.path,
          await backend.readFile(workspace.id, entry.path),
        );
        if (projectRef.current?.id !== workspace.id) return 'failed';
        tab = tabsRef.current.find((item) => item.path === entry.path);
        if (!tab) {
          tab = created;
          updateTabs([...tabsRef.current, created]);
          void loadHead(entry.path);
        }
      } catch {
        return 'failed';
      }
    }
    if (tab.truncated) return 'failed';
    const change = diffChange(tab.state.doc, entry.content);
    if (change) {
      const view = viewRef.current;
      if (view && activeRef.current === tab.path && view.state === tab.state) {
        view.dispatch({ changes: change });
        tab.state = view.state;
      } else tab.state = tab.state.update({ changes: change }).state;
    }
    const changed = tab.revision !== entry.revision;
    if (changed) tab.paused = true;
    updateTabs(tabsRef.current);
    if (!activeRef.current) activate(tab.path);
    return changed ? 'changed' : 'ok';
  }

  /** 打开文件并定位到 1 起始的行和 UTF-16 列，选中 length 个字符。 */
  async function openAt(path: string, line: number, column = 0, length = 0) {
    await openFile(path);
    if (activeRef.current !== path) return;
    revealKey.current += 1;
    setReveal({ path, line, column, length, key: revealKey.current });
  }

  function showQuickOpen() {
    if (!projectRef.current || busyRef.current || promptRef.current) return;
    setPalette(false);
    setSettings(false);
    setQuickOpen((value) => !value);
  }

  /** 打开项目搜索；当前编辑器选中单行文本时用它作为搜索内容。 */
  function showSearch() {
    if (!projectRef.current) return;
    const state = viewRef.current?.state;
    const range = state?.selection.main;
    const text =
      state && range && !range.empty
        ? state.sliceDoc(range.from, range.to)
        : '';
    setSidebar(true);
    setPanel('search');
    setSearchFocus((previous) => ({
      key: previous.key + 1,
      seed: text && !text.includes('\n') && text.length <= 200 ? text : null,
    }));
  }

  /** 实时观察复用一个主区标签，不为每次变化创建文件标签。 */
  function showLiveChanges() {
    if (!projectRef.current || busyRef.current || promptRef.current) return;
    desiredFile.current = null;
    setOpening(null);
    setSidebar(true);
    setPanel('live');
    setLiveOpen(true);
    activate(LIVE_TAB);
  }

  function closeLiveChanges() {
    setLiveOpen(false);
    if (activeRef.current === LIVE_TAB)
      activate(
        tabsRef.current.at(-1)?.path ??
          (diffsRef.current.length
            ? DIFF_PREFIX + diffsRef.current.at(-1)!.key
            : null),
      );
  }

  function showPalette() {
    setQuery('');
    setCommandIndex(0);
    setSettings(false);
    setQuickOpen(false);
    setPalette(true);
  }

  const commands: PaletteCommand[] = [
    {
      label: '快速打开文件',
      detail: `${mod} P`,
      action: showQuickOpen,
      disabled: !project,
    },
    {
      label: '在项目中搜索',
      detail: `${mod} ⇧ F`,
      action: showSearch,
      disabled: !project,
    },
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
      label: '文件',
      detail: '侧边栏',
      action: () => {
        setSidebar(true);
        setPanel('files');
      },
      disabled: !project,
    },
    {
      label: '实时变更',
      detail: '实时观察文件与 Diff',
      action: showLiveChanges,
      disabled: !project,
    },
    {
      label: '恢复上次未保存的内容',
      detail: '恢复',
      action: () => {
        if (projectRef.current) void checkRecovery(projectRef.current, true);
      },
      disabled: !project || !desktop,
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
      label: '提交记录',
      detail: 'Git Log',
      action: showLogPanel,
      disabled: !repository,
    },
    {
      label: '分支与远程操作',
      detail: 'Git Branches',
      action: () => openBranches(),
      disabled: !repository,
    },
    {
      label: '新建分支',
      detail: 'Git Branch',
      action: () => createBranch(),
      disabled: !repository,
    },
    {
      label: '添加远程仓库',
      detail: 'Git Remote',
      action: () => addRemote(),
      disabled: !repository || Boolean(remoteTask),
    },
    {
      label: '获取 (Fetch)',
      detail: 'Git',
      action: fetchRemote,
      disabled: !repository || Boolean(remoteTask),
    },
    {
      label: '拉取 (Pull，仅快进)',
      detail: 'Git',
      action: () => void pullRemote(),
      disabled: !repository || Boolean(remoteTask),
    },
    {
      label: '推送 (Push)',
      detail: `${mod} ⇧ K`,
      action: pushRemote,
      disabled: !repository || Boolean(remoteTask),
    },
    {
      label: repository?.operation === '变基' ? '继续变基' : '完成合并',
      detail: 'Git',
      action: () => void continueOperation(),
      disabled:
        repository?.operation !== '合并' && repository?.operation !== '变基',
    },
    {
      label: `中止${repository?.operation === '变基' ? '变基' : '合并'}`,
      detail: 'Git',
      action: () => void abortOperation(),
      disabled:
        repository?.operation !== '合并' && repository?.operation !== '变基',
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
      label: '复制当前文件的路径',
      detail: '文件',
      action: () => {
        if (selected && project)
          void copyText(`${project.root}/${selected.path}`, '路径');
      },
      disabled: !selected,
    },
    {
      label: '复制当前文件的相对路径',
      detail: '文件',
      action: () => {
        if (selected) void copyText(selected.path, '相对路径');
      },
      disabled: !selected,
    },
    {
      label: mac ? '在访达中显示当前文件' : '在文件管理器中显示当前文件',
      detail: '文件',
      action: () => {
        if (selected) revealEntry({ path: selected.path, isDir: false });
      },
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
      label: '增大字号',
      detail: `${mod} +`,
      action: () => setFontSize((size) => Math.min(24, size + 1)),
    },
    {
      label: '减小字号',
      detail: `${mod} −`,
      action: () => setFontSize((size) => Math.max(10, size - 1)),
    },
    {
      label: '重置字号',
      detail: `${mod} 0`,
      action: () => setFontSize(13),
    },
    {
      label: '切换缩进宽度',
      detail: `当前 ${tabSize}`,
      action: () => setTabSize((size) => (size === 2 ? 4 : size === 4 ? 8 : 2)),
    },
    {
      label: '设置',
      detail: `${mod} ,  字体 / 字号 / 缩进 / 换行 / 自动保存 / Git 显示`,
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
      if (current === LIVE_TAB) {
        closeLiveChanges();
        return;
      }
      if (current?.startsWith(DIFF_PREFIX)) {
        closeDiff(current.slice(DIFF_PREFIX.length));
        return;
      }
      const tab = tabsRef.current.find((item) => item.path === current);
      if (tab) void closeTabs([tab]);
    },
    palette: showPalette,
    quickOpen: showQuickOpen,
    search: showSearch,
    autoSave: autoSaveAll,
    filesChanged,
    commitPanel: showCommitPanel,
    push: pushRemote,
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

  /** 设置框中修改的设置项立即生效，稍后统一写盘。 */
  function changeSettings(patch: Partial<SettingValues>) {
    if (patch.fontFamily !== undefined) setFontFamily(patch.fontFamily);
    if (patch.fontSize !== undefined) setFontSize(patch.fontSize);
    if (patch.tabSize !== undefined) setTabSize(patch.tabSize);
    if (patch.wrap !== undefined) setWrap(patch.wrap);
    if (patch.autoSave !== undefined) setAutoSave(patch.autoSave);
    if (patch.changeTree !== undefined) setChangeTree(patch.changeTree);
    if (patch.unifiedDiff !== undefined) setUnified(patch.unifiedDiff);
  }

  /** 应用后台保存或其他窗口修改后的设置。 */
  function applySettings(next: Settings) {
    savedSettings.current = next;
    setFontFamily(next.fontFamily);
    setFontSize(next.fontSize);
    setTabSize(next.tabSize);
    setWrap(next.wrap);
    setAutoSave(next.autoSave);
    setChangeTree(next.changeTree);
    setUnified(next.unifiedDiff);
  }

  // 启动时读取设置和侧边栏宽度；读取完成前不写盘，避免用默认值覆盖已保存的设置。
  useEffect(() => {
    if (!desktop) return;
    backend
      .getSettings()
      .then((next) => {
        applySettings(next);
        settingsLoaded.current = true;
      })
      .catch((error) => notify(`读取设置失败：${errorMessage(error)}`));
    backend
      .getLayout()
      .then((layout) => {
        if (layout.sidebarWidth) {
          savedSidebarWidth.current = layout.sidebarWidth;
          setSidebarWidth(layout.sidebarWidth);
        }
        sidebarLoaded.current = true;
        const view: View = {
          sidebar: layout.sidebar ?? true,
          panel: layout.panel ?? 'files',
        };
        setSidebar(view.sidebar);
        setPanel(view.panel);
        savedView.current = JSON.stringify(view);
        viewLoaded.current = true;
      })
      .catch(() => {
        sidebarLoaded.current = true;
        viewLoaded.current = true;
      });
  }, []);

  // 侧边栏显示与当前面板停止变化后写盘。
  useEffect(() => {
    if (!desktop || !viewLoaded.current) return;
    const view: View = { sidebar, panel };
    const key = JSON.stringify(view);
    if (key === savedView.current) return;
    const timer = window.setTimeout(() => {
      backend
        .saveView(view)
        .then(() => {
          savedView.current = key;
        })
        .catch((error) => notify(`侧边栏状态保存失败：${errorMessage(error)}`));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [sidebar, panel]);

  // 设置变化后稍后写盘；保存失败时退回上次保存的设置。
  useEffect(() => {
    if (!settingsLoaded.current) return;
    const saved = savedSettings.current;
    const next: Settings = {
      version: saved?.version ?? 1,
      fontFamily,
      fontSize,
      tabSize,
      wrap,
      autoSave,
      changeTree,
      unifiedDiff: unified,
    };
    if (
      saved &&
      saved.fontFamily === next.fontFamily &&
      saved.fontSize === next.fontSize &&
      saved.tabSize === next.tabSize &&
      saved.wrap === next.wrap &&
      saved.autoSave === next.autoSave &&
      saved.changeTree === next.changeTree &&
      saved.unifiedDiff === next.unifiedDiff
    )
      return;
    if (settingsTimer.current !== null)
      window.clearTimeout(settingsTimer.current);
    settingsTimer.current = window.setTimeout(() => {
      settingsTimer.current = null;
      backend
        .saveSettings(next)
        .then(applySettings)
        .catch((error) => {
          notify(`设置保存失败：${errorMessage(error)}`);
          if (savedSettings.current) applySettings(savedSettings.current);
        });
    }, SETTINGS_DELAY);
  }, [fontFamily, fontSize, tabSize, wrap, autoSave, changeTree, unified]);

  // 侧边栏宽度停止变化后写盘。
  useEffect(() => {
    if (!desktop || !sidebarLoaded.current) return;
    if (sidebarWidth === savedSidebarWidth.current) return;
    const timer = window.setTimeout(() => {
      backend
        .saveSidebarWidth(sidebarWidth)
        .then(() => {
          savedSidebarWidth.current = sidebarWidth;
        })
        .catch((error) => notify(`侧边栏宽度保存失败：${errorMessage(error)}`));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [sidebarWidth]);

  // 标签内容或状态变化后计划写入恢复数据。
  useEffect(() => {
    scheduleRecovery();
  }, [tabs]);

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
      if (
        promptRef.current ||
        namingRef.current ||
        pushingRef.current !== null
      ) {
        if (['s', 'w', 'o', 'p', 'b', 'n', 'k', 'f', ','].includes(key))
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
      } else if (key === 'k' && event.shiftKey && !event.altKey) {
        // 打开推送确认框，与 GoLand 的 ⌘⇧K 一致；实际推送仍需确认。
        event.preventDefault();
        operations.current.push();
      } else if (key === 'k' && !event.shiftKey) {
        // 打开提交面板，与 GoLand 的 ⌘K 一致。
        event.preventDefault();
        operations.current.commitPanel();
      } else if (key === 'p' && event.shiftKey) {
        event.preventDefault();
        operations.current.palette();
      } else if (key === 'p') {
        event.preventDefault();
        operations.current.quickOpen();
      } else if (key === 'f' && event.shiftKey) {
        event.preventDefault();
        operations.current.search();
      } else if (key === ',') {
        event.preventDefault();
        setSettings((value) => !value);
      } else if (['=', '+', '-'].includes(key)) {
        event.preventDefault();
        setFontSize((size) =>
          Math.max(
            FONT_SIZE.min,
            Math.min(FONT_SIZE.max, size + (key === '-' ? -1 : 1)),
          ),
        );
      } else if (key === '0') {
        event.preventDefault();
        setFontSize(DEFAULT_SETTINGS.fontSize);
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
          const workspace = projectRef.current;
          if (await mayDiscard(tabsRef.current)) {
            await finishRecovery();
            try {
              await getCurrentWindow().destroy();
            } catch (error) {
              if (workspace) resumeRecovery(workspace);
              throw error;
            }
          }
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
      // 其他窗口修改了设置。
      listen<Settings>('nib://settings-changed', ({ payload }) =>
        applySettings(payload),
      ),
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
        if (root) await loadProject(root, false);
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
    if (!palette && !quickOpen && !settings && !prompt && !projectMenu)
      viewRef.current?.focus();
  }, [palette, quickOpen, settings, prompt, projectMenu]);

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
          ...(fontFamily
            ? {
                '--editor-font': `${cssFontFamily(fontFamily)}, ${DEFAULT_EDITOR_FONT}`,
              }
            : {}),
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
          title={`设置 (${mod}+,)`}
          aria-label="设置"
          aria-haspopup="dialog"
          aria-expanded={settings}
        >
          <SettingsIcon size={16} />
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
                    aria-label="文件"
                    title="文件"
                  >
                    <Files size={14} />
                  </button>
                  <button
                    role="tab"
                    aria-selected={panel === 'commit'}
                    className={panel === 'commit' ? 'active' : ''}
                    onClick={showCommitPanel}
                    disabled={!project}
                    aria-label="提交"
                    title={`提交 (${mod}+K)`}
                  >
                    <GitCommitHorizontal size={14} />
                    {Boolean(repository?.files.length) && (
                      <span className="sidebar-badge">
                        {repository!.files.length}
                      </span>
                    )}
                  </button>
                  <button
                    role="tab"
                    aria-selected={panel === 'log'}
                    className={panel === 'log' ? 'active' : ''}
                    onClick={showLogPanel}
                    disabled={!project}
                    aria-label="提交记录"
                    title="当前分支的提交记录"
                  >
                    <History size={14} />
                  </button>
                  <button
                    role="tab"
                    aria-selected={panel === 'live'}
                    className={panel === 'live' ? 'active' : ''}
                    onClick={showLiveChanges}
                    disabled={!project}
                    aria-label="实时变更"
                    title="实时变更 · 观察外部工具的文件修改"
                  >
                    <Radio size={14} />
                  </button>
                  <button
                    role="tab"
                    aria-selected={panel === 'search'}
                    aria-label="搜索"
                    className={panel === 'search' ? 'active' : ''}
                    onClick={showSearch}
                    disabled={!project}
                    title={`在项目中搜索 (${mod}+Shift+F)`}
                  >
                    <Search size={14} />
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
                  selected={
                    selectedDiff && !selectedDiff.commit
                      ? selectedDiff.path
                      : null
                  }
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
                  remoteTask={remoteTask}
                  onBranches={openBranches}
                  onPull={() => void pullRemote()}
                  onPush={pushRemote}
                  tree={changeTree}
                  onTree={setChangeTree}
                  onResolve={(paths) => void resolveConflicts(paths)}
                  onContinue={() => void continueOperation()}
                  onSkip={() => void skipCommit()}
                  onAbort={() => void abortOperation()}
                />
              ) : project && panel === 'live' ? (
                <LiveChangesPanel
                  files={live.files}
                  selected={live.selected}
                  following={live.following}
                  status={git}
                  loading={gitLoading}
                  error={gitError}
                  rescan={live.rescan}
                  onSelect={(path) => {
                    if (idle()) {
                      live.select(path);
                      showLiveChanges();
                    }
                  }}
                  onFollow={live.follow}
                  onPause={live.pause}
                  onRefresh={() => {
                    void live.record({
                      projectId: project.id,
                      paths: [],
                      rescan: true,
                      git: false,
                    });
                    void refreshGit(null);
                  }}
                />
              ) : project && panel === 'log' ? (
                repository ? (
                  <LogPanel
                    key={project.id}
                    projectId={project.id}
                    version={`${repository.head}:${repository.branch}:${refsVersion}`}
                    selected={selectedDiff?.commit ? selectedDiff.key : null}
                    onOpenFile={openCommitDiff}
                    onCopy={(text) => void copyText(text, '提交哈希')}
                  />
                ) : (
                  <div className="git-empty">
                    <History size={22} strokeWidth={1.3} />
                    <p>
                      {git?.kind === 'unavailable'
                        ? 'Git 不可用'
                        : git?.kind === 'notRepository'
                          ? '不是 Git 项目'
                          : (gitError ?? '正在读取 Git 状态…')}
                    </p>
                  </div>
                )
              ) : project && panel === 'search' ? null : project ? (
                <Explorer
                  key={project.id}
                  project={project}
                  selected={active}
                  changes={treeChanges}
                  gitKinds={gitKinds}
                  gitDirs={gitDirs}
                  marked={menu?.marked ?? null}
                  reveal={treeReveal}
                  initialExpanded={expanded}
                  onExpanded={persistExpanded}
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
              {project && (
                // 切换到其他面板时保留搜索内容和结果。
                <div
                  className="search-host"
                  style={{ display: panel === 'search' ? undefined : 'none' }}
                >
                  <SearchPanel
                    key={project.id}
                    projectId={project.id}
                    focus={searchFocus}
                    onOpen={(path, match) =>
                      void openAt(path, match.line, match.column, match.length)
                    }
                  />
                </div>
              )}
              <div className="sidebar-bottom">
                <span className="version-dot" />
                <span>Nib 0.1</span>
                <span className="phase-label">阶段三</span>
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
                // 缩放或高分屏下 clientX 可能为小数，后端按整数像素保存
                const move = (pointer: PointerEvent) =>
                  setSidebarWidth(
                    Math.max(180, Math.min(420, Math.round(pointer.clientX))),
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
                  onContextMenu={(event) => showTabMenu(event, tab.path)}
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
                    <span
                      className={
                        gitKinds.has(tab.path)
                          ? `git-${gitKinds.get(tab.path)}`
                          : undefined
                      }
                    >
                      {baseName(tab.path)}
                    </span>
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
                  key={DIFF_PREFIX + diff.key}
                  className={`tab diff-tab ${active === DIFF_PREFIX + diff.key ? 'active' : ''}`}
                  onContextMenu={(event) =>
                    showTabMenu(event, DIFF_PREFIX + diff.key)
                  }
                >
                  <button
                    role="tab"
                    aria-selected={active === DIFF_PREFIX + diff.key}
                    title={
                      diff.commit
                        ? `${diff.path} 在 ${diff.commit.hash.slice(0, 7)} 中的变更 · ${diff.commit.subject}`
                        : `${diff.path} 的变更`
                    }
                    onClick={() => {
                      desiredFile.current = null;
                      activate(DIFF_PREFIX + diff.key);
                      setOpening(null);
                    }}
                    onMouseDown={(event) => {
                      if (event.button === 1) {
                        event.preventDefault();
                        closeDiff(diff.key);
                      }
                    }}
                  >
                    {diff.commit ? (
                      <History size={13} />
                    ) : (
                      <GitCompare size={13} />
                    )}
                    <span
                      className={
                        !diff.commit && gitKinds.has(diff.path)
                          ? `git-${gitKinds.get(diff.path)}`
                          : undefined
                      }
                    >
                      {baseName(diff.path)}
                      {diff.commit && ` @ ${diff.commit.hash.slice(0, 7)}`}
                    </span>
                  </button>
                  <button
                    className="tab-close"
                    aria-label={`关闭 ${baseName(diff.path)} 的变更`}
                    title="关闭变更"
                    onClick={() => closeDiff(diff.key)}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              {liveOpen && project && (
                <div
                  className={`tab live-tab ${active === LIVE_TAB ? 'active' : ''}`}
                  onContextMenu={(event) => showTabMenu(event, LIVE_TAB)}
                >
                  <button
                    role="tab"
                    aria-selected={active === LIVE_TAB}
                    onClick={showLiveChanges}
                    onMouseDown={(event) => {
                      if (event.button === 1) {
                        event.preventDefault();
                        closeLiveChanges();
                      }
                    }}
                  >
                    <Radio size={13} />
                    <span>实时变更</span>
                  </button>
                  <button
                    className="tab-close"
                    aria-label="关闭实时变更"
                    onClick={closeLiveChanges}
                  >
                    <X size={12} />
                  </button>
                </div>
              )}
              {!tabs.length && !diffs.length && !liveOpen && (
                <span className="tab-placeholder">工作区</span>
              )}
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
              indent={tabSize}
              locked={Boolean(busy) || Boolean(prompt)}
              reveal={reveal}
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
            {project && active === LIVE_TAB && (
              <div className="diff-layer live-view">
                <div className="live-view-heading">
                  <Radio size={14} />
                  <span
                    className="live-view-path"
                    title={live.displayed ?? undefined}
                  >
                    {live.displayed ?? '实时变更'}
                  </span>
                  {live.loading && (
                    <LoaderCircle
                      size={12}
                      className="spin"
                      aria-label="正在更新预览"
                    />
                  )}
                  <span className="live-disk-label">
                    {live.preview ? '磁盘预览' : 'HEAD → 当前磁盘'}
                  </span>
                  <button
                    className={`secondary-button ${live.following ? 'active' : ''}`}
                    aria-pressed={live.following}
                    onClick={() =>
                      live.following ? live.pause() : live.follow()
                    }
                    disabled={!live.files.length}
                  >
                    {live.following ? '正在跟随' : '回到最新'}
                  </button>
                </div>
                {tabs.some(
                  (tab) => tab.path === live.displayed && isDirty(tab),
                ) && (
                  <div className="live-unsaved">
                    此文件有未保存的编辑，下面仅显示磁盘内容。
                  </div>
                )}
                {live.diff ? (
                  <DiffView
                    diff={live.diff}
                    unified={unified}
                    onToggleUnified={() => setUnified((value) => !value)}
                    onOpenFile={(path) => void openFile(path)}
                    onRestore={() => {}}
                    onRevert={async () => false}
                    readOnly
                    preview={live.preview}
                    follow={live.following}
                    onInteract={live.pause}
                  />
                ) : live.selected ? (
                  <div className="diff-message">
                    <LoaderCircle size={14} className="spin" /> 正在读取文件…
                  </div>
                ) : (
                  <div className="live-waiting">
                    <Radio size={34} strokeWidth={1.2} />
                    <h2>等待文件变化</h2>
                    <p>
                      在外部 Agent 或编辑器中保存文件，变更会自动显示在这里。
                    </p>
                    <span>
                      {live.preview
                        ? '非 Git 项目显示最新内容'
                        : '选择左侧文件查看差异，或开启跟随最新变化'}
                    </span>
                  </div>
                )}
              </div>
            )}
            {!selected && !selectedDiff && active !== LIVE_TAB && (
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
                      从左侧文件树选择文件，或按 {mod} P 快速打开。
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
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                openBranches(rect.left, rect.top);
              }}
              title={`分支与远程操作 · ${repository.root}${repository.upstream ? ` · 上游 ${repository.upstream}` : ''}`}
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
        <SettingsDialog
          values={{
            fontFamily,
            fontSize,
            tabSize,
            wrap,
            autoSave,
            changeTree,
            unifiedDiff: unified,
          }}
          mod={mod}
          onChange={changeSettings}
          onClose={() => setSettings(false)}
        />
      )}

      {quickOpen && project && (
        <QuickOpen
          key={project.id}
          projectId={project.id}
          // 其他已打开的文件在前，当前文件放最后，回车即可切换到别的文件。
          recent={[
            ...tabs.filter((tab) => tab.path !== active),
            ...tabs.filter((tab) => tab.path === active),
          ].map((tab) => tab.path)}
          onOpen={(path, line) => {
            if (line) void openAt(path, line);
            else void openFile(path);
          }}
          onClose={() => setQuickOpen(false)}
        />
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
      {branchPopup && project && (
        <BranchPopup
          projectId={project.id}
          x={branchPopup.x}
          y={branchPopup.y}
          remoteTask={remoteTask}
          onClose={() => setBranchPopup(null)}
          onAction={branchAction}
        />
      )}
      {pushing !== null && project?.id === pushing && (
        <PushDialog
          projectId={pushing}
          onPush={confirmPush}
          onClose={() => setPushing(null)}
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
          ) : kind === 'recover' ? (
            <ArchiveRestore size={22} />
          ) : kind === 'rebase' ? (
            <GitMerge size={22} />
          ) : kind === 'delete' ||
            kind === 'removeRemote' ||
            branchPrompts.has(kind) ? (
            <Trash2 size={22} />
          ) : (
            <Undo2 size={22} />
          )}
        </div>
        <h2 id="unsaved-title">
          {kind === 'unsaved' || kind === 'recover'
            ? promptChoices[kind].title
            : confirmations[kind].title}
        </h2>
        <p id="unsaved-description">
          {kind === 'unsaved' || kind === 'recover'
            ? promptChoices[kind].description
            : confirmations[kind].description}
          {note && <strong className="dialog-note">{note}</strong>}
        </p>
        <ul>
          {paths.map((path) => (
            <li key={path}>
              {kind === 'removeRemote' ? (
                <Server size={14} />
              ) : branchPrompts.has(kind) ? (
                <GitBranch size={14} />
              ) : (
                <FileCode2 size={14} />
              )}
              <span>{path}</span>
            </li>
          ))}
        </ul>
        {kind === 'unsaved' || kind === 'recover' ? (
          <div className="dialog-actions">
            <button
              className="secondary-button"
              onClick={() => onDecide('cancel')}
            >
              {promptChoices[kind].cancel}
            </button>
            <button
              className="text-button danger"
              onClick={() => onDecide('discard')}
            >
              {promptChoices[kind].discard}
            </button>
            <button className="primary-button" onClick={() => onDecide('save')}>
              {promptChoices[kind].save}
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
