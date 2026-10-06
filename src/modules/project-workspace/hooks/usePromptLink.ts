import { useEffect, useRef } from 'react';
import type { NavigateFunction } from 'react-router-dom';

import { writeDraftText } from '@/shared/chatDrafts';
import type { Project } from '@/shared/types';

type Args = {
  sessionId?: string;
  projects: Project[];
  isLoadingProjects: boolean;
  navigate: NavigateFunction;
  startNewSession: (project: Project) => void;
};

/** What a prompt link asks for: prefill `prompt` in a chat, or in a new chat of `project`. */
export function readPromptLink(search: string, sessionId?: string): { prompt: string; scope: 'session' | 'project'; target: string } | null {
  const params = new URLSearchParams(search);
  const prompt = params.get('prompt');
  if (!prompt?.trim()) return null;
  if (sessionId) return { prompt, scope: 'session', target: sessionId };
  const project = params.get('project')?.trim();
  return project ? { prompt, scope: 'project', target: project } : null;
}

/**
 * Applies a prompt link (`/session/<id>?prompt=…` or `/?project=<path>&prompt=…`)
 * that agents put into e-mails through `channels_build_link`: the prompt lands
 * in that chat's composer draft and is never sent on its own. The query is
 * dropped afterwards so a reload does not paste it again.
 */
export function usePromptLink({ sessionId, projects, isLoadingProjects, navigate, startNewSession }: Args): void {
  const appliedRef = useRef(false);

  useEffect(() => {
    if (appliedRef.current) return;
    const link = readPromptLink(window.location.search, sessionId);
    if (!link) return;

    if (link.scope === 'session') {
      appliedRef.current = true;
      writeDraftText(link.target, link.prompt);
      navigate(`/session/${encodeURIComponent(link.target)}`, { replace: true });
      return;
    }

    // A new-chat link needs the project list to find the project by path or id.
    if (isLoadingProjects) return;
    appliedRef.current = true;
    const project = projects.find((candidate) => (
      candidate.projectId === link.target || candidate.fullPath === link.target || candidate.path === link.target
    ));
    if (!project) {
      console.warn(`[prompt link] Project not found or not accessible: ${link.target}`);
      navigate('/', { replace: true });
      return;
    }
    startNewSession(project);
    writeDraftText(`project:${project.projectId}`, link.prompt);
  }, [sessionId, projects, isLoadingProjects, navigate, startNewSession]);
}
