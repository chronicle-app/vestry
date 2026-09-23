import { afterEach, beforeEach, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPackage, convertInPlace, copyArchive } from '../src/locations.js';
import { verify } from '../src/package.js';
import { walk } from '../src/inventory.js';
import { readZip, writeZip } from '../src/zip.js';
import { mtimeNs, readTimestamps } from '../src/timestamps.js';
import { canonical } from '../src/fs-util.js';

let root: string;
beforeEach(async () => { root = await canonical(await mkdtemp(join(tmpdir(), 'vestry-times-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const memberTime = 1_600_000_001.123456;
const archiveTime = 1_650_000_003.456789;
async function expectTime(path: string, expected: number) {
  // Node's utimes and filesystem rounding may differ by a few microseconds.
  expect(Math.abs((await lstat(path)).mtimeMs / 1000 - expected)).toBeLessThan(0.00001);
}

for (const packed of [false, true]) it(`preserves directory file times across repeated conversions (initially packed=${packed})`, async () => {
  const source = join(root, 'files'), file = join(source, 'note');
  await mkdir(source); await writeFile(file, 'original'); await utimes(file, memberTime, memberTime);
  const originalNs = await mtimeNs(file);
  const context = { home: join(root, 'home') };
  await createPackage(source, { ...context, packed });
  const original = await verify(source);
  expect((await readTimestamps(source))?.files).toEqual([{ path: 'data/note', mtimeNs: originalNs }]);
  if (packed) await convertInPlace(source, 'expanded', context);
  for (let i = 0; i < 3; i++) {
    await expectTime(join(source, 'data/note'), memberTime);
    await convertInPlace(source, 'packed', context);
    const times = new Map<string, string>();
    await readZip(join(source, 'data.zip'), { onMtime: (path, ns) => times.set(path, ns) });
    expect(Number(times.get('note')) / 1e9).toBe(Math.floor(memberTime));
    await convertInPlace(source, 'expanded', context);
    expect((await verify(source)).packageDigest).toBe(original.packageDigest);
  }
  await expectTime(join(source, 'data/note'), memberTime);
  const copy = join(root, 'copy'); await copyArchive(source, copy, context);
  await expectTime(join(copy, 'data/note'), memberTime);
}, 30000);

for (const copied of [false, true]) it(`preserves original ZIP container and member times across repeated conversions (copied=${copied})`, async () => {
  const files = join(root, 'files'); await mkdir(files);
  await writeFile(join(files, 'note'), 'takeout'); await utimes(join(files, 'note'), memberTime, memberTime);
  const zip = join(root, 'takeout.zip'); await writeZip(files, await walk(files), zip);
  await utimes(zip, archiveTime, archiveTime);
  const originalNs = await mtimeNs(zip);
  const bag = join(root, copied ? 'copy' : 'takeout');
  const context = { home: join(root, 'home') };
  await createPackage(zip, { ...context, ...(copied ? { output: bag } : {}) });
  const original = await verify(bag);
  expect((await readTimestamps(bag))?.originalZipMtimeNs).toBe(originalNs);
  expect(await readFile(join(bag, 'bag-info.txt'), 'utf8')).toContain('Original-Zip-Mtime:');
  for (let i = 0; i < 3; i++) {
    await expectTime(join(bag, 'data.zip'), archiveTime);
    await convertInPlace(bag, 'expanded', context);
    await expectTime(join(bag, 'data/note'), Math.floor(memberTime));
    await convertInPlace(bag, 'packed', context);
    expect((await verify(bag)).packageDigest).toBe(original.packageDigest);
  }
  await expectTime(join(bag, 'data.zip'), archiveTime);
  const copy = join(root, 'second-copy'); await copyArchive(bag, copy, context);
  await expectTime(join(copy, 'data.zip'), archiveTime);
}, 30000);

it('protects recorded timestamps with the tag manifest', async () => {
  const source = join(root, 'files'); await mkdir(source); await writeFile(join(source, 'note'), 'original');
  await createPackage(source, { home: join(root, 'home') });
  const times = (await readTimestamps(source))!;
  times.files[0].mtimeNs = '0';
  await writeFile(join(source, 'timestamps.json'), JSON.stringify(times));
  await expect(verify(source)).rejects.toMatchObject({ exitCode: 3 });
});
