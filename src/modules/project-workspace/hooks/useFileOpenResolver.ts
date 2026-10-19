import { useCallback, useMemo } from 'react';

import { api } from '@/shared/api';
import type { Project } from '@/shared/types';
import { createFileRefResolver, isAbsoluteRef } from '@/modules/project-workspace/utils/fileRefResolver';
import type { FlatFile } from '@/modules/project-workspace/utils/fileRefResolver';

type FileNode = {
  type: 'file' | 'directory';
  name: string;
  path: string;
  children?: FileNode[];
};

// `diffInfo` is intentionally `any` so this resolver can wrap editor handlers
// that expect a concrete diff payload type as well as generic callers.
type OnFileOpen = (filePath: string, diffInfo?: any, line?: number | null) => void;

const normalize = (value: string): string => value.replace(/\\/g, '/');

const flatten = (nodes: FileNode[], out: FlatFile[]): void => {
  for (const node of nodes) {
    if (node.type === 'file') {
      out.push({ name: node.name, path: node.path });
    } else if (node.children && node.children.length > 0) {
      flatten(node.children, out);
    }
  }
};

/**
 * Wraps an `onFileOpen` handler so a possibly bare/partial file reference is
 * resolved against the project's file tree (cached per project) before the file
 * is opened in the in-app editor. `resolveFileRef` tells chat whether an
 * `inline code` span names an existing file (ethia fork).
 */
export function useFileOpenResolver(
  selectedProject: Project | null | undefined,
  onFileOpen: OnFileOpen,
): { openFile: OnFileOpen; resolveFileRef: (ref: string) => Promise<string | null> } {
  const projectId = selectedProject?.projectId;

  const resolver = useMemo(
    () => createFileRefResolver({
      listFiles: async () => {
        if (!projectId) return [];
        const response = await api.getFiles(projectId);
        if (!response.ok) return [];
        const data = await response.json();
        const flat: FlatFile[] = [];
        flatten(Array.isArray(data) ? data : [], flat);
        return flat;
      },
      filesExist: async (paths) => {
        if (!projectId) return [];
        const response = await api.filesExist(projectId, paths);
        if (!response.ok) return [];
        const data = await response.json();
        return Array.isArray(data?.existing) ? data.existing : [];
      },
    }),
    [projectId],
  );

  const openFile = useCallback(
    (filePath: string, diffInfo?: any, line?: number | null) => {
      // Normalized once and used for every outcome: a reference picked up from
      // link text can carry surrounding whitespace, which the API would take as
      // part of the filename and answer with a 404.
      const ref = normalize(filePath).trim();
      // An absolute path already names one exact file: matching it against the
      // tree can only send it somewhere else.
      if (isAbsoluteRef(ref)) {
        onFileOpen(ref, diffInfo, line);
        return;
      }
      void resolver.match(ref).then((match) => {
        onFileOpen(match ?? ref, diffInfo, line);
      });
    },
    [resolver, onFileOpen],
  );

  return { openFile, resolveFileRef: resolver.resolve };
}
