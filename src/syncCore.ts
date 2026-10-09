// Sync between the plugin, Solo and the iPad through a hub on mini4: the
// rules every side shares. Pure — the hub (syncHub.ts), the plugin's client
// (syncClient.ts) and the Swift port (native-app/Sources/Sync.swift) drive it.
//
// What travels: presets and the per-station gains. Each side's own files stay
// where they are and are the local cache: the app reads and writes them as
// before, offline included. A sync compares the files with what the hub last
// confirmed (`base`); whatever differs is this side's change, so an edit made
// while the hub was out of reach is simply still different next time and goes
// up then. No edit site needs to know sync exists.
//
// Per record, the newer `t` wins. A deletion travels as `v: null` so a station
// removed on one device does not come back from another. A side's very first
// sync sends what it holds with `t: 0`: it fills gaps on the hub and never
// overrides what is already there.

export type SyncValue = number | { [k: string]: number | string | boolean };

/** One entry of one collection. `s` is the hub's sequence number for it. */
export interface SyncRecord { c: string; k: string; v: SyncValue | null; t: number; s?: number }

/** collection → key → value, as the local files hold it. */
export type Snapshot = Record<string, Record<string, SyncValue>>;

/** collection → key → the value and time the hub last confirmed. */
export type Base = Record<string, Record<string, { v: SyncValue | null; t: number }>>;

/** JSON with sorted keys, so two equal values compare equal however built. */
export function canon(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
}

/** This side's changes since the hub last confirmed. `t` is when the local
 *  file last changed (per collection); `first` sends everything at t 0. */
export function diffLocal(local: Snapshot, base: Base, t: Record<string, number>,
                          first: boolean): SyncRecord[] {
  const out: SyncRecord[] = [];
  const colls = new Set([...Object.keys(local), ...Object.keys(base)]);
  for (const c of colls) {
    const lc = local[c] ?? {}, bc = base[c] ?? {};
    for (const k of new Set([...Object.keys(lc), ...Object.keys(bc)])) {
      const lv = lc[k] ?? null, bv = bc[k]?.v ?? null;
      if (canon(lv) === canon(bv)) continue;
      out.push({ c, k, v: lv, t: first ? 0 : (t[c] ?? 0) });
    }
  }
  return out;
}

/** The hub's whole state. */
export interface HubStore { seq: number; recs: Record<string, Record<string, { v: SyncValue | null; t: number; s: number }>> }

export function emptyHub(): HubStore { return { seq: 0, recs: {} }; }

/** Take a side's records: a newer one replaces the hub's, an older or equal
 *  one is turned down. Returns the keys turned down, so the side can be told
 *  what stands instead (it may never see that record otherwise: its `s` can be
 *  older than what the side has already pulled). */
export function hubMerge(store: HubStore, records: SyncRecord[]): Array<{ c: string; k: string }> {
  const rejected: Array<{ c: string; k: string }> = [];
  for (const r of records) {
    const coll = (store.recs[r.c] ??= {});
    const cur = coll[r.k];
    if (cur && !(r.t > cur.t)) {
      if (canon(cur.v) !== canon(r.v)) rejected.push({ c: r.c, k: r.k });
      continue;
    }
    if (!cur && r.v === null) continue;       // deleting what was never there
    store.seq++;
    coll[r.k] = { v: r.v, t: r.t, s: store.seq };
  }
  return rejected;
}

/** Everything the hub took after `since`, plus the standing records for
 *  `extra` keys. */
export function hubSince(store: HubStore, since: number,
                         extra: Array<{ c: string; k: string }> = []): SyncRecord[] {
  const out: SyncRecord[] = [];
  const seen = new Set<string>();
  for (const [c, coll] of Object.entries(store.recs)) {
    for (const [k, e] of Object.entries(coll)) {
      if (e.s > since) { out.push({ c, k, v: e.v, t: e.t, s: e.s }); seen.add(c + '\u0000' + k); }
    }
  }
  for (const { c, k } of extra) {
    const e = store.recs[c]?.[k];
    if (e && !seen.has(c + '\u0000' + k)) out.push({ c, k, v: e.v, t: e.t, s: e.s });
  }
  return out;
}

/** Fold the hub's answer into the local snapshot and the base. Returns the
 *  collections whose local content changed, which are the files to write. */
export function applyRemote(local: Snapshot, base: Base, remote: SyncRecord[]): Set<string> {
  const changed = new Set<string>();
  for (const r of remote) {
    (base[r.c] ??= {})[r.k] = { v: r.v, t: r.t };
    const lc = (local[r.c] ??= {});
    if (canon(lc[r.k] ?? null) === canon(r.v)) continue;
    if (r.v === null) delete lc[r.k]; else lc[r.k] = r.v;
    changed.add(r.c);
  }
  return changed;
}

// ---- the two kinds of data, mapped to and from their files ----

/** Presets: `list::name` → { frequency, bandwidth, mode }. */
export const PRESETS = 'preset';
export const GAIN_AUTO = 'gainAuto';
export const GAIN_SAVED = 'gainSaved';

// Loose on purpose: the plugin's PresetFile and a raw JSON parse both fit.
export interface PresetFileShape { lists: Record<string, { bookmarks?: Record<string, object> }> }

export function presetsToSnapshot(file: PresetFileShape | null | undefined): Record<string, SyncValue> {
  const out: Record<string, SyncValue> = {};
  for (const [list, l] of Object.entries(file?.lists ?? {})) {
    for (const [name, b] of Object.entries(l?.bookmarks ?? {})) {
      const o = b as Record<string, unknown>;
      const f = Number(o.frequency), bw = Number(o.bandwidth ?? 0), m = Number(o.mode ?? 1);
      if (!Number.isFinite(f)) continue;
      out[`${list}::${name}`] = { frequency: f, bandwidth: Number.isFinite(bw) ? bw : 0, mode: Number.isFinite(m) ? m : 1 };
    }
  }
  return out;
}

/** Write the snapshot back into `file`, keeping whatever else the lists hold. */
export function snapshotToPresets(snap: Record<string, SyncValue>, file: PresetFileShape | null | undefined): PresetFileShape {
  const lists: PresetFileShape['lists'] = {};
  for (const [list, l] of Object.entries(file?.lists ?? {})) lists[list] = { ...l, bookmarks: {} };
  for (const [key, v] of Object.entries(snap)) {
    const i = key.indexOf('::');
    if (i < 0 || typeof v !== 'object') continue;
    const list = key.slice(0, i), name = key.slice(i + 2);
    (lists[list] ??= { bookmarks: {} }).bookmarks ??= {};
    lists[list].bookmarks![name] = { ...v };
  }
  return { ...(file ?? {}), lists };
}
