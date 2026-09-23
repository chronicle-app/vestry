import { constants } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { digest, matchPayload, hashFile, walk } from './inventory.js';
import { conflict, integrity, usage } from './errors.js';
import { canonical, within } from './fs-util.js';
import { packageReference } from './locations.js';
import { readRegistry, withCacheMutation, withReference } from './registry.js';
import { verifyRecorded } from './workflow.js';
import { listOperations, retireAbandoned, transaction, type Context, type Checked } from './operations.js';
import { readZip } from './zip.js';
import { mtimeNs, readTimestamps, restoreMtime } from './timestamps.js';

export async function checkEjected(path: string): Promise<Checked> {
  const files = await walk(path);
  return { identity: digest('code', files), result: { status: 'ejected', payloadFiles: files.length, payloadBytes: files.reduce((n, f) => n + f.size, 0n).toString() } };
}
export async function ejectPackage(ref: string, context: Context & { keepZip?: boolean; offline?: boolean } = {}): Promise<Record<string, unknown>> {
  const selected = await packageReference(ref, context);
  if (selected.storage !== 'external') throw usage('Eject requires an external package copy, not a managed cache copy.');
  if (within(await canonical(process.cwd()), selected.path)) throw usage('Run eject from outside the package folder.');
  for (const op of await listOperations(context)) if ([op.source, op.destination].includes(selected.path)) await retireAbandoned(op.id, context);
  const pending = (await listOperations(context)).find(op => op.kind !== 'verify' && !['succeeded', 'discarded'].includes(op.status) && [op.source, op.destination].includes(selected.path));
  if (pending) throw conflict(`An unfinished operation involves this path. Run vestry recover ${pending.id} with the same --home.`);
  return withReference(selected.path, context, async source => {
    const verified = await verifyRecorded(source.path, { ...context, expected: source.expected });
    const id = verified.packageDigest as string;
    if (context.keepZip && verified.representation !== 'packed') throw usage('--keep-zip requires a packed package; expanded eject already preserves nested ZIP originals.');
    const record = (await readRegistry(context)).packages[id];
    const importRecord = (await listOperations(context)).find(op => op.expected === id && op.status === 'succeeded' && (op.zipEntry || op.kind === 'import-zip'));
    const zipName = record.originalZipName ?? importRecord?.zipEntry ?? (importRecord?.kind === 'import-zip' ? basename(importRecord.source) : 'payload.zip');
    if (!/^[^/\\]+\.zip$/i.test(zipName)) throw conflict('Invalid recorded original ZIP filename.');
    return withCacheMutation(id, source.lease, context, async () => {
      let expected: string;
      if (context.keepZip) expected = digest('code', [{ ...await hashFile(join(source.path, 'data.zip'), zipName), path: zipName }]);
      else expected = verified.payloadDigest as string;
      return transaction('eject', source.path, source.path, async stage => {
        context.onActivity?.(context.keepZip ? 'Restoring original ZIP without extraction' : 'Restoring payload files');
        if (context.keepZip) {
          await copyFile(join(source.path, 'data.zip'), join(stage, zipName), constants.COPYFILE_EXCL);
          await restoreMtime(join(stage, zipName), await mtimeNs(join(source.path, 'data.zip')));
        }
        else if (verified.representation === 'packed') await readZip(join(source.path, 'data.zip'), { destination: stage, existingEmptyDirectory: true });
        else for (const item of await walk(join(source.path, 'data'))) {
          context.signal?.throwIfAborted();
          await mkdir(dirname(join(stage, item.path)), { recursive: true });
          await copyFile(join(source.path, 'data', item.path), join(stage, item.path), constants.COPYFILE_EXCL);
          await restoreMtime(join(stage, item.path), await mtimeNs(join(source.path, 'data', item.path)));
        }
        if (!context.keepZip) {
          const timestamps = await readTimestamps(source.path);
          if (timestamps) for (const file of timestamps.files) await restoreMtime(join(stage, file.path.slice(5)), file.mtimeNs);
        }
      }, async stage => {
        const files = await walk(stage);
        const actual = context.keepZip ? digest('code', files) : digest('payload', matchPayload(await readFile(join(source.path, 'manifest-sha256.txt'), 'utf8'), files.map(f => ({ ...f, path: 'data/' + f.path }))));
        if (actual !== expected) throw integrity('Restored data differs from the package payload; original retained.');
        const checked = await checkEjected(stage);
        return { ...checked, result: { ...checked.result, contentId: verified.payloadDigest, payloadDigest: verified.payloadDigest } };
      }, { ...context, ejectPackageDigest: id });
    });
  });
}
