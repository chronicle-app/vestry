import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPackage } from '../src/locations.js';
import { buildBag, verify } from '../src/package.js';
import { canonical, exists, owner } from '../src/fs-util.js';
import { listOperations, newOperation, save, workspace, type Context } from '../src/operations.js';
import { digest, walk } from '../src/inventory.js';
import { forgetPackage } from '../src/registry.js';
let root: string, source: string, context: Context;
beforeEach(async () => {
  root = await canonical(await mkdtemp(join(tmpdir(), 'vestry-retry-')));
  source = join(root, 'original'); context = { home: join(root, 'records'), quarantined: [] };
  await mkdir(source); await writeFile(join(source, 'note'), 'Original bytes');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
// Reproduce a journal written by the previous CLI: complete staging, no verified checkpoint.
async function failedCreation(complete = true) {
  const home = await workspace(context, [source]);
  const op = await newOperation(home, 'create', source, source);
  op.sourceOwner = await owner(source); op.sourceIdentity = digest('code', await walk(source));
  op.backup = join(root, `.vestry-${op.id}.original`);
  await mkdir(op.staging!); op.stageOwner = await owner(op.staging!);
  if (complete) await buildBag(source, op.staging!, undefined);
  await writeFile(join(op.staging!, '.DS_Store'), 'Finder bytes');
  op.phase = 'building'; op.status = 'failed'; op.error = { code: 'INTEGRITY_MISMATCH', message: 'Unexpected .DS_Store' };
  await save(home, op); return op;
}
it('quarantines Finder extras created during a new build and completes normally', async () => {
  const result = await createPackage(source, { ...context, onPhase: async (phase, op) => {
    if (phase === 'building') await writeFile(join(op.staging!, '.DS_Store'), 'Finder bytes');
  } });
  expect((await verify(source)).packageDigest).toBe(result.packageDigest);
  expect(context.quarantined).toHaveLength(1);
  expect(await readFile(join(context.quarantined![0].directory, 'files/.DS_Store'), 'utf8')).toBe('Finder bytes');
});
it('retries the old failed creation, reuses verified staging, and preserves Finder bytes', async () => {
  const op = await failedCreation();
  const result = await createPackage(source, context);
  expect(result).toMatchObject({ operationId: op.id, resumed: true, status: 'succeeded' });
  expect(await readFile(join(source, 'data/note'), 'utf8')).toBe('Original bytes');
  expect(context.quarantined).toHaveLength(1);
  expect((await listOperations(context)).filter(o => o.kind === 'create')).toHaveLength(1);
});
it('retains a changed original; explicit restart rebuilds from current bytes', async () => {
  await failedCreation(); await writeFile(join(source, 'note'), 'Intentional new bytes');
  await expect(createPackage(source, context)).rejects.toThrow('changed');
  expect(await readFile(join(source, 'note'), 'utf8')).toBe('Intentional new bytes');
  await createPackage(source, { ...context, restart: true });
  expect(await readFile(join(source, 'data/note'), 'utf8')).toBe('Intentional new bytes');
});
it('refuses complete but different staged payloads and leaves the original intact', async () => {
  const op = await failedCreation();
  await rm(op.staging!, { recursive: true }); await mkdir(op.staging!);
  const other = join(root, 'different'); await mkdir(other); await writeFile(join(other, 'note'), 'Different bytes');
  await buildBag(other, op.staging!, undefined);
  // Record ownership to exercise content matching independently of ownership refusal.
  op.stageOwner = await owner(op.staging!); await save(context.home!, op);
  await expect(createPackage(source, context)).rejects.toThrow('does not match');
  expect(await readFile(join(source, 'note'), 'utf8')).toBe('Original bytes');
});
it('keeps incomplete staging until explicit restart and gives forget an actionable message', async () => {
  const op = await failedCreation(false);
  await expect(createPackage(source, context)).rejects.toThrow('--restart');
  expect(await exists(op.staging!)).toBe(true);
  await expect(forgetPackage(source, context)).rejects.toThrow('unfinished creation');
  await createPackage(source, { ...context, restart: true });
  expect(await readFile(join(source, 'data/note'), 'utf8')).toBe('Original bytes');
});
it('refuses to resume or discard a live creation', async () => {
  const op = await failedCreation(); op.status = 'running'; await save(context.home!, op);
  await expect(createPackage(source, context)).rejects.toThrow('still active');
  await expect(createPackage(source, { ...context, restart: true })).rejects.toThrow('still active');
  expect(await readFile(join(source, 'note'), 'utf8')).toBe('Original bytes');
});
