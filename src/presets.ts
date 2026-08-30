// deck-rx-owned preset store. Lives in the plugin's data/ directory and is
// the source of truth for the Tune dial's preset cycler. It is UTF-8 clean
// so Japanese / CJK broadcaster names round-trip cleanly — SDR++'s
// frequency_manager_config.json is ASCII / Latin-1 in practice (its parser
// has been observed to reject non-ASCII content), so we keep that file
// read-only and import from it on user request via the PI Import button.

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { lookupJpStation } from './japanStations.js';

declare const __dirname: string;

// Path resolution is done per-call rather than once at module load so unit
// tests can flip DECK_RX_PRESETS_PATH / DECK_RX_SDR_CONFIG_PATH per test
// case without having to invalidate the module cache. SDR++ config is the
// source the Import button pulls from; same env-override convention as
// DECK_RX_CONFIG_PATH / DECK_RX_JP_STATIONS_PATH.
function presetsPath(): string {
  return process.env.DECK_RX_PRESETS_PATH ??
    join(__dirname, '..', 'data', 'presets.json');
}
function sdrConfigPath(): string {
  return process.env.DECK_RX_SDR_CONFIG_PATH ??
    join(homedir(), 'Library/Application Support/sdrpp/frequency_manager_config.json');
}

export interface PresetEntry {
  frequency: number;
  bandwidth: number;
  mode: number;
}
export interface PresetList {
  bookmarks: Record<string, PresetEntry>;
}
export interface PresetFile {
  lists: Record<string, PresetList>;
}

/** Load deck-rx-owned presets. Empty file (or missing file) returns a fresh
 *  empty PresetFile rather than throwing — first-run plugins have no presets
 *  yet, the user populates via the PI Import button or by hand-editing.
 *
 *  CAUTION: each call returns a fresh top-level object so callers (notably
 *  importFromSdrpp) can mutate the result without polluting a shared
 *  module-level constant. Returning a single EMPTY constant from here led
 *  to back-to-back imports inheriting the previous run's bookmarks via
 *  reference. */
