// ethia fork: resolves file references from chat messages against the project.
// `match` is the tree lookup the editor uses when a link is clicked; `resolve`
// additionally asks the server about exact paths the tree leaves out
// (gitignored, dist/, build/ …) and decides whether chat shows a link at all.

export type FlatFile = {
  name: string;
  path: string;
};

type FileRefResolverOptions = {
  listFiles: () => Promise<FlatFile[]>;
  filesExist: (paths: string[]) => Promise<string[]>;
  now?: () => number;
  batchDelayMs?: number;
};

// The tree is refetched on a miss at most this often, so a file the agent
// wrote after the tree loaded still turns into a link.
const TREE_REFRESH_MS = 10_000;
// A miss is remembered this long; afterwards a re-render asks again.
const MISS_TTL_MS = 15_000;
const MAXIMUM_BATCH = 200;

const normalize = (value: string): string => value.replace(/\\/g, '/');

// References inside chat messages are often bare basenames (`foo.ts`) or partial
// paths (`utils/foo.ts`) rather than full paths, so match by path suffix and
// fall back to filename equality.
export const findBestMatch = (files: FlatFile[], ref: string): string | null => {
  const target = normalize(ref).replace(/^\.\//, '').replace(/^\/+/, '');
  if (!target) {
    return null;
  }

  const suffixMatch = files.find((file) => {
    const filePath = normalize(file.path);
    return filePath === target || filePath.endsWith(`/${target}`);
  });
  if (suffixMatch) {
    return suffixMatch.path;
  }

  const base = target.split('/').pop() || target;
  return files.find((file) => file.name === base)?.path ?? null;
};

export function createFileRefResolver({
  listFiles,
  filesExist,
  now = Date.now,
  batchDelayMs = 30,
}: FileRefResolverOptions) {
  let tree: { files: Promise<FlatFile[]>; at: number } | null = null;
  const answers = new Map<string, { result: Promise<string | null>; at: number }>();
  let pending: Array<{ path: string; settle: (exists: boolean) => void }> = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const loadTree = (): Promise<FlatFile[]> => {
    if (!tree) {
      tree = { files: listFiles().catch(() => []), at: now() };
    }
    return tree.files;
  };

  const refreshTree = (): Promise<FlatFile[]> => {
    if (tree && now() - tree.at < TREE_REFRESH_MS) {
      return tree.files;
    }
    tree = null;
    return loadTree();
  };

  const flush = () => {
    flushTimer = null;
    const batch = pending;
    pending = [];
    for (let start = 0; start < batch.length; start += MAXIMUM_BATCH) {
      const chunk = batch.slice(start, start + MAXIMUM_BATCH);
      const paths = [...new Set(chunk.map((entry) => entry.path))];
      filesExist(paths)
        .then((existing) => {
          const found = new Set(existing);
          chunk.forEach((entry) => entry.settle(found.has(entry.path)));
        })
        .catch(() => chunk.forEach((entry) => entry.settle(false)));
    }
  };

  const existsOnServer = (filePath: string): Promise<boolean> =>
    new Promise((settle) => {
      pending.push({ path: filePath, settle });
      flushTimer ??= setTimeout(flush, batchDelayMs);
    });

  const match = async (ref: string): Promise<string | null> =>
    findBestMatch(await loadTree(), ref);

  const lookUp = async (ref: string): Promise<string | null> => {
    const inTree = findBestMatch(await loadTree(), ref);
    if (inTree) return inTree;
    const afterRefresh = findBestMatch(await refreshTree(), ref);
    if (afterRefresh) return afterRefresh;
    return (await existsOnServer(ref)) ? ref : null;
  };

  const resolve = (ref: string): Promise<string | null> => {
    const cached = answers.get(ref);
    if (cached) {
      return cached.result.then((result) => {
        if (result !== null || now() - cached.at < MISS_TTL_MS) return result;
        answers.delete(ref);
        return resolve(ref);
      });
    }
    const result = lookUp(ref);
    answers.set(ref, { result, at: now() });
    return result;
  };

  return { match, resolve };
}
