// Isolation state of projects (columns on `projects`, added in database/migrations.ts).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getConnection } from '@/modules/database/index.js';
import { isolationConfig } from '@/modules/isolation/isolation.config.js';
import { normalizeProjectPath } from '@/shared/utils.js';

export const MIN_ISOLATED_UID = 20000;

export type IsolationTools = { channels: boolean; tasks: boolean };

export type IsolatedProject = {
  projectId: string;
  projectPath: string;
  name: string;
  uid: number;
  /** Raw allowlist lines as entered (comments and blanks kept); parsed by daemon/allowlist.ts. */
  allowlist: string[];
  tools: IsolationTools;
  /** Password of the project's account at the sandbox egress proxy. Never sent to the browser. */
  proxySecret: string;
  homeDir: string;
};

type IsolationRow = {
  project_id: string;
  project_path: string;
  custom_project_name: string | null;
  isolated: number;
  isolation_uid: number | null;
  isolation_allowlist: string;
  isolation_tools: string;
  isolation_proxy_secret: string | null;
};

const COLUMNS = 'project_id, project_path, custom_project_name, isolated, isolation_uid, isolation_allowlist, isolation_tools, isolation_proxy_secret';

const DEFAULT_TOOLS: IsolationTools = { channels: true, tasks: true };

function parseAllowlistColumn(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((line): line is string => typeof line === 'string') : [];
  } catch {
    return [];
  }
}

function parseToolsColumn(raw: string): IsolationTools {
  try {
    const value = JSON.parse(raw) as Partial<IsolationTools> | null;
    return {
      channels: typeof value?.channels === 'boolean' ? value.channels : DEFAULT_TOOLS.channels,
      tasks: typeof value?.tasks === 'boolean' ? value.tasks : DEFAULT_TOOLS.tasks,
    };
  } catch {
    return { ...DEFAULT_TOOLS };
  }
}

function toProject(row: IsolationRow): IsolatedProject | null {
  if (row.isolated !== 1 || row.isolation_uid === null || !row.isolation_proxy_secret) return null;
  const homes = isolationConfig().isolatedHomes;
  return {
    projectId: row.project_id,
    projectPath: row.project_path,
    name: row.custom_project_name?.trim() || path.basename(row.project_path) || row.project_path,
    uid: row.isolation_uid,
    allowlist: parseAllowlistColumn(row.isolation_allowlist),
    tools: parseToolsColumn(row.isolation_tools),
    proxySecret: row.isolation_proxy_secret,
    // Must match the daemon's expectedHome(): <isolatedHomes>/<projectId>.
    homeDir: homes ? path.join(homes, row.project_id) : '',
  };
}

/** Real path when it exists, otherwise the normalized absolute path (a deleted project still compares). */
function canonical(p: string): string {
  const normalized = normalizeProjectPath(p);
  if (!normalized) return '';
  try {
    return normalizeProjectPath(fs.realpathSync(normalized));
  } catch {
    return normalizeProjectPath(path.resolve(normalized));
  }
}

const isInside = (child: string, parent: string) =>
  Boolean(parent) && (child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`));

function isolatedRows(): IsolationRow[] {
  try {
    return getConnection().prepare(`SELECT ${COLUMNS} FROM projects WHERE isolated = 1`).all() as IsolationRow[];
  } catch (error) {
    // A database without the projects table or the isolation columns (not migrated yet) holds no isolated
    // project. Any other failure stays an error: the caller must not guess "not isolated".
    if (/no such (table|column)/i.test((error as Error).message)) return [];
    throw error;
  }
}

export const isolationDb = {
  getById(projectId: string): IsolatedProject | null {
    const row = getConnection().prepare(`SELECT ${COLUMNS} FROM projects WHERE project_id = ?`).get(projectId) as IsolationRow | undefined;
    return row ? toProject(row) : null;
  },

  /** The isolated project whose directory is `projectPath` or contains it (real paths compared). */
  getByPath(projectPath: string): IsolatedProject | null {
    const target = canonical(projectPath);
    if (!target) return null;
    let best: { row: IsolationRow; length: number } | null = null;
    for (const row of isolatedRows()) {
      const dir = canonical(row.project_path);
      if (isInside(target, dir) && (!best || dir.length > best.length)) best = { row, length: dir.length };
    }
    return best ? toProject(best.row) : null;
  },

  listIsolated(): IsolatedProject[] {
    return isolatedRows().map(toProject).filter((project): project is IsolatedProject => project !== null);
  },

  /** Next free uid: max(isolation_uid) + 1, starting at 20000. */
  nextUid(): number {
    const row = getConnection().prepare('SELECT MAX(isolation_uid) AS max FROM projects').get() as { max: number | null };
    return row.max === null ? MIN_ISOLATED_UID : Math.max(MIN_ISOLATED_UID, row.max + 1);
  },

  /**
   * Marks a project isolated with `uid` and a fresh proxy secret. Idempotent for an already
   * isolated project: it keeps its uid and secret (the sandbox owns files under that uid).
   */
  markIsolated(projectId: string, uid: number): IsolatedProject {
    const db = getConnection();
    return db.transaction(() => {
      const row = db.prepare(`SELECT ${COLUMNS} FROM projects WHERE project_id = ?`).get(projectId) as IsolationRow | undefined;
      if (!row) throw new Error(`Unknown project ${projectId}`);
      const existing = toProject(row);
      if (existing) return existing;
      if (!Number.isInteger(uid) || uid < MIN_ISOLATED_UID) throw new Error(`Isolated uid must be an integer >= ${MIN_ISOLATED_UID}`);
      const taken = db.prepare('SELECT project_id FROM projects WHERE isolation_uid = ? AND project_id <> ?').get(uid, projectId);
      if (taken) throw new Error(`Isolated uid ${uid} is already used by another project`);
      db.prepare('UPDATE projects SET isolated = 1, isolation_uid = ?, isolation_proxy_secret = ? WHERE project_id = ?')
        .run(uid, crypto.randomBytes(24).toString('hex'), projectId);
      const updated = db.prepare(`SELECT ${COLUMNS} FROM projects WHERE project_id = ?`).get(projectId) as IsolationRow;
      return toProject(updated)!;
    })();
  },

  updateSettings(projectId: string, settings: { allowlist?: string[]; tools?: Partial<IsolationTools> }): IsolatedProject {
    const current = isolationDb.getById(projectId);
    if (!current) throw new Error(`Project ${projectId} is not isolated`);
    const allowlist = settings.allowlist ?? current.allowlist;
    const tools: IsolationTools = { ...current.tools, ...settings.tools };
    getConnection()
      .prepare('UPDATE projects SET isolation_allowlist = ?, isolation_tools = ? WHERE project_id = ? AND isolated = 1')
      .run(JSON.stringify(allowlist), JSON.stringify(tools), projectId);
    return isolationDb.getById(projectId)!;
  },
};

/**
 * The single place that decides whether a path belongs to an isolated project — every run of
 * such a project must go to the sandbox. True for an isolated project's directory, anything
 * inside it, and anything under the isolated root (an unregistered directory there must not run
 * in the main container either). Paths are compared after realpath.
 */
export function isIsolatedPath(projectPath: string): boolean {
  if (typeof projectPath !== 'string' || !projectPath.trim()) return false;
  const root = isolationConfig().isolatedRoot;
  if (root && isInside(canonical(projectPath), canonical(root))) return true;
  return isolationDb.getByPath(projectPath) !== null;
}
