import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';

import { ZipArchive } from 'archiver';

import { isolatedAreaOf, isolatedFs, openIsolatedPath } from '@/modules/isolation/index.js';

/**
 * ethia fork: stazeni celeho projektu jako ZIP (admin-only, viz routa).
 *
 * Archiv je uplna kopie slozky vcetne node_modules a .git — po rozbaleni ma
 * uzivatel projekt presne tak, jak lezi na instanci. Proto se taky nic
 * needituje ani nefiltruje a stream jde rovnou do odpovedi: projekt muze mit
 * klidne gigabajty a do pameti serveru se vejit nemusi.
 */

// Uplna kopie znamena hlavne node_modules, kde uz je vetsina souboru
// zkomprimovana nebo mala. Nejnizsi uroven drzi CPU instance pri zemi a rozdil
// ve velikosti je proti case kompletni komprese zanedbatelny.
const COMPRESSION_LEVEL = 1;

export function createProjectArchiveStream(projectRoot: string): Readable {
  const archive = new ZipArchive({ zlib: { level: COMPRESSION_LEVEL } });
  // Chybejici soubor (smazany behem archivace, rozbity symlink) nesmi shodit
  // cele stahovani — archiv ho preskoci.
  archive.on('warning', (error: any) => {
    if (error?.code === 'ENOENT') {
      console.warn('[Archive] Preskakuji soubor:', error?.message || error);
      return;
    }
    archive.emit('error', error);
  });

  if (isolatedAreaOf(projectRoot)) {
    appendIsolatedTree(archive, projectRoot);
    return archive as unknown as Readable;
  }

  archive.directory(projectRoot, false);
  void archive.finalize();
  return archive as unknown as Readable;
}

// Deeper directories of an isolated project are left out (each level of the walk holds a directory open).
const MAX_ISOLATED_ARCHIVE_DEPTH = 64;

/**
 * An isolated project belongs to its agent, which can plant symlinks (to the app's secrets) and FIFOs: its ZIP holds
 * only real directories and regular files, each opened without following a link (see the isolation module), one
 * entry at a time so a huge tree never queues up in memory. Everything else is skipped.
 */
function appendIsolatedTree(archive: ZipArchive, projectRoot: string): void {
  let stopped = false;
  let current: fs.ReadStream | null = null;
  const stop = () => {
    stopped = true;
    current?.destroy();
  };
  archive.once('close', stop);
  archive.once('error', stop);
  archive.once('end', stop);

  const append = (source: Buffer | fs.ReadStream, data: Record<string, unknown>) => new Promise<void>((resolve) => {
    if (stopped) return resolve();
    archive.once('close', resolve);
    archive.append(source, {
      ...data,
      callback: () => {
        archive.off('close', resolve);
        resolve();
      },
    } as never);
  });

  let skipped = 0;
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    for await (const entry of isolatedFs.listDirectory(directory)) {
      if (stopped) return;
      const absolute = path.join(directory, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth >= MAX_ISOLATED_ARCHIVE_DEPTH) {
          skipped += 1;
          continue;
        }
        let stats: fs.Stats;
        try {
          stats = await isolatedFs.lstat(absolute);
        } catch {
          skipped += 1;
          continue;
        }
        if (!stats.isDirectory()) {
          skipped += 1;
          continue;
        }
        await append(Buffer.alloc(0), { name, type: 'directory', date: stats.mtime, mode: stats.mode });
        try {
          await walk(absolute, name, depth + 1);
        } catch {
          skipped += 1; // swapped for a symlink since the listing, or unreadable: left out
        }
      } else if (entry.isFile()) {
        const area = isolatedAreaOf(absolute);
        let fd: number;
        try {
          fd = openIsolatedPath(area!.root, area!.rel, 'read');
        } catch {
          skipped += 1; // swapped for a link or FIFO since the listing
          continue;
        }
        const stats = fs.fstatSync(fd);
        current = fs.createReadStream(absolute, { fd, autoClose: true });
        await append(current, { name, date: stats.mtime, mode: stats.mode });
        current = null;
      } else {
        skipped += 1; // symlink, FIFO, socket, device
      }
    }
  };

  walk(projectRoot, '', 0)
    .then(() => {
      if (stopped) return;
      if (skipped) console.warn(`[Archive] ${projectRoot}: ${skipped} symlinks or special files left out of the ZIP`);
      void archive.finalize();
    })
    .catch((error: unknown) => {
      if (!stopped) archive.emit('error', error);
    });
}

/**
 * Jmeno stahovaneho souboru. Drzi se jen ASCII slov, protoze putuje do hlavicky
 * Content-Disposition — diakritika a uvozovky by ji rozbily.
 */
export function archiveFileName(projectRoot: string): string {
  const base = path.basename(projectRoot.replace(/[/\\]+$/, ''));
  const slug = base
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'project'}.zip`;
}
