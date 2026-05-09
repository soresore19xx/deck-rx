export { svgB64, dumpAndB64 } from './dialDisplay.js';

/** Wrap an SVG's contents in a low-opacity <g> when `dim` is true. Accepts
 *  either a raw SVG string or a `data:image/svg+xml;base64,…` URL (which is
 *  what most of the dial-display helpers return). Used to visually
 *  deactivate every dial panel while the master ON/OFF is OFF. */
export function dimSvg(svg: string, dim: boolean): string {
  if (!dim) return svg;
  const wrap = (s: string) => s
    .replace(/<svg([^>]*)>/, '<svg$1><g opacity="0.30">')
    .replace(/<\/svg>\s*$/, '</g></svg>');
  const prefix = 'data:image/svg+xml;base64,';
  if (svg.startsWith(prefix)) {
    const inner = Buffer.from(svg.slice(prefix.length), 'base64').toString('utf8');
    return prefix + Buffer.from(wrap(inner)).toString('base64');
  }
  return wrap(svg);
}

export function tuneSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72" width="72" height="72">
    <rect width="72" height="72" fill="#1a1a2e"/>
    <line x1="36" y1="8" x2="36" y2="40" stroke="#00cc44" stroke-width="3"/>
    <line x1="36" y1="40" x2="20" y2="56" stroke="#00cc44" stroke-width="3"/>
    <line x1="36" y1="40" x2="52" y2="56" stroke="#00cc44" stroke-width="3"/>
    <ellipse cx="36" cy="28" rx="14" ry="6" fill="none" stroke="#00cc44" stroke-width="2" opacity="0.7"/>
    <ellipse cx="36" cy="22" rx="22" ry="9" fill="none" stroke="#00cc44" stroke-width="1.5" opacity="0.4"/>
  </svg>`;
}

// Metallic dial-knob image (ATS-Mini style): toothed rim + radial gradient body
// + position indicator dot at top.
export function knobSvg(): string {
  const cx = 36, cy = 36, N = 60;
  const outerR = 34, toothH = 4, toothW = 2.2;
  const innerR = outerR - toothH;
  let teeth = '';
  for (let i = 0; i < N; i++) {
    const deg = i * 360 / N;
    const rad = deg * Math.PI / 180;
    const tx = cx + innerR * Math.sin(rad);
    const ty = cy - innerR * Math.cos(rad);
    teeth += `<rect x="${(tx - toothW / 2).toFixed(2)}" y="${(ty - toothH / 2).toFixed(2)}" width="${toothW}" height="${toothH}" rx="0.5" fill="#3a3a3a" transform="rotate(${deg.toFixed(1)},${tx.toFixed(2)},${ty.toFixed(2)})"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
<defs>
  <radialGradient id="kg" cx="38%" cy="32%" r="65%">
    <stop offset="0%" stop-color="#505050"/>
    <stop offset="60%" stop-color="#2a2a2a"/>
    <stop offset="100%" stop-color="#141414"/>
  </radialGradient>
  <radialGradient id="ks" cx="50%" cy="50%" r="50%">
    <stop offset="70%" stop-color="transparent"/>
    <stop offset="100%" stop-color="#000000" stop-opacity="0.5"/>
  </radialGradient>
