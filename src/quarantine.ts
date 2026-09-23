import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicJson, canonical, exists, syncPath, syncTree } from './fs-util.js';
import { hashFile, parseManifest } from './inventory.js';
import { conflict, diagnostic, integrity } from './errors.js';
import { workspace, type Context } from './operations.js';
import { requirePackageDirectory, verify } from './package.js';

export interface QuarantineReport { directory: string; files: string[]; warnings: string[]; copyOnly?: boolean }

/** Only known Finder files outside the checked manifests are eligible. */
export async function quarantineFinderFiles(source: string, context: Context): Promise<QuarantineReport | undefined> {
  source = await canonical(source);
  await requirePackageDirectory(source, context.expected);
  const candidates: string[] = [];
  async function scan(root: string, prefix: string, recurse: boolean): Promise<void> {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.name === '.DS_Store' && entry.isFile()) candidates.push(path);
      else if (entry.isDirectory() && (recurse || entry.name === 'data')) await scan(join(root, entry.name), path + '/', true);
    }
  }
  await scan(source, '', false);
  if (!candidates.length) return;
  const protectedPaths = new Set<string>();
  try {
    for (const name of ['manifest-sha256.txt', 'tagmanifest-sha256.txt']) {
      for (const path of parseManifest(await readFile(join(source, name), 'utf8')).keys()) protectedPaths.add(path);
    }
  } catch (error) { throw integrity(`Cannot establish which Finder files are preserved: ${(error as Error).message}`); }
  for (let i = candidates.length - 1; i >= 0; i--) if (protectedPaths.has(candidates[i])) candidates.splice(i, 1);
  if (!candidates.length) return;
  // Do not "repair" a broken manifest or conceal unrelated corruption. All
  // preserved bytes and manifests must verify before anything is moved.
  const checked = await verify(source, new Set(candidates));
  if (context.expected && checked.packageDigest !== context.expected) throw integrity('Package identity changed; Finder metadata has not been moved.');
  return preserveFinderFiles(source, candidates, checked.packageDigest, context);
}

/** Called only after the ZIP folder original and published package have been verified. */
export async function preserveZipFolderFinderFile(source: string, context: Context): Promise<boolean> {
  if (!await exists(join(source, '.DS_Store'))) return false;
  await preserveFinderFiles(source, ['.DS_Store'], context.expected!, context, true);
  return true;
}

async function preserveFinderFiles(source: string, candidates: string[], packageDigest: string, context: Context, copyOnly = false): Promise<QuarantineReport> {
  const home = await workspace(context, [source]);
  const parent = join(home, 'quarantine');
  if (await canonical(parent) !== parent) throw conflict('Quarantine directory must not redirect through symlinks.');
  await mkdir(parent, { recursive: true });
  const directory = join(parent, randomUUID()); await mkdir(directory);
  const report: QuarantineReport = { directory, files: [], warnings: [], ...(copyOnly ? { copyOnly: true } : {}) };
  context.quarantined?.push(report);
  const warnings = report.warnings;
  const record = { schemaVersion: 1, source, packageDigest, createdAt: new Date().toISOString(),
    files: [] as { path: string; sha256: string; bytes: string; status: 'planned' | 'copied' | 'quarantined' }[], warnings };
  const save = () => atomicJson(join(directory, 'record.json'), record, warnings);
  try {
    await save();
    for (const path of candidates) {
      context.signal?.throwIfAborted();
      const input = join(source, path), output = join(directory, 'files', path);
      if (await canonical(input) !== input) throw conflict('Finder metadata path was replaced with a symlink.');
      const stat = await lstat(input, { bigint: true });
      if (!stat.isFile()) throw conflict('Finder metadata is no longer a regular file.');
      const before = await hashFile(input, path);
      const entry = { path, sha256: before.sha256, bytes: before.size.toString(), status: 'planned' as 'planned' | 'copied' | 'quarantined' };
      record.files.push(entry); await save();
      await mkdir(dirname(output), { recursive: true });
      await copyFile(input, output, constants.COPYFILE_EXCL);
      await syncTree(directory, warnings); await syncPath(parent, warnings);
      const copied = await hashFile(output, path);
      if (copied.sha256 !== before.sha256 || copied.size !== before.size) throw integrity('Quarantine copy differs; original retained.');
      entry.status = 'copied'; await save();
      const after = await lstat(input, { bigint: true }), current = await hashFile(input, path);
      if (!after.isFile() || after.dev !== stat.dev || after.ino !== stat.ino || current.sha256 !== before.sha256 || current.size !== before.size) throw conflict('Finder metadata changed during quarantine; original retained.');
      context.signal?.throwIfAborted();
      if (copyOnly) {
        if (warnings.length) throw conflict('Finder metadata copy could not be durably flushed; original folder retained.');
        report.files.push(path); continue;
      }
      await unlink(input); report.files.push(path);
      await syncPath(dirname(input), warnings);
      entry.status = 'quarantined'; await save();
    }
    return report;
  } catch (error) {
    const failure = diagnostic(error); failure.details.quarantine = directory; throw failure;
  }
}
