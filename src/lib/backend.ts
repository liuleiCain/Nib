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

/** 合并、变基、继续或跳过的结果；stopped 时仓库停在进行中的状态。 */
export type Integration =
  | { kind: 'upToDate' }
  | { kind: 'done'; hash: string }
  | {
      kind: 'stopped';
      /** 未解决冲突的文件（相对项目根目录），最多列出 20 个。 */
      files: string[];
      total: number;
      /** 没有冲突时 Git 给出的停止原因。 */
      message: string | null;
    };

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

/** 指向提交的引用：head 为当前分支。 */
export interface CommitRef {
  name: string;
  kind: 'head' | 'branch' | 'remote' | 'tag';
}

/** 提交记录中的一个提交；time 为 Unix 秒。 */
export interface CommitSummary {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  subject: string;
  refs: CommitRef[];
}

export interface LogPage {
  commits: CommitSummary[];
  /** 还有更早的提交。 */
  more: boolean;
}

/** 提交中变更的文件，路径相对项目根目录。 */
export interface CommitFile {
  path: string;
  original: string | null;
  kind: ChangeKind;
}

/** 提交详情；合并提交的文件与第一个父提交比较。 */
export interface CommitDetail {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  committer: string;
  commitTime: number;
  message: string;
  files: CommitFile[];
  truncated: boolean;
}

export interface LocalBranch {
  name: string;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** 上游分支已在远程删除。 */
  gone: boolean;
  time: number;
}

/** 远程仓库；地址中的密码已隐藏。 */
export interface Remote {
  name: string;
  url: string;
}

/** 本地记录的远程分支，获取后更新。 */
export interface RemoteBranch {
  /** 显示名，如 origin/feature/x。 */
  name: string;
  remote: string;
  /** 远程仓库中的分支名。 */
  branch: string;
  time: number;
}

export interface Branches {
  current: string | null;
  local: LocalBranch[];
  remoteBranches: RemoteBranch[];
  /** 远程分支过多，只返回了前一部分。 */
  remoteTruncated: boolean;
  remotes: Remote[];
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
  /** 当前分支的一页提交记录，skip 为已加载的数量。 */
  gitLog: (projectId: number, skip: number) =>
    invoke<LogPage>('git_log', { projectId, skip }),
  gitCommitDetail: (projectId: number, commit: string) =>
    invoke<CommitDetail>('git_commit_detail', { projectId, commit }),
  /** 提交中一个文件相对第一个父提交的两侧内容。 */
  gitCommitDiff: (
    projectId: number,
    commit: string,
    path: string,
    original: string | null,
  ) =>
    invoke<DiffSources>('git_commit_diff', {
      projectId,
      commit,
      path,
      original,
    }),
  gitBranches: (projectId: number) =>
    invoke<Branches>('git_branches', { projectId }),
  /** 新建分支并切换过去；start 为起点分支的完整引用名，为空时从当前 HEAD 新建。返回分支名。 */
  gitCreateBranch: (projectId: number, name: string, start: string | null) =>
    invoke<string>('git_create_branch', { projectId, name, start }),
  /** 检出远程分支为跟踪它的本地分支；返回本地分支名。 */
  gitCheckoutRemote: (projectId: number, remote: string, branch: string) =>
    invoke<string>('git_checkout_remote', { projectId, remote, branch }),
  gitRenameBranch: (projectId: number, name: string, target: string) =>
    invoke<string>('git_rename_branch', { projectId, name, target }),
  /** 删除本地分支；未合并时返回 NOT_MERGED 错误，确认后以 force 重试。 */
  gitDeleteBranch: (projectId: number, name: string, force: boolean) =>
    invoke<void>('git_delete_branch', { projectId, name, force }),
  gitDeleteRemoteBranch: (projectId: number, remote: string, branch: string) =>
    invoke<void>('git_delete_remote_branch', { projectId, remote, branch }),
  gitSwitchBranch: (projectId: number, name: string) =>
    invoke<void>('git_switch_branch', { projectId, name }),
  gitFetch: (projectId: number) => invoke<void>('git_fetch', { projectId }),
  /** 仅快进拉取当前分支的上游；commits 为 0 表示已是最新。 */
  gitPull: (projectId: number) =>
    invoke<{ upstream: string; commits: number }>('git_pull', { projectId }),
  /** 推送当前分支；没有上游时需指定 remote，推送后设为上游。 */
  gitPush: (projectId: number, remote: string | null) =>
    invoke<{ upstream: string }>('git_push', { projectId, remote }),
  /** 把目标分支（完整引用名）合并到当前分支；要求没有未提交的修改。 */
  gitMerge: (projectId: number, target: string) =>
    invoke<Integration>('git_merge', { projectId, target }),
  /** 把当前分支变基到目标分支（完整引用名）；要求没有未提交的修改。 */
  gitRebase: (projectId: number, target: string) =>
    invoke<Integration>('git_rebase', { projectId, target }),
  /** 把冲突文件标记为已解决；仍有冲突标记时返回 CONFLICT_MARKERS，确认后以 force 重试。 */
  gitResolve: (projectId: number, paths: string[], force: boolean) =>
    invoke<void>('git_resolve', { projectId, paths, force }),
  /** 冲突都已解决后完成合并或继续变基。 */
  gitContinue: (projectId: number) =>
    invoke<Integration>('git_continue', { projectId }),
  /** 变基时跳过当前停下的提交。 */
  gitSkip: (projectId: number) =>
    invoke<Integration>('git_skip', { projectId }),
  /** 中止合并或变基，恢复到开始前的状态。 */
  gitAbort: (projectId: number) => invoke<void>('git_abort', { projectId }),
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
