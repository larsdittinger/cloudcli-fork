// Claude transcripts of isolated projects live in their homes (<isolatedHomes>/<projectId>/.claude/projects), which
// the app reads but the agent writes. Indexing them must not let an agent plant sessions in other projects,
// take over existing sessions, or point the app at files outside its home.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { isolationConfig } from '@/modules/isolation/isolation.config.js';
import { isolationDb } from '@/modules/isolation/isolation.db.js';

const isRealDir = (p: string) => {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

const isInside = (child: string, parent: string) =>
  Boolean(parent) && (child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`));

/** Every directory Claude transcripts live in: the app's own, then each isolated home's (real directories only). */
export function claudeTranscriptRoots(): string[] {
  const roots = [path.join(os.homedir(), '.claude', 'projects')];
  const homes = isolationConfig().isolatedHomes;
  if (!homes) return roots;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(homes, { withFileTypes: true });
  } catch {
    return roots;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue; // a symlinked home is never followed
    const claudeDir = path.join(homes, entry.name, '.claude');
    const projects = path.join(claudeDir, 'projects');
    if (isRealDir(claudeDir) && isRealDir(projects)) roots.push(projects);
  }
  return roots;
}

/** The parent of all isolated homes, watched as one more transcript root (new homes appear at runtime). */
export function isolatedHomesRoot(): string | null {
  return isolationConfig().isolatedHomes || null;
}

/**
 * chokidar filter for the homes root: descend only along <home>/.claude/projects, never into subagent
 * transcripts or tool results (like the main watcher), never anywhere else in a home (caches, node_modules).
 */
export function isIsolatedHomeWatchPath(filePath: string): boolean {
  const homes = isolatedHomesRoot();
  if (!homes) return false;
  const relative = path.relative(homes, filePath);
  if (relative === '') return true;
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const parts = relative.split(path.sep);
  if (parts.length >= 2 && parts[1] !== '.claude') return false;
  if (parts.length >= 3 && parts[2] !== 'projects') return false;
  return !parts.includes('subagents') && !parts.includes('tool-results');
}

/** The isolated project whose home holds `filePath`, by location; null when the file is not in an isolated home. */
function homeProjectId(filePath: string): string | null {
  const homes = isolatedHomesRoot();
  if (!homes) return null;
  const relative = path.relative(path.resolve(homes), path.resolve(filePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep)[0] || null;
}

/** Before a transcript is read: in an isolated home only a regular file (no symlink, FIFO…) inside that home. */
export function isReadableTranscript(filePath: string): boolean {
  const projectId = homeProjectId(filePath);
  if (projectId === null) return true;
  const homes = isolatedHomesRoot()!;
  try {
    if (!fs.lstatSync(filePath).isFile()) return false;
    return isInside(fs.realpathSync(filePath), path.join(fs.realpathSync(homes), projectId));
  } catch {
    return false;
  }
}

/**
 * After a transcript was parsed: one from an isolated home counts only for a session of that same isolated
 * project — its cwd inside the project, and its session id not one of a session elsewhere.
 */
export function acceptTranscript(filePath: string, parsed: { sessionId: string; projectPath: string }): boolean {
  const projectId = homeProjectId(filePath);
  if (projectId === null) return true;
  if (!isReadableTranscript(filePath)) return false;
  const project = isolationDb.getById(projectId);
  if (!project) return false;
  const owner = isolationDb.getByPath(parsed.projectPath);
  if (owner?.projectId !== project.projectId) return false;
  const existing = sessionsDb.getSessionByProviderSessionId(parsed.sessionId) ?? sessionsDb.getSessionById(parsed.sessionId);
  if (existing && isolationDb.getByPath(existing.project_path ?? '')?.projectId !== project.projectId) return false;
  return true;
}
