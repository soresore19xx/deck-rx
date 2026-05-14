// Unit tests for src/actions/dialRowHelper.ts — the navigation
// abstraction the four multi-row dials (Combo, 2Col, OptionsAuto,
// BandSelect) all share since the 2026-05-14 refactor.
//
// These tests pin the bug class that motivated the refactor:
//   * row counts in totalRows() drifting from the actual row data
//   * selectedIdx wrapping at a stale constant after rows shrank
//   * longPressTimer firing after onWillDisappear
//   * Band PUSH triggering edit toggle when it should fire onShortPush
//
// Unit-test scope on purpose: the failing test mode is "did the
// helper compute the right index / call the right handler", not
// "did the SVG render correctly" — that is dial-specific and
// covered by the existing comboDial.test.ts integration tests.

import { describe, it, expect, vi } from 'vitest';
import {
  DialRow,
  DialRowState,
  clampIdx,
  dialDispose,
  dialDown,
  dialRotate,
  dialUp,
} from '../src/actions/dialRowHelper.js';

function mkRows(labels: string[], extra: Partial<DialRow> = {}): DialRow[] {
  return labels.map((label) => ({ label, value: 'v', ...extra }));
}

describe('dialRowHelper — selection navigation', () => {
  it('rotate CW advances selectedIdx by 1', async () => {
    const state = new DialRowState();
    const rows = mkRows(['a', 'b', 'c']);
    const render = vi.fn();
    await dialRotate(state, rows, 1, render);
    expect(state.selectedIdx).toBe(1);
    expect(state.focused).toBe(true);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('rotate CCW from 0 wraps to last row', async () => {
    const state = new DialRowState();
    const rows = mkRows(['a', 'b', 'c']);
    await dialRotate(state, rows, -1, () => {});
    expect(state.selectedIdx).toBe(2);
  });

  it('rotate CW past last row wraps to 0', async () => {
    const state = new DialRowState();
    state.selectedIdx = 2;
    const rows = mkRows(['a', 'b', 'c']);
    await dialRotate(state, rows, 1, () => {});
    expect(state.selectedIdx).toBe(0);
  });

  it('all rows are reachable by rotating rows.length-1 ticks (Gain row regression)', async () => {
    // Specifically pins the bug class where Combo had a hardcoded
    // total = 6 for FM, making the 7th row (Gain) unreachable.
    const labels = ['BW', 'Deemph', 'IFNR', 'HPF', 'LPF', 'Ste', 'Gain'];
    const state = new DialRowState();
    const rows = mkRows(labels);
    for (let i = 0; i < labels.length - 1; i++) {
      await dialRotate(state, rows, 1, () => {});
    }
    expect(state.selectedIdx).toBe(labels.length - 1);
    expect(rows[state.selectedIdx].label).toBe('Gain');
  });

  it('rotating rows.length ticks wraps back to 0', async () => {
    const labels = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const state = new DialRowState();
    const rows = mkRows(labels);
    for (let i = 0; i < labels.length; i++) {
      await dialRotate(state, rows, 1, () => {});
    }
    expect(state.selectedIdx).toBe(0);
  });

  it('zero-row case is a no-op (no crash, no render)', async () => {
    const state = new DialRowState();
    const render = vi.fn();
    await dialRotate(state, [], 1, render);
    expect(state.selectedIdx).toBe(0);
    expect(render).not.toHaveBeenCalled();
  });
});

describe('dialRowHelper — edit-mode dispatch', () => {
  it('edit mode routes rotate ticks to the active row onEdit, not navigation', async () => {
    const state = new DialRowState();
    state.editMode = true;
    state.selectedIdx = 1;
    const onEditA = vi.fn();
    const onEditB = vi.fn();
    const rows: DialRow[] = [
      { label: 'a', value: 'v', onEdit: onEditA },
      { label: 'b', value: 'v', onEdit: onEditB },
    ];
    await dialRotate(state, rows, 1, () => {});
    expect(onEditA).not.toHaveBeenCalled();
    expect(onEditB).toHaveBeenCalledWith(1);
    // Cursor must NOT advance while in edit mode.
    expect(state.selectedIdx).toBe(1);
  });

  it('edit mode on a row without onEdit is a no-op', async () => {
    const state = new DialRowState();
    state.editMode = true;
    const rows = mkRows(['a']);
    await expect(dialRotate(state, rows, 1, () => {})).resolves.toBeUndefined();
    expect(state.selectedIdx).toBe(0);
  });
});

describe('dialRowHelper — short PUSH vs edit toggle', () => {
  it('short PUSH on an opts row toggles edit mode (no onShortPush set)', async () => {
    const state = new DialRowState();
    const rows = mkRows(['a']);
    await dialUp(state, rows, () => {});
    expect(state.editMode).toBe(true);
    await dialUp(state, rows, () => {});
    expect(state.editMode).toBe(false);
  });

  it('short PUSH on a row with onShortPush fires the handler, NOT edit toggle', async () => {
    const state = new DialRowState();
    const onShortPush = vi.fn();
    const rows: DialRow[] = [{
      label: 'Band', value: '', skipEditToggle: true, onShortPush,
    }];
    await dialUp(state, rows, () => {});
    expect(onShortPush).toHaveBeenCalled();
    expect(state.editMode).toBe(false);
    expect(state.focused).toBe(true);            // Band PUSH should focus the row
  });

  it('skipEditToggle without onShortPush is a true no-op (Band row guard)', async () => {
    const state = new DialRowState();
    const rows: DialRow[] = [{ label: 'Band', value: '', skipEditToggle: true }];
    await dialUp(state, rows, () => {});
    expect(state.editMode).toBe(false);
  });
});

describe('dialRowHelper — long PUSH', () => {
  it('long PUSH fires onLongPush after the timer interval', async () => {
    vi.useFakeTimers();
    try {
      const state = new DialRowState();
      state.longPressMs = 100;
      const onLongPush = vi.fn();
      const rows: DialRow[] = [{ label: 'Mode/Step', value: '', onLongPush }];

      dialDown(state, rows);
      expect(onLongPush).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);
      expect(onLongPush).toHaveBeenCalled();
      expect(state.longPressFired).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('short PUSH (Up before timeout) does NOT fire onLongPush, falls through to edit toggle', async () => {
    vi.useFakeTimers();
    try {
      const state = new DialRowState();
      state.longPressMs = 1000;
      const onLongPush = vi.fn();
      const rows: DialRow[] = [{ label: 'Mode/Step', value: '', onLongPush }];

      dialDown(state, rows);
      vi.advanceTimersByTime(50);
      await dialUp(state, rows, () => {});
      expect(onLongPush).not.toHaveBeenCalled();
      expect(state.editMode).toBe(true);          // fell through to edit toggle
    } finally { vi.useRealTimers(); }
  });

  it('long PUSH fires, then short-PUSH-after eats the onShortPush slot (no double action)', async () => {
    // After a long press fires, the matching Up event must not also trigger
    // onShortPush / edit toggle. Without this guard the user gets two
    // actions (toggle preset/vfo + then toggle edit) on one press.
    vi.useFakeTimers();
    try {
      const state = new DialRowState();
      state.longPressMs = 100;
      const onLongPush = vi.fn();
      const onShortPush = vi.fn();
      const rows: DialRow[] = [{ label: 'r', value: '', onLongPush, onShortPush }];

      dialDown(state, rows);
      vi.advanceTimersByTime(150);                 // long press fires
      expect(onLongPush).toHaveBeenCalledTimes(1);
      await dialUp(state, rows, () => {});
      expect(onShortPush).not.toHaveBeenCalled();
      expect(state.editMode).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('dialDispose clears a pending long-press timer (onWillDisappear safety)', () => {
    vi.useFakeTimers();
    try {
      const state = new DialRowState();
      state.longPressMs = 100;
      const onLongPush = vi.fn();
      const rows: DialRow[] = [{ label: 'r', value: '', onLongPush }];

      dialDown(state, rows);
      dialDispose(state);
      vi.advanceTimersByTime(500);
      expect(onLongPush).not.toHaveBeenCalled();   // timer was cancelled
    } finally { vi.useRealTimers(); }
  });
});

describe('dialRowHelper — clampIdx', () => {
  it('keeps selectedIdx in [0, rowCount)', () => {
    const state = new DialRowState();
    state.selectedIdx = 5;
    clampIdx(state, 3);
    expect(state.selectedIdx).toBe(2);
  });

  it('rowCount 0 resets selectedIdx to 0', () => {
    const state = new DialRowState();
    state.selectedIdx = 7;
    clampIdx(state, 0);
    expect(state.selectedIdx).toBe(0);
  });

  it('negative selectedIdx clamps to 0', () => {
    const state = new DialRowState();
    state.selectedIdx = -1;
    clampIdx(state, 5);
    expect(state.selectedIdx).toBe(0);
  });

  it('in-range selectedIdx is unchanged', () => {
    const state = new DialRowState();
    state.selectedIdx = 2;
    clampIdx(state, 5);
    expect(state.selectedIdx).toBe(2);
  });

  it('FM (7 rows) → SSB (3 rows) clamp: cursor at FM Gain (idx 6) snaps to SSB Gain (idx 2)', () => {
    // Direct simulation of the SsbOptions bug we just fixed: mode change
    // shrinks the row set, the cursor must clamp to the new last row.
    const state = new DialRowState();
    state.selectedIdx = 6;                          // FM Gain
    clampIdx(state, 3);                             // SSB has 3 rows
    expect(state.selectedIdx).toBe(2);              // SSB Gain
  });
});
