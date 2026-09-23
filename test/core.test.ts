import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { checkManifest, digest, logicalPath, manifest, walk } from '../src/inventory.js';
import { verify } from '../src/package.js';
import { convert, seal } from './core-helpers.js';
import { readZip } from '../src/zip.js';
import { fixture, type Member } from './zip-fixture.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'vestry-test-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

describe('digest protocol', () => {
  it('matches an independent Python golden for empty payload', () => {
    expect(digest('payload', [])).toBe('vestry-payload-v1:sha256:f8b5ef6803436fe84a6bd1ef4674bb05ee728a3506fd3e39b887d69c9261d060');
  });
  it('matches independent UTF-8 ordering, no normalization, and >2^53 length golden', () => {
    const entries = [
      { path: 'data/é.txt', size: 0n, sha256: sha('') },
      { path: 'data/é.txt', size: 5n, sha256: sha('hello') },
      { path: 'data/space %\n.txt', size: 2n ** 53n + 17n, sha256: 'ab'.repeat(32) },
    ];
    expect(digest('payload', entries)).toBe('vestry-payload-v1:sha256:f701d1ff1419ef8b3359db63e8095f90d7e623cfb94d3b8229bd1d6ed2d54444');
    expect(digest('payload', entries.reverse())).toBe(digest('payload', [...entries].reverse()));
    expect(digest('package', entries)).not.toBe(digest('payload', entries));
  });
  it('round-trips BagIt escapes without decoding literal percent sequences twice', () => {
    const items = [{ path: 'data/a %0A\r\n.txt', size: 0n, sha256: sha('') }];
    expect(() => checkManifest(manifest(items), items)).not.toThrow();
    expect(() => checkManifest(manifest(items).repeat(2), items)).toThrow('Duplicate');
  });
  it.each(['/absolute', '../escape', 'a/../b', 'a\\b', 'C:escape', 'a//b', './a', 'a\0b', '\ud800'])('rejects unsafe path %j', path => {
    expect(() => logicalPath(path)).toThrow();
  });
});

describe('ZIP boundary', () => {
  const bad: [string, Member[]][] = [
    ['duplicate', [{ name: 'x' }, { name: 'x' }]],
    ['traversal', [{ name: '../x' }]],
    ['absolute', [{ name: '/x' }]],
    ['backslash', [{ name: 'a\\b' }]],
    ['file-directory conflict', [{ name: 'a' }, { name: 'a/b' }]],
    ['symlink', [{ name: 'link', mode: 0o120777 }]],
    ['device', [{ name: 'device', mode: 0o020600 }]],
    ['encrypted', [{ name: 'x', flags: 0x801 }]],
    ['bad UTF-8', [{ name: Buffer.from([0xff]), flags: 0x800 }]],
    ['unsupported legacy encoding', [{ name: Buffer.from([0x82]), flags: 0 }]],
    ['unflagged traversal', [{ name: '../é', flags: 0 }]],
    ['mixed-flag duplicate', [{ name: 'é', flags: 0 }, { name: 'é', flags: 0x800 }]],
    ['CRC corruption', [{ name: 'x', crc: 0 }]],
    ['false stored size', [{ name: 'x', size: 1 }]],
    ['false deflated size', [{ name: 'x', data: Buffer.alloc(100_000), size: 1, deflate: true }]],
    ['local/central mismatch', [{ name: 'x', localName: 'y' }]],
  ];
  it.each(bad)('rejects %s and leaves no materialized output', async (_name, entries) => {
    const file = join(root, 'bad.zip'), output = join(root, 'output');
    await writeFile(file, fixture(entries));
    await expect(readZip(file, { destination: output })).rejects.toThrow();
    await expect(access(output)).rejects.toThrow();
  });
  it('checks member and expanded-byte budgets', async () => {
    const file = join(root, 'zip'); await writeFile(file, fixture([{ name: 'x' }, { name: 'y' }]));
    await expect(readZip(file, { limits: { maxMembers: 1, maxBytes: 100n } })).rejects.toThrow('member limit');
    await expect(readZip(file, { limits: { maxMembers: 10, maxBytes: 9n } })).rejects.toThrow('byte limit');
  });
  it('reads and extracts strict UTF-8 filenames even without the UTF-8 flag', async () => {
    const file = join(root, 'unflagged.zip'), output = join(root, 'output');
    const names = ['Screenshot 2024-02-15 at 5.25.01\u202fPM.png', 'janvier à août.xlsx'];
    await writeFile(file, fixture(names.map(name => ({ name, flags: 0 }))));
    expect((await readZip(file, { destination: output })).map(item => item.path)).toEqual(names);
    for (const name of names) expect(await readFile(join(output, name), 'utf8')).toBe('hello');
  });
  it('verifies colliding names without materialization, detects collisions on actual destination', async () => {
    const file = join(root, 'zip');
    await writeFile(file, fixture([{ name: 'A/x' }, { name: 'a/y' }, { name: 'é' }, { name: 'é' }]));
    expect(await readZip(file)).toHaveLength(4);
    await expect(readZip(file, { destination: join(root, 'out') })).rejects.toThrow('Ambiguous Unicode');
  });
  it('refuses an existing destination without touching it', async () => {
    const file = join(root, 'zip'); await writeFile(file, fixture([{ name: 'x' }]));
    const out = join(root, 'out'); await mkdir(out); await writeFile(join(out, 'x'), 'keep');
    await expect(readZip(file, { destination: out })).rejects.toThrow();
    expect(await readFile(join(out, 'x'), 'utf8')).toBe('keep');
  });
});

