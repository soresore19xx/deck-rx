export { svgB64 } from './dialDisplay.js';

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

export function optionsPanelSvg(rows: OptionsPanelRow[], selectedRow = -1, editMode = false, borderSide: 'left' | 'right' | 'center' | 'none' = 'none'): string {
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
  let startY: number;
  if (lastRowHasBar) {
    const upperRows = rows.length - 1;
    if (upperRows > 0) {
      const upperSpan = textH + (upperRows - 1) * rowH;
      const topMargin = Math.max(2, Math.floor((upperAreaH - upperSpan) / 2));
      startY = topMargin + textH;
    } else {
      startY = lastBarY;
    }
  } else {
    // Top-anchored, fixed first-baseline so panels with different row counts
    // line up at the top. Vertical centring is intentionally NOT used here.
    // rowH=12 lets up to 8 rows fit (last baseline 100 - just at frame edge);
    // 7 rows leave breathing room at the bottom, 6 rows leave more.
    startY = rowH + 4;
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
  return `<svg width="200" height="${SVG_H}" xmlns="http://www.w3.org/2000/svg">
<rect width="200" height="${SVG_H}" fill="#000000"/>
${items}
${frame}
</svg>`;
}
