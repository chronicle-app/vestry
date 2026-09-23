import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export type ReadProgress = (path: string, bytes: string, total: string) => void;
export interface Item { path: string; size: bigint; sha256: string }
export const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function logicalPath(path: string): string {
  if (!path || path.includes('\\') || path.includes('\0') || /^[A-Za-z]:/.test(path) ||
      path.split('/').some(p => !p || p === '.' || p === '..') ||
      utf8.decode(Buffer.from(path)) !== path) throw new Error(`Unsafe logical path: ${JSON.stringify(path)}`);
  return path;
}

export function membership(paths: string[], directories: string[] = []): void {
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const path of [...paths, ...directories]) {
    logicalPath(path);
    const parts = path.split('/');
    for (let n = 1; n < parts.length; n++) dirs.add(parts.slice(0, n).join('/'));
  }
  for (const path of directories) dirs.add(path);
  for (const path of paths) {
    if (files.has(path) || dirs.has(path)) throw new Error(`Duplicate or conflicting path: ${path}`);
    files.add(path);
  }
}

export function sorted(items: Item[]): Item[] {
  return [...items].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}

export function digest(scope: 'package' | 'payload' | 'code', items: Item[]): string {
  membership(items.map(x => x.path));
  const hash = createHash('sha256').update(`vestry-${scope}-v1\n`);
  const count = Buffer.alloc(8); count.writeBigUInt64BE(BigInt(items.length)); hash.update(count);
  for (const item of sorted(items)) {
    const path = Buffer.from(item.path);
    const pathLength = Buffer.alloc(4); pathLength.writeUInt32BE(path.length);
    const size = Buffer.alloc(8); size.writeBigUInt64BE(item.size);
    if (!/^[0-9a-f]{64}$/.test(item.sha256)) throw new Error('Invalid SHA-256');
    hash.update(pathLength).update(path).update(size).update(Buffer.from(item.sha256, 'hex'));
  }
  return `vestry-${scope}-v1:sha256:${hash.digest('hex')}`;
}

export async function hashFile(file: string, path: string, progress?: ReadProgress): Promise<Item> {
  const hash = createHash('sha256'); let size = 0n;
  const total = progress ? (await lstat(file, { bigint: true })).size.toString() : '0';
  progress?.(file, '0', total);
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) { hash.update(chunk); size += BigInt(chunk.length); progress?.(file, size.toString(), total); }
  return { path, size, sha256: hash.digest('hex') };
}

export async function walk(root: string, prefix = '', excluded: ReadonlySet<string> = new Set(), progress?: ReadProgress): Promise<Item[]> {
  if (!(await lstat(root)).isDirectory()) throw new Error('Expected regular directory');
  const items: Item[] = [];
  for (const raw of await readdir(root, { encoding: 'buffer' })) {
    const name = utf8.decode(raw); const path = logicalPath(prefix + name);
    if (excluded.has(path)) continue;
    const source = join(root, name); const stat = await lstat(source);
    if (stat.isDirectory()) items.push(...await walk(source, path + '/', excluded, progress));
    else if (stat.isFile()) items.push(await hashFile(source, path, progress));
    else throw new Error(`Unsupported filesystem entry: ${path}`);
  }
  return sorted(items);
}

export function manifest(items: Item[]): string {
  return sorted(items).map(i => `${i.sha256}  ${i.path.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}\n`).join('');
}

export function parseManifest(text: string): Map<string, string> {
  const expected = new Map<string, string>();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) throw new Error('Malformed manifest');
    const path = logicalPath(match[2].replace(/%25|%0D|%0A/g, s => ({ '%25': '%', '%0D': '\r', '%0A': '\n' })[s]!));
    if (expected.has(path)) throw new Error(`Duplicate manifest entry: ${path}`);
    expected.set(path, match[1]);
  }
  return expected;
}

export function checkManifest(text: string, actual: Item[]): void {
  const expected = parseManifest(text);
  if (actual.length !== expected.size) throw new Error('Manifest membership mismatch');
  for (const i of actual) if (expected.get(i.path) !== i.sha256) throw new Error(`Manifest checksum/membership mismatch: ${i.path}`);
}

/** Reject ambiguous Unicode spellings, including aliases of parent directories. */
export function portableNames(paths: string[]): void {
  const names = new Map<string, string>();
  for (const path of paths) {
    logicalPath(path);
    const parts = path.split('/');
    for (let n = 1; n <= parts.length; n++) {
      const name = parts.slice(0, n).join('/'), key = name.normalize('NFC');
      const prior = names.get(key);
      if (prior !== undefined && prior !== name) throw new Error(`Ambiguous Unicode filenames: ${JSON.stringify(prior)} and ${JSON.stringify(name)}`);
      names.set(key, name);
    }
  }
  membership(paths.map(path => path.normalize('NFC')));
}

/** Match physical files one-to-one to immutable manifest names. Never normalize identity. */
export function matchPayload(text: string, actual: Item[]): (Item & { diskPath: string })[] {
  const expected = parseManifest(text);
  portableNames([...expected.keys()]); portableNames(actual.map(item => item.path));
  if (actual.length !== expected.size) throw new Error('Manifest membership mismatch');
  const names = new Map([...expected.keys()].map(path => [path.normalize('NFC'), path]));
  const matched = new Set<string>();
  return actual.map(item => {
    const path = names.get(item.path.normalize('NFC'));
    if (path === undefined || matched.has(path) || expected.get(path) !== item.sha256) throw new Error(`Manifest checksum/membership mismatch: ${item.path}`);
    matched.add(path);
    return { ...item, path, diskPath: item.path };
  });
}
