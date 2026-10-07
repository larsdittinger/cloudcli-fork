import { useCallback, useMemo } from 'react';

import { api } from '@/shared/api';
import type { Project } from '@/shared/types';
import { createFileRefResolver } from '@/modules/project-workspace/utils/fileRefResolver';
import type { FlatFile } from '@/modules/project-workspace/utils/fileRefResolver';

type FileNode = {
  type: 'file' | 'directory';
  name: string;
  path: string;
  children?: FileNode[];
};

// `diffInfo` is intentionally `any` so this resolver can wrap editor handlers
// that expect a concrete diff payload type as well as generic callers.
type OnFileOpen = (filePath: string, diffInfo?: any) => void;

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
    (filePath: string, diffInfo?: any) => {
      const ref = filePath.replace(/\\/g, '/').trim();
      void resolver.match(ref).then((match) => {
        onFileOpen(match ?? filePath, diffInfo);
      });
    },
    [resolver, onFileOpen],
  );

  return { openFile, resolveFileRef: resolver.resolve };
}
