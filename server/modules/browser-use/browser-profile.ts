import fs from 'node:fs';
import os from 'node:os';
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

const SINGLETON_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

// ethia fork: persistentni profil na volume si z predchoziho kontejneru nese
// SingletonLock ("<hostname>-<pid>"). Novy kontejner ma jiny hostname, Chrome
// profil povazuje za pouzivany "na jinem pocitaci", ukaze xmessage a launch visi
// navzdy. Volat jen na profil, ktery tenhle proces prave nepouziva.
export function clearStaleProfileLock(
  profileDir: string,
  env: { hostname?: string; isAlive?: (pid: number) => boolean } = {},
): boolean {
  let target: string;
  try {
    target = fs.readlinkSync(path.join(profileDir, 'SingletonLock'));
  } catch {
    return false;
  }
  const match = /^(.*)-(\d+)$/.exec(target);
  const hostname = env.hostname ?? os.hostname();
  const isAlive = env.isAlive ?? processAlive;
  if (match && match[1] === hostname && isAlive(Number(match[2]))) {
    return false;
  }
  for (const name of SINGLETON_FILES) {
    fs.rmSync(path.join(profileDir, name), { force: true });
  }
  return true;
}
