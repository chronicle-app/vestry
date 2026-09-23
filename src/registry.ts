import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { lstat, mkdir, readFile, rm, rmdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson, canonical, exists, owner, within, type Owner } from './fs-util.js';
import { VestryError, conflict, usage } from './errors.js';
import { homePath, workspace, type Context } from './operations.js';
import { verify, type Verification } from './package.js';

export type Storage = 'external' | 'cache' | 'pinned';
export interface Location {
  path: string; representation: 'expanded' | 'packed'; storage: Storage;
  lastVerifiedAt: string; owner: Owner; state: 'known' | 'changed' | 'evicted'; observedDigest?: string;
}
export interface VestryMetadata { title?: string; description?: string; notes?: string; updatedAt?: string }
export interface PackageRecord { originalZipName?: string; metadata?: VestryMetadata; payloadFiles?: number; payloadBytes?: string; packageDigest: string; payloadDigest: string; registeredAt: string; mainLocation?: string | null; locations: Location[] }
interface Holder { pid: number; host: string }
export interface Lease extends Holder { token: string; path: string; digest?: string }
export interface Registry {
  schemaVersion: 1; packages: Record<string, PackageRecord>; aliases: Record<string, string>;
  leases: Lease[]; mutations: Record<string, Holder & { token: string }>;
  pathMutations?: (Holder & { token: string; path: string })[];
}
export const packageId = /^vestry-package-v1:sha256:[0-9a-f]{64}$/;
export const overlapping = (a: string, b: string) => within(a, b) || within(b, a);
const blank = (): Registry => ({ schemaVersion: 1, packages: {}, aliases: {}, leases: [], mutations: {} });
const registryFile = (context: Context) => join(homePath(context.home), 'registry', 'index.json');
export function holderAlive(holder: Holder): boolean {
  if (!holder || typeof holder.host !== 'string') return true;
  if (holder.host !== hostname()) return true;
  if (!Number.isSafeInteger(holder.pid) || holder.pid <= 0) return true;
  try { process.kill(holder.pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export async function readRegistry(context: Context = {}): Promise<Registry> {
  if (!await exists(registryFile(context))) return blank();
  let state: Registry;
  try { state = JSON.parse(await readFile(registryFile(context), 'utf8')); }
  catch (e) { if (e instanceof SyntaxError) throw usage('Malformed registry/index.json; restore its backup.'); throw e; }
  if (!state || state.schemaVersion !== 1 || !state.packages || typeof state.packages !== 'object' || Array.isArray(state.packages) || !state.aliases || typeof state.aliases !== 'object' || Array.isArray(state.aliases) || !Array.isArray(state.leases) || !state.mutations || typeof state.mutations !== 'object' || Array.isArray(state.mutations)) throw usage('Invalid registry schema.');
  for (const [id, record] of Object.entries(state.packages)) {
    if (!packageId.test(id) || !record || record.packageDigest !== id || !Array.isArray(record.locations)) throw usage('Invalid package registry record.');
    for (const location of record.locations) if (!location || typeof location.path !== 'string' || !isAbsolute(location.path) || !['external', 'cache', 'pinned'].includes(location.storage) || !['known', 'changed', 'evicted'].includes(location.state)) throw usage('Invalid registered location.');
  }
  for (const id of Object.values(state.aliases)) if (!Object.hasOwn(state.packages, id)) throw usage('Alias points to an unknown package.');
  for (const lease of state.leases) if (!lease || !Number.isSafeInteger(lease.pid) || lease.pid <= 0 || typeof lease.host !== 'string' || typeof lease.token !== 'string' || typeof lease.path !== 'string' || !isAbsolute(lease.path)) throw usage('Invalid reader lease.');
  for (const [id, holder] of Object.entries(state.mutations)) if (!packageId.test(id) || !holder || !Number.isSafeInteger(holder.pid) || holder.pid <= 0 || typeof holder.host !== 'string' || typeof holder.token !== 'string') throw usage('Invalid cache mutation reservation.');
  if (state.pathMutations !== undefined && (!Array.isArray(state.pathMutations) || state.pathMutations.some(h => !h || typeof h.path !== 'string' || !isAbsolute(h.path) || !Number.isSafeInteger(h.pid) || h.pid <= 0 || typeof h.host !== 'string' || typeof h.token !== 'string'))) throw usage('Invalid path mutation reservation.');
  for (const record of Object.values(state.packages)) {
    // Upgrade earlier registries in memory, preserving their first external location.
    if (record.mainLocation === undefined) record.mainLocation = record.locations.find(l => l.storage === 'external' && l.state !== 'evicted')?.path;
    if (record.mainLocation && !record.locations.some(l => l.path === record.mainLocation && l.storage === 'external')) throw usage('Invalid main package location.');
  }
  return state;
}

// A short external lock serializes alias updates, lease admission, and eviction.
// Never hold it while hashing/copying package content. Dead owners require an
// explicit administrative unlock; age alone cannot establish that a job stopped.
export async function mutateRegistry<T>(context: Context, roots: string[], action: (state: Registry) => Promise<T> | T): Promise<T> {
  const home = await workspace(context, roots), directory = join(home, 'registry');
  if (await exists(directory) && !(await lstat(directory)).isDirectory()) throw conflict('Registry must be a regular directory.');
  await mkdir(directory, { recursive: true });
  const lock = join(directory, 'mutation.lock');
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    context.signal?.throwIfAborted();
    try { await mkdir(lock); acquired = true; break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        const holder = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')) as Holder;
        if (!holderAlive(holder)) throw conflict('Registry lock owner has exited. Use vestry recover --release-registry-lock with the same --home.');
      } catch (readError) { if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError; }
      await delay(25);
    }
  }
  if (!acquired) throw conflict('Registry is busy or has an incomplete lock; retry or inspect registry/mutation.lock.');
  try {
    await atomicJson(join(lock, 'owner.json'), { pid: process.pid, host: hostname() });
    const state = await readRegistry({ ...context, home });
    state.leases = state.leases.filter(holderAlive);
    state.pathMutations = (state.pathMutations ?? []).filter(holderAlive);
    for (const [id, holder] of Object.entries(state.mutations)) if (!holderAlive(holder)) delete state.mutations[id];
    const result = await action(state);
    await atomicJson(join(directory, 'index.json'), state);
    return result;
  } finally { await rm(join(lock, 'owner.json'), { force: true }); await rmdir(lock); }
}
export async function releaseRegistryLock(context: Context): Promise<Record<string, unknown>> {
  const home = await workspace(context, []), lock = join(home, 'registry', 'mutation.lock');
  const holder = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')) as Holder;
  if (holderAlive(holder)) throw conflict('Registry lock owner is live, unknown, or belongs to another host.');
  await rm(join(lock, 'owner.json')); await rmdir(lock);
  return { status: 'lock-released' };
}

export async function rememberVerified(path: string, result: Verification, context: Context = {}, options: { alias?: string; storage?: Storage; deferMain?: boolean; metadata?: VestryMetadata; originalZipName?: string } = {}): Promise<void> {
  path = await canonical(path);
  if (options.alias !== undefined && !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(options.alias)) throw usage('Alias must begin with a letter and contain at most 64 letters, digits, dots, underscores or hyphens.');
  const physicalOwner = await owner(path);
  const failure = await mutateRegistry(context, [path], state => {
    const previous = Object.values(state.packages).find(p => p.packageDigest !== result.packageDigest && p.locations.some(l => l.path === path && l.state !== 'evicted'));
    if (previous) {
      const location = previous.locations.find(l => l.path === path)!;
      location.state = 'changed'; location.observedDigest = result.packageDigest;
      return new VestryError('LOCATION_CHANGED', 'This path now contains a different package. Use a new location for the new revision.', 5, { path, expected: previous.packageDigest, actual: result.packageDigest });
    }
    if (options.alias && Object.hasOwn(state.aliases, options.alias) && state.packages[state.aliases[options.alias]]?.payloadDigest !== result.payloadDigest) throw conflict(`Alias ${options.alias} already names a different package.`);
    const record = state.packages[result.packageDigest] ?? { packageDigest: result.packageDigest, payloadDigest: result.payloadDigest, registeredAt: new Date().toISOString(), mainLocation: null, locations: [] };
    if (record.metadata === undefined && (!options.metadata || !Object.keys(options.metadata).length)) record.metadata = Object.values(state.packages).find(r => r.payloadDigest === result.payloadDigest && r.metadata)?.metadata;
    if (record.metadata === undefined && options.metadata !== undefined) record.metadata = { ...options.metadata, updatedAt: new Date().toISOString() };
    if (options.originalZipName && !record.originalZipName) record.originalZipName = options.originalZipName;
    record.payloadFiles = result.payloadFiles; record.payloadBytes = result.payloadBytes;
    const prior = record.locations.find(l => l.path === path);
    const location: Location = { path, representation: result.representation, storage: options.storage ?? prior?.storage ?? 'external',
      lastVerifiedAt: new Date().toISOString(), owner: physicalOwner, state: 'known' };
    record.locations = [...record.locations.filter(l => l.path !== path), location];
    if (!record.mainLocation && !options.deferMain && location.storage === 'external' && !Object.values(state.packages).some(r => r.payloadDigest === result.payloadDigest && r.mainLocation)) record.mainLocation = path;
    state.packages[result.packageDigest] = record;
    if (options.alias && !Object.hasOwn(state.aliases, options.alias)) state.aliases[options.alias] = result.packageDigest;
  });
  if (failure) throw failure;
}
export async function markChanged(path: string, context: Context, actual?: string): Promise<void> {
  path = await canonical(path);
  await mutateRegistry(context, [path], state => {
    for (const record of Object.values(state.packages)) for (const location of record.locations) if (location.path === path && location.state !== 'evicted') {
      location.state = 'changed'; if (actual) location.observedDigest = actual;
    }
  });
}
/** Content references group exact package variants without rewriting their integrity records. */
export function contentRecords(ref: string, state: Registry): PackageRecord[] {
  const records = Object.values(state.packages);
  const alias = state.aliases[ref];
  const payload = alias ? state.packages[alias]?.payloadDigest : undefined;
  if (payload) return records.filter(record => record.payloadDigest === payload);
  const fullPayload = ref.startsWith('vestry-payload-v1:sha256:');
  const fullPackage = ref.startsWith('vestry-package-v1:sha256:');
  const prefix = fullPayload || fullPackage ? ref.split(':').at(-1)! : ref;
  if (!/^[0-9a-f]{1,64}$/.test(prefix)) throw new VestryError('REFERENCE_UNAVAILABLE', `Unknown content reference: ${ref}`, 4);
  const ids = [...new Set(records.filter(record => !fullPackage && record.payloadDigest.split(':').at(-1)!.startsWith(prefix)).map(record => record.payloadDigest))];
  if (ids.length > 1) throw new VestryError('AMBIGUOUS_DIGEST', 'Digest prefix matches multiple contents.', 5, { candidates: ids });
  if (ids.length) return records.filter(record => record.payloadDigest === ids[0]);
  if (!fullPayload) {
    const variants = records.filter(record => record.packageDigest.split(':').at(-1)!.startsWith(prefix));
    if (variants.length > 1) throw new VestryError('AMBIGUOUS_DIGEST', 'Digest prefix matches multiple packages.', 5, { candidates: variants.map(r => r.packageDigest) });
    if (variants.length) return variants;
  }
  throw new VestryError('REFERENCE_UNAVAILABLE', `Unknown content reference: ${ref}`, 4);
}
export function resolveIdentity(ref: string, state: Registry): string {
  const records = contentRecords(ref, state);
  if (records.length !== 1) throw new VestryError('AMBIGUOUS_COPY', 'Several package versions share this content. Select a copy by its path.', 5, { candidates: records.flatMap(r => r.locations.filter(l => l.state !== 'evicted').map(l => l.path)) });
  return records[0].packageDigest;
}
export interface Resolved { path: string; expected?: string; storage: Storage; lease?: string }
export async function resolveReference(ref: string, context: Context & { offline?: boolean; location?: string } = {}): Promise<Resolved> {
  const state = await readRegistry(context);
  const candidate = resolve(ref);
  // Explicit paths, existing cwd entries, and known path locators precede aliases.
  const known = Object.values(state.packages).find(p => p.locations.some(l => l.path === candidate && l.state !== 'evicted'));
  if (isAbsolute(ref) || ref.startsWith('.') || ref.includes('/') || known && !Object.hasOwn(state.aliases, ref) || await exists(candidate)) {
    if (context.location) throw usage('--location is for aliases/digests; an explicit input path already selects a copy.');
    const path = await canonical(candidate);
    const record = known ?? Object.values(state.packages).find(p => p.locations.some(l => l.path === path && l.state !== 'evicted'));
    const location = record?.locations.find(l => l.path === path);
    return { path, expected: record?.packageDigest, storage: location?.storage ?? 'external' };
  }
  const records = contentRecords(ref, state), record = records[0], id = record.payloadDigest;
  let locations = records.flatMap(r => r.locations.map(l => ({ ...l, packageDigest: r.packageDigest }))).filter(l => l.state !== 'evicted');
  if (context.location) {
    const path = await canonical(context.location); locations = locations.filter(l => l.path === path);
    if (!locations.length) throw conflict('--location is not registered for this package.');
  }
  if (context.offline) locations = locations.filter(l => l.storage !== 'external');
  if (records.length > 1 && !context.location) {
    const available = [];
    for (const location of locations) if (await exists(location.path)) available.push(location.path);
    if (available.length > 1) throw new VestryError('AMBIGUOUS_COPY', 'Several copies share this content. Select a copy by its path.', 5, { candidates: available });
  }
  const rank = { pinned: 0, cache: 1, external: 2 };
  locations.sort((a, b) => rank[a.storage] - rank[b.storage] || Number(b.path === record.mainLocation) - Number(a.path === record.mainLocation) || a.path.localeCompare(b.path));
  for (const location of locations) if (await exists(location.path)) return { path: location.path, expected: location.packageDigest, storage: location.storage };
  throw new VestryError('RESOURCE_UNAVAILABLE', context.offline ? 'No managed offline copy is available. Use cache add REF --pin while the source is available.' : 'No registered copy is currently available.', 4, { packageDigest: id });
}

export async function withReference<T>(ref: string, context: Context & { offline?: boolean; location?: string }, action: (resolved: Resolved) => Promise<T>): Promise<T> {
  const resolved = await resolveReference(ref, context);
  const token = randomUUID();
  await mutateRegistry(context, [resolved.path], state => {
    if (state.pathMutations?.some(h => overlapping(h.path, resolved.path))) throw conflict('This path is being modified; retry after the operation.');
    // Recheck under the admission lock: registration/migration may have finished
    // since resolution read the registry. Never admit against a stale snapshot.
    const latest = Object.values(state.packages).find(p => p.locations.some(l => l.path === resolved.path && l.state !== 'evicted'));
    if (resolved.expected && latest && latest.packageDigest !== resolved.expected) throw conflict('Location identity changed while resolving input.');
    if (latest) {
      resolved.expected = latest.packageDigest;
      resolved.storage = latest.locations.find(l => l.path === resolved.path)!.storage;
    }
    if (resolved.expected && state.mutations[resolved.expected]) throw conflict('Managed package copies are being modified; retry after the cache operation.');
    if (Object.keys(state.mutations).some(id => state.packages[id]?.locations.some(l => overlapping(l.path, resolved.path)))) throw conflict('Selected copy is being modified; retry after the cache operation.');
    state.leases.push({ token, path: resolved.path, digest: resolved.expected, pid: process.pid, host: hostname() });
  });
  try { return await action({ ...resolved, lease: token }); }
  finally { await mutateRegistry({ ...context, signal: undefined }, [resolved.path], state => { state.leases = state.leases.filter(l => l.token !== token); }); }
}
export async function withCacheMutation<T>(id: string, ownLease: string | undefined, context: Context, action: () => Promise<T>): Promise<T> {
  const token = randomUUID();
  await mutateRegistry(context, [], state => {
    if (state.pathMutations?.some(h => state.packages[id]?.locations.some(l => overlapping(l.path, h.path)))) throw conflict('Package location is being modified.');
    if (state.mutations[id] || state.leases.some(l => l.token !== ownLease && (l.digest === id || state.packages[id]?.locations.some(p => overlapping(p.path, l.path))))) throw conflict('Package has active readers or another cache operation.');
    state.mutations[id] = { token, pid: process.pid, host: hostname() };
  });
  try { return await action(); }
  finally { await mutateRegistry({ ...context, signal: undefined }, [], state => { if (state.mutations[id]?.token === token) delete state.mutations[id]; }); }
}
export async function withPaths<T>(paths: string[], context: Context, action: () => Promise<T>): Promise<T> {
  if (!paths.length) return action();
  return withReference(resolve(paths[0]), context, () => withPaths(paths.slice(1), context, action));
}
export async function locate(ref: string, context: Context & { offline?: boolean } = {}): Promise<Record<string, unknown>> {
  const state = await readRegistry(context);
  let id: string;
  const path = resolve(ref), known = Object.values(state.packages).find(p => p.locations.some(l => l.path === path));
  if (known && (!Object.hasOwn(state.aliases, ref) || await exists(path))) id = known.packageDigest;
  else if (isAbsolute(ref) || ref.startsWith('.') || ref.includes('/') || await exists(path)) {
    return withReference(path, context, async selected => {
      const result = await verify(selected.path);
      return { contentId: result.payloadDigest, payloadDigest: result.payloadDigest, packageDigest: result.packageDigest, payloadFiles: result.payloadFiles, payloadBytes: result.payloadBytes, aliases: Object.keys(state.aliases).filter(a => state.aliases[a] === result.packageDigest),
        locations: [{ path: selected.path, storage: selected.storage, representation: result.representation, availability: 'available', registered: false }], identityConfidence: 'verified' };
    });
  }
  else id = contentRecords(ref, state)[0].packageDigest;
  const selectedRecord = state.packages[id];
  const records = Object.values(state.packages).filter(r => r.payloadDigest === selectedRecord.payloadDigest);
  const main = records.find(r => r.mainLocation)?.mainLocation ?? null;
  const locations = await Promise.all(records.flatMap(r => r.locations.map(l => ({ ...l, packageDigest: r.packageDigest }))).map(async location => ({ ...location,
    availability: location.state === 'evicted' ? 'evicted' : context.offline && location.storage === 'external' ? 'not-checked-offline' : await exists(location.path) ? (location.state === 'changed' ? 'changed' : 'available') : 'unavailable',
  })));
  return { contentId: selectedRecord.payloadDigest, payloadDigest: selectedRecord.payloadDigest, metadata: records.find(r => r.metadata)?.metadata, metadataVariants: records.filter(r => r.metadata).map(r => ({ packageDigest: r.packageDigest, metadata: r.metadata })), packageDigest: records.length === 1 ? id : undefined, packageDigests: records.map(r => r.packageDigest), payloadFiles: selectedRecord.payloadFiles, payloadBytes: selectedRecord.payloadBytes, mainLocation: main, aliases: Object.keys(state.aliases).filter(a => records.some(r => r.packageDigest === state.aliases[a])), locations, identityConfidence: 'expected' };
}

export async function withPathMutation<T>(path: string, context: Context, action: () => Promise<T>): Promise<T> {
  path = await canonical(path);
  const token = randomUUID();
  await mutateRegistry(context, [path], state => {
    if (state.leases.some(l => overlapping(l.path, path)) || state.pathMutations?.some(h => overlapping(h.path, path)) || Object.keys(state.mutations).some(id => state.packages[id]?.locations.some(l => overlapping(l.path, path)))) throw conflict('Path has active readers or another operation.');
    (state.pathMutations ??= []).push({ token, path, pid: process.pid, host: hostname() });
  });
  try { return await action(); }
  finally { await mutateRegistry({ ...context, signal: undefined }, [], state => { state.pathMutations = state.pathMutations?.filter(h => h.token !== token); }); }
}

export async function listPackages(context: Context & { offline?: boolean } = {}): Promise<Record<string, unknown>> {
  const state = await readRegistry(context);
  const ids = [...new Set(Object.values(state.packages).map(r => r.payloadDigest))];
  const packages = await Promise.all(ids.map(async id => {
    const item = await locate(id, context);
    const locations = item.locations as (Location & { availability: string })[];
    const active = locations.filter(l => l.state !== 'evicted');
    const available = active.filter(l => l.availability === 'available').length;
    const main = locations.find(l => l.path === item.mainLocation);
    return { ...item, copyAvailability: context.offline ? 'not-checked-offline' : available ? 'available' : 'unavailable',
      copySummary: context.offline ? `${active.length} known locations` : `${available} available · ${active.length - available} missing`,
      availability: main?.availability ?? 'no-main-location', representation: main?.representation, lastVerifiedAt: main?.lastVerifiedAt };
  }));
  return { packages };
}

export async function setMainLocation(id: string, path: string, context: Context, onlyIfUnset = false): Promise<void> {
  path = await canonical(path);
  await mutateRegistry(context, [path], state => {
    const record = state.packages[id];
    const location = record?.locations.find(l => l.path === path && l.state === 'known');
    if (!location || location.storage !== 'external') throw conflict('Main location must be a verified external package, not a managed cache copy.');
    if (onlyIfUnset && Object.values(state.packages).some(r => r.payloadDigest === record.payloadDigest && r.mainLocation)) return;
    for (const variant of Object.values(state.packages)) if (variant.payloadDigest === record.payloadDigest) variant.mainLocation = variant === record ? path : null;
  });
}

export async function forgetPackage(ref: string, context: Context = {}): Promise<Record<string, unknown>> {
  const candidate = resolve(ref);
  const explicit = isAbsolute(ref) || ref.startsWith('.') || ref.includes('/') || await exists(candidate);
  const path = explicit ? await canonical(candidate) : candidate;
  return mutateRegistry(context, [], async state => {
    const known = Object.values(state.packages).find(p => p.locations.some(l => l.path === path || l.path === candidate));
    let id: string;
    if (explicit || known && !Object.hasOwn(state.aliases, ref)) {
      if (!known) {
        const { listOperations } = await import('./operations.js');
        const unfinished = (await listOperations(context)).find(op => op.source === candidate && ['create', 'import-zip'].includes(op.kind) && !['succeeded', 'discarded'].includes(op.status));
        throw new VestryError('REFERENCE_UNAVAILABLE', unfinished ? `No package was registered. An unfinished creation exists. Run vestry create ${JSON.stringify(candidate)} with the same --home to continue.` : `No registered package at: ${candidate}`, 4);
      }
      id = known.packageDigest;
    } else id = contentRecords(ref, state)[0].packageDigest;
    const record = state.packages[id];
    const variants = Object.values(state.packages).filter(r => r.payloadDigest === record.payloadDigest);
    const variantIds = variants.map(r => r.packageDigest);
    const overlaps = (path: string) => variants.flatMap(r => r.locations).some(l => overlapping(l.path, path));
    if (variantIds.some(id => state.mutations[id]) || state.leases.some(l => variantIds.includes(l.digest ?? '') || overlaps(l.path)) || state.pathMutations?.some(h => overlaps(h.path))) throw conflict('Package has active readers or an operation. Retry forget after it finishes.');
    const aliases = Object.keys(state.aliases).filter(alias => variantIds.includes(state.aliases[alias]));
    for (const alias of aliases) delete state.aliases[alias];
    for (const variantId of variantIds) delete state.packages[variantId];
    return { status: 'forgotten', contentId: record.payloadDigest, packageDigest: id, payloadDigest: record.payloadDigest,
      aliasesRemoved: aliases, locationsRemoved: variants.flatMap(r => r.locations.map(l => l.path)),
      message: 'Registration and aliases removed. Package files, managed copies, and operation history retained.' };
  });
}

export async function editMetadata(ref: string, patch: VestryMetadata, context: Context = {}): Promise<Record<string, unknown>> {
  if (!Object.keys(patch).length) throw usage('Use edit PACKAGE --title TEXT, --description TEXT, or --notes FILE. Empty text clears a field.');
  const located = await locate(ref, context);
  const id = located.payloadDigest as string;
  const metadata = await mutateRegistry(context, [], state => {
    const records = Object.values(state.packages).filter(r => r.payloadDigest === id);
    const record = records[0];
    if (!record) throw usage('Register this package with scan before editing its catalog metadata.');
    record.metadata = { ...record.metadata, ...patch, updatedAt: new Date().toISOString() };
    for (const variant of records) if (variant !== record) variant.metadata = { ...variant.metadata, ...patch, updatedAt: record.metadata.updatedAt };
    return record.metadata;
  });
  return { status: 'metadata-updated', contentId: id, payloadDigest: id, metadata, message: 'Vestry metadata updated. Package bytes and both digests are unchanged.' };
}
