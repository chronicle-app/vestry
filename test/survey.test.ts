import { afterEach, beforeEach, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { canonical, exists } from '../src/fs-util.js';
import { createPackage, convertInPlace } from '../src/locations.js';
import { verify } from '../src/package.js';
import type { Context } from '../src/operations.js';
import { fixture } from './zip-fixture.js';

// A stand-in for the chronicle command: it logs each call and answers as
// Chronicle's JSON does, finding one export it reads, one it can't, and one
// above the payload, which Vestry must not keep. FAKE_CHRONICLE_ROWS is what
// scan finds instead, and FAKE_CHRONICLE_FAIL names a command that fails.
const fake = `#!/usr/bin/env node
const { appendFileSync, existsSync } = require('node:fs');
const { dirname } = require('node:path');
const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
appendFileSync(process.env.FAKE_CHRONICLE_LOG, JSON.stringify(args) + '\\n');
if (args[0] === '--version') console.log('@chronicle.app/cli/9.9.9 test');
else if (process.env.FAKE_CHRONICLE_FAIL === args[0] || args[0] === 'survey' && !existsSync(value('--input').split('/data.zip/')[0])) {
  console.error(JSON.stringify({ level: 'error', message: 'Nothing at ' + (value('--input') ?? args[1]), hint: { action: 'Run \`chronicle survey notes --help\` to see what it reads.' } }));
  process.exit(2);
} else if (args[0] === 'scan' && process.env.FAKE_CHRONICLE_ROWS) console.log(process.env.FAKE_CHRONICLE_ROWS);
else if (args[0] === 'scan' && args[1].endsWith('notes.zip')) console.log(JSON.stringify([
  { source: 'notes', strategy: 'archive', plugin: 'notes', status: 'ready', installed: true, root: args[1], config: { input: args[1] } },
]));
else if (args[0] === 'scan') console.log(JSON.stringify([
  { source: 'notes', strategy: 'archive', plugin: 'notes', status: 'ready', installed: true, pluginVersion: '1.2.3', root: args[1] + '/export', config: { input: args[1] + '/export', account: 'me' }, evidence: { files: ['notes.json'] } },
  { source: 'old-notes', strategy: 'archive', plugin: 'old-notes', status: 'unsupported', installed: true, root: args[1] + '/old', config: { input: args[1] + '/old' } },
  { source: 'elsewhere', strategy: 'archive', plugin: 'elsewhere', status: 'ready', installed: true, root: dirname(dirname(args[1])), config: {} },
]));
else console.log(JSON.stringify([{ source: args[1], strategy: value('--strategy'), status: 'ready', pluginVersion: '1.2.3',
  survey: { notes: { count: 3, earliest: '2019-05-01T00:00:00.000Z', latest: '2023-02-01T00:00:00.000Z', measures: [{ key: 'folders', label: 'folders', value: 2 }] } } }]));
`;
let root: string, source: string, bin: string, log: string, context: Context;
beforeEach(async () => {
  root = await canonical(await mkdtemp(join(tmpdir(), 'vestry-survey-')));
  source = join(root, 'source'); bin = join(root, 'bin'); log = join(root, 'chronicle.log'); context = { home: join(root, 'records') };
  await mkdir(join(source, 'export'), { recursive: true }); await mkdir(join(source, 'old')); await mkdir(bin);
  await writeFile(join(source, 'export', 'notes.json'), '[]'); await writeFile(join(source, 'old', 'notes.xml'), '<notes/>');
  await writeFile(join(bin, 'chronicle'), fake); await chmod(join(bin, 'chronicle'), 0o755); await writeFile(log, '');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, ['bin/vestry.js', ...args, '--home', context.home!],
  { encoding: 'utf8', env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_CHRONICLE_LOG: log, TZ: 'UTC', ...env } });
const cli = (args: string[], env: Record<string, string> = {}) => {
  const child = run([...args, '--json'], env);
  return { ...child, result: JSON.parse(child.stdout) };
};
const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);

