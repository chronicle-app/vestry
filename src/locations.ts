import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { buildBag, buildZipBag } from './package.js';
import { canonical, exists, outside, within } from './fs-util.js';
import { VestryError, conflict, integrity, usage } from './errors.js';
import { homePath, listOperations, retireAbandoned, recover, transaction, type Context } from './operations.js';
import { checkOutput, checkPackage, convertPackage, verifyRecorded } from './workflow.js';
import { contentRecords, readRegistry, resolveIdentity, resolveReference, setMainLocation, withCacheMutation, withPathMutation, withReference } from './registry.js';
import { cacheRoot, copyPackage } from './cache.js';

async function pending(path: string, context: Context): Promise<void> {
  const operations = (await listOperations(context)).filter(op => (op.inPlace || ['create', 'move', 'copy', 'eject', 'import-zip'].includes(op.kind)) && !['succeeded', 'discarded'].includes(op.status) && (op.source === path || op.destination === path));
  for (const op of operations) {
    if (await retireAbandoned(op.id, context)) continue;
    throw conflict(`An unfinished ${op.kind} operation involves this path. Run vestry recover ${op.id} with the same --home.`);
  }
}

async function externalPath(path: string, context: Context): Promise<void> {
  await outside(path, [homePath(context.home), cacheRoot(context)]);
  await outside(homePath(context.home), [path]);
  for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) {
    if (await exists(join(parent, 'bagit.txt')) || await exists(join(parent, '.vestry-draft.json'))) throw conflict('Package location must not be inside another package or draft.');
  }
}

async function outsideWorkingDirectory(path: string): Promise<void> {
  if (within(await canonical(process.cwd()), path)) throw usage('Run this command from outside the source folder (for example, its parent). The source directory is replaced or removed after verification.');
}

// Only explicit paths select a copy without asking. Digest lookup never guesses.
export async function packageReference(ref: string, context: Context & { offline?: boolean; location?: string }) {
  const selected = await resolveReference(ref, context);
  const state = await readRegistry(context), candidate = resolve(ref);
  if (context.location || isAbsolute(ref) || ref.startsWith('.') || ref.includes('/') || await exists(candidate) || Object.values(state.packages).some(p => p.locations.some(l => l.path === candidate)) && !Object.hasOwn(state.aliases, ref)) return selected;
  const records = contentRecords(ref, state);
  const choices = [];
  for (const location of records.flatMap(r => r.locations)) {
    if (location.state !== 'evicted' && (!context.offline || location.storage !== 'external') && await exists(location.path)) choices.push(location.path);
  }
  if (choices.length > 1) throw new VestryError('AMBIGUOUS_COPY', 'Several copies are available. Select a copy by its path.', 5, { candidates: choices });
  return selected;
}
export const conversionReference = packageReference;

export async function convertInPlace(ref: string, target: 'packed' | 'expanded', context: Context & { offline?: boolean; location?: string; compress?: boolean; zip64?: boolean } = {}): Promise<Record<string, unknown>> {
  const selected = await conversionReference(ref, context);
  await outsideWorkingDirectory(selected.path); await pending(selected.path, context);
  return withReference(selected.path, { ...context, location: undefined }, async source => {
    const verified = await verifyRecorded(source.path, { ...context, expected: source.expected });
    return withCacheMutation(verified.packageDigest as string, source.lease, context, async () => {
      await pending(source.path, context);
      return convertPackage(source.path, source.path, target, { ...context, expected: verified.packageDigest as string, inPlace: true });
    });
  });
}

