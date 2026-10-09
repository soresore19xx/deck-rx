// The gains the automatic search chose and the ones the user saved, per
// receiver, channel and demod mode. Host-specific data, beside presets.json
// and gitignored like it. See gainSearch.ts for the search itself.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

declare const __dirname: string;   // provided by the bundle, as in presets.ts

function memoryPath(): string {
  return process.env.DECK_RX_GAIN_MEMORY_PATH ??
    join(__dirname, '..', 'data', 'gain-memory.json');
}

// Two maps: `gains` holds what the search chose, `saved` what the user saved
// for a station (preset) on purpose. A saved gain wins and is never searched
// over; an auto one is replaced by the next search.
interface MemoryFile { version: 1; gains: Record<string, number>; saved?: Record<string, number>; }

type Maps = { gains: Record<string, number>; saved: Record<string, number> };
let cache: Maps | null = null;

function load(): Maps {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(memoryPath(), 'utf-8')) as Partial<MemoryFile>;
    const obj = (o: unknown) => (o && typeof o === 'object' ? { ...(o as Record<string, number>) } : {});
    cache = { gains: obj(parsed?.gains), saved: obj(parsed?.saved) };
  } catch {
    cache = { gains: {}, saved: {} };
  }
  return cache;
}

/** Synchronous and atomic (tmp + rename): the file is small and a write
 *  happens once per station, not per tick. */
function writeOut(): void {
  const m = load();
  const p = memoryPath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    const body: MemoryFile = { version: 1, gains: m.gains, saved: m.saved };
    writeFileSync(`${p}.tmp`, JSON.stringify(body, null, 1) + '\n', 'utf-8');
    renameSync(`${p}.tmp`, p);
  } catch { /* a lost memory costs one more search, nothing else */ }
}

const num = (g: unknown): number | undefined =>
  typeof g === 'number' && Number.isFinite(g) ? g : undefined;

/** The gain for this station: the saved one if there is one, else the auto one. */
export function recallGain(key: string): number | undefined {
  const m = load();
  return num(m.saved[key]) ?? num(m.gains[key]);
}

/** Where recallGain's answer comes from. */
export function gainSource(key: string): 'saved' | 'auto' | undefined {
  const m = load();
  if (num(m.saved[key]) !== undefined) return 'saved';
  if (num(m.gains[key]) !== undefined) return 'auto';
  return undefined;
}

/** File the gain the search chose. */
export function rememberGain(key: string, gain: number): void {
  const m = load();
  if (m.gains[key] === gain) return;
  m.gains[key] = gain;
  writeOut();
}

/** File a gain the user saved for this station. */
export function saveGain(key: string, gain: number): void {
  const m = load();
  if (m.saved[key] === gain) return;
  m.saved[key] = gain;
  writeOut();
}

/** Drop both the saved and the auto gain. */
export function forgetGain(key: string): void {
  const m = load();
  if (!(key in m.gains) && !(key in m.saved)) return;
  delete m.gains[key];
  delete m.saved[key];
  writeOut();
}

/** Tests only: drop the in-process copy so the next read goes to disk. */
export function resetGainMemoryCache(): void { cache = null; }
