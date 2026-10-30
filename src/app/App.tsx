import type {CSSProperties} from 'react';
import {useEffect, useRef, useState} from 'react';
import type {EditorState} from '@codemirror/state';
import {Transaction} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
import {redo, undo} from '@codemirror/commands';
import {openSearchPanel} from '@codemirror/search';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {getCurrentWebviewWindow} from '@tauri-apps/api/webviewWindow';
import {listen} from '@tauri-apps/api/event';
import {open} from '@tauri-apps/plugin-dialog';
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
    Keyboard,
    LoaderCircle,
    PanelLeft,
    PenLine,
    RotateCw,
    Save,
    Search,
    Settings2,
    WrapText,
    X,
} from 'lucide-react';
import type {FileChanges, Project, ProjectTabs, RecentProject,} from '../lib/backend';
import {backend, desktop, errorMessage} from '../lib/backend';
import {Editor} from '../features/editor/Editor';
import type {Tab} from '../features/editor/model';
import {createTab, diffChange, formatSize, isDirty, languageName, serialize,} from '../features/editor/model';
import type {TreeChanges} from '../features/explorer/Explorer';
import {Explorer} from '../features/explorer/Explorer';
import {ProjectMenu, RecentList} from '../features/projects/ProjectMenu';

type Decision = 'save' | 'discard' | 'cancel';
interface Prompt {
  paths: string[];
  resolve: (decision: Decision) => void;
}
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
  const selected = tabs.find((tab) => tab.path === active);
  const dirtyCount = tabs.filter(isDirty).length;
  const operations = useRef({
    openProject: () => {},
    newWindow: () => {},
    save: () => {},
    close: () => {},
    palette: () => {},
    autoSave: () => {},
    filesChanged: (_changes: FileChanges) => {},
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

  function ask(paths: string[]): Promise<Decision> {
    if (promptRef.current) return Promise.resolve('cancel');
    return new Promise((resolve) => {
      const next = { paths, resolve };
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
        return;
      }
      applyDisk(tab, document);
    } catch (error) {
      const tab = tabsRef.current.find((item) => item.path === path);
      if (!tab || projectRef.current?.id !== workspace.id) return;
      // 文件被删除、改名或变为不可编辑：保留编辑内容，暂停自动保存，避免重新写回。
      if (!tab.paused) {
        tab.paused = true;
        updateTabs(tabsRef.current);
        notify(
          `${baseName(path)}：${errorMessage(error)} 已暂停该文件的自动保存。`,
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

  /** 后台推送一批文件变化：刷新文件树并同步受影响的已打开标签。 */
  function filesChanged(changes: FileChanges) {
    const workspace = projectRef.current;
    if (!workspace || changes.projectId !== workspace.id) return;
    setTreeChanges((previous) => ({
      key: previous.key + 1,
      paths: changes.rescan ? null : changes.paths,
    }));
    const changed = new Set(changes.paths);
    for (const tab of tabsRef.current)
      if (changes.rescan || changed.has(tab.path)) void syncTab(tab.path);
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
        activeRef.current,
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

  /** 在当前窗口打开项目；调用方负责处理当前项目的未保存内容。 */
  async function loadProject(path: string) {
    const result = await backend.openProject(path);
    if (result.kind === 'focused') return;
    const next = result.project;
    desiredFile.current = null;
    restoring.current = false;
    projectRef.current = next;
    setProject(next);
    updateTabs([]);
    activate(null);
    setOpening(null);
    setNotice(result.warning ? { text: result.warning, error: true } : null);
    setSidebar(true);
    setWindowTitle(next);
    refreshRecent();
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
      const remove = new Set(candidates.map((tab) => tab.path));
      const old = tabsRef.current;
      const next = old.filter((tab) => !remove.has(tab.path));
      if (activeRef.current && remove.has(activeRef.current)) {
        const index = old.findIndex((tab) => tab.path === activeRef.current);
        activate(next[Math.min(index, next.length - 1)]?.path ?? null);
      }
      updateTabs(next);
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
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
      const tab = tabsRef.current.find(
        (item) => item.path === activeRef.current,
      );
      if (tab) void closeTabs([tab]);
    },
    palette: showPalette,
    autoSave: autoSaveAll,
    filesChanged,
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

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.isComposing || !(mac ? event.metaKey : event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (promptRef.current) {
        if (['s', 'w', 'o', 'p', 'b', 'n'].includes(key))
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
        if (payload) refreshRecent();
        else operations.current.autoSave();
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
                <span>
                  <Files size={14} /> 文件
                </span>
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
              {project ? (
                <Explorer
                  key={project.id}
                  project={project}
                  selected={active}
                  changes={treeChanges}
                  onOpen={(path) => void openFile(path)}
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
                <span className="phase-label">阶段一</span>
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
              {!tabs.length && <span className="tab-placeholder">工作区</span>}
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
            {!selected && (
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

      {prompt && <UnsavedDialog paths={prompt.paths} onDecide={decide} />}
    </main>
  );
}

/** 危险操作前提供保存、放弃与返回三种明确选择，并锁定键盘焦点。 */
function UnsavedDialog({
  paths,
  onDecide,
}: {
  paths: string[];
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
          <ArrowDownToLine size={22} />
        </div>
        <h2 id="unsaved-title">保存这次修改？</h2>
        <p id="unsaved-description">
          以下文件的修改尚未保存到磁盘。放弃后将无法恢复。
        </p>
        <ul>
          {paths.map((path) => (
            <li key={path}>
              <FileCode2 size={14} />
              <span>{path}</span>
            </li>
          ))}
        </ul>
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
      </div>
    </div>
  );
}
