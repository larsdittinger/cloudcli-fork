// Per-project network config pushed by the main app; persisted at <isolationDir>/state/projects.json (0600).
import fs from 'node:fs';
import path from 'node:path';

import { parseAllowlist, type AllowEntry } from './allowlist.js';
import { MIN_ISOLATED_UID } from './firewall.js';

export type ProjectConfig = { uid: number; name: string; allowlist: string[]; proxySecret: string };
export type StoredProject = ProjectConfig & { entries: AllowEntry[] };

export const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function validateProjectConfig(raw: unknown): { config?: ProjectConfig; error?: string } {
  const body = raw as Partial<ProjectConfig> | null;
  if (!body || typeof body !== 'object') return { error: 'Invalid body' };
  if (!Number.isInteger(body.uid) || (body.uid as number) < MIN_ISOLATED_UID) return { error: `uid must be an integer >= ${MIN_ISOLATED_UID}` };
  if (typeof body.name !== 'string' || !body.name) return { error: 'name is required' };
  if (typeof body.proxySecret !== 'string' || !body.proxySecret) return { error: 'proxySecret is required' };
  if (!Array.isArray(body.allowlist) || body.allowlist.some((line) => typeof line !== 'string')) return { error: 'allowlist must be string[]' };
  const { errors } = parseAllowlist(body.allowlist);
  if (errors.length) return { error: errors.map((e) => `line ${e.line}: ${e.message}`).join('; ') };
  return { config: { uid: body.uid as number, name: body.name, allowlist: body.allowlist, proxySecret: body.proxySecret } };
}

export class ProjectStore {
  private readonly projects = new Map<string, StoredProject>();
  private readonly file: string;

  constructor(isolationDir: string) {
    this.file = path.join(isolationDir, 'state', 'projects.json');
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      for (const [id, raw] of Object.entries(saved)) {
        const { config } = validateProjectConfig(raw);
        if (config && PROJECT_ID.test(id)) this.projects.set(id, { ...config, entries: parseAllowlist(config.allowlist).entries });
      }
    } catch {
      // No file yet (or unreadable): start empty, i.e. the proxy rejects everyone until the app pushes configs.
    }
  }

  get(id: string): StoredProject | undefined {
    return this.projects.get(id);
  }

  /** Id of a project other than `exceptId` that already uses this uid. */
  uidOwner(uid: number, exceptId: string): string | undefined {
    for (const [id, project] of this.projects) if (id !== exceptId && project.uid === uid) return id;
    return undefined;
  }

  all(): StoredProject[] {
    return [...this.projects.values()];
  }

  set(id: string, config: ProjectConfig): void {
    this.projects.set(id, { ...config, entries: parseAllowlist(config.allowlist).entries });
    this.persist();
  }

  private persist(): void {
    const data: Record<string, ProjectConfig> = {};
    for (const [id, { entries: _entries, ...config }] of this.projects) data[id] = config;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
  }
}
