import { lstat, readFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { membership, type Item } from './inventory.js';

export const TIMESTAMPS = 'timestamps.json';
export interface Timestamps {
  version: 1;
  files: { path: string; mtimeNs: string }[];
  originalZipMtimeNs?: string;
}

export async function mtimeNs(path: string): Promise<string> {
  return String((await lstat(path, { bigint: true })).mtimeNs);
}

export function timestampDate(ns: string): Date { return new Date(Number(BigInt(ns)) / 1e6); }

/** Keep the exact value in metadata; apply the precision supported by Node/the filesystem. */
export async function restoreMtime(path: string, ns: string): Promise<void> {
  const stat = await lstat(path);
  const seconds = Number(BigInt(ns)) / 1e9;
  // Node treats negative numeric times as "now"; Date preserves pre-epoch values.
  await utimes(path, stat.atime, seconds < 0 ? timestampDate(ns) : seconds);
}

export function validateTimestamps(value: Timestamps, payload: Item[]): void {
  const validTime = (ns: unknown) => typeof ns === 'string' && /^-?\d+$/.test(ns) && Number.isFinite(timestampDate(ns).getTime());
  if (!value || value.version !== 1 || !Array.isArray(value.files) ||
      (value.originalZipMtimeNs !== undefined && !validTime(value.originalZipMtimeNs))) throw new Error('Invalid timestamp metadata');
  const paths = new Set(payload.map(item => item.path));
  for (const file of value.files) {
    if (!file || typeof file.path !== 'string' || !paths.has(file.path) || !validTime(file.mtimeNs)) throw new Error('Invalid payload timestamp');
  }
  membership(value.files.map(file => file.path));
  if (value.files.length !== paths.size) throw new Error('Timestamp membership mismatch');
}

export async function readTimestamps(root: string): Promise<Timestamps | undefined> {
  try { return JSON.parse(await readFile(join(root, TIMESTAMPS), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export async function restorePayloadTimes(root: string, timestamps: Timestamps): Promise<void> {
  for (const file of timestamps.files) await restoreMtime(join(root, file.path), file.mtimeNs);
}
