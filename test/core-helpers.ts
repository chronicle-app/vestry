import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gather, describe } from '../src/draft.js';
import { sealDraft, convertPackage } from '../src/workflow.js';
import { verify } from '../src/package.js';
import { outside } from '../src/fs-util.js';

// Run format fixtures through the same preparation/publication service as CLI.
export async function seal(source: string, destination: string, description: string) {
  await outside(destination, [source]);
  const work = await mkdtemp(join(tmpdir(), 'vestry-core-'));
  try {
    const context = { home: join(work, 'home') }, draft = join(work, 'draft');
    await gather([source], draft, context); await describe(draft, { description });
    return await sealDraft(draft, destination, context);
  } finally { await rm(work, { recursive: true, force: true }); }
}
export async function convert(source: string, destination: string, options: { compress?: boolean; zip64?: boolean } = {}) {
  const work = await mkdtemp(join(tmpdir(), 'vestry-core-'));
  try { return await convertPackage(source, destination, (await verify(source)).representation === 'expanded' ? 'packed' : 'expanded', { ...options, home: join(work, 'home') }); }
  finally { await rm(work, { recursive: true, force: true }); }
}
