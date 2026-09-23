import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gather, describe, readDraft } from '../src/draft.js';
import { sealDraft, checkOutput, verifyRecorded } from '../src/workflow.js';
import { listOperations, recover, type Context } from '../src/operations.js';
import { exists } from '../src/fs-util.js';
import { digest, walk } from '../src/inventory.js';
import { verify } from '../src/package.js';

let root: string, draft: string, destination: string, context: Context;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vestry-workflow-')); draft = join(root, 'draft'); destination = join(root, 'sealed'); context = { home: join(root, 'home') };
  await writeFile(join(root, 'original.zip'), 'original export bytes');
  await gather([join(root, 'original.zip')], draft, context);
  await describe(draft, { description: 'A description with an uncertain date.' });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('seals both representations from the same intact draft and records only external history', async () => {
  const before = digest('code', await walk(draft));
  const expanded = await sealDraft(draft, destination, context);
  const packed = await sealDraft(draft, join(root, 'packed'), { ...context, packed: true });
  expect(expanded.payloadDigest).toBe(packed.payloadDigest);
  expect(digest('code', await walk(draft))).toBe(before);
  expect(await readdir(destination)).toEqual(expect.not.arrayContaining(['.vestry-draft.json', 'operation.json']));
  expect((await listOperations(context)).filter(op => op.kind === 'seal' && op.status === 'succeeded')).toHaveLength(2);
  const frozen = digest('code', await walk(destination));
  await verifyRecorded(destination, context);
  expect(digest('code', await walk(destination))).toBe(frozen);
  await rm(context.home!, { recursive: true });
  expect((await verify(destination)).packageDigest).toBe(expanded.packageDigest);
});

it('gathers multiple named sources, includes dotfiles, and rejects collisions', async () => {
  const folder = join(root, 'loose'); await mkdir(folder); await writeFile(join(folder, '.hidden'), 'included');
  const multi = join(root, 'multi'); await gather([join(root, 'original.zip'), folder], multi, context);
  expect(await readFile(join(multi, 'data/loose/.hidden'), 'utf8')).toBe('included');
  await expect(gather([folder, folder], join(root, 'collision'), context)).rejects.toMatchObject({ exitCode: 5 });
  expect(await exists(join(root, 'collision'))).toBe(false);
});

it('detects a source changed between inventory and copying', async () => {
  const source = join(root, 'original.zip'), output = join(root, 'changing-draft');
  await expect(gather([source], output, { ...context, onPhase: async phase => {
    if (phase === 'building') await writeFile(source, 'changed during gather');
  }})).rejects.toMatchObject({ exitCode: 3 });
  expect(await exists(output)).toBe(false);
  expect(await readFile(source, 'utf8')).toBe('changed during gather');
});

it('refuses a malformed draft schema before creating output', async () => {
  await writeFile(join(draft, '.vestry-draft.json'), 'null');
  await expect(sealDraft(draft, destination, context)).rejects.toMatchObject({ exitCode: 2 });
  expect(await exists(destination)).toBe(false);
});

it('requires real descriptive text and refuses editing sealed packages', async () => {
  await writeFile(join(draft, 'README.txt'), ' \n');
  await expect(sealDraft(draft, destination, context)).rejects.toMatchObject({ exitCode: 2 });
  expect(await exists(destination)).toBe(false);
  const notes = join(root, 'notes.txt'); await writeFile(notes, 'Free text title\n\nDates are unknown.\n');
  await describe(draft, { readme: notes });
  await sealDraft(draft, destination, context);
  await expect(describe(destination, { description: 'Edit sealed notes' })).rejects.toMatchObject({ exitCode: 5 });
});

it('rejects workspace and output recursion, including symlink aliases', async () => {
  await expect(sealDraft(draft, destination, { home: join(draft, 'workspace') })).rejects.toMatchObject({ exitCode: 5 });
  await symlink(draft, join(root, 'alias'));
  await expect(sealDraft(draft, join(root, 'alias/output'), context)).rejects.toMatchObject({ exitCode: 5 });
  expect(await exists(join(draft, 'workspace'))).toBe(false);
  expect(await exists(destination)).toBe(false);
});