</defs>
<circle cx="${cx}" cy="${cy}" r="35" fill="#0d0d0d"/>
${teeth}
<circle cx="${cx}" cy="${cy}" r="${innerR - 0.5}" fill="url(#kg)"/>
<circle cx="${cx}" cy="${cy}" r="${innerR - 0.5}" fill="url(#ks)"/>
<circle cx="${cx}" cy="13" r="2" fill="white" opacity="0.85"/>
</svg>`;
}

const BLUE = '#00aaff';

export interface OptionsPanelRow {
  label: string;
  value: string;
  /** Optional inline horizontal bar (0..100) rendered between label and value
   *  text. Used by the Volume+Status panel to show the volume level. */
  bar?: number;
  /** When bar is present, switch the fill colour to a muted/disabled tone. */
  barMuted?: boolean;
  /** Override the value-text colour (e.g. ONLINE indicator). The selected /
   *  edit-mode highlight still wins. */
  valueColor?: string;
}

export function optionsPanelSvg(rows: OptionsPanelRow[], selectedRow = -1, editMode = false, borderSide: 'left' | 'right' | 'center' | 'none' = 'none', title = ''): string {
  // Fixed compact metrics: rowH 14 / font 11/12. Used for ALL panel-style
  // dials so AM Options, FM Options and Volume+Status share identical
  // typography regardless of how many rows each happens to render.
  const SVG_H = 100;
  // Non-bar panels (Options / AM Options) use a fixed rowH and startY so the
  // top of the panel sits in the same place regardless of row count. This
  // keeps FM Options and AM Options visually aligned even when one shows a
  // mode-specific row (Gain/Stereo/etc) that the other doesn't. Bar panels
  // (Volume) keep the previous taller rowH because their layout is anchored
  // by the bar at y=91 and only has a few upper rows.
  const lastRowHasBar = typeof rows[rows.length - 1]?.bar === 'number';
  const rowH = lastRowHasBar ? 14 : 12;
  const labelFs = lastRowHasBar ? 11 : 10;
  const valueFs = lastRowHasBar ? 12 : 11;
  const bgPad = rowH - 3;
  const textH = valueFs;
  const lastBarY = SVG_H - 9;  // = 91, used only when lastRowHasBar
  // upperArea ends a few px above the bar so there's breathing room.
  const upperAreaH = lastBarY - textH - 8;
  // Optional title bar at the top — works on both non-bar (Options) and
  // bar (Volume) panels. Volume uses it to host the live HH:MM clock that
  // moved over from the Tune dial.
  const titleVisible = title.length > 0;
  const TITLE_H = titleVisible ? 12 : 0;
  let startY: number;
  if (lastRowHasBar) {
    const upperRows = rows.length - 1;
    if (upperRows > 0) {
      const upperSpan = textH + (upperRows - 1) * rowH;
      // When a title is shown, anchor the upper rows just below it so the
      // clock has a dedicated band; otherwise vertically centre between top
      // and the bar like before.
      const topMargin = titleVisible
        ? TITLE_H + 4
        : Math.max(2, Math.floor((upperAreaH - upperSpan) / 2));
      startY = topMargin + textH;
    } else {
      startY = lastBarY;
    }
  } else {
    // Top-anchored, fixed first-baseline so panels with different row counts
    // line up at the top. Vertical centring is intentionally NOT used here.
    // rowH=12 lets up to 8 rows fit (last baseline 100 - just at frame edge);
    // 7 rows leave breathing room at the bottom, 6 rows leave more.
    // When a title bar is shown, push the first row down by TITLE_H but trim
    // the +4 gap to keep 7 rows + title fitting inside the 100 px frame.
    startY = titleVisible ? TITLE_H + rowH : rowH + 4;
  }
  // Panel-wide column positions: panels containing an inline bar (Volume) keep
  // the original wide layout (label flush left, value flush right of the bar)
  // so all rows align with the bar's natural columns. Pure label/value panels
  // (Options / AM Options) pull both columns inward so label↔value gaps stay
  // tight and the focus highlight is balanced.
  const panelHasBar = rows.some(r => typeof r.bar === 'number');
  // Bar-style panels (Volume) push columns out near the frame edges to match
  // the Tune dial's S/N gauge layout (label x≈4, num right-anchor x≈196).
  // Pure label/value panels left-align labels (x=8 — past the focus side
  // bar at x=0..3) and right-anchor values inside the rounded frame.
  const panelLabelX = panelHasBar ? 4 : 8;
  const panelValueX = panelHasBar ? 196 : 120;
  const items = rows.map((row, i) => {
    const { label, value, bar: barPct, barMuted, valueColor: valueColorOverride } = row;
    // Bar row baseline is pinned (y=lastBarY=91) regardless of where the
    // upper-row stack would have placed it.
    const isBarRow = lastRowHasBar && i === rows.length - 1;
    const y = isBarRow ? lastBarY : (startY + i * rowH);
    const isSelected = i === selectedRow;
    const isEdit = isSelected && editMode;
    const accent = isEdit ? '#ffaa55' : BLUE;
    // Background:
    //   - Focused row: faint translucent grey (opacity 0.12) so the active
    //     row pops as a unit without screaming.
    //   - Non-focused even rows (zebra): even fainter grey (opacity 0.04)
    //     gives visual row separation without horizontal lines (which made
    //     the panel feel cluttered at this density).
    //   - Bar rows skip zebra so the bar visual stays clean.
    const isBarRowZebra = typeof barPct === 'number';
    let bg = '';
    if (isSelected) {
      bg = `<rect x="0" y="${y - bgPad}" width="200" height="${rowH}" fill="#ffffff" fill-opacity="0.22"/>`;
    } else if (i % 2 === 0 && !isBarRowZebra) {
      bg = `<rect x="0" y="${y - bgPad}" width="200" height="${rowH}" fill="#ffffff" fill-opacity="0.08"/>`;
    }
    const sideBar = isSelected ? `<rect x="0" y="${y - bgPad}" width="3" height="${rowH}" fill="${accent}"/>` : '';
    // Focus colours:
    //  - nav mode  : label deep yellow (#d4b800), value yellow (#ffee00)
    //  - edit mode : label orange (accent),       value yellow (#ffee00)
    // The value stays yellow in both modes so it remains visually anchored as
    // "the focused datum"; the mode (navigate vs edit) is conveyed by the
    // label colour and the left-side accent rail.
    const labelColor = isSelected ? (isEdit ? accent : '#d4b800') : 'white';
    const valueColor = isSelected ? '#aaff00' : (valueColorOverride ?? 'white');
    // Inline progress bar (Volume row). Position is intentionally NOT tied to
    // the row baseline — it's pinned to a fixed bottom y so it visually lines
    // up with the Tune dial's RSSI bar (y=85, h=6, bottom=91 in the dial
    // layout). Vol bar is 1 px thinner and shares the same bottom edge.
    let barSvg = '';
    if (typeof barPct === 'number') {
      // Bar starts at x=22 (matching the Tune dial S/N gauge start). Width
      // 140 ends at x=162 — extra clearance to value text right-anchored at
      // x=196.
      const barX = 22, barW = 140, barH = 5;
      const barY = SVG_H - barH - 9;  // bottom edge at SVG_H - 9 = 91 (matches Dial RSSI)
      // Bar covers the full 0-150 % volume range. 100 % lands at 2/3 of the
      // bar, 150 % fills it. A faint tick at the 100 % mark gives the user a
      // visual reference for "unity" vs the overdrive zone above it.
      const BAR_MAX_PCT = 150;
      const clamped = Math.max(0, Math.min(BAR_MAX_PCT, barPct));
      const filled = clamped * barW / BAR_MAX_PCT;
      const fillColor = barMuted ? '#666666' : (barPct > 100 ? '#ff7733' : '#55aaff');
      const unityX = barX + (100 / BAR_MAX_PCT) * barW;
      barSvg =
        `<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" fill="#333333" rx="1"/>` +
        (filled > 0 ? `<rect x="${barX}" y="${barY}" width="${filled.toFixed(1)}" height="${barH}" fill="${fillColor}" rx="1"/>` : '') +
        `<line x1="${unityX.toFixed(1)}" y1="${(barY - 1).toFixed(1)}" x2="${unityX.toFixed(1)}" y2="${(barY + barH + 1).toFixed(1)}" stroke="#888888" stroke-width="0.6"/>`;
    }
    // Use the panel-wide columns (decided once above based on whether the
    // panel contains any bar row). All rows in a panel align consistently.
    return `${bg}${sideBar}${barSvg}
<text x="${panelLabelX}" y="${y}" fill="${labelColor}" font-size="${labelFs}" font-family="monospace">${label}</text>
<text x="${panelValueX}" y="${y}" fill="${valueColor}" font-size="${valueFs}" font-family="monospace" text-anchor="end">${value}</text>`;
  }).join('\n');
  // Rounded grey frame around the whole panel (replaces the previous
  // borderSide-driven top/bottom/side lines). 0.5 inset keeps the 1 px stroke
  // pixel-aligned. The borderSide param is left in the signature for caller
  // compatibility but no longer drives any extra geometry.
  void borderSide;
  const C = '#888888';
  // SVG now matches the layout pixmap (200×100) so the Vol bar can land at the
  // exact same y as the Tune dial's RSSI bar without scaling. Frame bottom is
  // pulled up 1 px (height 99→98) to avoid device-edge clipping.
  const frame = `<rect x="0.5" y="0.5" width="199" height="98" rx="4" ry="4" fill="none" stroke="${C}" stroke-width="1"/>`;
  // Title bar: dial-name banner pinned to the top, divider line below it.
  // Centred horizontally so it reads as a header, not a row.
  const headerSvg = titleVisible
    ? `<text x="100" y="${TITLE_H - 2}" fill="#ffffff" font-size="${labelFs}" font-family="monospace" text-anchor="middle">${title}</text>` +
      `<line x1="2" y1="${TITLE_H + 1}" x2="198" y2="${TITLE_H + 1}" stroke="#444444" stroke-width="0.6"/>`
    : '';
  return `<svg width="200" height="${SVG_H}" xmlns="http://www.w3.org/2000/svg">
<rect width="200" height="${SVG_H}" fill="#000000"/>
${headerSvg}
${items}
${frame}
</svg>`;
}