export async function loadDeckRxPresets(): Promise<PresetFile> {
  try {
    const raw = await readFile(presetsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PresetFile>;
    if (parsed.lists && typeof parsed.lists === 'object') {
      return { lists: parsed.lists };
    }
    return { lists: {} };
  } catch {
    return { lists: {} };
  }
}

/** Atomic write (write to .tmp then rename) so a crash mid-write does not
 *  leave a half-flushed file. UTF-8 clean — JSON.stringify with the default
 *  ensureAscii=false equivalent (Node's behaviour). */
export async function saveDeckRxPresets(presets: PresetFile): Promise<void> {
  await mkdir(dirname(presetsPath()), { recursive: true });
  const tmp = `${presetsPath()}.tmp`;
  await writeFile(tmp, JSON.stringify(presets, null, 2) + '\n', 'utf-8');
  // rename is atomic on POSIX
  const { rename } = await import('fs/promises');
  await rename(tmp, presetsPath());
}

/** Flatten the nested PresetFile structure into a freq-sorted Preset[] (the
 *  shape the Tune dial preset cycler consumes). Stable across list keys —
 *  list order does not influence the result. */
export function flattenPresets(p: PresetFile): Array<{ name: string; freq: number; bandwidth: number; mode: number }> {
  const out: Array<{ name: string; freq: number; bandwidth: number; mode: number }> = [];
  for (const list of Object.values(p.lists ?? {})) {
    for (const [name, bm] of Object.entries(list.bookmarks ?? {})) {
      out.push({
        name,
        freq: Math.round(bm.frequency),
        bandwidth: bm.bandwidth,
        mode: bm.mode,
      });
    }
  }
  out.sort((a, b) => a.freq - b.freq);
  return out;
}

/**
 * Collapse duplicate-frequency bookmarks within a single list. When two
 * entries share a freq (typically an old ASCII placeholder from a
 * pre-CJK-rename import era + the JP-DB-renamed CJK entry), keep one and
 * drop the others. Preference order: an entry whose name matches the JP
 * DB lookup → an entry whose name is non-ASCII → the first-inserted
 * entry. Returns the collapsed list + the number of entries removed.
 *
 * Exposed so importFromSdrpp can pre-clean the destination before the
 * merge step, which guarantees that historical duplicates (introduced
 * when the import dedup was name-keyed instead of freq-keyed) get
 * collapsed on the next import.
 */
function dedupBookmarksByFreq(bookmarks: Record<string, PresetEntry>): { result: Record<string, PresetEntry>; removed: number } {
  const byFreq = new Map<number, Array<[string, PresetEntry]>>();
  for (const [name, e] of Object.entries(bookmarks)) {
    const f = Math.round(e.frequency);
    const arr = byFreq.get(f) ?? [];
    arr.push([name, e]);
    byFreq.set(f, arr);
  }
  let removed = 0;
  const result: Record<string, PresetEntry> = {};
  const isAscii = (s: string) => /^[\x00-\x7F]*$/.test(s);
  for (const [freq, entries] of byFreq) {
    if (entries.length === 1) {
      const [n, e] = entries[0];
      result[n] = e;
      continue;
    }
    const jp = lookupJpStation(freq);
    let pick: [string, PresetEntry] | undefined;
    if (jp?.name) {
      const match = entries.find(([n]) => n === jp.name);
      pick = match ?? [jp.name, entries[0][1]];
    } else {
      pick = entries.find(([n]) => !isAscii(n)) ?? entries[0];
    }
    result[pick[0]] = pick[1];
    removed += entries.length - 1;
  }
  return { result, removed };
}

/**
 * Import bookmarks from an SDR++ frequency_manager_config.json into the
 * deck-rx presets store.
 *
 * Dedup is **frequency-keyed** (not name-keyed): if the destination
 * already has a bookmark at the same freq, the SDR++ entry is skipped
 * regardless of whether the name matches. This prevents the "MW tbc
 * tohoku" (SDR++ ASCII) + "TBCラジオ" (post-rename CJK) double-add
 * regression that name-keyed dedup allowed.
 *
 * Before the merge step, the destination list is run through
 * dedupBookmarksByFreq() so any historical duplicates from earlier
 * imports get collapsed in-place — counted as `migrated`.
 *
 * The SDR++ config file is NOT touched — read-only. Returns counts so
 * the PI can show "imported N / skipped M / migrated K" feedback.
 */
export async function importFromSdrpp(sdrPath = sdrConfigPath()): Promise<{ added: number; skipped: number; migrated: number; lists: number }> {
  const raw = await readFile(sdrPath, 'utf-8');
  const src = JSON.parse(raw) as PresetFile;
  const dst = await loadDeckRxPresets();
  let added = 0, skipped = 0, migrated = 0, lists = 0;
  for (const [listName, list] of Object.entries(src.lists ?? {})) {
    const isNewList = !dst.lists[listName];
    const dstList = dst.lists[listName] ?? { bookmarks: {} };
    // Pre-clean: collapse any duplicate-freq entries already in the dst.
    const cleaned = dedupBookmarksByFreq(dstList.bookmarks);
    dstList.bookmarks = cleaned.result;
    migrated += cleaned.removed;
    let listChanged = cleaned.removed > 0;

    // Build a freq → name map for freq-keyed dedup during the merge.
    const existingByFreq = new Map<number, string>();
    for (const [n, e] of Object.entries(dstList.bookmarks)) {
      existingByFreq.set(Math.round(e.frequency), n);
    }
    for (const [bmName, bm] of Object.entries(list.bookmarks ?? {})) {
      const freq = Math.round(bm.frequency);
      // The bookmark's own name, as the user wrote it in SDR++. The station
      // database names the LCD's station line and the labels on the trace —
      // that is what a database name is for — but a preset is the user's
      // wording for their own entry, and overwriting it with the broadcaster's
      // official name lost the distinction they made ("MW NHK(東京)" against
      // "MW NHK(第2)", both of which the database calls NHK).
      const finalName = bmName;
      // Primary check: freq-keyed dedup (the actual identity of a station).
      if (existingByFreq.has(freq)) {
        skipped++;
        continue;
      }
      // Secondary check: a different freq is already bookmarked under the
      // same name. Skip to preserve the user's hand-edited entry — the
      // bookmarks dict is name-keyed so adding would overwrite.
      if (dstList.bookmarks[finalName]) {
        skipped++;
        continue;
      }
      dstList.bookmarks[finalName] = {
        frequency: freq,
        bandwidth: bm.bandwidth,
        mode: bm.mode,
      };
      existingByFreq.set(freq, finalName);
      added++;
      listChanged = true;
    }
    if (isNewList && listChanged) {
      lists++;
    }
    dst.lists[listName] = dstList;
  }
  await saveDeckRxPresets(dst);
  return { added, skipped, migrated, lists };
}

export function getDeckRxPresetsPath(): string { return presetsPath(); }
export function getSdrConfigPath(): string { return sdrConfigPath(); }
