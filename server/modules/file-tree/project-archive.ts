import path from 'node:path';
import type { Readable } from 'node:stream';

import { ZipArchive } from 'archiver';

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

  archive.directory(projectRoot, false);
  void archive.finalize();
  return archive as unknown as Readable;
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
