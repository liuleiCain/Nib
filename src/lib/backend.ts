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
}

/** 统一提取后台结构化错误与运行时异常的可读说明。 */
export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error.message);
  }
  return String(error);
}

/** 前端仅通过这些受控命令访问当前工作区文件。 */
export const backend = {
  openProject: (path: string) => invoke<Project>('open_project', { path }),
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