it('does not overwrite an empty destination created during staging', async () => {
  await expect(sealDraft(draft, destination, { ...context, onPhase: async phase => {
    if (phase === 'verified') await mkdir(destination);
  }})).rejects.toMatchObject({ exitCode: 5 });
  expect(await readdir(destination)).toEqual([]);
  const op = (await listOperations(context)).find(op => op.kind === 'seal')!;
  await expect(recover(op.id, checkOutput, context, true)).rejects.toMatchObject({ exitCode: 5 });
  expect(await exists(op.staging!)).toBe(true);
});

it('refuses modified staging during recovery and preserves the original draft', async () => {
  await expect(sealDraft(draft, destination, { ...context, onPhase: phase => { if (phase === 'verified') throw new Error('Simulated I/O failure'); } })).rejects.toThrow('Simulated');
  const op = (await listOperations(context)).find(op => op.kind === 'seal')!;
  await writeFile(join(op.staging!, 'data/original.zip'), 'tampered');
  await expect(recover(op.id, checkOutput, context)).rejects.toMatchObject({ exitCode: 3 });
  expect(await exists(destination)).toBe(false);
  expect((await readDraft(draft)).readme).toContain('uncertain');
  await recover(op.id, checkOutput, context, true);
  expect(await exists(op.staging!)).toBe(false);
});

it.each(['planned', 'building', 'verified', 'reserved', 'published', 'complete'])('recovers an actual SIGKILL at %s', async phase => {
  const worker = fileURLToPath(new URL('../dist/test/helpers/seal-worker.js', import.meta.url));
  const child = spawnSync(process.execPath, [worker, draft, destination, context.home!, phase], { encoding: 'utf8' });
  expect(child.signal, child.stderr).toBe('SIGKILL');
  const op = (await listOperations(context)).find(op => op.kind === 'seal')!;
  if (phase === 'planned' || phase === 'building') {
    expect(await exists(destination)).toBe(false);
    await expect(recover(op.id, checkOutput, context)).rejects.toMatchObject({ exitCode: 5 });
    await recover(op.id, checkOutput, context, true);
    expect(await exists(op.staging!)).toBe(false);
    await sealDraft(draft, destination, context);
  } else {
    if (phase === 'reserved') await expect(verify(destination)).rejects.toMatchObject({ exitCode: 3 });
    await recover(op.id, checkOutput, context);
  }
  expect((await verify(destination)).status).toBe('verified');
  expect((await readDraft(draft)).readme).toContain('uncertain');
});

it('permits one concurrent publisher and refuses the other', async () => {
  const results = await Promise.allSettled([sealDraft(draft, destination, context), sealDraft(draft, destination, context)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  expect((await verify(destination)).status).toBe('verified');
});

it('records failed verification without changing a corrupted package', async () => {
  await sealDraft(draft, destination, context);
  await writeFile(join(destination, 'data/original.zip'), 'tampered');
  const before = digest('code', await walk(destination));
  await expect(verifyRecorded(destination, context)).rejects.toMatchObject({ exitCode: 3 });
  expect((await listOperations(context)).some(op => op.kind === 'verify' && op.status === 'failed')).toBe(true);
  expect(digest('code', await walk(destination))).toBe(before);
});

it('recovers after recovery itself is killed using explicit dead-owner lock release', async () => {
  await expect(sealDraft(draft, destination, { ...context, onPhase: phase => { if (phase === 'verified') throw new Error('Stop before publish'); } })).rejects.toThrow('Stop before publish');
  const op = (await listOperations(context)).find(op => op.kind === 'seal')!;
  const worker = fileURLToPath(new URL('../dist/test/helpers/recover-worker.js', import.meta.url));
  const child = spawnSync(process.execPath, [worker, op.id, context.home!], { encoding: 'utf8' });
  expect(child.signal, child.stderr).toBe('SIGKILL');
  await expect(recover(op.id, checkOutput, context)).rejects.toThrow('locked');
  await recover(op.id, checkOutput, context, false, true);
  await recover(op.id, checkOutput, context);
  expect((await verify(destination)).status).toBe('verified');
});
