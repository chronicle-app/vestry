import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPackage } from '../src/locations.js';
import { canonical, exists } from '../src/fs-util.js';
import { verify } from '../src/package.js';
import { verifyRecorded } from '../src/workflow.js';
import type { Context } from '../src/operations.js';

let root: string, source: string, id: string, context: Context;
beforeEach(async () => {
  root = await canonical(await mkdtemp(join(tmpdir(), 'vestry-quarantine-')));
  source = join(root, 'package'); context = { home: join(root, 'home'), quarantined: [] };
  await mkdir(source); await mkdir(join(source, 'nested'));
  await writeFile(join(source, 'nested/note'), 'Original');
  await writeFile(join(source, '.DS_Store'), 'Original checksummed Finder file');
  id = (await createPackage(source, { ...context, description: 'Example', alias: 'example' })).packageDigest as string;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('quarantines only unmanifested Finder files, retaining their bytes and original package identity', async () => {
  await writeFile(join(source, '.DS_Store'), 'Root Finder bytes');
  await writeFile(join(source, 'data/nested/.DS_Store'), 'Nested Finder bytes');
  const result = await verifyRecorded(source, { ...context, expected: id });
  expect(result.packageDigest).toBe(id);
  expect(await readFile(join(source, 'data/.DS_Store'), 'utf8')).toBe('Original checksummed Finder file');
  expect(await exists(join(source, '.DS_Store'))).toBe(false);
  const report = context.quarantined![0];
  expect(await readFile(join(report.directory, 'files/.DS_Store'), 'utf8')).toBe('Root Finder bytes');
  expect(await readFile(join(report.directory, 'files/data/nested/.DS_Store'), 'utf8')).toBe('Nested Finder bytes');
  const record = JSON.parse(await readFile(join(report.directory, 'record.json'), 'utf8'));
  expect(record.files).toHaveLength(2);
  expect(record.files.every((f: { status: string }) => f.status === 'quarantined')).toBe(true);
  expect((await verify(source)).packageDigest).toBe(id);
});

it('preserves changed manifested Finder files and refuses unrelated extras', async () => {
  await writeFile(join(source, 'data/.DS_Store'), 'Changed original');
  await writeFile(join(source, '.DS_Store'), 'New Finder metadata');
  await expect(verifyRecorded(source, context)).rejects.toMatchObject({ exitCode: 3 });
  expect(await exists(join(source, '.DS_Store'))).toBe(true);
  expect(context.quarantined).toEqual([]);
  await writeFile(join(source, 'data/.DS_Store'), 'Original checksummed Finder file');
  await writeFile(join(source, 'unexpected.txt'), 'User file');
  await expect(verifyRecorded(source, context)).rejects.toMatchObject({ exitCode: 3 });
  expect(await exists(join(source, '.DS_Store'))).toBe(true);
  expect(await readFile(join(source, 'unexpected.txt'), 'utf8')).toBe('User file');
});

it('does not move anything when the expected digest differs', async () => {
  await writeFile(join(source, '.DS_Store'), 'Finder');
  await expect(verifyRecorded(source, { ...context, expected: 'vestry-package-v1:sha256:' + '0'.repeat(64) })).rejects.toMatchObject({ exitCode: 3 });
  expect(await exists(join(source, '.DS_Store'))).toBe(true);
  expect(context.quarantined).toEqual([]);
});

it('rejects a symlink named .DS_Store without touching its target', async () => {
  const target = join(root, 'external'); await writeFile(target, 'Keep');
  await symlink(target, join(source, '.DS_Store'));
  await expect(verifyRecorded(source, context)).rejects.toMatchObject({ exitCode: 3 });
  expect(await readFile(target, 'utf8')).toBe('Keep');
  expect(context.quarantined).toEqual([]);
});

it('packs automatically through the CLI and reports cleanup in JSON; plans do not clean', () => {
  const cli = (...args: string[]) => spawnSync(process.execPath, ['bin/vestry.js', ...args, '--home', context.home!, '--json', '--quiet'], { encoding: 'utf8' });
  return (async () => {
    await writeFile(join(source, '.DS_Store'), 'Finder');
    const planned = cli('pack', 'example', '--plan'); expect(planned.status).toBe(0);
    expect(await exists(join(source, '.DS_Store'))).toBe(true);
    const packed = cli('pack', 'example'); expect(packed.status, packed.stdout).toBe(0);
    const result = JSON.parse(packed.stdout);
    expect(result.packageDigest).toBe(id);
    expect(result.quarantined[0].files).toEqual(['.DS_Store']);
    expect((await verify(source)).representation).toBe('packed');
    await writeFile(join(source, '.DS_Store'), 'Finder again');
    const unpacked = cli('unpack', 'example'); expect(unpacked.status, unpacked.stdout).toBe(0);
    expect(JSON.parse(unpacked.stdout).quarantined).toHaveLength(1);
    expect(await readFile(join(source, 'data/.DS_Store'), 'utf8')).toBe('Original checksummed Finder file');
  })();
});
