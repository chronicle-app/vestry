import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical } from '../src/fs-util.js';
import { createPackage, convertInPlace } from '../src/locations.js';
import { editMetadata, forgetPackage, listPackages, locate, mutateRegistry, readRegistry, resolveReference, setMainLocation } from '../src/registry.js';
import { verifyRecorded } from '../src/workflow.js';
import { scanDirectory } from '../src/scan.js';
let root: string, home: string;
beforeEach(async () => { root = await canonical(await mkdtemp(join(tmpdir(), 'vestry-content-'))); home = join(root, 'home'); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function create(name: string) {
  const path = join(root, name); await mkdir(path); await writeFile(join(path, 'file.txt'), 'same content');
  return createPackage(path, { home, alias: name });
}
it('groups different package metadata under one content ID and checks the selected exact package', async () => {
  const a = await create('first'), b = await create('second');
  expect(a.packageDigest).not.toBe(b.packageDigest);
  expect(a.contentId).toBe(b.contentId);
  const id = a.payloadDigest as string;
  expect((await listPackages({ home })).packages).toHaveLength(1);
  const detail = await locate(id, { home });
  expect(detail).toMatchObject({ contentId: id, mainLocation: a.path, aliases: ['first', 'second'] });
  expect(detail.locations).toEqual(expect.arrayContaining([expect.objectContaining({ path: a.path, packageDigest: a.packageDigest }), expect.objectContaining({ path: b.path, packageDigest: b.packageDigest })]));
  expect((await locate(id.split(':').at(-1)!.slice(0, 12), { home })).contentId).toBe(id);
  await expect(convertInPlace(id, 'packed', { home })).rejects.toMatchObject({ code: 'AMBIGUOUS_COPY' });
  expect(await resolveReference(id, { home, location: b.path as string })).toMatchObject({ expected: b.packageDigest });
  await setMainLocation(b.packageDigest as string, b.path as string, { home });
  expect((await locate(id, { home })).mainLocation).toBe(b.path);
  await convertInPlace(b.path as string, 'packed', { home });
  expect((await verifyRecorded(b.path as string, { home, expected: b.packageDigest as string })).payloadDigest).toBe(id);
  await mutateRegistry({ home }, [], state => {
    state.packages[a.packageDigest as string].metadata = { notes: 'First existing notes' };
    state.packages[b.packageDigest as string].metadata = { notes: 'Second existing notes' };
  });
  const previous = await readRegistry({ home });
  expect((await locate(id, { home })).metadataVariants).toHaveLength(2);
  expect(await readRegistry({ home })).toEqual(previous);
  await editMetadata(id, { title: 'Shared title' }, { home });
  const edited = await readRegistry({ home });
  expect(edited.packages[a.packageDigest as string].metadata?.notes).toBe('First existing notes');
  expect(edited.packages[b.packageDigest as string].metadata?.notes).toBe('Second existing notes');
  expect((await locate('first', { home })).metadata).toMatchObject({ title: 'Shared title' });
  expect((await locate('second', { home })).metadata).toMatchObject({ title: 'Shared title' });
  const forgotten = await forgetPackage(id, { home });
  expect(forgotten.locationsRemoved).toHaveLength(2);
  expect((await listPackages({ home })).packages).toHaveLength(0);
  expect(await readFile(join(a.path as string, 'data/file.txt'), 'utf8')).toBe('same content');
});
it('keeps existing package references working and detects sealed metadata tampering', async () => {
  const a = await create('first');
  expect((await resolveReference(a.packageDigest as string, { home })).expected).toBe(a.packageDigest);
  const before = await readRegistry({ home });
  expect((await locate(a.payloadDigest as string, { home })).contentId).toBe(a.payloadDigest);
  expect(await readRegistry({ home })).toEqual(before);
  await writeFile(join(a.path as string, 'bag-info.txt'), 'tampered');
  await expect(verifyRecorded(a.path as string, { home, expected: a.packageDigest as string })).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' });
});

it('discovers package variants as one content item and refuses an ambiguous main', async () => {
  const a = await create('first'); await create('second');
  const discoveredHome = join(root, 'other-home');
  const result = await scanDirectory(root, { home: discoveredHome, makeMain: true });
  expect(result.summary).toMatchObject({ packages: 1 });
  expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'AMBIGUOUS_MAIN_LOCATION' })]));
  expect((await locate(a.payloadDigest as string, { home: discoveredHome })).locations).toHaveLength(2);
});