it('surveys each export Chronicle finds, keeps its readers by content, and leaves package bytes unchanged', async () => {
  await createPackage(source, context);
  const before = await verify(source);
  const first = cli(['survey', source]);
  expect(first.status, first.stdout).toBe(0);
  expect(first.result).toMatchObject({ command: 'survey', contentId: before.payloadDigest, representation: 'expanded', identityConfidence: 'expected', chronicle: '9.9.9', foundReaders: true, exitCode: 0 });
  expect(first.result.readers).toEqual([
    { source: 'notes', strategy: 'archive', root: 'export', pluginVersion: '1.2.3', outcome: 'counted', survey: expect.objectContaining({ notes: expect.objectContaining({ count: 3 }) }) },
    { source: 'old-notes', strategy: 'archive', root: 'old', outcome: 'skipped', reason: expect.stringContaining('cannot read it yet') },
  ]);
  const surveyed = (await calls()).find(args => args[0] === 'survey')!;
  expect(surveyed).toEqual(expect.arrayContaining(['notes', '--strategy', 'archive', '--input', join(source, 'data', 'export'), '--account', 'me']));
  expect((await calls()).find(args => args[0] === 'scan')![1]).toBe(join(source, 'data'));

  const again = cli(['survey', source]);
  expect(again.result.foundReaders).toBe(false);
  expect((await calls()).filter(args => args[0] === 'scan')).toHaveLength(1);
  expect(await readdir(join(context.home!, 'surveys'))).toHaveLength(2);
  const shown = cli(['show', source]).result;
  expect(shown.readers.map((r: { source: string }) => r.source)).toEqual(['notes', 'old-notes']);
  expect(shown.lastSurvey).toMatchObject({ id: again.result.surveyId, readers: [{ outcome: 'counted' }, { outcome: 'skipped' }] });
  expect(await verify(source)).toEqual(before);
  expect(cli(['check', source]).status).toBe(0);
});

it('prints a survey as a table, a word to a cell, and names on stderr the exports it did not count', async () => {
  await createPackage(source, context);
  const printed = run(['survey', source]);
  expect(printed.status, printed.stderr).toBe(0);
  expect(printed.stdout.split('\n')).toEqual([
    'source  kind   count  first       last        measures',
    '──────  ─────  ─────  ──────────  ──────────  ─────────',
    'notes   notes      3  2019-05-01  2023-02-01  folders=2',
    '',
  ]);
  expect(printed.stderr).toBe('vestry: old-notes in data/old: Chronicle recognizes this export but cannot read it yet.\n');
  expect(run(['show', source]).stdout).toContain('  notes   notes      3  2019-05-01  2023-02-01  folders=2\n');
});

it('reads a packed copy through data.zip with the readers another form found, after --check', async () => {
  await createPackage(source, context);
  expect(cli(['survey', source]).status).toBe(0);
  await convertInPlace(source, 'packed', context);
  const packed = cli(['survey', source, '--check']);
  expect(packed.status, packed.stdout).toBe(0);
  expect(packed.result).toMatchObject({ representation: 'packed', identityConfidence: 'verified', foundReaders: false });
  expect((await calls()).filter(args => args[0] === 'survey').at(-1)).toContain(join(source, 'data.zip', 'export'));
  const found = cli(['survey', source, '--find']);
  expect(found.result.foundReaders).toBe(true);
  expect((await calls()).filter(args => args[0] === 'scan').at(-1)![1]).toBe(join(source, 'data.zip'));
});

it('says when Chronicle is missing, and records what it could not count', async () => {
  await createPackage(source, context);
  const missing = spawnSync(process.execPath, ['bin/vestry.js', 'survey', source, '--home', context.home!, '--json'], { encoding: 'utf8', env: { ...process.env, PATH: join(root, 'empty') } });
  expect(missing.status).toBe(4);
  expect(JSON.parse(missing.stdout).error).toMatchObject({ code: 'CHRONICLE_UNAVAILABLE', message: expect.stringContaining('npm install -g @chronicle.app/cli') });
  const failing = cli(['survey', source], { FAKE_CHRONICLE_FAIL: 'survey' });
  expect(failing.status).toBe(1);
  expect(failing.result.readers[0]).toMatchObject({ source: 'notes', outcome: 'failed', reason: expect.stringMatching(/^Nothing at .*chronicle survey notes --help/) });
  expect(await readdir(join(context.home!, 'surveys'))).toHaveLength(1);
  const unregistered = join(root, 'unregistered'); await mkdir(unregistered);
  await createPackage(unregistered, { home: join(root, 'other-records') });
  expect(cli(['survey', unregistered]).result.error.message).toMatch(/^Register this package with scan/);
  const shelf = join(root, 'shelf'); await mkdir(join(shelf, 'notes'), { recursive: true });
  await writeFile(join(shelf, 'notes', 'notes.json'), '[]'); await createPackage(join(shelf, 'notes'), context);
  const folder = cli(['survey', shelf]);
  expect(folder.status).toBe(2);
  expect(folder.result.error.message).toMatch(/^Not a Vestry package: .*No bagit.txt found/);
});

