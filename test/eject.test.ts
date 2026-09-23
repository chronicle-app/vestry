import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonical, exists } from '../src/fs-util.js';
import { createPackage, copyArchive } from '../src/locations.js';
import { ejectPackage } from '../src/eject.js';
import { cleanupMove, listOperations, recover, type Context } from '../src/operations.js';
import { readRegistry, withReference } from '../src/registry.js';
import { verify } from '../src/package.js';
import { checkOutput } from '../src/workflow.js';
import { fixture } from './zip-fixture.js';
let root: string, source: string, context: Context;
beforeEach(async () => {
  root = await canonical(await mkdtemp(join(tmpdir(), 'vestry-eject-')));
  source = join(root, 'package'); context = { home: join(root, 'records') };
  await mkdir(source); await writeFile(join(source, 'README.txt'), 'Original README');
  await writeFile(join(source, 'manifest-sha256.txt'), 'An original with a tag filename');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
for (const packed of [false, true]) it(`restores ${packed ? 'packed' : 'expanded'} payload, retaining the package and other locations`, async () => {
  const made = await createPackage(source, { ...context, packed, description: 'Vestry notes', alias: 'example' });
  const copy = join(root, 'copy'); await copyArchive(source, copy, context);
  const result = await ejectPackage(source, context);
  expect(await readFile(join(source, 'README.txt'), 'utf8')).toBe('Original README');
  expect(await readFile(join(source, 'manifest-sha256.txt'), 'utf8')).toBe('An original with a tag filename');
  expect(await exists(join(source, 'bagit.txt'))).toBe(false);
  expect((await verify(result.recoveryCopy as string)).packageDigest).toBe(made.packageDigest);
  const state = await readRegistry(context), record = state.packages[made.packageDigest as string];
  expect(record.locations.map(l => l.path)).toEqual([copy]);
  expect(record.mainLocation).toBeNull(); expect(record.metadata?.description).toBe('Vestry notes');
  expect(state.aliases.example).toBe(made.packageDigest);
  await cleanupMove(result.operationId as string, context);
  expect(await exists(result.recoveryCopy as string)).toBe(false);
  expect((await verify(copy)).packageDigest).toBe(made.packageDigest);
});
it('restores exact ZIP bytes under their imported name, without extraction', async () => {
  await rm(source, { recursive: true }); await mkdir(source);
  const bytes = fixture([{ name: 'note.txt', data: Buffer.from('Archive content') }]);
  await writeFile(join(source, 'export.zip'), bytes);
  await createPackage(source, { ...context, zipContents: true });
  const result = await ejectPackage(source, { ...context, keepZip: true });
  expect(await readFile(join(source, 'export.zip'))).toEqual(bytes);
  expect(await exists(join(source, 'note.txt'))).toBe(false);
  expect(result.cleanupRequired).toBe(true);
});
it('uses payload.zip for packages created packed without an imported filename', async () => {
  await createPackage(source, { ...context, packed: true });
  const bytes = await readFile(join(source, 'data.zip'));
  await ejectPackage(source, { ...context, keepZip: true });
  expect(await readFile(join(source, 'payload.zip'))).toEqual(bytes);
});
it('refuses corrupted input, active readers, and cleanup after restored files change', async () => {
  await createPackage(source, context);
  await withReference(source, context, async () => { await expect(ejectPackage(source, context)).rejects.toThrow(); });
  await writeFile(join(source, 'data/README.txt'), 'Damaged');
  await expect(ejectPackage(source, context)).rejects.toThrow();
  expect(await exists(join(source, 'bagit.txt'))).toBe(true);
  await writeFile(join(source, 'data/README.txt'), 'Original README');
  const result = await ejectPackage(source, context);
  await writeFile(join(source, 'new-file'), 'Intentional edit');
  await expect(cleanupMove(result.operationId as string, context)).rejects.toThrow('changed');
  expect(await exists(result.recoveryCopy as string)).toBe(true);
});
for (const phase of ['planned', 'building', 'verified', 'relocated', 'reserved', 'published', 'complete']) it(`recovers eject killed at ${phase}`, async () => {
  const original = await createPackage(source, context);
  const child = spawnSync(process.execPath, [resolve('dist/test/helpers/eject-worker.js'), source, context.home!, phase], { encoding: 'utf8', timeout: 15000 });
  expect(child.signal, child.stderr).toBe('SIGKILL');
  const op = (await listOperations(context)).find(o => o.kind === 'eject')!;
  const discard = ['planned', 'building'].includes(phase);
  await recover(op.id, checkOutput, context, discard);
  if (discard) expect((await verify(source)).packageDigest).toBe(original.packageDigest);
  else {
    expect(await readFile(join(source, 'README.txt'), 'utf8')).toBe('Original README');
    expect((await verify(op.backup!)).packageDigest).toBe(original.packageDigest);
    expect((await readRegistry(context)).packages[original.packageDigest as string].locations).toHaveLength(0);
  }
});
it('exposes eject through the linked command', async () => {
  await createPackage(source, context);
  const child = spawnSync(process.execPath, ['bin/vestry.js', 'eject', source, '--home', context.home!, '--json'], { encoding: 'utf8' });
  expect(child.status, child.stdout).toBe(0);
  expect(JSON.parse(child.stdout)).toMatchObject({ command: 'eject', cleanupRequired: true, status: 'ejected' });
});
