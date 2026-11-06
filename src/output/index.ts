/**
 * The only place terminal text is styled, after Chronicle's output module.
 * Blocks and formatters return strings cut to a width; the sinks render
 * `@chronicle.app/logging` events for a person on stderr. See "Output" in
 * AGENTS.md for the style guide.
 */
export { tokens, plainTokens, colorEnabled, type ColorMode, type Style, type Tokens } from './tokens.js';
export { glyphs } from './glyphs.js';
export { bytes, clean, clock, count, date, day, duration, pathArg, plural, relativePath, shellArg, tilde, tildes, truncate, truncatePath } from './format.js';
export { card, codeSpans, definitions, heading, hint, line, paragraph, summary, table, wrap, type Definition, type Segment, type Status, type TableInput } from './blocks.js';
export { LiveRegion, LiveView, progress, type ProgressFields } from './live.js';
export { PlainSink, PrettySink, createSink, render, type SinkOptions } from './sinks.js';