/**
 * Side-by-side dual-column options panel for the combo dial. Each column is
 * 100 px wide with its own header (AM ▶ / FM, ▶ marks the column whose rows
 * are currently navigable), then 7 rows × 12 px. The selectedRow / editMode
 * highlight only renders inside the active column; the inactive column shows
 * read-only values (slightly dimmed so the user can see live state of the
 * other mode without confusing it for the focus target).
 */
export function optionsPanelDualSvg(
  amRows: OptionsPanelRow[],
  fmRows: OptionsPanelRow[],
  activeCol: 'AM' | 'FM',
  selectedRow = -1,
  editMode = false,
): string {
  const SVG_W = 200, SVG_H = 100;
  const COL_W = SVG_W / 2;
  const HEADER_H = 12;
  const ROW_H = 12;
  const FS = 10;
  const FRAME_C = '#888888';
  const DIVIDER_C = '#444444';
  const accent = editMode ? '#ffaa55' : BLUE;

  // Header — active column: bright white + ▶ marker; inactive: dim grey.
  const amHdr = activeCol === 'AM' ? { color: '#ffffff', text: 'AM ▶' } : { color: '#666666', text: 'AM' };
  const fmHdr = activeCol === 'FM' ? { color: '#ffffff', text: 'FM ▶' } : { color: '#666666', text: 'FM' };
  const header =
    `<text x="6" y="${HEADER_H - 2}" fill="${amHdr.color}" font-size="${FS}" font-family="monospace">${amHdr.text}</text>` +
    `<text x="${COL_W + 6}" y="${HEADER_H - 2}" fill="${fmHdr.color}" font-size="${FS}" font-family="monospace">${fmHdr.text}</text>`;

  const renderCol = (rows: OptionsPanelRow[], xOff: number, isActive: boolean): string => {
    const out: string[] = [];
    const labelX = xOff + 4;
    const valueX = xOff + COL_W - 4;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      // Baseline for row i: header band (HEADER_H) + (i+1) * ROW_H. First row
      // baseline = 12 + 12 = 24; last (i=6) = 12 + 7*12 = 96. bg rect sits
      // (rowH - 2) px above the baseline so it visually centres on the text.
      const y = HEADER_H + (i + 1) * ROW_H;
      const isSelected = isActive && i === selectedRow;
      const isEdit = isSelected && editMode;
      const bgPad = ROW_H - 2;
      let bg = '';
      if (isSelected) {
        bg = `<rect x="${xOff}" y="${y - bgPad}" width="${COL_W}" height="${ROW_H}" fill="#ffffff" fill-opacity="0.22"/>`;
      } else if (i % 2 === 0) {
        bg = `<rect x="${xOff}" y="${y - bgPad}" width="${COL_W}" height="${ROW_H}" fill="#ffffff" fill-opacity="0.06"/>`;
      }
      const sideBar = isSelected ? `<rect x="${xOff}" y="${y - bgPad}" width="3" height="${ROW_H}" fill="${accent}"/>` : '';
      // Color rules:
      //  - selected (active col): label deep yellow / orange (edit), value bright yellow
      //  - active col, not selected: white text
      //  - inactive col: light grey (#888) so values still readable but visibly secondary
      const labelColor = isSelected ? (isEdit ? accent : '#d4b800') : (isActive ? 'white' : '#888888');
      const valueColor = isSelected ? '#aaff00' : (r.valueColor ?? (isActive ? 'white' : '#888888'));
      out.push(
        `${bg}${sideBar}` +
        `<text x="${labelX}" y="${y}" fill="${labelColor}" font-size="${FS}" font-family="monospace">${r.label}</text>` +
        `<text x="${valueX}" y="${y}" fill="${valueColor}" font-size="${FS}" font-family="monospace" text-anchor="end">${r.value}</text>`,
      );
    }
    return out.join('\n');
  };

  const amCol = renderCol(amRows, 0, activeCol === 'AM');
  const fmCol = renderCol(fmRows, COL_W, activeCol === 'FM');
  const divider = `<line x1="${COL_W}" y1="${HEADER_H + 1}" x2="${COL_W}" y2="${SVG_H - 4}" stroke="${DIVIDER_C}" stroke-width="0.6"/>`;
  const headerSep = `<line x1="2" y1="${HEADER_H + 1}" x2="${SVG_W - 2}" y2="${HEADER_H + 1}" stroke="${DIVIDER_C}" stroke-width="0.6"/>`;
  const frame = `<rect x="0.5" y="0.5" width="${SVG_W - 1}" height="${SVG_H - 2}" rx="4" ry="4" fill="none" stroke="${FRAME_C}" stroke-width="1"/>`;
  return `<svg width="${SVG_W}" height="${SVG_H}" xmlns="http://www.w3.org/2000/svg">
<rect width="${SVG_W}" height="${SVG_H}" fill="#000000"/>
${header}
${headerSep}
${amCol}
${fmCol}
${divider}
${frame}
</svg>`;
}

