import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { matchPayload, manifest, type Item } from '../src/inventory.js';
import { buildConversion, buildZipBag, verify } from '../src/package.js';
import { readZip } from '../src/zip.js';
import { fixture } from './zip-fixture.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'vestry-unicode-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

for (const form of ['NFC', 'NFD'] as const) it(`preserves ${form} manifest spelling through a different disk spelling and repacking`, async () => {
  const opposite = form === 'NFC' ? 'NFD' : 'NFC';
  const directory = 'pièces'.normalize(form), filename = 'janvier à août.xlsx'.normalize(form);
  const path = `${directory}/${filename}`, bytes = Buffer.from('original spreadsheet bytes');
  const zip = join(root, 'input.zip'), packed = join(root, 'packed'), expanded = join(root, 'expanded'), repacked = join(root, 'repacked');
  await writeFile(zip, fixture([{ name: path, data: bytes }]));
  await mkdir(packed); await buildZipBag(zip, packed, undefined);
  const original = await verify(packed);
  await mkdir(expanded); await buildConversion(packed, expanded, original, {});
  // Simulate a filesystem returning a different canonical Unicode spelling.
  await rename(join(expanded, 'data', directory, filename), join(expanded, 'data', directory, filename.normalize(opposite)));
  await rename(join(expanded, 'data', directory), join(expanded, 'data', directory.normalize(opposite)));
  const checked = await verify(expanded);
  expect(checked.packageDigest).toBe(original.packageDigest);
  expect(checked.payloadDigest).toBe(original.payloadDigest);
  await mkdir(repacked); await buildConversion(expanded, repacked, checked, {});
  expect((await verify(repacked)).packageDigest).toBe(original.packageDigest);
  expect((await readZip(join(repacked, 'data.zip'))).map(item => item.path)).toEqual([path]);
  expect(await readFile(join(repacked, 'manifest-sha256.txt'))).toEqual(await readFile(join(packed, 'manifest-sha256.txt')));
  await writeFile(join(expanded, 'data', directory.normalize(opposite), filename.normalize(opposite)), 'corrupt');
  await expect(verify(expanded)).rejects.toThrow('checksum/membership');
});

const item = (path: string): Item => ({ path, size: 1n, sha256: 'a'.repeat(64) });
it('rejects ambiguous manifest names, physical names, and parent directory aliases', () => {
  for (const paths of [['data/é', 'data/é'], ['data/é/a', 'data/é/b']]) {
    expect(() => matchPayload(manifest(paths.map(item)), paths.map(item))).toThrow('Ambiguous Unicode');
    expect(() => matchPayload(manifest([item('data/é')]), paths.map(item))).toThrow('Ambiguous Unicode');
  }
});
it('does not match compatibility characters or changed membership', () => {
  expect(() => matchPayload(manifest([item('data/①')]), [item('data/1')])).toThrow('checksum/membership');
  expect(() => matchPayload(manifest([item('data/é')]), [item('data/é'), item('data/extra')])).toThrow('membership');
});
it('refuses normalized archive collisions before extraction, preserving the archive', async () => {
  for (const names of [['é', 'é'], ['é/a', 'é/b'], ['é', 'é/child']]) {
    const zip = join(root, 'collision.zip'), out = join(root, 'out');
    const bytes = fixture(names.map(name => ({ name })));
    await writeFile(zip, bytes);
    expect(await readZip(zip)).toHaveLength(2);
    await expect(readZip(zip, { destination: out })).rejects.toThrow('Ambiguous Unicode');
    expect(await readFile(zip)).toEqual(bytes);
  }
});
