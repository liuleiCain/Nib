import { invoke, isTauri } from '@tauri-apps/api/core';

export const desktop = isTauri();

export interface Project {
  id: number;
  name: string;
  root: string;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
}

export interface Directory {
  entries: FileEntry[];
  skippedNames: number;
}

export interface Document {
  content: string;
  revision: string;
  newline: 'LF' | 'CRLF' | 'CR';
  hasBom: boolean;
  mixedNewlines: boolean;
  /** 超过可编辑上限，content 只是开头部分，只读展示且不保存。 */
  truncated: boolean;
  /** 磁盘文件总字节数。 */
  size: number;
}

/** 项目上次打开的标签，路径相对项目根目录。 */
export interface ProjectTabs {
  tabs: string[];
  active: string | null;
}

/** 在当前窗口打开项目的结果；项目已在其他窗口打开时只切换窗口。 */
export type OpenResult =
  | {
      kind: 'opened';
      project: Project;
      tabs: ProjectTabs;
      warning: string | null;
    }
  | { kind: 'focused' };

export interface RecentProject {
  root: string;
  name: string;
  available: boolean;
}

/** 后台合并后推送的一批项目文件变化，路径相对项目根目录；rescan 表示需整体刷新。 */
export interface FileChanges {
  projectId: number;
  paths: string[];
  rescan: boolean;
  /** .git 的 HEAD、索引或引用有变化。 */
  git: boolean;
}

/** 合并暂存区与工作区后的文件状态。 */
export type ChangeKind =
  'modified' | 'added' | 'deleted' | 'renamed' | 'conflicted' | 'untracked';

/** 一个变更文件，路径相对项目根目录；项目外的重命名原路径以 ../ 开头。 */
export interface FileChange {
  path: string;
  original: string | null;
  kind: ChangeKind;
  submodule: boolean;
}

/** 项目所属仓库的分支与相对 HEAD 的变更。 */
export interface Repository {
  root: string;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** 正在进行的合并、变基等操作。 */
  operation: string | null;
  files: FileChange[];
  truncated: boolean;
}

export type GitStatus =
  | { kind: 'unavailable'; message: string }
  | { kind: 'notRepository' }
  | ({ kind: 'repository' } & Repository);

/** Diff 一侧的内容；文本已统一为 LF 并去掉 BOM。 */
export type Side =
  | { kind: 'text'; content: string }
  | { kind: 'missing' }
  | { kind: 'binary' }
  | { kind: 'tooLarge' }
  | { kind: 'unsupported'; message: string };

export interface DiffSources {
  base: Side;
  current: Side;
}

export interface CommitResult {
  hash: string;
  summary: string;
}

/** 统一提取后台结构化错误与运行时异常的可读说明。 */
export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error.message);
  }
  return String(error);
}

/** 提取后台结构化错误的错误码，非后台错误返回 null。 */
export function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String(error.code);
  }
  return null;
}

/** 前端仅通过这些受控命令访问当前窗口的工作区文件与会话记录。 */
export const backend = {
  windowStartup: () => invoke<string | null>('window_startup'),
  openProject: (path: string) => invoke<OpenResult>('open_project', { path }),
  openProjectWindow: (path: string) =>
    invoke<void>('open_project_window', { path }),
  newWindow: () => invoke<void>('new_window'),
  closeProject: () => invoke<void>('close_project'),
  recentProjects: () => invoke<RecentProject[]>('recent_projects'),
  forgetProject: (root: string) => invoke<void>('forget_project', { root }),
  saveTabs: (projectId: number, tabs: string[], active: string | null) =>
    invoke<void>('save_tabs', { projectId, tabs, active }),
  cancelQuit: () => invoke<void>('cancel_quit'),
  listDirectory: (projectId: number, path: string) =>
    invoke<Directory>('list_directory', { projectId, path }),
  readFile: (projectId: number, path: string) =>
    invoke<Document>('read_file', { projectId, path }),
  saveFile: (
    projectId: number,
    path: string,
    content: string,
    expectedRevision: string,
  ) =>
    invoke<string>('save_file', {
      projectId,
      path,
      content,
      expectedRevision,
    }),
  gitStatus: (projectId: number) =>
    invoke<GitStatus>('git_status', { projectId }),
  gitDiff: (projectId: number, path: string, original: string | null) =>
    invoke<DiffSources>('git_diff', { projectId, path, original }),
  gitHeadFile: (projectId: number, path: string) =>
    invoke<Side>('git_head_file', { projectId, path }),
  /** 只提交 paths 中的文件；untracked 为其中的未跟踪文件。 */
  gitCommit: (
    projectId: number,
    message: string,
    paths: string[],
    untracked: string[],
  ) =>
    invoke<CommitResult>('git_commit', {
      projectId,
      message,
      paths,
      untracked,
    }),
  /** 从 HEAD 恢复已删除的文件。 */
  gitRestore: (projectId: number, path: string) =>
    invoke<void>('git_restore', { projectId, path }),
  /** 将未跟踪文件加入版本控制，不提交。 */
  gitAdd: (projectId: number, paths: string[]) =>
    invoke<void>('git_add', { projectId, paths }),
  /** 回滚变更：修改与删除恢复为 HEAD，重命名恢复原路径，新增取消加入版本控制。 */
  gitRollback: (projectId: number, paths: string[]) =>
    invoke<void>('git_rollback', { projectId, paths }),
  /** 把未跟踪的文件或目录写入项目根目录的 .gitignore。 */
  gitIgnore: (projectId: number, paths: string[]) =>
    invoke<void>('git_ignore', { projectId, paths }),
  /** 在 parent 目录下新建空文件或目录，返回新路径。 */
  createEntry: (
    projectId: number,
    parent: string,
    name: string,
    directory: boolean,
  ) => invoke<string>('create_entry', { projectId, parent, name, directory }),
  /** 重命名文件或目录，返回新路径。 */
  renameEntry: (projectId: number, path: string, name: string) =>
    invoke<string>('rename_entry', { projectId, path, name }),
  /** 移到系统废纸篓。 */
  trashEntry: (projectId: number, path: string) =>
    invoke<void>('trash_entry', { projectId, path }),
  /** 在系统文件管理器中显示；path 为空时显示项目根目录。 */
  revealEntry: (projectId: number, path: string) =>
    invoke<void>('reveal_entry', { projectId, path }),
};
