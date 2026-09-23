import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { convertInPlace, createPackage } from '../src/locations.js';
import { canonical, exists } from '../src/fs-util.js';
import { readRegistry, withReference } from '../src/registry.js';
import { cacheCopy, cacheEvict } from '../src/cache.js';
import { verify } from '../src/package.js';
import { checkOutput } from '../src/workflow.js';
import { listOperations, recover, type Context } from '../src/operations.js';

let root: string, source: string, id: string, context: Context;
beforeEach(async () => {
  root = await canonical(await mkdtemp(join(tmpdir(), 'vestry-in-place-')));
  source = join(root, 'package'); context = { home: join(root, 'home') };
  await mkdir(source); await writeFile(join(source, 'note'), 'Original');
  id = (await createPackage(source, { ...context, description: 'Conversion', alias: 'example' })).packageDigest as string;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('requires explicit CLI copy selection when multiple copies exist, retaining metadata, identity, aliases and other copies', async () => {
  const pinned = await cacheCopy('example', 'pin', context);
  const readme = await readFile(join(source, 'bag-info.txt'));
  const cli = (...args: string[]) => spawnSync(process.execPath, ['bin/vestry.js', ...args, '--home', context.home!, '--json', '--quiet'], { encoding: 'utf8' });
  expect(cli('pack', 'example').status).toBe(5);
  const plan = cli('pack', source, '--plan');
  expect(JSON.parse(plan.stdout).writes[0]).toBe(source);
  expect((await verify(source)).representation).toBe('expanded');
  const packed = cli('pack', source); expect(packed.status, packed.stdout).toBe(0);
  expect((await verify(source))).toMatchObject({ packageDigest: id, representation: 'packed' });
  expect((await verify(pinned.path as string)).representation).toBe('expanded');
  const unpacked = cli('unpack', source); expect(unpacked.status, unpacked.stdout).toBe(0);
  expect(await exists(join(source, 'data.zip'))).toBe(false);
  expect(await readFile(join(source, 'data/note'), 'utf8')).toBe('Original');
  expect(await readFile(join(source, 'bag-info.txt'))).toEqual(readme);
  const state = await readRegistry(context);
  expect(state.packages[id].mainLocation).toBe(source); expect(state.aliases.example).toBe(id);
  expect((await readdir(root)).some(name => name.startsWith('.vestry-'))).toBe(false);
});

it('can select a pinned copy explicitly while preserving its storage role and main location', async () => {
  const pinned = await cacheCopy('example', 'pin', context);
  await convertInPlace('example', 'packed', { ...context, location: pinned.path as string });
  expect((await verify(source)).representation).toBe('expanded');
  expect((await verify(pinned.path as string)).representation).toBe('packed');
  const record = (await readRegistry(context)).packages[id];
  expect(record.mainLocation).toBe(source);
  expect(record.locations.find(l => l.path === pinned.path)?.storage).toBe('pinned');
  await expect(cacheEvict('example', context)).rejects.toMatchObject({ exitCode: 5 });
});

it('refuses active readers and preserves a changed original', async () => {
  await withReference(join(source, 'data/note'), context, async () => {
    await expect(convertInPlace('example', 'packed', context)).rejects.toMatchObject({ exitCode: 5 });
  });
  await expect(convertInPlace('example', 'packed', { ...context, onPhase: async phase => {
    if (phase === 'verified') await writeFile(join(source, 'data/note'), 'Changed during conversion');
  }})).rejects.toMatchObject({ exitCode: 3 });
  expect(await readFile(join(source, 'data/note'), 'utf8')).toBe('Changed during conversion');
  const op = (await listOperations(context)).find(op => op.inPlace)!;
  await recover(op.id, checkOutput, context, true);
  expect(await readFile(join(source, 'data/note'), 'utf8')).toBe('Changed during conversion');
});

for (const kind of ['pack', 'unpack'] as const) for (const phase of ['planned', 'building', 'verified', 'relocated', 'reserved', 'published', 'cleaning', 'complete']) {
  it(`recovers in-place ${kind} after SIGKILL at ${phase}`, async () => {
    if (kind === 'unpack') await convertInPlace(source, 'packed', context);
    const child = spawnSync(process.execPath, [resolve('dist/test/helpers/location-worker.js'), kind, source, '', context.home!, phase], { encoding: 'utf8', timeout: 15000 });
    expect(child.signal, child.stderr).toBe('SIGKILL');
    const op = (await listOperations(context)).filter(op => op.kind === kind && op.inPlace).at(-1)!;
    const discarded = ['planned', 'building'].includes(phase);
    await recover(op.id, checkOutput, context, discarded);
    expect((await verify(source))).toMatchObject({ packageDigest: id, representation: (kind === 'pack') !== discarded ? 'packed' : 'expanded' });
    const state = await readRegistry(context);
    expect(state.packages[id].mainLocation).toBe(source); expect(state.aliases.example).toBe(id);
    expect(await exists(op.backup!)).toBe(false);
  });
}
