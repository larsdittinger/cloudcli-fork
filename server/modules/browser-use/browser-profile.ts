import path from 'node:path';

export const DEFAULT_PROFILE_NAME = 'default';

function safeName(profileName: string): string {
  return profileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || DEFAULT_PROFILE_NAME;
}

export function resolveProfileDir(args: {
  profileName: string | null;
  profileRoot: string;
  inUse: ReadonlySet<string>;
  makeTempDir: () => string;
}): { dir: string; ephemeral: boolean } {
  const name = args.profileName ? safeName(args.profileName) : DEFAULT_PROFILE_NAME;
  const target = path.join(args.profileRoot, name);
  if (args.inUse.has(target)) {
    return { dir: args.makeTempDir(), ephemeral: true };
  }
  return { dir: target, ephemeral: false };
}
