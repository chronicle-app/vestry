import { recover } from '../../src/operations.js';
import { checkOutput } from '../../src/workflow.js';
const [id, home] = process.argv.slice(2);
await recover(id, checkOutput, { home, onPhase: phase => { if (phase === 'reserved') process.kill(process.pid, 'SIGKILL'); } });
