// Shared row-navigation helper for multi-row encoder dial actions.
//
// Each multi-row dial (Combo, 2Col, OptionsAuto, BandSelect) used to roll
// its own onDialRotate / onDialDown / onDialUp / selectedIdx-clamp logic.
// That worked, but the row-count constants drifted from the actual row
// data on multiple occasions (Combo and 2Col both had a hardcoded `6`
// that didn't update when the FM Gain row got added) and the SSB-only
// dial forgot to clamp selectedIdx on mode change. The bugs all reduced
// to: "the integer driving navigation got out of sync with the rows".
//
// Fix the bug class structurally: derive everything from a single
// per-frame `DialRow[]` snapshot. Each row carries its own handlers, so
// there are no `case 0:` / `case N:` lookup tables that can fall out of
// sync. Mode changes just trigger a re-render that produces a new row
// array; clampIdx() keeps the cursor in range automatically.
//
// Each dial owns a `DialRowState` instance, calls onRotate/onDown/onUp
// from its dial event handlers, and feeds the helper a freshly-built
// `DialRow[]` on every call. Cheap — row construction is O(rows).

export interface DialRow {
  /** Left-side label (e.g., "BW", "Gain"). Rendered by the dial's
   *  optionsPanelSvg / bandSelectPanelSvg. */
  label: string;
  /** Right-side value display. */
  value: string;
  /** Optional value color (e.g., warning red, locked green). */
  valueColor?: string;
  /** Optional bar fill (0-100 typical). Used by Volume-style rows. */
  bar?: number;
  /** Optional muted-bar style hint. */
  barMuted?: boolean;
  /** Called when the dial rotates while this row is in edit mode. */
  onEdit?: (ticks: number) => void | Promise<void>;
  /** Called on short PUSH. When omitted, the default action is to toggle
   *  edit mode (the typical Opts-row behaviour). */
  onShortPush?: () => void | Promise<void>;
  /** Called when PUSH is held ≥ longPressMs. */
  onLongPush?: () => void | Promise<void>;
  /** Skip the default "toggle edit mode" behaviour on short PUSH. Used
   *  by Band rows where pressing should fire setDemodMode directly. */
  skipEditToggle?: boolean;
}

export class DialRowState {
  selectedIdx = 0;
  editMode = false;
  /** True while the user is actively interacting (rotate or press). The
   *  render code can hide the cursor when !focused so an idle dial
   *  doesn't show a stale highlight forever. */
  focused = false;
  longPressMs = 1000;
  // Internal long-press tracking.
  longPressTimer: ReturnType<typeof setTimeout> | null = null;
  longPressFired = false;
}

/** Wrap-around row navigation. ticks > 0 → next row, < 0 → previous.
 *  In edit mode, dispatches to the active row's onEdit handler instead. */
export async function dialRotate(
  state: DialRowState,
  rows: DialRow[],
  ticks: number,
  render: () => void,
): Promise<void> {
  if (rows.length === 0) return;
  if (state.editMode) {
    const row = rows[state.selectedIdx];
    if (row?.onEdit) await row.onEdit(ticks);
  } else {
    state.focused = true;
    const total = rows.length;
    state.selectedIdx = ((state.selectedIdx + (ticks > 0 ? 1 : -1)) + total) % total;
  }
  render();
}

/** Start the long-press timer. The dial's onDialDown should call this. */
export function dialDown(state: DialRowState, rows: DialRow[]): void {
  state.longPressFired = false;
  if (state.longPressTimer) clearTimeout(state.longPressTimer);
  const row = rows[state.selectedIdx];
  if (!row?.onLongPush) return;
  state.longPressTimer = setTimeout(() => {
    state.longPressTimer = null;
    state.longPressFired = true;
    void row.onLongPush!();
  }, state.longPressMs);
}

/** Short PUSH dispatch. If a long-press already fired, this is a no-op
 *  (the long-press action consumed the press). Otherwise calls the row's
 *  onShortPush, or toggles edit mode (default opts-row behaviour). */
export async function dialUp(
  state: DialRowState,
  rows: DialRow[],
  render: () => void,
): Promise<void> {
  if (state.longPressTimer) {
    clearTimeout(state.longPressTimer);
    state.longPressTimer = null;
  }
  if (state.longPressFired) {
    state.longPressFired = false;
    render();
    return;
  }
  const row = rows[state.selectedIdx];
  if (!row) return;
  if (row.onShortPush) {
    // Band PUSH / single-action PUSH (skipEditToggle rows). The old
    // hand-rolled handlers in Combo / BandSelect set focused = true here
    // so the cursor stays visible on the pressed row right after the
    // action fires (visual confirmation of which band the user
    // selected). Preserve that behaviour.
    state.focused = true;
    await row.onShortPush();
    render();
    return;
  }
  if (!row.skipEditToggle) {
    state.editMode = !state.editMode;
    state.focused = state.editMode;
    render();
  }
}

/** Cleanup — call from onWillDisappear so the long-press timer doesn't
 *  fire after the dial has been removed from the layout. */
export function dialDispose(state: DialRowState): void {
  if (state.longPressTimer) {
    clearTimeout(state.longPressTimer);
    state.longPressTimer = null;
  }
}

/** Keep selectedIdx in [0, rowCount). Call after any event that may
 *  shrink the row count (typically demod-mode change). */
export function clampIdx(state: DialRowState, rowCount: number): void {
  if (rowCount <= 0) {
    state.selectedIdx = 0;
    return;
  }
  if (state.selectedIdx >= rowCount) {
    state.selectedIdx = rowCount - 1;
  } else if (state.selectedIdx < 0) {
    state.selectedIdx = 0;
  }
}
