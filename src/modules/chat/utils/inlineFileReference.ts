// ethia fork: agents name the files they produced in `inline code`. A span
// that could be a file path is offered for an existence check; the chat links
// only the ones the project really has, so this filter only has to keep the
// obvious non-paths (prose, commands, URLs, numbers) from costing a lookup.

const MAXIMUM_LENGTH = 300;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const NOT_IN_PATHS = /[\s()<>{}[\]|*?"'`,;=!$&^]/;
const LINE_SUFFIX = /:\d+(?::\d+)?$/;
// A filename extension with at least one letter: `.pdf`, `.mp4`, not `.5`.
const EXTENSION = /\.(?=[a-z0-9]{0,9}[a-z])[a-z0-9]{1,10}$/i;

/** The path to open for an inline-code span, or null when it is not a file path. */
export function inlineCodeFileRef(text: string): string | null {
  const value = text.trim();
  if (!value || value.length > MAXIMUM_LENGTH) return null;
  if (URL_SCHEME.test(value) || NOT_IN_PATHS.test(value) || value.startsWith('-')) return null;

  const filePath = value.replace(LINE_SUFFIX, '');
  const baseName = filePath.split(/[\\/]/).pop() ?? '';
  return EXTENSION.test(baseName) ? filePath : null;
}
