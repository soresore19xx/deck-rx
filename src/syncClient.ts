// The plugin's side of sync (rules in syncCore.ts, hub in syncHub.ts).
//
// Every SYNC_INTERVAL_MS: read the preset file and the gain memory, send what
// differs from what the hub last confirmed, fold in what the hub answers and
// write the files back if anything came in. The files stay the plugin's own
// and are its cache: with the hub out of reach nothing changes for the
// plugin, and an edit made meanwhile is still a difference next time.

import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { log } from './log.js';
import {
  Base, Snapshot, SyncRecord, diffLocal, applyRemote,
  PRESETS, GAIN_AUTO, GAIN_SAVED, presetsToSnapshot, snapshotToPresets,
} from './syncCore.js';
import { getDeckRxPresetsPath, PresetFile } from './presets.js';
import { gainMaps, replaceGainMaps, gainMemoryMtime } from './gainMemory.js';
import { notifyPresetsChanged } from './presetList.js';

const SYNC_INTERVAL_MS = 30_000;
const SYNC_TIMEOUT_MS = 5_000;
/** mini4 on the Macs' segment, then on the iPad's. */
const DEFAULT_HUBS = ['http://192.168.0.51:8772', 'http://192.168.1.51:8772'];

interface State { seq: number; base: Base }

function statePath(): string {
  return process.env.DECK_RX_SYNC_STATE ?? join(dirname(getDeckRxPresetsPath()), 'sync-state.json');
}

function loadState(): State {
  try {
    const s = JSON.parse(readFileSync(statePath(), 'utf-8')) as State;
    if (typeof s.seq === 'number' && s.base) return s;
  } catch { /* first sync */ }
  return { seq: 0, base: {} };
}

function writeJson(path: string, v: unknown, indent: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(v, null, indent) + '\n', 'utf-8');
  renameSync(`${path}.tmp`, path);
}

function readPresets(): PresetFile | null {
  try { return JSON.parse(readFileSync(getDeckRxPresetsPath(), 'utf-8')) as PresetFile; }
  catch { return null; }
}

function mtime(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

function hubs(): string[] {
  const env = process.env.DECK_RX_SYNC_HUBS;
  if (env !== undefined) return env.split(',').map(s => s.trim()).filter(Boolean);
  return DEFAULT_HUBS;
}

async function post(hub: string, body: unknown): Promise<{ seq: number; records: SyncRecord[] }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SYNC_TIMEOUT_MS);
  try {
    const res = await fetch(`${hub}/sync`, {
      method: 'POST', body: JSON.stringify(body), signal: ctl.signal,
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json() as { seq: number; records: SyncRecord[] };
  } finally {
    clearTimeout(timer);
  }
}

let running = false;
let lastHub: string | null = null;
let lastError = '';

/** One round. Exported for tests; the timer calls it. */
export async function syncOnce(): Promise<'synced' | 'offline' | 'busy'> {
  if (running) return 'busy';
  running = true;
  try {
    const state = loadState();
    const presetFile = readPresets();
    const g = gainMaps();
    const local: Snapshot = {
      [PRESETS]: presetsToSnapshot(presetFile),
      [GAIN_AUTO]: g.gains,
      [GAIN_SAVED]: g.saved,
    };
    const first = state.seq === 0 && Object.keys(state.base).length === 0;
    const gm = gainMemoryMtime();
    const records = diffLocal(local, state.base,
      { [PRESETS]: mtime(getDeckRxPresetsPath()), [GAIN_AUTO]: gm, [GAIN_SAVED]: gm }, first);
    const order = lastHub ? [lastHub, ...hubs().filter(h => h !== lastHub)] : hubs();
    let answer: { seq: number; records: SyncRecord[] } | null = null;
    for (const hub of order) {
      try {
        answer = await post(hub, { since: state.seq, records, who: 'plugin' });
        lastHub = hub;
        break;
      } catch (e) {
        lastError = `${hub}: ${e}`;
      }
    }
    if (!answer) return 'offline';
    const changed = applyRemote(local, state.base, answer.records);
    if (changed.has(PRESETS)) {
      // Re-read just before writing so an edit made during the round trip is
      // kept: only the keys the hub sent are taken from `local`.
      const fresh = readPresets();
      const freshSnap = presetsToSnapshot(fresh);
      for (const r of answer.records) {
        if (r.c !== PRESETS) continue;
        if (r.v === null) delete freshSnap[r.k]; else freshSnap[r.k] = r.v;
      }
      writeJson(getDeckRxPresetsPath(), snapshotToPresets(freshSnap, fresh ?? presetFile), 2);
      notifyPresetsChanged();
    }
    if (changed.has(GAIN_AUTO) || changed.has(GAIN_SAVED)) {
      // Same care as the presets: a search may have filed a gain meanwhile.
      const fresh = gainMaps();
      for (const r of answer.records) {
        const m = r.c === GAIN_AUTO ? fresh.gains : r.c === GAIN_SAVED ? fresh.saved : null;
        if (!m) continue;
        if (typeof r.v === 'number') m[r.k] = r.v; else delete m[r.k];
      }
      replaceGainMaps(fresh.gains, fresh.saved);
    }
    writeJson(statePath(), { seq: answer.seq, base: state.base }, 0);
    if (records.length > 0 || changed.size > 0) {
      log.info(`[sync] ${lastHub}: sent ${records.length}, took in ${[...changed].join(',') || 'nothing'} (seq ${answer.seq})`);
    }
    return 'synced';
  } finally {
    running = false;
  }
}

let wasOffline = false;
export function startSync(): void {
  // Harness instances run sandboxed via DECK_RX_CONFIG_PATH and must never
  // reach the real hub; an explicit DECK_RX_SYNC_HUBS opts one back in.
  if (process.env.DECK_RX_CONFIG_PATH && process.env.DECK_RX_SYNC_HUBS === undefined) {
    log.info('[sync] sandboxed instance — sync disabled');
    return;
  }
  if (hubs().length === 0) { log.info('[sync] no hub configured — sync disabled'); return; }
  const tick = () => {
    syncOnce().then((r) => {
      if (r === 'offline' && !wasOffline) log.warn(`[sync] hub out of reach, working from the local files (${lastError})`);
      if (r === 'synced' && wasOffline) log.info('[sync] hub reachable again');
      if (r !== 'busy') wasOffline = r === 'offline';
    }).catch((e) => log.warn(`[sync] ${e}`));
  };
  setTimeout(tick, 3_000);
  setInterval(tick, SYNC_INTERVAL_MS).unref?.();
}
