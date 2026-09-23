import { constants, createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { checkManifest, matchPayload, digest, hashFile, manifest, walk, type Item } from './inventory.js';
import { readZip, writeZip } from './zip.js';
import { VestryError, diagnostic, integrity, usage } from './errors.js';
import packageInfo from '../package.json' with { type: 'json' };
import { TIMESTAMPS, mtimeNs, readTimestamps, restoreMtime, restorePayloadTimes, timestampDate, validateTimestamps, type Timestamps } from './timestamps.js';

const TAGS = ['bagit.txt', 'bag-info.txt', 'README.txt', TIMESTAMPS, 'manifest-sha256.txt', 'tagmanifest-sha256.txt'];
const DECLARATION = 'BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n';
const FOOTER = '\n\nRecovery: This package preserves original files. Verify an expanded bag with a BagIt 1.0 validator.\nIf data.zip replaces data/, extract data.zip into a new data/ directory and remove the outer data.zip.\nThe packed layout is a Vestry convention, not a complete standard BagIt bag.\nOriginal ZIPs inside data/ remain original files; do not extract them in place.\n';

export interface Verification {
  contentId?: string;
  status: 'verified'; representation: 'expanded' | 'packed'; standardBag: boolean;
  packageDigest: string; payloadDigest: string; payloadBytes: string; payloadFiles: number;
}

/** Reject wrong inputs before journaling verification or handling Finder files. */
export async function requirePackageDirectory(root: string, expected?: string): Promise<void> {
  let stat;
  try { stat = await lstat(root); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw new VestryError('RESOURCE_UNAVAILABLE', `Path not found: ${root}. Check the package path and whether its drive is connected.`, 4);
    }
    throw error;
  }
  if (!stat.isDirectory()) throw usage(`Not a package folder: ${root}. Use the folder containing bagit.txt.`);
  for (const name of ['bagit.txt', 'bag-info.txt', 'manifest-sha256.txt', 'tagmanifest-sha256.txt']) {
    try { await lstat(join(root, name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (name === 'bagit.txt' && !expected) throw usage(`Not a Vestry package: ${root}. No bagit.txt found. Check the path and select the package folder.`);
      throw integrity(`Package is missing ${name}: ${root}.`);
    }
  }
}

export async function verify(root: string, excludedFinderFiles: ReadonlySet<string> = new Set()): Promise<Verification> {
  try {
    for (const path of excludedFinderFiles) if (path.split('/').at(-1) !== '.DS_Store') throw new Error('Only Finder metadata can be excluded during quarantine validation');
    return await verifyBytes(root, excludedFinderFiles);
  }
  catch (error) {
    const result = diagnostic(error);
    if (result.exitCode !== 1 || (error as NodeJS.ErrnoException).code) throw result;
    throw integrity(result.message);
  }
}

async function verifyBytes(root: string, excluded: ReadonlySet<string>): Promise<Verification> {
  if (!(await lstat(root)).isDirectory()) throw new Error('Expected package directory');
  const names = (await readdir(root)).filter(name => !excluded.has(name));
  const packed = names.includes('data.zip');
  const presentTags = TAGS.filter(name => !['README.txt', TIMESTAMPS].includes(name) || names.includes(name));
  const required = [...presentTags, packed ? 'data.zip' : 'data'].sort();
  if (JSON.stringify([...names].sort()) !== JSON.stringify(required)) {
    const extra = names.filter(name => !required.includes(name)).sort();
    const missing = required.filter(name => !names.includes(name));
    const details = [extra.length ? `Unexpected: ${extra.map(name => JSON.stringify(name)).join(', ')}.` : '', missing.length ? `Missing: ${missing.map(name => JSON.stringify(name)).join(', ')}.` : '', names.includes('data') && packed ? 'Both data/ and data.zip exist; representations are ambiguous. Use vestry recover if a conversion was interrupted.' : ''].filter(Boolean);
    throw new Error(`Package membership mismatch. ${details.join(' ')}`);
  }
  for (const name of required) {
    const st = await lstat(join(root, name));
    if (name === 'data' ? !st.isDirectory() : !st.isFile()) throw new Error(`Unsupported package entry: ${name}`);
  }
  if (await readFile(join(root, 'bagit.txt'), 'utf8') !== DECLARATION) throw new Error('Unsupported BagIt declaration');
  if (names.includes('README.txt') && !(await readFile(join(root, 'README.txt'), 'utf8')).trim()) throw new Error('Empty README');
  const payload = packed
    ? (await readZip(join(root, 'data.zip'))).map(i => ({ ...i, path: 'data/' + i.path }))
    : matchPayload(await readFile(join(root, 'manifest-sha256.txt'), 'utf8'), await walk(join(root, 'data'), 'data/', excluded));
  const tags = await Promise.all(presentTags.map(name => hashFile(join(root, name), name)));
  checkManifest(await readFile(join(root, 'manifest-sha256.txt'), 'utf8'), payload);
  checkManifest(await readFile(join(root, 'tagmanifest-sha256.txt'), 'utf8'), tags.filter(i => i.path !== 'tagmanifest-sha256.txt'));
  const timestamps = await readTimestamps(root);
  if (timestamps !== undefined) validateTimestamps(timestamps, payload);
  const bytes = payload.reduce((sum, i) => sum + i.size, 0n);
  const info = await readFile(join(root, 'bag-info.txt'), 'utf8');
  if (!info.split('\n').includes(`Payload-Oxum: ${bytes}.${payload.length}`)) throw new Error('Payload-Oxum mismatch');
  return { contentId: digest('payload', payload), status: 'verified', representation: packed ? 'packed' : 'expanded', standardBag: !packed,
    packageDigest: digest('package', [...payload, ...tags]), payloadDigest: digest('payload', payload),
    payloadBytes: bytes.toString(), payloadFiles: payload.length };
}

/** Build inside an already-created staging directory. Publication is external. */
export async function buildBag(source: string, destination: string, readme: string | undefined, description?: string, packed = false, signal?: AbortSignal, activity?: (message: string, bytes?: string, total?: string) => void): Promise<void> {
  const reading = (path: string, bytes: string, total: string) => activity?.(`Reading: ${path}`, bytes, total);
  const original = await walk(source, '', new Set(), reading);
  const timestamps: Timestamps = { version: 1, files: [] };
  await mkdir(join(destination, 'data'));
  for (const item of original) {
    signal?.throwIfAborted();
    const target = join(destination, 'data', item.path);
    await mkdir(dirname(target), { recursive: true });
    activity?.(`Copying: ${item.path}`);
    const time = await mtimeNs(join(source, item.path));
    await copyFile(join(source, item.path), target, constants.COPYFILE_EXCL);
    await restoreMtime(target, time);
    timestamps.files.push({ path: 'data/' + item.path, mtimeNs: time });
  }
  activity?.('Checking copied payload');
  const payload = await walk(join(destination, 'data'), 'data/', new Set(), reading);
  if (digest('payload', payload) !== digest('payload', original.map(i => ({ ...i, path: 'data/' + i.path }))) || digest('code', await walk(source, '', new Set(), reading)) !== digest('code', original)) throw integrity('Draft payload changed during sealing.');
  await writeTags(destination, payload, readme, description, timestamps);
  if (packed) {
    signal?.throwIfAborted();
    await writeZip(join(destination, 'data'), await walk(join(destination, 'data')), join(destination, 'data.zip'), {
      mtimes: new Map(timestamps.files.map(file => [file.path.slice(5), file.mtimeNs])),
    });
    await rm(join(destination, 'data'), { recursive: true });
  }
}

export async function buildConversion(source: string, destination: string, before: Verification, options: { compress?: boolean; zip64?: boolean }): Promise<void> {
  for (const tag of (await readdir(source)).filter(name => TAGS.includes(name))) await copyFile(join(source, tag), join(destination, tag), constants.COPYFILE_EXCL);
  const timestamps = await readTimestamps(source);
  if (before.representation === 'expanded') {
    const payload = matchPayload(await readFile(join(source, 'manifest-sha256.txt'), 'utf8'), await walk(join(source, 'data'), 'data/'));
    if (timestamps !== undefined) validateTimestamps(timestamps, payload);
    const mtimes = timestamps && new Map(timestamps.files.map(file => [file.path.slice(5), file.mtimeNs]));
    await writeZip(join(source, 'data'), payload.map(item => ({ ...item, path: item.path.slice(5), diskPath: item.diskPath.slice(5) })), join(destination, 'data.zip'), { ...options, mtimes });
    if (timestamps?.originalZipMtimeNs !== undefined) await restoreMtime(join(destination, 'data.zip'), timestamps.originalZipMtimeNs);
  }
  else {
    const payload = await readZip(join(source, 'data.zip'), { destination: join(destination, 'data') });
    if (timestamps !== undefined) {
      validateTimestamps(timestamps, payload.map(item => ({ ...item, path: 'data/' + item.path })));
      await restorePayloadTimes(destination, timestamps);
    }
  }
}

export async function writeTags(destination: string, payload: Item[], readme: string | undefined, description?: string, timestamps?: Timestamps): Promise<void> {
  if (timestamps !== undefined) {
    validateTimestamps(timestamps, payload);
    await writeFile(join(destination, TIMESTAMPS), JSON.stringify(timestamps, null, 2) + '\n');
  }
  await writeFile(join(destination, 'bagit.txt'), DECLARATION);
  if (readme !== undefined) await writeFile(join(destination, 'README.txt'), readme.trimEnd() + FOOTER);
  const short = description ?? readme?.split(/\r?\n/).find(line => line.trim())?.trim();
  if (short !== undefined && /[\r\n]/.test(short)) throw integrity('Description must be a single line.');
  const bytes = payload.reduce((sum, i) => sum + i.size, 0n);
  const timestamp = new Date().toISOString();
  const originalZip = timestamps?.originalZipMtimeNs;
  await writeFile(join(destination, 'bag-info.txt'), `Bagging-Date: ${timestamp.slice(0, 10)}\nBagging-Timestamp: ${timestamp}\nBag-Software-Agent: ${packageInfo.name}/${packageInfo.version}\n${originalZip === undefined ? '' : `Original-Zip-Mtime: ${timestampDate(originalZip).toISOString()}\n`}${short === undefined ? '' : `External-Description: ${short}\n`}Payload-Oxum: ${bytes}.${payload.length}\n`);
  await writeFile(join(destination, 'manifest-sha256.txt'), manifest(payload));
  const tags = await Promise.all(TAGS.filter(n => n !== 'tagmanifest-sha256.txt' && (n !== 'README.txt' || readme !== undefined) && (n !== TIMESTAMPS || timestamps !== undefined)).map(n => hashFile(join(destination, n), n)));
  await writeFile(join(destination, 'tagmanifest-sha256.txt'), manifest(tags));
}

/** Adopt ZIP member paths as the logical payload, retaining exact container bytes. */
export async function buildZipBag(source: string, destination: string, readme: string | undefined, description?: string, signal?: AbortSignal, activity?: (message: string, bytes?: string, total?: string) => void): Promise<void> {
  signal?.throwIfAborted();
  const reading = (path: string, bytes: string, total: string) => activity?.(`Reading ZIP: ${path}`, bytes, total);
  const sourceStat = await lstat(source, { bigint: true });
  const timestamps: Timestamps = { version: 1, files: [], originalZipMtimeNs: String(sourceStat.mtimeNs) };
  if (!sourceStat.isFile()) throw integrity('ZIP source must be a regular file.');
  const container = join(destination, 'data.zip');
  const hash = createHash('sha256'); let size = 0n;
  activity?.('Copying and checksumming ZIP', '0', sourceStat.size.toString());
  const measure = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    hash.update(chunk); size += BigInt(chunk.length);
    activity?.('Copying and checksumming ZIP', size.toString(), sourceStat.size.toString());
    callback(null, chunk);
  }});
  await pipeline(createReadStream(source, { highWaterMark: 1024 * 1024 }), measure,
    createWriteStream(container, { flags: 'wx', highWaterMark: 1024 * 1024 }), { signal });
  const before = { sha256: hash.digest('hex'), size };
  const afterCopyStat = await lstat(source, { bigint: true });
  if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => sourceStat[key as keyof typeof sourceStat] !== afterCopyStat[key as keyof typeof afterCopyStat])) throw integrity('Source ZIP changed while copying; no package published.');
  signal?.throwIfAborted();
  activity?.('Checking files inside the ZIP');
  let payload: Item[];
  try { payload = (await readZip(container, { onMtime: (path, ns) => timestamps.files.push({ path: 'data/' + path, mtimeNs: ns }) })).map(item => ({ ...item, path: 'data/' + item.path })); }
  catch (error) {
    const failure = diagnostic(error);
    if (failure.exitCode !== 1 || (error as NodeJS.ErrnoException).code) throw failure;
    throw integrity(failure.message);
  }
  const copied = await hashFile(container, 'data.zip', reading);
  const after = await hashFile(source, 'data.zip', reading);
  if (before.sha256 !== copied.sha256 || before.sha256 !== after.sha256 || before.size !== copied.size || before.size !== after.size) throw integrity('Source ZIP changed during packaging; no package published.');
  signal?.throwIfAborted();
  await restoreMtime(container, timestamps.originalZipMtimeNs!);
  await writeTags(destination, payload, readme, description, timestamps);
}