export async function singleZipDirectory(path: string): Promise<string | undefined> {
  try {
    if (!(await lstat(resolve(path))).isDirectory()) return;
    const entries = (await readdir(resolve(path), { withFileTypes: true })).filter(entry => !(entry.name === '.DS_Store' && entry.isFile()));
    if (entries.length === 1 && entries[0].isFile() && /\.zip$/i.test(entries[0].name)) return entries[0].name;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export async function creationPaths(path: string, output?: string, options: { zipContents?: boolean; keepZip?: boolean } = {}): Promise<{ source: string; destination: string; zip: boolean; zipEntry?: string }> {
  const stat = await lstat(resolve(path));
  const zip = stat.isFile() && /\.zip$/i.test(path);
  if (!stat.isDirectory() && !zip) throw usage('create requires an existing regular directory or .zip file (not a symlink).');
  if (!zip && output !== undefined) throw usage('--output is only supported for ZIP input; directory creation is in place.');
  const singleZip = stat.isDirectory() ? await singleZipDirectory(path) : undefined;
  if (options.zipContents && options.keepZip) throw usage('--zip-contents and --keep-zip are mutually exclusive.');
  if ((options.zipContents || options.keepZip) && !singleZip) throw usage('ZIP folder options require a directory containing one regular ZIP file, optionally accompanied by a regular .DS_Store file.');
  if (singleZip && !options.zipContents && !options.keepZip) throw new VestryError('ZIP_PAYLOAD_CHOICE', 'This folder contains one ZIP. Use --zip-contents to catalog its entries, or --keep-zip to preserve the ZIP as one original file.', 2, { zipFile: singleZip });
  const source = await canonical(path);
  const name = basename(source).replace(/\.zip$/i, '') || 'package';
  const destination = zip ? await canonical(output ?? join(dirname(source), name)) : source;
  return { source, destination, zip, ...(options.zipContents ? { zipEntry: singleZip } : {}) };
}

export async function createPackage(path: string, options: Context & { description?: string; readme?: string; packed?: boolean; alias?: string; output?: string; restart?: boolean; zipContents?: boolean; keepZip?: boolean } = {}): Promise<Record<string, unknown>> {
  const candidate = await canonical(path);
  for (const op of await listOperations(options)) if (['create', 'import-zip'].includes(op.kind) && op.source === candidate) await retireAbandoned(op.id, options);
  const unfinished = (await listOperations(options)).filter(op => ['create', 'import-zip'].includes(op.kind) && op.source === candidate && !['succeeded', 'discarded'].includes(op.status));
  if (unfinished.length > 1) throw conflict('Multiple unfinished creations involve this source. Inspect vestry recover before continuing.');
  if (unfinished.length) {
    const op = unfinished[0];
    if (!options.restart && (options.zipContents && !op.zipEntry || options.keepZip && op.zipEntry)) throw conflict('Retry must use the original ZIP choice. Omit ZIP options to resume, or use --restart to rebuild with a different choice.');
    if (options.output && await canonical(options.output) !== op.destination) throw conflict('Retry destination differs from the unfinished creation. Resume using its original destination.');
    if (!options.restart && (options.description !== undefined && options.description !== op.catalogMetadata?.description || options.readme && await readFile(resolve(options.readme), 'utf8') !== op.catalogMetadata?.notes || options.alias && options.alias !== op.alias || options.packed && op.result?.representation !== 'packed')) throw conflict('Retry uses the original creation settings. Rerun create with only the source path (and --home/--output if needed), or use --restart to rebuild with new settings.');
    if (options.restart) {
      options.onActivity?.('Discarding owned temporary work; original files will be retained');
      await recover(op.id, checkOutput, options, true);
      // Discard may finish an already-published operation; never create over it.
      const current = (await listOperations(options)).find(record => record.id === op.id)!;
      if (current.status !== 'discarded') return { ...current.result, operationId: op.id, path: current.destination, status: current.status };
    } else {
      options.onActivity?.(`Resuming interrupted creation ${op.id}`);
      try { return { ...await recover(op.id, checkOutput, { ...options, resumeCreation: true }), resumed: true }; }
      catch (error) {
        // Keep precise failures and recovery details. Restart is explicit because
        // it discards temporary work, and recovery still enforces ownership.
        if (error instanceof VestryError) error.message += ' To discard temporary work and rebuild from the current original, run vestry create PATH --restart with the same --home. Existing ownership and active-operation safeguards still apply.';
        throw error;
      }
    }
  }
  const paths = await creationPaths(path, options.output, options);
  path = paths.source;
  if (!paths.zip) {
    await outsideWorkingDirectory(path);
    if (await exists(join(path, 'bagit.txt')) || await exists(join(path, '.vestry-draft.json'))) throw conflict('This is already a package or draft. Use scan for packages or create --from-draft for drafts instead.');
  } else if (await exists(paths.destination)) throw conflict(`Destination exists: ${paths.destination}. Choose a new directory with --output DIR.`);
  await externalPath(paths.destination, options); await pending(path, options); await pending(paths.destination, options);
  const text = options.readme ? await readFile(resolve(options.readme), 'utf8') : options.description ?? '';
  options = { ...options, catalogMetadata: { ...(options.description !== undefined ? { description: options.description } : {}), ...(options.readme ? { notes: text } : {}) } };
  if (options.description !== undefined && (!options.description.trim() || /[\r\n]/.test(options.description))) throw usage('Description must be a nonempty single line.');
  if (options.alias && !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(options.alias)) throw usage('Invalid alias. Use up to 64 letters, digits, dots, underscores or hyphens, beginning with a letter.');
  const state = await readRegistry(options);
  if (options.alias && Object.hasOwn(state.aliases, options.alias)) throw conflict('Alias already exists. Choose a new alias.');
  if (Object.values(state.packages).some(p => p.locations.some(l => l.path === paths.destination))) throw conflict('This path is already registered; create a new package at a new location.');
  const protectZipSource = <T>(action: () => Promise<T>) => options.output === undefined
    ? withPathMutation(path, options, action) : withReference(path, options, action);
  if (paths.zip) return protectZipSource(() => withPathMutation(paths.destination, options, async () => {
    await pending(path, options); await pending(paths.destination, options);
    const result = await transaction('import-zip', path, paths.destination,
      stage => buildZipBag(path, stage, undefined, undefined, options.signal, options.onActivity), checkPackage, { ...options, adoptZip: options.output === undefined });
    return { ...result, mainLocation: paths.destination, sourceRetained: options.output !== undefined };
  }));
  return withPathMutation(path, options, async () => {
    await pending(path, options);
    if (await exists(join(path, 'bagit.txt')) || await exists(join(path, '.vestry-draft.json'))) throw conflict('Source became a package or draft while waiting.');
    const result = await transaction('create', path, path,
      stage => paths.zipEntry ? buildZipBag(join(path, paths.zipEntry), stage, undefined, undefined, options.signal, options.onActivity) : buildBag(path, stage, undefined, undefined, options.packed, options.signal, options.onActivity), checkPackage, { ...options, zipEntry: paths.zipEntry });
    return { ...result, mainLocation: path };
  });
}

export async function mainReference(ref: string, context: Context): Promise<{ path: string; id: string }> {
  const state = await readRegistry(context), path = await canonical(resolve(ref));
  const known = Object.values(state.packages).find(p => p.locations.some(l => l.path === path));
  const explicit = ref.includes('/') || ref.startsWith('.') || await exists(path);
  const id = explicit || known && !Object.hasOwn(state.aliases, ref) ? known?.packageDigest : resolveIdentity(ref, state);
  if (!id) throw usage('Register this package before moving it.');
  const main = state.packages[id].mainLocation;
  if (!main) throw conflict('Package has no main location. Register an external copy with --main first.');
  if (explicit && main !== path) throw conflict('move acts on the main location. Use the package alias/digest or register this copy with --main first.');
  return { path: main, id };
}

export async function movePackage(ref: string, destination: string, context: Context & { offline?: boolean } = {}): Promise<Record<string, unknown>> {
  if (context.offline) throw usage('mv relocates an external archive copy and cannot use --offline.');
  const resolved = await packageReference(ref, context);
  const selected = { path: resolved.path, id: resolved.expected };
  await outsideWorkingDirectory(selected.path);
  destination = await canonical(destination);
  if (within(selected.path, destination) || within(destination, selected.path)) throw conflict('Move destination must be separate from the source.');
  await externalPath(destination, context); await externalPath(selected.path, context);
  if (await exists(destination)) throw conflict('Move destination already exists.');
  await pending(selected.path, context); await pending(destination, context);
  return withReference(selected.path, context, async source => {
    const verified = await verifyRecorded(source.path, { ...context, expected: selected.id });
    selected.id = verified.packageDigest as string;
    return withCacheMutation(selected.id, source.lease, context, async () => {
    await pending(selected.path, context); await pending(destination, context);
    const result = await transaction('move', source.path, destination,
      stage => copyPackage(source.path, stage, context), async stage => {
        const checked = await checkPackage(stage);
        if (checked.identity !== selected.id) throw integrity('Move changed package identity; original retained.');
        return checked;
      }, context);
    return { ...result, mainLocation: destination, previousLocation: source.path };
  }); });
}

export async function adoptMain(path: string, id: string, lease: string | undefined, context: Context, onlyIfUnset = false): Promise<void> {
  await externalPath(path, context);
  await withCacheMutation(id, lease, context, async () => {
    const state = await readRegistry(context);
    if (onlyIfUnset && state.packages[id].mainLocation) return;
    for (const location of state.packages[id].locations) await pending(location.path, context);
    await setMainLocation(id, path, context, onlyIfUnset);
  });
}

export async function copyArchive(ref: string, destination: string, context: Context & { offline?: boolean } = {}): Promise<Record<string, unknown>> {
  const selected = await packageReference(ref, context);
  destination = await canonical(destination);
  if (within(destination, selected.path) || within(selected.path, destination)) throw conflict('Copy destination must be separate from the source.');
  await externalPath(destination, context);
  await pending(selected.path, context); await pending(destination, context);
  return withReference(selected.path, context, source => withPathMutation(destination, context, async () => {
    const verified = await verifyRecorded(source.path, { ...context, expected: source.expected });
    const result = await transaction('copy', source.path, destination, stage => copyPackage(source.path, stage, context), async stage => {
      const checked = await checkPackage(stage);
      if (checked.identity !== verified.packageDigest) throw integrity('Copy changed package identity; original retained.');
      return checked;
    }, context);
    return { ...result, sourceRetained: true };
  }));
}
