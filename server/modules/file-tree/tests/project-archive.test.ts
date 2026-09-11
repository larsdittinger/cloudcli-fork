import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { archiveFileName, createProjectArchiveStream } from '@/modules/file-tree/project-archive.js';

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudcli-archive-'));
  fs.writeFileSync(path.join(root, 'README.md'), '# projekt\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'index.js'), 'console.log(1);\n');
  // Lars chce uplnou kopii: zavisle i git historie musi v archivu byt.
  fs.mkdirSync(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return root;
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

test('archiv je ZIP a nese uplny obsah projektu vcetne node_modules a .git', async () => {
  const root = makeProject();
  try {
    const zip = await collect(createProjectArchiveStream(root));
    assert.equal(zip.subarray(0, 2).toString(), 'PK');
    const raw = zip.toString('latin1');
    for (const entry of ['README.md', 'src/index.js', 'node_modules/left-pad/index.js', '.git/HEAD']) {
      assert.ok(raw.includes(entry), `v archivu chybi ${entry}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('jmeno souboru vychazi z posledni slozky cesty a je bezpecne', () => {
  assert.equal(archiveFileName('/workspace/kamvokoli'), 'kamvokoli.zip');
  assert.equal(archiveFileName('/workspace/muj projekt'), 'muj-projekt.zip');
  assert.equal(archiveFileName('/workspace/Ceska/Republika!'), 'republika.zip');
  assert.equal(archiveFileName('/'), 'project.zip');
});
