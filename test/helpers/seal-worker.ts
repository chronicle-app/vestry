import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sealDraft } from '../../src/workflow.js';
const [source, destination, home, killAt] = process.argv.slice(2);
await sealDraft(source, destination, { home, packed: true, onPhase: async (phase, op) => {
  if (phase === killAt) {
    if (phase === 'building') await writeFile(join(op.staging!, 'partial-payload'), 'interrupted copy');
    process.kill(process.pid, 'SIGKILL');
  }
} });
