import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, owner } from '../src/fs-util.js';
import { createPackage } from '../src/locations.js';
import { listOperations, newOperation, retireAbandoned, save, workspace, type Operation } from '../src/operations.js';
import { fixture } from './zip-fixture.js';
let root: string, home: string, path: string;
beforeEach(async () => { root = await canonical(await mkdtemp(join(tmpdir(), 'vestry-abandoned-'))); home = join(root, 'home'); path = join(root, 'archive'); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function abandoned(): Promise<Operation> {
  await workspace({ home }, [path]);
  await mkdir(path);
  const op = await newOperation(home, 'unpack', path, path);
  op.inPlace = true; op.sourceOwner = await owner(path);
  op.backup = join(root, `.vestry-${op.id}.original`);
  await mkdir(op.staging!); op.stageOwner = await owner(op.staging!);
  op.phase = 'building'; op.status = 'failed'; op.error = { code: 'INTEGRITY_MISMATCH', message: 'Old failed attempt' };
  await save(home, op);
  await rm(op.staging!, { recursive: true }); await rm(path, { recursive: true });
  return op;
}
it('automatically frees the destination after manual deletion, keeping the failed attempt in history', async () => {
  const op = await abandoned();
  const bytes = fixture([{ name: 'note.txt', data: Buffer.from('original') }]);
  await writeFile(path + '.zip', bytes);
  const result = await createPackage(path + '.zip', { home });
  expect(result.representation).toBe('packed');
  expect(await readFile(join(path, 'data.zip'))).toEqual(bytes);
  expect((await listOperations({ home })).find(o => o.id === op.id)).toMatchObject({ status: 'discarded', error: op.error });
});
for (const blocker of ['staging', 'backup', 'verified', 'live', 'locked', 'offline', 'replacement', 'zip-adoption']) it(`does not retire an operation with ${blocker}`, async () => {
  const op = await abandoned();
  if (blocker === 'staging') await mkdir(op.staging!);
  if (blocker === 'backup') await mkdir(op.backup!);
  if (blocker === 'verified') { op.phase = 'verified'; op.expected = 'vestry-package-v1:sha256:' + 'a'.repeat(64); }
  if (blocker === 'live') op.status = 'running';
  if (blocker === 'locked') await mkdir(join(home, 'operations', op.id, 'recovery.lock'));
  if (blocker === 'offline') { op.source = join(root, 'missing-volume', 'archive'); op.destination = op.source; op.staging = join(root, 'missing-volume', `.vestry-${op.id}.tmp`); op.backup = join(root, 'missing-volume', `.vestry-${op.id}.original`); }
  if (blocker === 'replacement') { await mkdir(path); op.sourceOwner = { dev: '0', ino: '0' }; }
  if (blocker === 'zip-adoption') { op.kind = 'import-zip'; delete op.inPlace; delete op.backup; op.expected = 'vestry-package-v1:sha256:' + 'a'.repeat(64); op.zipAdoption = { dev: '1', ino: '1', size: '1', mtimeNs: '1', ctimeNs: '1', sha256: 'a'.repeat(64) }; }
  await save(home, op);
  expect(await retireAbandoned(op.id, { home })).toBe(false);
  expect((await listOperations({ home })).find(o => o.id === op.id)?.status).toBe(op.status);
});
it('allows retrying create when its original remains but its temporary work was removed', async () => {
  await workspace({ home }, [path]); await mkdir(path); await writeFile(join(path, 'note'), 'original');
  const op = await newOperation(home, 'create', path, path);
  op.sourceOwner = await owner(path); op.phase = 'building'; op.status = 'failed'; await save(home, op);
  expect((await createPackage(path, { home })).representation).toBe('expanded');
  expect(await readFile(join(path, 'data/note'), 'utf8')).toBe('original');
});