it('copies a ZIP out of a packed copy for Chronicle to read, and removes the copy after', async () => {
  const kept = join(root, 'kept'); await mkdir(kept);
  await writeFile(join(kept, 'notes.zip'), fixture([{ name: 'notes.json', data: Buffer.from('[]') }]));
  await writeFile(join(kept, 'about.txt'), 'Notes kept as the ZIP they came in');
  await createPackage(kept, { ...context, packed: true });
  const surveyed = cli(['survey', kept]);
  expect(surveyed.status, surveyed.stdout).toBe(0);
  expect(surveyed.result.readers.find((r: { root: string }) => r.root === 'notes.zip')).toMatchObject({ source: 'notes', outcome: 'counted' });
  const scans = (await calls()).filter(args => args[0] === 'scan').map(args => args[1]);
  expect(scans).toEqual([join(kept, 'data.zip'), expect.stringMatching(/scratch.+notes\.zip$/)]);
  const counted = (await calls()).filter(args => args[0] === 'survey' && args[1] === 'notes').map(args => args[args.indexOf('--input') + 1]);
  expect(counted).toContainEqual(expect.stringMatching(/scratch.+notes\.zip$/));
  const scratch = join(context.home!, 'cache', 'scratch');
  expect(await exists(scratch) ? await readdir(scratch) : []).toEqual([]);
});

it('lists the exports Chronicle recognizes outside packages when scanning a folder', async () => {
  const shelf = join(root, 'shelf'); await mkdir(join(shelf, 'notes'), { recursive: true });
  await writeFile(join(shelf, 'notes', 'notes.json'), '[]'); await createPackage(join(shelf, 'notes'), context);
  const row = (root: string, more = {}) => ({ source: 'notes', strategy: 'archive', plugin: 'notes', status: 'ready', installed: true, root, config: { input: root }, ...more });
  const rows = JSON.stringify([
    row(join(shelf, 'notes', 'data')), row(join(shelf, 'loose')),
    row(join(shelf, 'takeout.zip', 'Takeout'), { source: 'takeout', plugin: 'google', status: 'unsupported' }),
    // Chronicle looks above a folder for the export it is in; that is not below the scan.
    row(root),
  ]);
  const scanned = cli(['scan', shelf], { FAKE_CHRONICLE_ROWS: rows });
  expect(scanned.status, scanned.stdout).toBe(0);
  expect(scanned.result.summary).toMatchObject({ verified: 1, packages: 1 });
  expect(scanned.result.exports).toEqual([
    { path: join(shelf, 'loose'), root: join(shelf, 'loose'), source: 'notes', strategy: 'archive', plugin: 'notes', status: 'ready' },
    { path: join(shelf, 'takeout.zip'), root: join(shelf, 'takeout.zip', 'Takeout'), source: 'takeout', strategy: 'archive', plugin: 'google', status: 'unsupported' },
  ]);
  expect((await calls()).find(args => args[0] === 'scan')![1]).toBe(shelf);
  const printed = run(['scan', shelf, '--quiet'], { FAKE_CHRONICLE_ROWS: rows }).stdout;
  expect(printed).toContain(`Not in a package`);
  expect(printed).toContain(`${join(shelf, 'takeout.zip')} · takeout unsupported`);
  expect(printed).toContain('Package one with: vestry create PATH');

  const failing = cli(['scan', shelf], { FAKE_CHRONICLE_FAIL: 'scan' });
  expect(failing.status).toBe(0);
  expect(failing.result.exports).toBeUndefined();
  expect(failing.result.warnings).toEqual([expect.stringMatching(/^Chronicle could not look for exports outside packages\. Nothing at /)]);
  const without = spawnSync(process.execPath, ['bin/vestry.js', 'scan', shelf, '--home', context.home!, '--json'], { encoding: 'utf8', env: { ...process.env, PATH: join(root, 'empty') } });
  expect(without.status).toBe(0);
  expect(JSON.parse(without.stdout)).not.toHaveProperty('exports');
  expect(JSON.parse(without.stdout)).not.toHaveProperty('warnings');
});