/**
 * Side-by-side Band + mode-dependent Options panel for the unified Combo dial
 * (F-2). Left column lists 6 demod bands (WFM/NFM/AM/USB/LSB/CW) with the
 * currently-active band marked by a bullet (●); the bottom band-column row
 * (idx 6) is the Mode/Step control. Right column shows the option rows for
 * the currently-active demod mode (AM/FM/SSB shapes differ).
 *
 * selectedIdx is a single continuous cursor:
 *   0..5  → Band rows (WFM/NFM/AM/USB/LSB/CW)
 *   6     → Band-column Mode/Step row
 *   7..N  → Opts column rows 0..(N-7)
 */
/**
 * Single-column Band selector panel — full 200 px width, 6 mode rows + a
 * Mode/Step bottom row. Used by the standalone Band Select dial (案 A/B/C).
 * Active mode row gets a saturated blue tint + bright cyan side rail; cursor
 * (selected) row wins with a white tint as in the Combo dial.
 */
export function bandSelectPanelSvg(
  bandLabels: readonly string[],
  activeBandIdx: number,
  modeStepRow: OptionsPanelRow,
  selectedIdx = -1,
  editMode = false,
): string {
  const SVG_W = 200, SVG_H = 100;
  const HEADER_H = 12;
  const ROW_H = 12;
  const FS = 10;
  const FRAME_C = '#888888';
  const DIVIDER_C = '#444444';
  const ACTIVE_BG = '#0055cc';
  const ACTIVE_RAIL = '#00ddff';
  const ACTIVE_DOT = '#ffee00';
  const accent = editMode ? '#ffaa55' : BLUE;
  const TOTAL = bandLabels.length + 1;

  const header = `<text x="100" y="${HEADER_H - 2}" fill="#ffffff" font-size="${FS}" font-family="monospace" text-anchor="middle">Band</text>`;

  const renderRow = (i: number): string => {
    const y = HEADER_H + (i + 1) * ROW_H;
    const isSelected = i === selectedIdx;
    const isActive = i < bandLabels.length && i === activeBandIdx;
    const isEdit = isSelected && editMode;
    const bgPad = ROW_H - 2;
    let bg = '';
    if (isSelected) {
      bg = `<rect x="0" y="${y - bgPad}" width="${SVG_W}" height="${ROW_H}" fill="#ffffff" fill-opacity="0.22"/>`;
    } else if (isActive) {
      bg = `<rect x="0" y="${y - bgPad}" width="${SVG_W}" height="${ROW_H}" fill="${ACTIVE_BG}" fill-opacity="0.85"/>`;
    } else if (i % 2 === 0) {
      bg = `<rect x="0" y="${y - bgPad}" width="${SVG_W}" height="${ROW_H}" fill="#ffffff" fill-opacity="0.06"/>`;
    }
    const sideBar = isSelected
      ? `<rect x="0" y="${y - bgPad}" width="3" height="${ROW_H}" fill="${accent}"/>`
      : (isActive
          ? `<rect x="0" y="${y - bgPad}" width="3" height="${ROW_H}" fill="${ACTIVE_RAIL}"/>`
          : '');
    const isBandRow = i < bandLabels.length;
    const labelText = isBandRow ? bandLabels[i] : modeStepRow.label;
    const valueText = isBandRow
      ? (isActive && !isSelected ? '●' : '')
      : modeStepRow.value;
    const labelColor = isSelected ? (isEdit ? accent : '#d4b800') : (isActive ? '#ffffff' : 'white');
    const valueColor = isSelected ? '#aaff00' : (isBandRow && isActive && !isSelected ? ACTIVE_DOT : 'white');
    return `${bg}${sideBar}` +
      `<text x="6" y="${y}" fill="${labelColor}" font-size="${FS}" font-family="monospace">${labelText}</text>` +
      (valueText
        ? `<text x="${SVG_W - 6}" y="${y}" fill="${valueColor}" font-size="${FS}" font-family="monospace" text-anchor="end">${valueText}</text>`
        : '');
  };

  const rows = Array.from({ length: TOTAL }, (_, i) => renderRow(i)).join('\n');
  const headerSep = `<line x1="2" y1="${HEADER_H + 1}" x2="${SVG_W - 2}" y2="${HEADER_H + 1}" stroke="${DIVIDER_C}" stroke-width="0.6"/>`;
  const frame = `<rect x="0.5" y="0.5" width="${SVG_W - 1}" height="${SVG_H - 2}" rx="4" ry="4" fill="none" stroke="${FRAME_C}" stroke-width="1"/>`;
  return `<svg width="${SVG_W}" height="${SVG_H}" xmlns="http://www.w3.org/2000/svg">
<rect width="${SVG_W}" height="${SVG_H}" fill="#000000"/>
${header}
${headerSep}
${rows}
${frame}
</svg>`;
}

