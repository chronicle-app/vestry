import { spawn } from 'node:child_process';
import { VestryError } from './errors.js';

// Chronicle reads the exports inside a package. Vestry runs its CLI and reads
// the JSON it prints: scan finds each export and the source that reads it,
// survey counts what one export holds.
export interface Measure { key: string; label: string; value: number; unit?: 'bytes' | 'seconds' }
export interface KindSurvey { count: number; label?: string; earliest?: string; latest?: string; asOf?: string; measures?: Measure[]; byMonth?: Record<string, number> }
export interface ScanRow { source: string; strategy: string; plugin: string; status: string; installed: boolean; root?: string; layout?: string; pluginVersion?: string; config: Record<string, unknown>; evidence?: { files?: string[] } }
export interface SurveyRow { source: string; strategy: string; status?: string; pluginVersion?: string; survey: Record<string, KindSurvey> | null; error?: string }

const install = 'Install it with `npm install -g @chronicle.app/cli`, then try again.';
const kebab = (key: string) => key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);

/**
 * The last error Chronicle logged as JSON, with its hint, or its last line of
 * output. A Chronicle from before scan and survey doesn't know the command.
 */
function failure(stderr: string, command: string): VestryError {
  const logged = stderr.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).filter(entry => entry?.level === 'error').at(-1);
  if (logged?.error?.code === 'unknown-command') return new VestryError('CHRONICLE_OUTDATED', `This Chronicle has no ${command} command`, 4, {}, 'Update it with `npm install -g @chronicle.app/cli`, then try again.');
  const message = logged?.message ?? (stderr.trim().split('\n').at(-1) || 'Chronicle failed without a message.');
  return new VestryError('CHRONICLE_FAILED', message, 6, logged?.error ? { chronicle: logged.error } : {}, logged?.hint?.action);
}
function run(args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('chronicle', args, { signal, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? new VestryError('CHRONICLE_UNAVAILABLE', 'Chronicle isn\'t installed', 4, {}, install) : error));
    child.on('close', code => code === 0 ? resolve(stdout) : reject(failure(stderr, args[0])));
  });
}
function parse<T>(stdout: string): T {
  try { return JSON.parse(stdout) as T; }
  catch { throw new VestryError('CHRONICLE_FAILED', 'Can\'t read what Chronicle printed', 6, {}, 'Update it with `npm install -g @chronicle.app/cli`, then try again.'); }
}
const quietly = ['--format', 'json', '--log-format', 'json', '--quiet'];

export async function chronicleVersion(signal?: AbortSignal): Promise<string> {
  const out = await run(['--version'], signal);
  return /\/cli\/(\S+)/.exec(out)?.[1] ?? out.trim();
}
/** Each export Chronicle recognizes in a folder or zip, by the source that reads it. */
export async function scanExports(target: string, signal?: AbortSignal): Promise<ScanRow[]> {
  return parse<ScanRow[]>(await run(['scan', target, ...quietly], signal));
}
/** What one source would extract from an export, counted by record type. */
export async function surveyExport(source: string, strategy: string, input: string, options: Record<string, unknown>, signal?: AbortSignal): Promise<SurveyRow> {
  const flags = Object.entries(options).flatMap(([key, value]) => typeof value === 'boolean' ? [`--${value ? '' : 'no-'}${kebab(key)}`] : [`--${kebab(key)}`, String(value)]);
  const [row] = parse<SurveyRow[]>(await run(['survey', source, '--strategy', strategy, '--input', input, ...flags, ...quietly], signal));
  if (!row) throw new VestryError('CHRONICLE_FAILED', `Chronicle found nothing for ${source} to count`, 6);
  return row;
}
