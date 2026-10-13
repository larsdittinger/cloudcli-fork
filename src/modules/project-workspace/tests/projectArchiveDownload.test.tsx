import assert from 'node:assert/strict';

import { test, vi } from 'vitest';

vi.mock('@/shared/api', () => ({
  api: { projectArchiveUrl: (projectId: string) => `/api/file-tree/projects/${projectId}/archive` },
}));

const { downloadProjectArchive } = await import('@/modules/project-workspace/utils/projectArchiveDownload');

/** ethia fork: the whole-project ZIP can be gigabytes, so it only starts after a confirm. */

test('nothing is downloaded when the confirm is dismissed', () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

  downloadProjectArchive('p1', 'Download?');

  assert.deepEqual(confirm.mock.calls, [['Download?']]);
  assert.equal(click.mock.calls.length, 0);
});

test('a confirmed download follows the archive link', () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const hrefs: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    hrefs.push(this.getAttribute('href') ?? '');
  });

  downloadProjectArchive('p1', 'Download?');

  assert.deepEqual(hrefs, ['/api/file-tree/projects/p1/archive']);
  // The temporary link does not stay in the page.
  assert.equal(document.querySelectorAll('a[href$="/archive"]').length, 0);
});
