// The gains the automatic search chose and the ones the user saved, per
// receiver, channel and demod mode. Host-specific data, beside presets.json
// and gitignored like it. See gainSearch.ts for the search itself.

import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'fs';
import { join, dirname } from 'path';

declare const __dirname: string;   // provided by the bundle, as in presets.ts

function memoryPath(): string {
  return process.env.DECK_RX_GAIN_MEMORY_PATH ??
    join(__dirname, '..', 'data', 'gain-memory.json');
}

// Two maps: `gains` holds what the search chose, `saved` what the user saved
// for a station (preset) on purpose. A saved gain wins and is never searched
// over; an auto one is replaced by the next search.
//
// `measured` holds when each auto gain was measured (ms since 1970). Reception
// moves — medium wave between day and night, fading, a new antenna — so an
// auto gain is trusted for AUTO_GAIN_MAX_AGE_MS and searched again on the
// next landing after that. A gain with no time on it was filed by the rule
// before f3898dc (one that chose 24 on 1440 kHz with the IQ at full scale)
// and is searched again too. The times stay on this device: a gain arriving
// by sync has none here, so this device measures it for itself once.
interface MemoryFile { version: 1; gains: Record<string, number>; saved?: Record<string, number>;
                       measured?: Record<string, number>; }

/** How long a searched gain is used before the station is measured again. */
export const AUTO_GAIN_MAX_AGE_MS = 60 * 60 * 1000;

type Maps = { gains: Record<string, number>; saved: Record<string, number>; measured: Record<string, number> };
let cache: Maps | null = null;

function load(): Maps {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(memoryPath(), 'utf-8')) as Partial<MemoryFile>;
    const obj = (o: unknown) => (o && typeof o === 'object' ? { ...(o as Record<string, number>) } : {});
    cache = { gains: obj(parsed?.gains), saved: obj(parsed?.saved), measured: obj(parsed?.measured) };
  } catch {
    cache = { gains: {}, saved: {}, measured: {} };
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
    const body: MemoryFile = { version: 1, gains: m.gains, saved: m.saved, measured: m.measured };
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

/** Whether the auto gain for this station was measured under the current
 *  rule within AUTO_GAIN_MAX_AGE_MS. */
export function autoGainFresh(key: string, now = Date.now()): boolean {
  const at = num(load().measured[key]);
  return at !== undefined && now - at < AUTO_GAIN_MAX_AGE_MS && now >= at;
}

/** File the gain the search chose, and when. */
export function rememberGain(key: string, gain: number, now = Date.now()): void {
  const m = load();
  m.gains[key] = gain;
  m.measured[key] = now;
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
  delete m.measured[key];
  writeOut();
}

/** Copies of both maps, for sync (syncClient.ts). */
export function gainMaps(): { gains: Record<string, number>; saved: Record<string, number> } {
  const m = load();
  return { gains: { ...m.gains }, saved: { ...m.saved } };
}

/** Replace both maps with what sync settled on, and write it out. A gain
 *  that came in from another device loses this device's time for that key. */
export function replaceGainMaps(gains: Record<string, number>, saved: Record<string, number>): void {
  const old = load();
  const measured: Record<string, number> = {};
  for (const [k, t] of Object.entries(old.measured)) if (gains[k] === old.gains[k]) measured[k] = t;
  cache = { gains: { ...gains }, saved: { ...saved }, measured };
  writeOut();
}

/** When the file last changed, in ms; 0 when there is none. */
export function gainMemoryMtime(): number {
  try { return statSync(memoryPath()).mtimeMs; } catch { return 0; }
}

/** Tests only: drop the in-process copy so the next read goes to disk. */
export function resetGainMemoryCache(): void { cache = null; }
