import { afterEach, beforeEach, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPackage } from '../src/locations.js';
import { canonical } from '../src/fs-util.js';
import { readRegistry } from '../src/registry.js';
import { scanDirectory } from '../src/scan.js';
import { verify } from '../src/package.js';
import type { Context } from '../src/operations.js';

let root: string, archive: string, pkg: string, id: string, context: Context;
beforeEach(async () => {
  root = await canonical(await mkdtemp(join(tmpdir(), 'vestry-scan-')));
  archive = join(root, 'archive'); pkg = join(archive, 'original'); context = { home: join(root, 'home') };
  await mkdir(pkg, { recursive: true }); await writeFile(join(pkg, 'note'), 'Keep me');
  id = (await createPackage(pkg, { ...context, description: 'Scan fixture', alias: 'example' })).packageDigest as string;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('discovers and registers unknown packages, assigning their unique main location', async () => {
  const fresh = { home: join(root, 'fresh-home') };
  const report = await scanDirectory(archive, fresh);
  expect(report).toMatchObject({ exitCode: 0, summary: { candidates: 1, verified: 1, newPackages: 1, mainLocationsSet: 1 } });
  expect((await readRegistry(fresh)).packages[id].mainLocation).toBe(pkg);
  const repeated = await scanDirectory(archive, fresh);
  expect(repeated).toMatchObject({ exitCode: 0, findings: [expect.objectContaining({ discovery: 'known', mainAction: 'unchanged' })] });
});

it('recognizes a manually moved package, retains its alias, and changes main only on request', async () => {
  const moved = join(archive, 'renamed'); await rename(pkg, moved);
  const report = await scanDirectory(archive, context);
  expect(report).toMatchObject({ exitCode: 0, findings: [expect.objectContaining({ discovery: 'possible-move', mainLocation: pkg })] });
  expect((await readRegistry(context)).aliases.example).toBe(id);
  await scanDirectory(archive, { ...context, makeMain: true });
  expect((await readRegistry(context)).packages[id].mainLocation).toBe(moved);
  expect((await readRegistry(context)).packages[id].locations.map(l => l.path)).toContain(pkg);
  expect((await verify(moved)).packageDigest).toBe(id);
});

it('adds a copy while retaining an available main, and never picks between duplicates with make-main', async () => {
  const copy = join(archive, 'copy'); await cp(pkg, copy, { recursive: true });
  expect(await scanDirectory(archive, context)).toMatchObject({ exitCode: 0, summary: { verified: 2 } });
  const report = await scanDirectory(archive, { ...context, makeMain: true });
  expect(report).toMatchObject({ exitCode: 1, issues: [expect.objectContaining({ code: 'AMBIGUOUS_MAIN_LOCATION' })] });
  expect((await readRegistry(context)).packages[id].mainLocation).toBe(pkg);
});

it('leaves a newly discovered duplicate group without an arbitrary main, including on subsequent reads', async () => {
  await cp(pkg, join(archive, 'copy'), { recursive: true });
  const fresh = { home: join(root, 'fresh-home') };
  expect(await scanDirectory(archive, fresh)).toMatchObject({ exitCode: 1 });
  let record = (await readRegistry(fresh)).packages[id];
  expect(record.locations).toHaveLength(2); expect(record.mainLocation).toBeNull();
  expect(await scanDirectory(archive, fresh)).toMatchObject({ exitCode: 1 });
  record = (await readRegistry(fresh)).packages[id]; expect(record.mainLocation).toBeNull();
});

it('reports invalid candidates, continues with good ones, and leaves prior registration unchanged', async () => {
  const invalid = join(archive, 'invalid'); await mkdir(invalid); await writeFile(join(invalid, 'bagit.txt'), 'Not a supported bag');
  let report = await scanDirectory(archive, context);
  expect(report).toMatchObject({ exitCode: 1, summary: { candidates: 2, verified: 1 }, issues: [expect.objectContaining({ path: invalid })] });
  const before = (await readRegistry(context)).packages[id];
  await writeFile(join(pkg, 'data/note'), 'Corrupt');
  report = await scanDirectory(pkg, context);
  expect(report).toMatchObject({ exitCode: 1, summary: { verified: 0 } });
  expect((await readRegistry(context)).packages[id]).toEqual(before);
});

it('stops at valid and invalid package boundaries, ignores loose ZIPs, and does not follow symlinks', async () => {
  // This nested bag is preserved content, not an independently scanned package.
  await mkdir(join(pkg, 'data/nested')); await writeFile(join(pkg, 'data/nested/bagit.txt'), 'nested marker');
  await symlink(pkg, join(archive, 'linked'));
  await writeFile(join(archive, 'loose.zip'), 'Not inspected');
  const report = await scanDirectory(archive, context);
  expect(report).toMatchObject({ summary: { candidates: 1 }, skipped: [expect.objectContaining({ reason: 'Symlink not followed' })] });
  await expect(scanDirectory(join(pkg, 'data'), context)).rejects.toMatchObject({ exitCode: 2 });
});

it('skips drafts, recovery staging, and the selected Vestry workspace', async () => {
  const draft = join(archive, 'draft'); await mkdir(draft); await writeFile(join(draft, '.vestry-draft.json'), '{}');
  const stage = join(archive, '.vestry-11111111-1111-1111-1111-111111111111.tmp'); await cp(pkg, stage, { recursive: true });
  const scoped = { home: join(archive, 'workspace') }; await mkdir(scoped.home); await cp(pkg, join(scoped.home, 'offline'), { recursive: true });
  const report = await scanDirectory(archive, scoped);
  expect(report).toMatchObject({ exitCode: 0, summary: { candidates: 1, skipped: 3 } });
});

it('quarantines Finder extras while scanning and does not rewrite manifested contents', async () => {
  const readme = await readFile(join(pkg, 'bag-info.txt'));
  await writeFile(join(pkg, '.DS_Store'), 'Finder');
  const options: Context = { ...context, quarantined: [] };
  expect(await scanDirectory(archive, options)).toMatchObject({ exitCode: 0 });
  expect(options.quarantined).toHaveLength(1);
  expect(await readFile(join(pkg, 'bag-info.txt'))).toEqual(readme);
  expect((await verify(pkg)).packageDigest).toBe(id);
});

it('emits machine-readable partial results with a nonzero exit and exposes scoped help', async () => {
  const invalid = join(archive, 'invalid'); await mkdir(invalid); await writeFile(join(invalid, 'bagit.txt'), 'bad');
  const child = spawnSync(process.execPath, [resolve('bin/vestry.js'), 'scan', archive, '--home', context.home!, '--json', '--quiet'], { encoding: 'utf8' });
  expect(child.status, child.stdout).toBe(1);
  expect(JSON.parse(child.stdout)).toMatchObject({ command: 'scan', status: 'complete-with-issues', summary: { verified: 1, issues: 1 } });
  const help = spawnSync(process.execPath, [resolve('bin/vestry.js'), 'scan', '--help', '--no-color'], { encoding: 'utf8' });
  expect(help.stdout).toContain('--make-main');
});
