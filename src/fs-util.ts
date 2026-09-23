import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { conflict } from './errors.js';

export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
export async function canonical(path: string): Promise<string> {
  path = resolve(path);
  try { return await realpath(path); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw e;
    return join(await canonical(dirname(path)), basename(path));
  }
}
export const within = (path: string, root: string) => path === root || path.startsWith(root + sep);
export async function outside(path: string, roots: string[]): Promise<void> {
  const actual = await canonical(path);
  for (const root of roots) if (within(actual, await canonical(root))) throw conflict(`${path} must be outside ${root}`);
}
export interface Owner { dev: string; ino: string }
export async function owner(path: string): Promise<Owner> {
  const st = await lstat(path, { bigint: true });
  if (!st.isDirectory()) throw conflict(`Expected an owned directory: ${path}`);
  return { dev: String(st.dev), ino: String(st.ino) };
}
export async function owned(path: string, expected?: Owner): Promise<boolean> {
  if (!expected || !await exists(path)) return false;
  const current = await owner(path);
  return current.dev === expected.dev && current.ino === expected.ino;
}
export async function syncPath(path: string, warnings: string[]): Promise<void> {
  let handle;
  try { handle = await open(path, 'r'); await handle.sync(); }
  catch (e) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
    const warning = 'Filesystem does not support all requested fsync operations; crash durability is limited.';
    if (!warnings.includes(warning)) warnings.push(warning);
  } finally { await handle?.close(); }
}
export async function syncTree(root: string, warnings: string[]): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await syncTree(path, warnings);
    else if (entry.isFile()) await syncPath(path, warnings);
    else throw conflict(`Unsupported staging entry: ${path}`);
  }
  await syncPath(root, warnings);
}
export async function atomicJson(path: string, value: unknown, warnings: string[] = []): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
    await rename(temp, path); await syncPath(dirname(path), warnings);
  } finally { await rm(temp, { force: true }); }
}
export async function reserveFiles(root: string, paths: string[]): Promise<void> {
  const dirs = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!dirs.has(dir)) { await mkdir(join(root, dir)); dirs.add(dir); }
    }
    const file = await open(join(root, path), 'wx'); await file.close();
  }
}
