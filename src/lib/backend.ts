import {invoke, isTauri} from '@tauri-apps/api/core';

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
}

/** 统一提取后台结构化错误与运行时异常的可读说明。 */
export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error.message);
  }
  return String(error);
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
};
