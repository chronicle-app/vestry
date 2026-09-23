import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, exists } from '../src/fs-util.js';
import { copyArchive, createPackage, movePackage } from '../src/locations.js';
import { cleanupMove, listOperations, recordPath, recover, type Context } from '../src/operations.js';
import { checkOutput } from '../src/workflow.js';
import { verify } from '../src/package.js';
import { readRegistry, withReference } from '../src/registry.js';

let root: string, source: string, destination: string, id: string, context: Context;
beforeEach(async () => {
  root = await canonical(await mkdtemp(join(tmpdir(), 'vestry-transfers-')));
  source = join(root, 'source'); destination = join(root, 'destination'); context = { home: join(root, 'records') };
  await mkdir(source); await writeFile(join(source, 'note'), 'Preserve these bytes');
  id = (await createPackage(source, { ...context, description: 'Transfer fixture' })).packageDigest as string;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const cli = (...args: string[]) => spawnSync(process.execPath, ['bin/vestry.js', ...args, '--home', context.home!, '--json'], { encoding: 'utf8' });

it('copies using positional destinations, rejects ambiguity, and shows all copies by digest', async () => {
  const copied = cli('cp', id.slice(-12), destination);
  // Prefixes are leading hexadecimal characters, not trailing characters.
  expect(copied.status).toBe(4);
  const copy = cli('cp', id.split(':').at(-1)!.slice(0, 12), destination);
  expect(copy.status, copy.stdout).toBe(0);
  expect((await verify(destination)).packageDigest).toBe(id);
  expect((await verify(source)).packageDigest).toBe(id);
  for (const command of ['check', 'pack', 'unpack']) expect(JSON.parse(cli(command, id).stdout).error.code).toBe('AMBIGUOUS_COPY');
  expect(cli('check', destination).status).toBe(0);
  const show = JSON.parse(cli('show', id).stdout);
  expect(show.locations).toHaveLength(2); expect(show.metadata.description).toContain('Transfer fixture');
  expect(cli('cp', source, destination).status).toBe(5);
  expect(await exists(join(destination, 'source'))).toBe(false);
});

it('mv retains a verified recovery copy until explicit cleanup, which is repeatable', async () => {
  const moved = cli('mv', source, destination); expect(moved.status, moved.stdout).toBe(0);
  const result = JSON.parse(moved.stdout);
  expect(result.cleanupRequired).toBe(true);
  expect(await exists(source)).toBe(false);
  expect((await verify(result.recoveryCopy)).packageDigest).toBe(id);
  expect((await recover(result.operationId, checkOutput, context)).cleanupRequired).toBe(true);
  expect(await exists(result.recoveryCopy)).toBe(true);
  const cleaned = cli('cleanup', result.operationId); expect(cleaned.status, cleaned.stdout).toBe(0);
  expect(await exists(result.recoveryCopy)).toBe(false);
  expect((await verify(destination)).packageDigest).toBe(id);
  expect(cli('cleanup', result.operationId).status).toBe(0);
});

it('refuses cleanup when destination is corrupt, original changed, or durability was limited', async () => {
  const moved = await movePackage(source, destination, context), operation = moved.operationId as string, backup = moved.recoveryCopy as string;
  await writeFile(join(destination, 'data/note'), 'Broken');
  await expect(cleanupMove(operation, context)).rejects.toThrow();
  expect((await verify(backup)).packageDigest).toBe(id);
  await writeFile(join(destination, 'data/note'), 'Preserve these bytes');
  await writeFile(join(backup, 'data/note'), 'New original bytes');
  await expect(cleanupMove(operation, context)).rejects.toThrow('changed');
  expect(await readFile(join(backup, 'data/note'), 'utf8')).toBe('New original bytes');
  await writeFile(join(backup, 'data/note'), 'Preserve these bytes');
  const path = recordPath(context.home!, operation), op = JSON.parse(await readFile(path, 'utf8'));
  op.warnings.push('Filesystem does not support all requested fsync operations; crash durability is limited.');
  await writeFile(path, JSON.stringify(op));
  await expect(cleanupMove(operation, context)).rejects.toThrow('durability');
  expect((await verify(backup)).packageDigest).toBe(id);
});

it('blocks cleanup during reads and resumes an interrupted cleanup only on explicit request', async () => {
  const moved = await movePackage(source, destination, context), operation = moved.operationId as string, backup = moved.recoveryCopy as string;
  await withReference(destination, context, async () => {
    await expect(cleanupMove(operation, context)).rejects.toThrow();
  });
  await expect(cleanupMove(operation, { ...context, onPhase: phase => { if (phase === 'cleaning') throw new Error('Interrupted cleanup'); } })).rejects.toThrow('Interrupted cleanup');
  await recover(operation, checkOutput, context);
  expect(await exists(backup)).toBe(true);
  await cleanupMove(operation, context);
  expect(await exists(backup)).toBe(false);
  expect((await verify(destination)).packageDigest).toBe(id);
});

it('recovers an interrupted copy without retiring its source', async () => {
  await expect(copyArchive(source, destination, { ...context, onPhase: phase => { if (phase === 'verified') throw new Error('Interrupted copy'); } })).rejects.toThrow();
  const op = (await listOperations(context)).find(op => op.kind === 'copy')!;
  await recover(op.id, checkOutput, context);
  expect((await verify(source)).packageDigest).toBe(id);
  expect((await verify(destination)).packageDigest).toBe(id);
  expect((await readRegistry(context)).packages[id].locations).toHaveLength(2);
});

it('rejects a changed published copy and preserves the source', async () => {
  await expect(copyArchive(source, destination, { ...context, onPhase: async (phase, op) => {
    if (phase === 'published') await writeFile(join(op.destination!, 'data/note'), 'Damaged destination');
  } })).rejects.toThrow();
  // cp never removes the source, even if an external writer changes the published copy.
  expect((await verify(source)).packageDigest).toBe(id);
});
