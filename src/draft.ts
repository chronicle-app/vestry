import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { digest, hashFile, logicalPath, membership, walk, type Item } from './inventory.js';
import { conflict, integrity, usage } from './errors.js';
import { atomicJson, outside, reserveFiles } from './fs-util.js';
import { homePath, transaction, type Checked, type Context } from './operations.js';
import { mtimeNs, restoreMtime } from './timestamps.js';

export const DRAFT = '.vestry-draft.json';
interface Draft { schemaVersion: 1; kind: 'vestry-draft'; description?: string }
export async function readDraft(root: string): Promise<{ metadata: Draft; readme: string }> {
  if (!(await lstat(root)).isDirectory()) throw conflict('Draft must be a regular directory.');
  const names = await readdir(root);
  if (JSON.stringify(names.sort()) !== JSON.stringify([DRAFT, 'README.txt', 'data'].sort())) throw conflict('Not a draft: expected only .vestry-draft.json, README.txt, and data/.');
  for (const name of names) {
    const st = await lstat(join(root, name));
    if (name === 'data' ? !st.isDirectory() : !st.isFile()) throw conflict(`Unsupported draft entry: ${name}`);
  }
  let metadata: Draft;
  try { metadata = JSON.parse(await readFile(join(root, DRAFT), 'utf8')) as Draft; }
  catch (error) { if (error instanceof SyntaxError) throw usage('Malformed draft metadata.'); throw error; }
  if (!metadata || metadata.schemaVersion !== 1 || metadata.kind !== 'vestry-draft' || (metadata.description !== undefined && (typeof metadata.description !== 'string' || !metadata.description.trim() || /[\r\n]/.test(metadata.description)))) throw usage('Invalid draft metadata.');
  return { metadata, readme: await readFile(join(root, 'README.txt'), 'utf8') };
}
export async function checkDraft(root: string): Promise<Checked> {
  await readDraft(root);
  const all = await walk(root), payload = all.filter(i => i.path.startsWith('data/'));
  return { identity: digest('code', all), result: { status: 'draft', payloadFiles: payload.length, payloadBytes: payload.reduce((n, i) => n + i.size, 0n).toString() } };
}
export async function gather(sources: string[], destination: string, context: Context = {}): Promise<Record<string, unknown>> {
  if (!sources.length) throw usage('gather requires at least one source.');
  sources = sources.map(source => resolve(source)); destination = resolve(destination);
  await outside(destination, sources);
  // Retain each source's top-level name, including for a single directory.
  const selected: (Item & { source: string })[] = [];
  const roots = new Set<string>();
  for (const source of sources) {
    context.signal?.throwIfAborted();
    const name = logicalPath(basename(source));
    if (roots.has(name)) throw conflict(`Source name collision: ${name}`); roots.add(name);
    const st = await lstat(source);
    if (st.isFile()) selected.push({ ...await hashFile(source, name), source });
    else if (st.isDirectory()) for (const item of await walk(source)) selected.push({ ...item, path: `${name}/${item.path}`, source: join(source, item.path) });
    else throw usage(`Only regular files and directories can be gathered: ${source}`);
  }
  membership(selected.map(i => i.path));
  // Check every source, not merely the first, before creating external state.
  await outside(homePath(context.home), sources);
  return transaction('gather', sources[0], destination, async stage => {
    await mkdir(join(stage, 'data'));
    await reserveFiles(join(stage, 'data'), selected.map(i => i.path));
    for (const item of selected) {
      context.signal?.throwIfAborted();
      const time = await mtimeNs(item.source);
      await copyFile(item.source, join(stage, 'data', item.path));
      await restoreMtime(join(stage, 'data', item.path), time);
    }
    const actual = await walk(join(stage, 'data'));
    if (digest('code', actual) !== digest('code', selected)) throw integrity('Source changed while gathering; use a stable source or filesystem snapshot.');
    // Read every source again: detect observed byte/membership changes, without
    // claiming these reads constitute a coherent filesystem snapshot.
    const again: Item[] = [];
    for (const source of sources) {
      const name = basename(source), st = await lstat(source);
      if (st.isFile()) again.push(await hashFile(source, name));
      else if (st.isDirectory()) again.push(...(await walk(source)).map(i => ({ ...i, path: `${name}/${i.path}` })));
      else throw conflict('Source type changed while gathering.');
    }
    if (digest('code', again) !== digest('code', selected)) throw integrity('Source changed while gathering; use a stable source or filesystem snapshot.');
    await writeFile(join(stage, 'README.txt'), '');
    await atomicJson(join(stage, DRAFT), { schemaVersion: 1, kind: 'vestry-draft' });
  }, checkDraft, context);
}

export async function describe(root: string, options: { description?: string; readme?: string; edit?: boolean }): Promise<Record<string, unknown>> {
  root = resolve(root);
  const draft = await readDraft(root);
  if (!options.edit && options.description === undefined && options.readme === undefined) throw usage('describe requires --edit, --readme FILE, or --description TEXT.');
  if (options.description !== undefined && (!options.description.trim() || /[\r\n]/.test(options.description))) throw usage('--description must be a nonempty single line.');
  let text = options.readme !== undefined ? await readFile(options.readme, 'utf8') : draft.readme;
  if (!text.trim() && options.description) text = options.description + '\n';
  if (options.edit) {
    if (!text.trim()) text = 'What: \nFrom: \nWhen: \nNotes: \n';
    const editPath = join(root, `.readme-${randomUUID()}.txt`);
    await writeFile(editPath, text, { flag: 'wx' });
    try {
      const editor = process.env.VISUAL || process.env.EDITOR;
      if (!editor) throw usage('Set $EDITOR (for example, export EDITOR="nano") or use --readme FILE.');
      await new Promise<void>((yes, no) => {
        // Editor is an explicitly user-configured command; filename is passed
        // separately as a shell positional argument, never interpolated.
        const child = spawn('/bin/sh', ['-c', `${editor} "$1"`, 'vestry-editor', editPath], { stdio: [0, 2, 2] });
        child.once('error', no); child.once('exit', (code, signal) => code === 0 ? yes() : no(new Error(`Editor exited with ${signal ?? code}`)));
      });
      text = await readFile(editPath, 'utf8');
    } finally { await rm(editPath, { force: true }); }
  }
  if (!text.trim()) throw usage('README must not be empty.');
  const temp = join(root, `.readme-${randomUUID()}.tmp`);
  await writeFile(temp, text, { flag: 'wx' }); await rename(temp, join(root, 'README.txt'));
  if (options.description !== undefined) draft.metadata.description = options.description.trim();
  await atomicJson(join(root, DRAFT), draft.metadata);
  return { status: 'draft', path: root, readme: text, description: draft.metadata.description ?? text.trim().split(/\r?\n/)[0] };
}
