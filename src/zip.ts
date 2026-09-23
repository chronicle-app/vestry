import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import * as yauzl from 'yauzl';
import * as yazl from 'yazl';
import { logicalPath, membership, portableNames, utf8, type Item } from './inventory.js';
import { mtimeNs, restoreMtime, timestampDate } from './timestamps.js';

export interface Limits { maxBytes: bigint; maxMembers: number }
export const defaults: Limits = { maxBytes: 20n * 1024n ** 3n, maxMembers: 100_000 };

// Use exclusive placeholders on the actual destination filesystem. This detects
// case/normalization collisions without renaming or normalizing logical names.
async function preflight(root: string, paths: string[]): Promise<void> {
  const dirs = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!dirs.has(dir)) { await mkdir(join(root, dir)); dirs.add(dir); }
    }
    const file = await open(join(root, path), 'wx'); await file.close();
  }
}

export async function readZip(file: string, options: { limits?: Limits; destination?: string; existingEmptyDirectory?: boolean; onMtime?: (path: string, ns: string) => void } = {}): Promise<Item[]> {
  const limits = options.limits ?? defaults;
  const zip = await yauzl.openPromise(file, { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true });
  let created = false;
  try {
    if (zip.entryCount > limits.maxMembers) throw new Error('ZIP member limit exceeded');
    const entries: { entry: yauzl.Entry; path: string; directory: boolean }[] = [];
    const seen = new Set<string>(); let declared = 0n;
    for await (const entry of zip.eachEntry()) {
      if (entries.length >= limits.maxMembers) throw new Error('ZIP member limit exceeded');
      const raw = entry.fileNameRaw;
      // Some exporters write UTF-8 names without setting bit 11 (including
      // macOS archives). Accept strict UTF-8 either way; never replace invalid
      // bytes or normalize names. Other legacy encodings remain unsupported.
      const name = utf8.decode(raw); const directory = name.endsWith('/');
      const path = logicalPath(directory ? name.slice(0, -1) : name);
      if (seen.has(path)) throw new Error(`Duplicate ZIP path: ${path}`); seen.add(path);
      const kind = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (kind && kind !== (directory ? 0x4000 : 0x8000)) throw new Error(`Unsupported ZIP entry type: ${path}`);
      if (entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod)) throw new Error('Unsupported encryption/compression');
      if (![entry.uncompressedSize, entry.compressedSize, entry.relativeOffsetOfLocalHeader].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('ZIP size/offset exceeds safe integer range');
      if (directory && entry.uncompressedSize !== 0) throw new Error('Nonempty ZIP directory');
      declared += BigInt(entry.uncompressedSize);
      if (declared > limits.maxBytes) throw new Error('ZIP expanded-byte limit exceeded');
      const local = await zip.readLocalFileHeaderPromise(entry);
      if (!local.fileName.equals(raw) || local.compressionMethod !== entry.compressionMethod || local.generalPurposeBitFlag !== entry.generalPurposeBitFlag) throw new Error('ZIP local/central header mismatch');
      entries.push({ entry, path, directory });
    }
    membership(entries.filter(x => !x.directory).map(x => x.path), entries.filter(x => x.directory).map(x => x.path));
    if (options.destination) {
      portableNames(entries.filter(x => !x.directory).map(x => x.path));
      if (options.existingEmptyDirectory) {
        if (!(await lstat(options.destination)).isDirectory() || (await readdir(options.destination)).length) throw new Error('Extraction destination must be empty');
      } else { await mkdir(options.destination); created = true; }
      await preflight(options.destination, entries.filter(x => !x.directory).map(x => x.path));
    }
    const items: Item[] = []; let total = 0n;
    for (const { entry, path, directory } of entries) {
      const hash = createHash('sha256'); let size = 0n; let crc = 0;
      const stream = await zip.openReadStreamPromise(entry);
      const measure = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        size += BigInt(chunk.length); total += BigInt(chunk.length);
        if (total > limits.maxBytes || size > BigInt(entry.uncompressedSize)) return callback(new Error('ZIP actual-byte limit/size exceeded'));
        hash.update(chunk); crc = crc32(chunk, crc); callback(null, chunk);
      }});
      // All streams participate in pipeline error propagation and backpressure.
      const sink = options.destination && !directory
        ? createWriteStream(join(options.destination, path), { flags: 'r+' })
        : new Transform({ transform(_chunk, _encoding, callback) { callback(); } });
      await pipeline(stream, measure, sink);
      if (size !== BigInt(entry.uncompressedSize) || crc !== entry.crc32) throw new Error(`ZIP size/CRC mismatch: ${path}`);
      if (!directory && (options.destination || options.onMtime)) {
        const date = entry.getLastModDate();
        if (!Number.isFinite(date.getTime())) throw new Error(`Invalid ZIP timestamp: ${path}`);
        const ns = String(BigInt(date.getTime()) * 1_000_000n);
        options.onMtime?.(path, ns);
        if (options.destination) await restoreMtime(join(options.destination, path), ns);
      }
      if (!directory) items.push({ path, size, sha256: hash.digest('hex') });
    }
    return items;
  } catch (error) {
    if (created) await rm(options.destination!, { recursive: true, force: true });
    throw error;
  } finally { zip.close(); }
}

export async function writeZip(root: string, files: (Item & { diskPath?: string })[], destination: string, options: { compress?: boolean; zip64?: boolean; mtimes?: ReadonlyMap<string, string> } = {}): Promise<void> {
  membership(files.map(i => i.path));
  for (const item of files) {
    if (item.size < 0n || item.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ZIP writer size exceeds safe integer range');
  }
  const dates = await Promise.all(files.map(async item => timestampDate(options.mtimes?.get(item.path) ?? await mtimeNs(join(root, item.diskPath ?? item.path)))));
  const zip = new yazl.ZipFile();
  zip.on('error', error => (zip.outputStream as Readable).destroy(error));
  const finished = pipeline(zip.outputStream, createWriteStream(destination, { flags: 'wx' }));
  for (const [index, item] of files.entries()) {
    zip.addReadStreamLazy(item.path, { mtime: dates[index], size: Number(item.size), compress: options.compress ?? false, forceZip64Format: options.zip64 ?? false }, callback => {
      callback(null, createReadStream(join(root, item.diskPath ?? item.path)));
    });
  }
  zip.end({ forceZip64Format: options.zip64 ?? false, comment: '' });
  await finished;
}
