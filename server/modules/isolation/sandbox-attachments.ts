// Files an isolated agent has to read but that live in the app (Channels attachments, chat uploads): copied into
// the project under .cloudcli-attachments/<subdir>/ and handed to the project uid by the daemon.
//
// The project tree is writable by the agent, so it could plant symlinks there to make the app write elsewhere in
// the main container. Every step works on a directory fd opened with O_NOFOLLOW, children are reached through
// /proc/self/fd/<fd> (openat equivalent; path based only where procfs is missing, i.e. macOS dev) and files are
// created with O_EXCL | O_NOFOLLOW.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { daemonClient } from '@/modules/isolation/daemon-client.js';
import { isIsolatedPath, isolationDb } from '@/modules/isolation/isolation.db.js';

export const ATTACHMENTS_DIR = '.cloudcli-attachments';

const SUBDIR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIR_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const FILE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
const hasProcFd = fs.existsSync('/proc/self/fd');

type Dir = { fd: number; path: string };

const at = (dir: Dir, name: string) => (hasProcFd ? `/proc/self/fd/${dir.fd}/${name}` : path.join(dir.path, name));

/** The child directory `name` of `parent`, created when missing; a symlink or file there is an error. */
function childDir(parent: Dir, name: string): Dir {
  try {
    fs.mkdirSync(at(parent, name), { mode: 0o2770 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const fd = fs.openSync(at(parent, name), DIR_FLAGS);
  return { fd, path: path.join(parent.path, name) };
}

async function copyInto(dir: Dir, name: string, source: string): Promise<void> {
  const target = at(dir, name);
  try {
    fs.unlinkSync(target); // never follows: a planted symlink is removed, not written through
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const handle = await fsp.open(target, FILE_FLAGS, 0o660);
  await handle.chmod(0o660);
  await pipeline(fs.createReadStream(source), handle.createWriteStream());
}

/**
 * Copies `items` (files the app holds) into `<project>/.cloudcli-attachments/<subdir>/` for an isolated project
 * and returns them with their new paths — the same path inside the sandbox. Items of any other project come back
 * as they are. Throws when the files cannot be staged: the run must not start without them.
 */
export async function stageForSandbox<T extends { path: string }>(
  projectPath: string | null | undefined,
  subdir: string,
  items: T[],
): Promise<T[]> {
  if (!items.length || !projectPath || !isIsolatedPath(projectPath)) return items;
  const project = isolationDb.getByPath(projectPath);
  if (!project) throw new Error('Tato cesta patří do izolované oblasti, ale nepatří k izolovanému projektu.');
  if (!SUBDIR.test(subdir)) throw new Error(`Invalid attachment subdir ${JSON.stringify(subdir)}`);

  const opened: Dir[] = [];
  try {
    const root: Dir = { fd: fs.openSync(project.projectPath, DIR_FLAGS), path: project.projectPath };
    opened.push(root);
    const attachments = childDir(root, ATTACHMENTS_DIR);
    opened.push(attachments);
    const target = childDir(attachments, subdir);
    opened.push(target);

    const staged: T[] = [];
    for (const item of items) {
      const name = path.basename(item.path);
      if (!name || name === '.' || name === '..') throw new Error(`Invalid attachment name ${JSON.stringify(item.path)}`);
      await copyInto(target, name, item.path);
      staged.push({ ...item, path: path.join(target.path, name) });
    }
    await daemonClient.adopt(project, [`${ATTACHMENTS_DIR}/${subdir}`]);
    return staged;
  } finally {
    for (const dir of opened.reverse()) fs.closeSync(dir.fd);
  }
}
