import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gather, describe } from '../src/draft.js';
import { sealDraft, verifyRecorded, checkOutput } from '../src/workflow.js';
import { verify } from '../src/package.js';
import { canonical, exists } from '../src/fs-util.js';
import { digest, walk } from '../src/inventory.js';
import { listOperations, recover, type Context } from '../src/operations.js';
import { forgetPackage, locate, readRegistry, releaseRegistryLock, rememberVerified, resolveIdentity, resolveReference, withReference } from '../src/registry.js';
import { cacheCopy, cacheEvict, cacheList, managedPath } from '../src/cache.js';

let root: string, archive: string, draft: string, id: string, context: Context;
beforeEach(async () => {
  root = await canonical(await mkdtemp(join(tmpdir(), 'vestry-registry-')));
  archive = join(root, 'archive'); draft = join(root, 'draft'); context = { home: join(root, 'home') };
  await writeFile(join(root, 'original'), 'preserve this');
  await gather([join(root, 'original')], draft, context); await describe(draft, { description: 'Example' });
  id = (await sealDraft(draft, archive, context)).packageDigest as string;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function alias() { await rememberVerified(archive, await verify(archive), context, { alias: 'example' }); }

it('forgets all aliases and locations while preserving package bytes, pinned copies, and history', async () => {
  await alias(); await rememberVerified(archive, await verify(archive), context, { alias: 'second-name' });
  const pinned = await cacheCopy('example', 'pin', context);
  const history = await listOperations(context);
  const result = await forgetPackage('example', context);
  expect(result.aliasesRemoved).toEqual(['example', 'second-name']);
  expect((await readRegistry(context)).packages[id]).toBeUndefined();
  expect((await readRegistry(context)).aliases).toEqual({});
  expect((await verify(archive)).packageDigest).toBe(id);
  expect((await verify(pinned.path as string)).packageDigest).toBe(id);
  expect(await listOperations(context)).toEqual(history);
  await rememberVerified(archive, await verify(archive), context, { alias: 'example' });
  expect((await readRegistry(context)).aliases.example).toBe(id);
});

it('forgets unavailable paths and digest prefixes without verifying package contents', async () => {
  await rename(archive, join(root, 'away'));
  await forgetPackage(archive, context);
  await rememberVerified(join(root, 'away'), await verify(join(root, 'away')), context);
  await writeFile(join(root, 'away', 'README.txt'), 'Changed bytes');
  await forgetPackage(id.split(':').at(-1)!.slice(0, 12), context);
  expect((await readRegistry(context)).packages).toEqual({});
});

it('refuses forgetting active readers or unknown references without losing registration', async () => {
  await withReference(archive, context, async () => {
    await expect(forgetPackage(id, context)).rejects.toMatchObject({ exitCode: 5 });
  });
  await expect(forgetPackage('unknown', context)).rejects.toMatchObject({ exitCode: 4 });
  expect((await readRegistry(context)).packages[id]).toBeDefined();
});

it('exposes forget through the CLI and does not fall back from an existing path to an alias', async () => {
  await alias();
  const existing = join(root, 'example'); await mkdir(existing);
  await expect(forgetPackage(existing, context)).rejects.toMatchObject({ exitCode: 4 });
  const child = spawnSync(process.execPath, ['bin/vestry.js', 'forget', 'example', '--home', context.home!, '--json', '--quiet'], { encoding: 'utf8' });
  expect(child.status, child.stdout).toBe(0);
  expect(JSON.parse(child.stdout)).toMatchObject({ command: 'forget', status: 'forgotten', packageDigest: id });
  expect((await readRegistry(context)).packages).toEqual({});
  expect((await verify(archive)).packageDigest).toBe(id);
});

it('automatically registers sealed packages and resolves full and abbreviated identities', async () => {
  const state = await readRegistry(context);
  expect(state.packages[id].locations[0].path).toBe(archive);
  expect((await resolveReference(id, context)).expected).toBe(id);
  expect((await resolveReference(id.split(':').at(-1)!.slice(0, 12), context)).path).toBe(archive);
  await alias(); expect((await resolveReference('example', context)).expected).toBe(id);
});

it('reports ambiguous prefixes with candidates', () => {
  const a = 'vestry-package-v1:sha256:a' + '0'.repeat(63), b = 'vestry-package-v1:sha256:a' + '1'.repeat(63);
  const state = { schemaVersion: 1 as const, aliases: {}, leases: [], mutations: {}, packages: {
    [a]: { packageDigest: a, payloadDigest: '', registeredAt: '', locations: [] },
    [b]: { packageDigest: b, payloadDigest: '', registeredAt: '', locations: [] },
  }};
  try { resolveIdentity('a', state); throw new Error('Expected ambiguity'); }
  catch (error) { expect(error).toMatchObject({ exitCode: 5, code: 'AMBIGUOUS_DIGEST', details: { candidates: [a, b] } }); }
});

it('registration and location lookup never alter package bytes', async () => {
  const before = digest('code', await walk(archive));
  await alias(); const result = await locate('example', context);
  expect(result.aliases).toEqual(['example']); expect(result.identityConfidence).toBe('expected');
  expect(digest('code', await walk(archive))).toBe(before);
});

it('does not silently reassign aliases or accept replaced registered paths', async () => {
  await alias(); await describe(draft, { description: 'Revision two' });
  const other = join(root, 'other'); await sealDraft(draft, other, context);
  await expect(rememberVerified(other, await verify(other), context, { alias: 'example' })).resolves.toBeUndefined();
  await rename(archive, join(root, 'original-location')); await rename(other, archive);
  await expect(withReference('example', context, r => verifyRecorded(r.path, { ...context, expected: r.expected }))).rejects.toMatchObject({ code: 'LOCATION_CHANGED', exitCode: 5 });
  expect((await readRegistry(context)).aliases.example).toBe(id);
  expect((await locate('example', context)).locations).toEqual(expect.arrayContaining([expect.objectContaining({ availability: 'changed' })]));
});

it('retains unavailable locations and reconstructs only current facts after catalog loss', async () => {
  await alias(); await rename(archive, join(root, 'away'));
  expect((await locate('example', context)).locations).toEqual(expect.arrayContaining([expect.objectContaining({ availability: 'unavailable' })]));
  expect((await readRegistry(context)).packages[id].locations).toHaveLength(1);
  await rename(join(root, 'away'), archive); await rm(context.home!, { recursive: true });
  await verifyRecorded(archive, context);
  expect((await listOperations(context)).map(op => op.kind)).toEqual(['verify']);
  expect((await readRegistry(context)).aliases).toEqual({});
});

it('pins a verified complete copy, resolves it offline, and refuses eviction', async () => {
  await alias(); const pinned = await cacheCopy('example', 'add', { ...context, pin: true });
  expect(pinned.path).toBe(await managedPath(id, 'pinned', context));
  expect((await verify(pinned.path as string)).packageDigest).toBe(id);
  await rename(archive, join(root, 'disconnected'));
  const resolved = await resolveReference('example', { ...context, offline: true });
  expect(resolved.path).toBe(pinned.path);
  await withReference('example', { ...context, offline: true }, r => verifyRecorded(r.path, { ...context, expected: r.expected }));
  expect((await locate('example', { ...context, offline: true })).locations).toEqual(expect.arrayContaining([expect.objectContaining({ path: archive, availability: 'not-checked-offline' })]));
  await expect(cacheEvict('example', context)).rejects.toMatchObject({ exitCode: 5 });
});

it('offline alias resolution never falls back to external archives', async () => {
  await alias(); await expect(resolveReference('example', { ...context, offline: true })).rejects.toMatchObject({ exitCode: 4 });
  // An explicit filesystem path stays explicit, rather than silently selecting another copy.
  expect((await resolveReference(archive, { ...context, offline: true })).path).toBe(archive);
});

it('pin/unpin migrate only after verification; eviction preserves originals and durable state', async () => {
  await alias(); const cached = await cacheCopy('example', 'add', context);
  const pinned = await cacheCopy('example', 'pin', context);
  expect(await exists(cached.path as string)).toBe(false);
  expect(await exists(pinned.path as string)).toBe(true);
  await mkdir(join(context.home!, 'code'), { recursive: true }); await writeFile(join(context.home!, 'code/script'), 'keep code');
  await mkdir(join(context.home!, 'runs'), { recursive: true }); await writeFile(join(context.home!, 'runs/result'), 'keep output');
  const unpinned = await cacheCopy('example', 'unpin', context);
  expect(await exists(pinned.path as string)).toBe(false);
  expect((await verify(unpinned.path as string)).packageDigest).toBe(id);
  await cacheEvict('example', context);
  expect((await cacheList(context)).copies).toEqual([]);
  expect(await readFile(join(context.home!, 'code/script'), 'utf8')).toBe('keep code');
  expect(await readFile(join(context.home!, 'runs/result'), 'utf8')).toBe('keep output');
  expect((await verify(archive)).packageDigest).toBe(id);
  expect((await listOperations(context)).length).toBeGreaterThan(0);
});

it('protects active inputs against eviction and pin migration', async () => {
  await alias(); await cacheCopy('example', 'add', context);
  await withReference('example', { ...context, offline: true }, async r => {
    await expect(cacheEvict('example', context)).rejects.toMatchObject({ exitCode: 5 });
    await expect(cacheCopy('example', 'pin', context)).rejects.toMatchObject({ exitCode: 5 });
    expect((await verify(r.path)).packageDigest).toBe(id);
  });
  const cachedPath = await managedPath(id, 'cache', context);
  await withReference(join(cachedPath, 'data/original'), context, async () => {
    await expect(cacheEvict('example', context)).rejects.toMatchObject({ exitCode: 5 });
  });
  await cacheEvict('example', context);
});

it('does not trust a corrupted cache or silently skip it for another copy', async () => {
  await alias(); const cached = await cacheCopy('example', 'add', context);
  await writeFile(join(cached.path as string, 'data/original'), 'corrupted');
  await expect(cacheCopy('example', 'pin', context)).rejects.toMatchObject({ exitCode: 3 });
  await cacheEvict('example', context);
  expect((await cacheCopy('example', 'add', context)).packageDigest).toBe(id);
});

it('refuses deletion if a managed directory was replaced', async () => {
  await alias(); const cached = await cacheCopy('example', 'add', context);
  await rename(cached.path as string, join(root, 'old-cache'));
  await mkdir(cached.path as string); await writeFile(join(cached.path as string, 'unrelated'), 'never delete');
  await expect(cacheEvict('example', context)).rejects.toMatchObject({ exitCode: 5 });
  expect(await readFile(join(cached.path as string, 'unrelated'), 'utf8')).toBe('never delete');
});

it('serializes concurrent registry writes without losing either alias', async () => {
  const result = await verify(archive);
  await Promise.all([rememberVerified(archive, result, context, { alias: 'one' }), rememberVerified(archive, result, context, { alias: 'two' })]);
  expect((await readRegistry(context)).aliases).toMatchObject({ one: id, two: id });
});

it('prunes a killed reader lease before eviction without relying on lease age', async () => {
  await alias(); await cacheCopy('example', 'add', context);
  const worker = fileURLToPath(new URL('../dist/test/helpers/cache-worker.js', import.meta.url));
  const child = spawn(process.execPath, [worker, 'hold', 'example', context.home!]);
  try {
    await new Promise<void>((yes, no) => { child.stdout.once('data', () => yes()); child.once('exit', code => no(new Error(`Worker exited early: ${code}`))); });
    await expect(cacheEvict('example', context)).rejects.toMatchObject({ exitCode: 5 });
    const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await ended;
    await cacheEvict('example', context);
    expect((await cacheList(context)).copies).toEqual([]);
  } finally { child.kill('SIGKILL'); }
});

it('recovers an interrupted pinned copy and preserves source bytes', async () => {
  await alias();
  const worker = fileURLToPath(new URL('../dist/test/helpers/cache-worker.js', import.meta.url));
  const child = spawnSync(process.execPath, [worker, 'copy', 'example', context.home!], { encoding: 'utf8' });
  expect(child.signal, child.stderr).toBe('SIGKILL');
  const pending = (await listOperations(context)).find(op => op.kind === 'cache-copy')!;
  await recover(pending.id, checkOutput, context);
  expect((await resolveReference('example', { ...context, offline: true })).storage).toBe('pinned');
  expect((await verify(archive)).packageDigest).toBe(id);
});

it('releases a killed registry writer lock but refuses to unlock a live writer', async () => {
  await alias(); await cacheCopy('example', 'add', context);
  const worker = fileURLToPath(new URL('../dist/test/helpers/cache-worker.js', import.meta.url));
  const child = spawn(process.execPath, [worker, 'lock', 'example', context.home!]);
  try {
    await new Promise<void>((yes, no) => { child.stdout.once('data', () => yes()); child.once('exit', code => no(new Error(`Worker exited early: ${code}`))); });
    await expect(releaseRegistryLock(context)).rejects.toMatchObject({ exitCode: 5 });
    const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await ended;
    await expect(cacheEvict('example', context)).rejects.toThrow('Registry lock owner has exited');
    await releaseRegistryLock(context); await cacheEvict('example', context);
    expect((await cacheList(context)).copies).toEqual([]);
  } finally { child.kill('SIGKILL'); }
});
