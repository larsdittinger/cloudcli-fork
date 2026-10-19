import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { test } from 'vitest';

import { PaletteOpsProvider, usePaletteOpsRegister } from '@/modules/command-palette';
import { Markdown } from '@/modules/chat/transcript/Markdown';

/**
 * "When the agent prints a path I have to go find the file": `inline code`
 * naming an existing project file is a link that opens it next to the chat.
 */

function Workspace({ files, opened, lines }: { files: Record<string, string>; opened: string[]; lines: Array<number | null | undefined> }) {
  usePaletteOpsRegister({
    resolveFileRef: async (ref) => files[ref] ?? null,
    openFileInEditor: (path, line) => {
      opened.push(path);
      lines.push(line);
    },
  });
  return null;
}

function renderChat(markdown: string, files: Record<string, string>, lines: Array<number | null | undefined> = []) {
  const opened: string[] = [];
  render(
    <PaletteOpsProvider>
      <Markdown>{markdown}</Markdown>
      <Workspace files={files} opened={opened} lines={lines} />
    </PaletteOpsProvider>,
  );
  return opened;
}

test('inline code naming an existing file opens it in the editor', async () => {
  const opened = renderChat('Hotovo: `vystup/krabice/velky.pdf`', {
    'vystup/krabice/velky.pdf': '/workspace/etikety/vystup/krabice/velky.pdf',
  });

  const link = await screen.findByRole('link', { name: 'vystup/krabice/velky.pdf' });
  fireEvent.click(link);
  assert.deepEqual(opened, ['/workspace/etikety/vystup/krabice/velky.pdf']);
});

test('a line suffix stays visible but the file is resolved without it', async () => {
  const opened = renderChat('See `src/foo.ts:130`.', { 'src/foo.ts': '/p/src/foo.ts' });

  fireEvent.click(await screen.findByRole('link', { name: 'src/foo.ts:130' }));
  assert.deepEqual(opened, ['/p/src/foo.ts']);
});

test('a line suffix opens the file at that line, as upstream file links do', async () => {
  const lines: Array<number | null | undefined> = [];
  const opened = renderChat('See `src/x.ts:42` and `src/y.ts:7:3`, or `README.md`.', {
    'src/x.ts': '/p/src/x.ts',
    'src/y.ts': '/p/src/y.ts',
    'README.md': '/p/README.md',
  }, lines);

  fireEvent.click(await screen.findByRole('link', { name: 'src/x.ts:42' }));
  fireEvent.click(await screen.findByRole('link', { name: 'src/y.ts:7:3' }));
  fireEvent.click(await screen.findByRole('link', { name: 'README.md' }));
  assert.deepEqual(opened, ['/p/src/x.ts', '/p/src/y.ts', '/p/README.md']);
  assert.deepEqual(lines, [42, 7, null]);
});

test('inline code that is not an existing file stays plain', async () => {
  renderChat('Řez `CutContour`, soubor `chybi.pdf` a `velky.pdf`.', { 'velky.pdf': '/p/velky.pdf' });

  await screen.findByRole('link', { name: 'velky.pdf' });
  assert.equal(screen.queryByRole('link', { name: 'chybi.pdf' }), null);
  assert.equal(screen.queryByRole('link', { name: 'CutContour' }), null);
  assert.ok(screen.getByText('chybi.pdf').tagName === 'CODE');
});

test('fenced code blocks never become links', async () => {
  renderChat('```\nvystup/a.pdf\n```', { 'vystup/a.pdf': '/p/vystup/a.pdf' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(screen.queryByRole('link'), null);
});

test('outside a workspace inline code stays plain', async () => {
  render(<Markdown>{'`vystup/a.pdf`'}</Markdown>);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await waitFor(() => assert.equal(screen.queryByRole('link'), null));
});
