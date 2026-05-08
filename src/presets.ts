// deck-rx-owned preset store. Lives in the plugin's data/ directory and is
// the source of truth for the Tune dial's preset cycler. It is UTF-8 clean
// so Japanese / CJK broadcaster names round-trip cleanly — SDR++'s
// frequency_manager_config.json is ASCII / Latin-1 in practice (its parser
// has been observed to reject non-ASCII content), so we keep that file
// read-only and import from it on user request via the PI Import button.

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';

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
 * Import bookmarks from an SDR++ frequency_manager_config.json into the
 * deck-rx presets store. Merge rule: an existing deck-rx bookmark with the
 * SAME name (within the same list) is preserved (skipped); new bookmarks
 * are added; the SDR++ list name is preserved on the deck-rx side so a
 * round-trip of "import → save" is idempotent.
 *
 * The SDR++ config file is NOT touched — read-only. Returns counts so the
 * PI can show "imported N, skipped M" feedback.
 */
export async function importFromSdrpp(sdrPath = sdrConfigPath()): Promise<{ added: number; skipped: number; lists: number }> {
  const raw = await readFile(sdrPath, 'utf-8');
  const src = JSON.parse(raw) as PresetFile;
  const dst = await loadDeckRxPresets();
  let added = 0, skipped = 0, lists = 0;
  for (const [listName, list] of Object.entries(src.lists ?? {})) {
    const dstList = dst.lists[listName] ?? { bookmarks: {} };
    let listChanged = false;
    for (const [bmName, bm] of Object.entries(list.bookmarks ?? {})) {
      if (dstList.bookmarks[bmName]) {
        skipped++;
        continue;
      }
      dstList.bookmarks[bmName] = {
        frequency: Math.round(bm.frequency),
        bandwidth: bm.bandwidth,
        mode: bm.mode,
      };
      added++;
      listChanged = true;
    }
    if (listChanged && !dst.lists[listName]) {
      lists++;
    }
    dst.lists[listName] = dstList;
  }
  await saveDeckRxPresets(dst);
  return { added, skipped, lists };
}

export function getDeckRxPresetsPath(): string { return presetsPath(); }
export function getSdrConfigPath(): string { return sdrConfigPath(); }
