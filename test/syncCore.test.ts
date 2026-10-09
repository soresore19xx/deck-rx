// Sync rules (src/syncCore.ts): two sides and a hub, in memory. The same cases
// run against the Swift port in native-app/Tests/main.swift.

import { describe, it, expect } from 'vitest';
import {
  Base, Snapshot, SyncRecord, HubStore, emptyHub, diffLocal, hubMerge, hubSince, applyRemote,
  presetsToSnapshot, snapshotToPresets, canon, PRESETS,
} from '../src/syncCore.js';

/** One device: its files (as a snapshot), what the hub confirmed, and when
 *  its files last changed. */
class Side {
  local: Snapshot = { [PRESETS]: {} };
  base: Base = {};
  seq = 0;
  mtime = 0;
  constructor(public hub: HubStore) {}
  edit(key: string, v: Snapshot[string][string] | null, at: number): void {
    if (v === null) delete this.local[PRESETS][key]; else this.local[PRESETS][key] = v;
    this.mtime = at;
  }
  sync(online = true): boolean {
    const first = this.seq === 0 && Object.keys(this.base).length === 0;
    const recs = diffLocal(this.local, this.base, { [PRESETS]: this.mtime }, first);
    if (!online) return false;
    const rejected = hubMerge(this.hub, recs);
    const answer = hubSince(this.hub, this.seq, rejected);
    this.seq = this.hub.seq;
    applyRemote(this.local, this.base, answer);
    return true;
  }
  get presets() { return this.local[PRESETS]; }
}

const st = (f: number, m = 2) => ({ frequency: f, bandwidth: 9000, mode: m });

describe('sync', () => {
  it('first syncs fill gaps and never override; both sides end with the union', () => {
    const hub = emptyHub();
    const a = new Side(hub), b = new Side(hub);
    a.edit('General::TBS', st(954_000), 100);
    a.edit('General::QR', st(1_134_000), 100);
    b.edit('General::QR', st(1_134_000, 3), 999);    // differs, but a first sync
    b.edit('General::YBC', st(918_000), 999);
    a.sync(); b.sync(); a.sync();
    expect(a.presets).toEqual(b.presets);
    expect(Object.keys(a.presets).sort()).toEqual(['General::QR', 'General::TBS', 'General::YBC']);
    expect(a.presets['General::QR']).toEqual(st(1_134_000));   // the first one there stands
  });

  it('an edit and a deletion travel; the deleted station does not come back', () => {
    const hub = emptyHub();
    const a = new Side(hub), b = new Side(hub);
    a.edit('General::TBS', st(954_000), 100);
    a.edit('General::LF', st(1_242_000), 100);
    a.sync(); b.sync();
    a.edit('General::TBS', { ...st(954_000), bandwidth: 6000 }, 200);
    a.edit('General::LF', null, 200);
    a.sync(); b.sync(); b.sync(); a.sync();
    expect(b.presets['General::TBS']).toEqual({ ...st(954_000), bandwidth: 6000 });
    expect(b.presets['General::LF']).toBeUndefined();
    expect(a.presets['General::LF']).toBeUndefined();
  });

  it('an edit made offline goes up on the next sync that reaches the hub', () => {
    const hub = emptyHub();
    const a = new Side(hub), b = new Side(hub);
    a.edit('General::TBS', st(954_000), 100);
    a.sync(); b.sync();
    b.edit('General::NHK', st(594_000), 300);
    expect(b.sync(false)).toBe(false);
    expect(b.sync(false)).toBe(false);
    b.sync(); a.sync();
    expect(a.presets['General::NHK']).toEqual(st(594_000));
  });

  it('two sides change the same station: the newer change wins on both', () => {
    const hub = emptyHub();
    const a = new Side(hub), b = new Side(hub);
    a.edit('General::TBS', st(954_000), 100);
    a.sync(); b.sync();
    a.edit('General::TBS', { ...st(954_000), mode: 3 }, 500);
    b.edit('General::TBS', { ...st(954_000), bandwidth: 4000 }, 400);   // older
    a.sync(); b.sync(); a.sync();
    expect(b.presets['General::TBS']).toEqual({ ...st(954_000), mode: 3 });
    expect(a.presets['General::TBS']).toEqual({ ...st(954_000), mode: 3 });
    // and b is settled: nothing left to send
    expect(diffLocal(b.local, b.base, { [PRESETS]: 400 }, false)).toEqual([]);
  });

  it('a turned-down side is told what stands even when it already pulled it', () => {
    const hub = emptyHub();
    hubMerge(hub, [{ c: PRESETS, k: 'General::X', v: st(1), t: 900 }]);
    const late: SyncRecord[] = [{ c: PRESETS, k: 'General::X', v: st(2), t: 100 }];
    const rejected = hubMerge(hub, late);
    expect(rejected).toEqual([{ c: PRESETS, k: 'General::X' }]);
    expect(hubSince(hub, hub.seq, rejected)).toEqual([
      { c: PRESETS, k: 'General::X', v: st(1), t: 900, s: 1 },
    ]);
  });

  it('presets file round trip keeps other lists and their other fields', () => {
    const file = { lists: {
      General: { showOnWaterfall: true, bookmarks: { 'FM BAYFM': { frequency: 78_000_000, bandwidth: 200_000, mode: 1 } } },
      Other: { bookmarks: {} },
    } };
    const snap = presetsToSnapshot(file);
    expect(Object.keys(snap)).toEqual(['General::FM BAYFM']);
    snap['Other::SW NHK'] = { frequency: 9_750_000, bandwidth: 9000, mode: 2 };
    const back = snapshotToPresets(snap, file) as unknown as typeof file & { lists: { Other: { bookmarks: Record<string, unknown> } } };
    expect(back.lists.General.showOnWaterfall).toBe(true);
    expect(back.lists.Other.bookmarks['SW NHK']).toEqual({ frequency: 9_750_000, bandwidth: 9000, mode: 2 });
  });

  it('canon ignores key order', () => {
    expect(canon({ a: 1, b: 2 })).toBe(canon({ b: 2, a: 1 }));
  });
});
