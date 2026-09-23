import { afterEach, beforeEach, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPackage, movePackage, adoptMain } from '../src/locations.js';
import { canonical, exists } from '../src/fs-util.js';
import { listPackages, readRegistry, rememberVerified, resolveReference, withReference } from '../src/registry.js';
import { checkOutput } from '../src/workflow.js';
import { listOperations, recover, type Context } from '../src/operations.js';
import { verify } from '../src/package.js';
import { cacheCopy } from '../src/cache.js';

let root: string, source: string, target: string, context: Context;
beforeEach(async () => {
  root = await canonical(await mkdtemp(join(tmpdir(), 'vestry-locations-')));
  source = join(root, 'files'); target = join(root, 'archive'); context = { home: join(root, 'home') };
  await mkdir(source); await mkdir(join(source, 'nested'));
  await writeFile(join(source, 'nested', 'note'), 'Original bytes');
  await writeFile(join(source, 'README.txt'), 'An original README');
  await writeFile(join(source, '.hidden'), 'Include dotfiles');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('creates in place, preserves original metadata as payload, and lists the main location', async () => {
  const result = await createPackage(source, { ...context, description: 'My originals', alias: 'notes' });
  expect((await verify(source)).packageDigest).toBe(result.packageDigest);
  expect(await readFile(join(source, 'data/README.txt'), 'utf8')).toBe('An original README');
  expect(await readFile(join(source, 'data/.hidden'), 'utf8')).toBe('Include dotfiles');
  expect(await readFile(join(source, 'data/nested/note'), 'utf8')).toBe('Original bytes');
  expect((await listPackages(context)).packages).toEqual([expect.objectContaining({ aliases: ['notes'], mainLocation: source, availability: 'available' })]);
  expect((await readdir(root)).some(name => name.startsWith('.vestry-'))).toBe(false);
  await expect(createPackage(source, { ...context, description: 'Again' })).rejects.toMatchObject({ exitCode: 5 });
});

it('moves an explicit copy and retains its original, preserves identity and pinned copies, and retains unavailable history', async () => {
  const created = await createPackage(source, { ...context, description: 'Move test', alias: 'notes' });
  const pinned = await cacheCopy('notes', 'pin', context);
  const moved = await movePackage(source, target, context);
  expect(moved.packageDigest).toBe(created.packageDigest);
  expect(await exists(source)).toBe(false);
  expect((await verify(target)).packageDigest).toBe(created.packageDigest);
  expect(await exists(pinned.path as string)).toBe(true);
  expect((await readRegistry(context)).packages[created.packageDigest as string].mainLocation).toBe(target);
  await mkdir(source); await writeFile(join(source, 'new-note'), 'Different package');
  await createPackage(source, { ...context, description: 'Reuse old location' });
  await rename(target, join(root, 'unmounted'));
  expect((await listPackages(context)).packages).toEqual(expect.arrayContaining([expect.objectContaining({ mainLocation: target, availability: 'unavailable' })]));
  expect((await resolveReference('notes', { ...context, offline: true })).path).toBe(pinned.path);
  await expect(movePackage(target, join(root, 'other'), context)).rejects.toMatchObject({ exitCode: 4 });
});

it('registering other copies preserves main; explicit adoption changes it without deleting bytes', async () => {
  const created = await createPackage(source, { ...context, description: 'Adopt test', alias: 'notes' });
  await cp(source, target, { recursive: true });
  await rememberVerified(target, await verify(target), context);
  expect((await readRegistry(context)).packages[created.packageDigest as string].mainLocation).toBe(source);
  await withReference(target, context, r => adoptMain(r.path, created.packageDigest as string, r.lease, context));
  expect((await resolveReference('notes', context)).path).toBe(target);
  expect(await exists(source)).toBe(true);
});

it('refuses overwrite, nested destinations, offline moves; allows an explicit secondary copy', async () => {
  await createPackage(source, { ...context, description: 'Boundaries' });
  await mkdir(target);
  await expect(movePackage(source, target, context)).rejects.toMatchObject({ exitCode: 5 });
  await expect(movePackage(source, join(source, 'inside'), context)).rejects.toMatchObject({ exitCode: 5 });
  await expect(movePackage(source, root, context)).rejects.toMatchObject({ exitCode: 5 });
  await expect(movePackage(source, target, { ...context, offline: true })).rejects.toMatchObject({ exitCode: 2 });
  const copy = join(root, 'copy'); await cp(source, copy, { recursive: true });
  await rememberVerified(copy, await verify(copy), context);
  expect(await movePackage(copy, join(root, 'new'), context)).toMatchObject({ cleanupRequired: true });
  await verify(source);
});

it('rejects unsafe sources without rearranging originals', async () => {
  await expect(createPackage(source, { home: join(source, 'home'), description: 'Bad workspace' })).rejects.toMatchObject({ exitCode: 5 });
  await symlink(join(source, 'nested/note'), join(source, 'link'));
  await expect(createPackage(source, { ...context, description: 'Bad link' })).rejects.toThrow();
  expect(await readFile(join(source, 'nested/note'), 'utf8')).toBe('Original bytes');
  expect(await exists(join(source, 'bagit.txt'))).toBe(false);
});

it('refuses moves and in-place creation while a reader is active', async () => {
  await withReference(source, context, async () => {
    await expect(createPackage(source, { ...context, description: 'Busy' })).rejects.toMatchObject({ exitCode: 5 });
  });
  await createPackage(source, { ...context, description: 'Busy package' });
  await withReference(join(source, 'data/nested/note'), context, async () => {
    await expect(movePackage(source, target, context)).rejects.toMatchObject({ exitCode: 5 });
  });
});

it('retains originals if they change after staged verification', async () => {
  await expect(createPackage(source, { ...context, description: 'Changing source', onPhase: async phase => {
    if (phase === 'verified') await writeFile(join(source, 'nested/note'), 'New bytes');
  }})).rejects.toMatchObject({ exitCode: 3 });
  expect(await readFile(join(source, 'nested/note'), 'utf8')).toBe('New bytes');
  const op = (await listOperations(context)).find(op => op.kind === 'create')!;
  await recover(op.id, checkOutput, context, true);
  expect(await readFile(join(source, 'nested/note'), 'utf8')).toBe('New bytes');
});

for (const kind of ['create', 'move'] as const) for (const phase of ['planned', 'building', 'verified', 'relocated', 'reserved', 'published', 'cleaning', 'complete']) {
  if (kind === 'move' && phase === 'cleaning') continue;
  it(`recovers ${kind} after SIGKILL at ${phase}`, async () => {
    if (kind === 'move') await createPackage(source, { ...context, description: 'Crash fixture' });
    const before = kind === 'move' ? (await verify(source)).packageDigest : undefined;
    const child = spawnSync(process.execPath, [resolve('dist/test/helpers/location-worker.js'), kind, source, target, context.home!, phase], { encoding: 'utf8', timeout: 15000 });
    expect(child.signal, child.stderr).toBe('SIGKILL');
    const op = (await listOperations(context)).filter(op => op.kind === kind).at(-1)!;
    if (['planned', 'building'].includes(phase)) {
      await recover(op.id, checkOutput, context, true);
      expect(await exists(source)).toBe(true);
      if (kind === 'create') expect(await readFile(join(source, 'nested/note'), 'utf8')).toBe('Original bytes');
      else expect((await verify(source)).packageDigest).toBe(before);
    } else {
      await recover(op.id, checkOutput, context);
      const path = kind === 'create' ? source : target;
      const verified = await verify(path);
      if (before) expect(verified.packageDigest).toBe(before);
      expect((await readRegistry(context)).packages[verified.packageDigest].mainLocation).toBe(path);
      if (kind === 'create') expect((await readRegistry(context)).aliases['crash-fixture']).toBe(verified.packageDigest);
      expect(await exists(op.backup!)).toBe(kind === 'move');
      if (kind === 'move') expect((await verify(op.backup!)).packageDigest).toBe(before);
      if (kind === 'move') expect(await exists(source)).toBe(false);
    }
  });
}

it('exposes the default create/list/move flow and manual main selection through the linked CLI entrypoint', () => {
  const cli = (...args: string[]) => spawnSync(process.execPath, ['bin/vestry.js', ...args, '--home', context.home!, '--json', '--quiet'], { encoding: 'utf8' });
  let result = cli('create', source, '--description', 'CLI flow', '--as', 'notes');
  expect(result.status, result.stdout).toBe(0);
  result = cli('list'); expect(JSON.parse(result.stdout).packages[0].mainLocation).toBe(source);
  result = cli('move', 'notes', '--to', target); expect(result.status, result.stdout).toBe(0);
  result = cli('list'); expect(JSON.parse(result.stdout).packages[0].mainLocation).toBe(target);
  result = cli('register', target, '--main'); expect(result.status, result.stdout).toBe(0);
});

it('supports packed in-place creation and refuses replacement from inside the source folder', async () => {
  const cli = spawnSync(process.execPath, [resolve('bin/vestry.js'), 'create', '.', '--description', 'Inside', '--home', context.home!, '--json'], { cwd: source, encoding: 'utf8' });
  expect(cli.status).toBe(2);
  expect(JSON.parse(cli.stdout).error.message).toContain('outside the source folder');
  const result = await createPackage(source, { ...context, description: 'Packed', packed: true });
  expect((await verify(source)).representation).toBe('packed');
  expect(result.payloadFiles).toBe(3);
});
