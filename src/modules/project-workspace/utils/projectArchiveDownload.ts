import { api } from '@/shared/api';

/**
 * ethia fork: downloads the whole project as a ZIP after the user confirms.
 * The browser fetches the link itself — an archive can be gigabytes and must
 * never be pulled into the page's memory.
 */
export function downloadProjectArchive(projectId: string, confirmMessage: string): void {
  if (!window.confirm(confirmMessage)) {
    return;
  }
  const link = document.createElement('a');
  link.href = api.projectArchiveUrl(projectId);
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
