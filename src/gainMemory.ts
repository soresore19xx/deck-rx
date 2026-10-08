// The gains the automatic search chose (or the user set by hand), per
// receiver, channel and demod mode. Host-specific data, beside presets.json
// and gitignored like it. See gainSearch.ts for the search itself.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

declare const __dirname: string;   // provided by the bundle, as in presets.ts

function memoryPath(): string {
  return process.env.DECK_RX_GAIN_MEMORY_PATH ??
    join(__dirname, '..', 'data', 'gain-memory.json');
}

interface MemoryFile { version: 1; gains: Record<string, number>; }

let cache: Record<string, number> | null = null;

function load(): Record<string, number> {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(memoryPath(), 'utf-8')) as Partial<MemoryFile>;
    cache = parsed?.gains && typeof parsed.gains === 'object' ? { ...parsed.gains } : {};
  } catch {
    cache = {};
  }
  return cache;
}

export function recallGain(key: string): number | undefined {
  const g = load()[key];
  return typeof g === 'number' && Number.isFinite(g) ? g : undefined;
}

/** Remember and write through. Synchronous and atomic (tmp + rename): the
 *  file is small and a write happens once per station, not per tick. */
export function rememberGain(key: string, gain: number): void {
  const m = load();
  if (m[key] === gain) return;
  m[key] = gain;
  const p = memoryPath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    const body: MemoryFile = { version: 1, gains: m };
    writeFileSync(`${p}.tmp`, JSON.stringify(body, null, 1) + '\n', 'utf-8');
    renameSync(`${p}.tmp`, p);
  } catch { /* a lost memory costs one more search, nothing else */ }
}

export function forgetGain(key: string): void {
  const m = load();
  if (!(key in m)) return;
  delete m[key];
  const p = memoryPath();
  try {
    writeFileSync(`${p}.tmp`, JSON.stringify({ version: 1, gains: m }, null, 1) + '\n', 'utf-8');
    renameSync(`${p}.tmp`, p);
  } catch { /* see rememberGain */ }
}

/** Tests only: drop the in-process copy so the next read goes to disk. */
export function resetGainMemoryCache(): void { cache = null; }