describe('preservation', () => {
  it('preserves identity through stored, deflated, ZIP64, and expanded copies', async () => {
    const source = join(root, 'source'); await mkdir(source);
    for (const name of ['é.txt', 'space %\n.txt', '.hidden', 'data.zip']) await writeFile(join(source, name), 'payload\n'.repeat(100));
    const expanded = join(root, 'expanded'); const before = await seal(source, expanded, 'Test package');
    for (const [index, options] of [{}, { compress: true }, { zip64: true }].entries()) {
      const packed = join(root, `packed-${index}`); const after = await convert(expanded, packed, options);
      expect(after.packageDigest).toBe(before.packageDigest); expect(after.payloadDigest).toBe(before.payloadDigest);
      expect(after.standardBag).toBe(false);
      const restored = await convert(packed, join(root, `restored-${index}`));
      expect(restored.packageDigest).toBe(before.packageDigest); expect(restored.standardBag).toBe(true);
    }
    expect((await verify(expanded)).packageDigest).toBe(before.packageDigest);
  });
  it('supports an empty payload', async () => {
    const source = join(root, 'empty'); await mkdir(source);
    const expanded = join(root, 'expanded'); await seal(source, expanded, 'Empty');
    expect((await convert(expanded, join(root, 'packed'))).payloadFiles).toBe(0);
  });
  it('detects changed payload, notes, extra files, and ambiguous representations', async () => {
    const source = join(root, 'input'); await writeFile(source, 'original');
    const out = join(root, 'out'); await seal(source, out, 'Notes');
    await writeFile(join(out, 'data', 'input'), 'tampered'); await expect(verify(out)).rejects.toThrow('mismatch');
    await writeFile(join(out, 'data', 'input'), 'original');
    await writeFile(join(out, 'README.txt'), 'changed'); await expect(verify(out)).rejects.toThrow('mismatch');
    await writeFile(join(out, '.DS_Store'), 'extra'); await expect(verify(out)).rejects.toThrow('membership');
    await rm(join(out, '.DS_Store')); await writeFile(join(out, 'data.zip'), 'ambiguous');
    await expect(verify(out)).rejects.toThrow('ambiguous');
  });
  it('new description changes package identity but preserves payload identity', async () => {
    const file = join(root, 'input'); await writeFile(file, 'original');
    const a = await seal(file, join(root, 'a'), 'First'), b = await seal(file, join(root, 'b'), 'Second');
    expect(a.packageDigest).not.toBe(b.packageDigest); expect(a.payloadDigest).toBe(b.payloadDigest);
  });
  it('rejects symlinks and outputs inside sources', async () => {
    const source = join(root, 'source'); await mkdir(source); await writeFile(join(source, 'a'), 'data');
    await expect(seal(source, join(source, 'output'), 'Notes')).rejects.toThrow('outside');
    await symlink(join(source, 'a'), join(source, 'link')); await expect(walk(source)).rejects.toThrow('Unsupported');
  });
});
