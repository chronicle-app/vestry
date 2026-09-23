import { lstat, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { exists, owned, syncPath } from './fs-util.js';
import { digest, hashFile, walk } from './inventory.js';
import { writeTags, type Verification } from './package.js';
import { readZip } from './zip.js';
import { checkpoint, type Context, type Operation } from './operations.js';
import { conflict, diagnostic, integrity } from './errors.js';
import { type Timestamps } from './timestamps.js';

export interface ZipAdoption {
  dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string; sha256: string;
}
async function fingerprint(path: string) {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isFile()) throw conflict('ZIP source must remain a regular file.');
  return { dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
}
function matches(actual: Awaited<ReturnType<typeof fingerprint>>, expected: ZipAdoption, moved = false) {
  return (['dev', 'ino', 'size', 'mtimeNs', ...(moved ? [] : ['ctimeNs'])] as const).every(key => actual[key as keyof typeof actual] === expected[key as keyof ZipAdoption]);
}

export async function prepareZipAdoption(source: string, stage: string, context: Context): Promise<{ archive: ZipAdoption; result: Verification }> {
  const before = await fingerprint(source);
  const timestamps: Timestamps = { version: 1, files: [], originalZipMtimeNs: before.mtimeNs };
  context.signal?.throwIfAborted();
  const checksum = await hashFile(source, 'data.zip', (path, bytes, total) => {
    context.signal?.throwIfAborted(); context.onActivity?.(`Checksumming original ZIP: ${path}`, bytes, total);
  });
  context.onActivity?.('Reading ZIP entries in place; no archive copy');
  let payload;
  try { payload = (await readZip(source, { onMtime: (path, ns) => timestamps.files.push({ path: 'data/' + path, mtimeNs: ns }) })).map(item => ({ ...item, path: 'data/' + item.path })); }
  catch (error) { const failure = diagnostic(error); if (failure.exitCode !== 1 || (error as NodeJS.ErrnoException).code) throw failure; throw integrity(failure.message); }
  const archive = { ...before, sha256: checksum.sha256 };
  if (!matches(await fingerprint(source), archive)) throw integrity('Source ZIP changed while reading; original retained.');
  context.signal?.throwIfAborted();
  await writeTags(stage, payload, undefined, undefined, timestamps);
  const tags = await walk(stage);
  return { archive, result: { status: 'verified', representation: 'packed', standardBag: false,
    packageDigest: digest('package', [...payload, ...tags]), payloadDigest: digest('payload', payload),
    payloadBytes: payload.reduce((sum, item) => sum + item.size, 0n).toString(), payloadFiles: payload.length } };
}

/** Idempotent across a crash between rename and the journal checkpoint. */
export async function relocateZip(home: string, op: Operation, context: Context): Promise<void> {
  if (!await owned(op.staging!, op.stageOwner)) throw conflict('ZIP staging directory was replaced; refusing relocation.');
  const archive = op.zipAdoption!, target = join(op.staging!, 'data.zip');
  const moved = await exists(target), path = moved ? target : op.source;
  if (!matches(await fingerprint(path), archive, moved)) throw integrity('Original ZIP changed or was replaced; refusing relocation.');
  context.onActivity?.(moved ? 'Checking the ZIP retained in staging' : 'Rechecking original ZIP before moving it');
  const checksum = await hashFile(path, 'data.zip', (_path, bytes, total) => {
    context.signal?.throwIfAborted(); context.onActivity?.('Checking unchanged ZIP bytes', bytes, total);
  });
  if (checksum.sha256 !== archive.sha256 || checksum.size.toString() !== archive.size || !matches(await fingerprint(path), archive, moved)) throw integrity('Original ZIP changed; refusing relocation.');
  context.signal?.throwIfAborted();
  if (!moved) {
    if (await exists(target)) throw conflict('ZIP staging target already exists.');
    context.onActivity?.('Moving unchanged ZIP into the package (no copy)');
    await rename(op.source, target);
  }
  // Sync both directory entries even when recovering an uncheckpointed rename.
  await syncPath(target, op.warnings);
  await syncPath(op.staging!, op.warnings);
  await syncPath(dirname(op.source), op.warnings);
  await checkpoint(home, op, 'relocated', context);
}