export function optionsPanelBandSvg(
  bandLabels: readonly string[],
  activeBandIdx: number,
  modeStepRow: OptionsPanelRow,
  optsRows: OptionsPanelRow[],
  selectedIdx = -1,
  editMode = false,
): string {
  const SVG_W = 200, SVG_H = 100;
  const COL_W = SVG_W / 2;
  const HEADER_H = 12;
  const ROW_H = 12;
  const FS = 10;
  const FRAME_C = '#888888';
  const DIVIDER_C = '#444444';
  const accent = editMode ? '#ffaa55' : BLUE;
  const BAND_TOTAL = bandLabels.length + 1; // 6 mode rows + Mode/Step row

  // Right column header reflects the active demod mode so the user knows
  // which mode's parameters are visible (e.g. "WFM Opts" vs "AM Opts").
  const optsHeaderText = activeBandIdx >= 0 && activeBandIdx < bandLabels.length
    ? `${bandLabels[activeBandIdx]} Opts`
    : 'Opts';
  const header =
    `<text x="6" y="${HEADER_H - 2}" fill="#ffffff" font-size="${FS}" font-family="monospace">Band</text>` +
    `<text x="${COL_W + 6}" y="${HEADER_H - 2}" fill="#ffffff" font-size="${FS}" font-family="monospace">${optsHeaderText}</text>`;

  // Active-row colour palette: a bold blue fill stands out at LCD viewing
  // distance, the bright cyan side rail catches the eye on the left, and a
  // yellow ● at the right edge gives a third independent cue. The white
  // label text reads cleanly against the saturated bg.
  const ACTIVE_BG    = '#0055cc';
  const ACTIVE_RAIL  = '#00ddff';
  const ACTIVE_DOT   = '#ffee00';
  const renderBandRow = (i: number): string => {
    const y = HEADER_H + (i + 1) * ROW_H;
    const isSelected = i === selectedIdx;
    const isActive   = i === activeBandIdx;
    const isEdit = isSelected && editMode;
    const bgPad = ROW_H - 2;
    // Layering rules for the band column:
    //   - Cursor (selected) row: bright white tint — user is mid-navigation,
    //     cursor wins.
    //   - Active demod-mode row (and not the cursor): saturated blue fill +
    //     bright cyan side rail + yellow ● at the right edge + white label.
    //     The triple cue (fill / rail / dot) reads as "live mode" at a
    //     glance even on a small LCD.
    //   - Otherwise: faint zebra alternation.
    let bg = '';
    if (isSelected) {
      bg = `<rect x="0" y="${y - bgPad}" width="${COL_W}" height="${ROW_H}" fill="#ffffff" fill-opacity="0.22"/>`;
    } else if (isActive) {
      bg = `<rect x="0" y="${y - bgPad}" width="${COL_W}" height="${ROW_H}" fill="${ACTIVE_BG}" fill-opacity="0.85"/>`;
    } else if (i % 2 === 0) {
      bg = `<rect x="0" y="${y - bgPad}" width="${COL_W}" height="${ROW_H}" fill="#ffffff" fill-opacity="0.06"/>`;
    }
    const sideBar = isSelected
      ? `<rect x="0" y="${y - bgPad}" width="3" height="${ROW_H}" fill="${accent}"/>`
      : (isActive
          ? `<rect x="0" y="${y - bgPad}" width="3" height="${ROW_H}" fill="${ACTIVE_RAIL}"/>`
          : '');
    const isBandRow = i < bandLabels.length;
    const labelText = isBandRow ? bandLabels[i] : modeStepRow.label;
    // For active band rows put a bright yellow bullet at the right edge so
    // the row also has a localised marker (in addition to the row-wide bg).
    // Mode/Step row keeps its original value text.
    const valueText = isBandRow
      ? (isActive && !isSelected ? '●' : '')
      : modeStepRow.value;
    const valueColorFinal = isBandRow && isActive && !isSelected ? ACTIVE_DOT : 'white';
    const labelColor = isSelected
      ? (isEdit ? accent : '#d4b800')
      : (isActive ? '#ffffff' : 'white');
    const valueColor = isSelected ? '#aaff00' : valueColorFinal;
    return `${bg}${sideBar}` +
      `<text x="4" y="${y}" fill="${labelColor}" font-size="${FS}" font-family="monospace">${labelText}</text>` +
      (valueText
        ? `<text x="${COL_W - 4}" y="${y}" fill="${valueColor}" font-size="${FS}" font-family="monospace" text-anchor="end">${valueText}</text>`
        : '');
  };

  const renderOptsRow = (j: number): string => {
    const r = optsRows[j];
    const y = HEADER_H + (j + 1) * ROW_H;
    const cursorIdx = BAND_TOTAL + j;
    const isSelected = cursorIdx === selectedIdx;
    const isEdit = isSelected && editMode;
    const bgPad = ROW_H - 2;
    let bg = '';
    if (isSelected) {
      bg = `<rect x="${COL_W}" y="${y - bgPad}" width="${COL_W}" height="${ROW_H}" fill="#ffffff" fill-opacity="0.22"/>`;
    } else if (j % 2 === 0) {
      bg = `<rect x="${COL_W}" y="${y - bgPad}" width="${COL_W}" height="${ROW_H}" fill="#ffffff" fill-opacity="0.06"/>`;
    }
    const sideBar = isSelected ? `<rect x="${COL_W}" y="${y - bgPad}" width="3" height="${ROW_H}" fill="${accent}"/>` : '';
    const labelColor = isSelected ? (isEdit ? accent : '#d4b800') : 'white';
    const valueColor = isSelected ? '#aaff00' : (r.valueColor ?? 'white');
    return `${bg}${sideBar}` +
      `<text x="${COL_W + 4}" y="${y}" fill="${labelColor}" font-size="${FS}" font-family="monospace">${r.label}</text>` +
      `<text x="${SVG_W - 4}" y="${y}" fill="${valueColor}" font-size="${FS}" font-family="monospace" text-anchor="end">${r.value}</text>`;
  };

  const bandPart = Array.from({ length: BAND_TOTAL }, (_, i) => renderBandRow(i)).join('\n');
  const optsPart = Array.from({ length: optsRows.length }, (_, j) => renderOptsRow(j)).join('\n');
  const headerSep = `<line x1="2" y1="${HEADER_H + 1}" x2="${SVG_W - 2}" y2="${HEADER_H + 1}" stroke="${DIVIDER_C}" stroke-width="0.6"/>`;
  const divider   = `<line x1="${COL_W}" y1="${HEADER_H + 1}" x2="${COL_W}" y2="${SVG_H - 4}" stroke="${DIVIDER_C}" stroke-width="0.6"/>`;
  const frame     = `<rect x="0.5" y="0.5" width="${SVG_W - 1}" height="${SVG_H - 2}" rx="4" ry="4" fill="none" stroke="${FRAME_C}" stroke-width="1"/>`;

  return `<svg width="${SVG_W}" height="${SVG_H}" xmlns="http://www.w3.org/2000/svg">
<rect width="${SVG_W}" height="${SVG_H}" fill="#000000"/>
${header}
${headerSep}
${bandPart}
${optsPart}
${divider}
${frame}
</svg>`;
}
