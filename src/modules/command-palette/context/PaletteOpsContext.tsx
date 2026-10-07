import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import type { MutableRefObject, ReactNode } from 'react';

export type PaletteOps = {
  openFile: (path: string) => void;
  // Opens a file in the editor side panel without changing the active tab
  // (used by in-chat file links so they behave like the inline edit view).
  openFileInEditor: (path: string) => void;
  // ethia fork: the project path an `inline code` span in chat refers to, or
  // null when no such file exists (the span then stays plain code).
  resolveFileRef: (ref: string) => Promise<string | null>;
  openSettings: (tab?: string) => void;
  refreshProjects: () => Promise<void> | void;
};

type Registry = MutableRefObject<Partial<PaletteOps>>;

const PaletteOpsContext = createContext<Registry | null>(null);

const defaultOps: PaletteOps = {
  openFile: () => undefined,
  openFileInEditor: () => undefined,
  resolveFileRef: async () => null,
  openSettings: () => undefined,
  refreshProjects: () => undefined,
};

/** Mounted by the project-workspace module so CommandPalette and the chat, code-editor and sidebar modules share one set of palette operations. */
export function PaletteOpsProvider({ children }: { children: ReactNode }) {
  const ref = useRef<Partial<PaletteOps>>({});
  return <PaletteOpsContext.Provider value={ref}>{children}</PaletteOpsContext.Provider>;
}

export function usePaletteOps(): PaletteOps {
  const ref = useContext(PaletteOpsContext);
  return useMemo<PaletteOps>(
    () => ({
      openFile: (path) => (ref?.current.openFile ?? defaultOps.openFile)(path),
      openFileInEditor: (path) =>
        (ref?.current.openFileInEditor ?? defaultOps.openFileInEditor)(path),
      // Chat mounts inside the workspace, and child effects run before the
      // workspace registers its ops — wait a tick so the first render of a
      // transcript already sees the real resolver.
      resolveFileRef: (path) =>
        new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() =>
          (ref?.current.resolveFileRef ?? defaultOps.resolveFileRef)(path),
        ),
      openSettings: (tab) => (ref?.current.openSettings ?? defaultOps.openSettings)(tab),
      refreshProjects: () => (ref?.current.refreshProjects ?? defaultOps.refreshProjects)(),
    }),
    [ref],
  );
}

export function usePaletteOpsRegister(partial: Partial<PaletteOps>) {
  const ref = useContext(PaletteOpsContext);
  const { openFile, openFileInEditor, resolveFileRef, openSettings, refreshProjects } = partial;

  useEffect(() => {
    if (!ref) return undefined;
    // The provider creates `ref.current` once and only ever mutates its fields,
    // so capturing the registry object here is equivalent to reading
    // `ref.current` in the cleanup — and keeps the cleanup off a live ref read.
    const registry = ref.current;
    const prev = { ...registry };
    if (openFile) registry.openFile = openFile;
    if (openFileInEditor) registry.openFileInEditor = openFileInEditor;
    if (resolveFileRef) registry.resolveFileRef = resolveFileRef;
    if (openSettings) registry.openSettings = openSettings;
    if (refreshProjects) registry.refreshProjects = refreshProjects;
    return () => {
      if (openFile && registry.openFile === openFile) registry.openFile = prev.openFile;
      if (openFileInEditor && registry.openFileInEditor === openFileInEditor) registry.openFileInEditor = prev.openFileInEditor;
      if (resolveFileRef && registry.resolveFileRef === resolveFileRef) registry.resolveFileRef = prev.resolveFileRef;
      if (openSettings && registry.openSettings === openSettings) registry.openSettings = prev.openSettings;
      if (refreshProjects && registry.refreshProjects === refreshProjects) registry.refreshProjects = prev.refreshProjects;
    };
  }, [ref, openFile, openFileInEditor, resolveFileRef, openSettings, refreshProjects]);
}
