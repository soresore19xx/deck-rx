export function svgB64(svg: string): string {
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

// LCD-dump debug hook. When the user `touch`es /tmp/deck-rx-lcd-dump, every
// dialDumpAndB64() call writes the *raw* SVG (pre-base64) to
// /tmp/deck-rx-lcd-<tag>.svg so the user can grab a clean SVG of any LCD
// panel for documentation / screenshots without needing to crop a Stream
// Deck app screen capture. Removing the flag file disables the writes.
// fs is loaded lazily so the module stays usable in non-Node contexts too.
let _fs: typeof import('fs') | null = null;
function _loadFs(): typeof import('fs') {
  if (!_fs) _fs = require('fs');  // eslint-disable-line @typescript-eslint/no-require-imports
  return _fs;
}
const LCD_DUMP_FLAG = '/tmp/deck-rx-lcd-dump';
export function dumpAndB64(tag: string, svg: string): string {
  try {
    const fs = _loadFs();
    if (fs.existsSync(LCD_DUMP_FLAG)) {
      fs.writeFileSync(`/tmp/deck-rx-lcd-${tag}.svg`, svg);
    }
  } catch { /* swallow — debug aid must never crash render */ }
  return svgB64(svg);
}

/** Compose the Tune dial's full 200×100 LCD into one SVG by inlining each
 *  pixmap layer at its layouts/dial-tune.json rect as a nested <svg> element
 *  (decoded from the base64 data URL the LCD path uses). All layers and the
 *  layout's text items (S/N labels + RSSI/SNR numerics) end up in a single
 *  outer SVG so rsvg-convert rasterises everything in one pass — matching
 *  the crispness of the device LCD. (The earlier <image href="data:..."/>
 *  approach forced a per-layer SVG→bitmap step that anti-aliased twice and
 *  read as visibly soft compared to the device.) Saved to
 *  /tmp/deck-rx-lcd-tune.svg when the dump flag is present. */
export function dumpTuneLcd(parts: {
  border: string;
  header: string;
  freqDisplay: string;
  snrBar: string;
  rssiBar: string;
  snrNum: string;
  rssiNum: string;
  textColor: string;
}): void {
  try {
    const fs = _loadFs();
    if (!fs.existsSync(LCD_DUMP_FLAG)) return;
    const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Decode a data:image/svg+xml;base64,… URL and re-emit as a <g transform>
    // group rather than a nested <svg>. The nested-svg approach triggered
    // rsvg-convert's SVG 1.1 viewport clip, trimming border strokes that sit
    // right at the edge (e.g. makeBorderSvg's rect at x=0.5/x=199.5).
    // overflow="visible" was ignored. <g transform> has no viewport, so the
    // body's geometry renders without clipping at the part's intended bounds.
    const PFX = 'data:image/svg+xml;base64,';
    const inlineNested = (dataUrl: string, x: number, y: number, w: number, h: number): string => {
      if (!dataUrl || !dataUrl.startsWith(PFX)) return '';
      const inner = Buffer.from(dataUrl.slice(PFX.length), 'base64').toString('utf8');
      const m = inner.match(/^\s*<svg([^>]*)>([\s\S]*)<\/svg>\s*$/);
      if (!m) return '';
      const attrs = m[1];
      const body = m[2];
      const wm = attrs.match(/\bwidth\s*=\s*"([^"]+)"/);
      const hm = attrs.match(/\bheight\s*=\s*"([^"]+)"/);
      const ow = parseFloat(wm ? wm[1] : String(w));
      const oh = parseFloat(hm ? hm[1] : String(h));
      const sx = w / ow;
      const sy = h / oh;
      const t = (sx === 1 && sy === 1)
        ? `translate(${x} ${y})`
        : `translate(${x} ${y}) scale(${sx} ${sy})`;
      return `<g transform="${t}">${body}</g>`;
    };
    // Border is spliced into the outer SVG raw — <g transform> (even
    // translate(0,0)) shifts the 0.5-px stroke off integer pixels so the side
    // edges anti-alias to #5F5F5F vs #888888 on top/bottom. The border SVG
    // shares the outer 200×100 viewport so its body pastes in directly.
    const inlineRaw = (dataUrl: string): string => {
      if (!dataUrl || !dataUrl.startsWith(PFX)) return '';
      const inner = Buffer.from(dataUrl.slice(PFX.length), 'base64').toString('utf8');
      const m = inner.match(/^\s*<svg[^>]*>([\s\S]*)<\/svg>\s*$/);
      return m ? m[1] : '';
    };
    // rect coordinates mirror layouts/dial-tune.json. Text baselines pinned
    // near rect-bottom (y + h·0.85) for sans-serif glyphs to sit centred.
    // No viewBox on the outer <svg>: with viewBox, rsvg-convert applies the
    // SVG 1.1 overflow="hidden" viewport clip on the side edges, trimming
    // the border's 0.5-px stroke at x=0.5/x=199.5. User-unit grid maps 1:1
    // to the canvas without viewBox (matches optionsPanelSvg's outer SVG).
    //
    // Border is rendered LAST so it overlays the content. freqDisplay's
    // 200×55 black background rect (translate(0,18)) would otherwise paint
    // over the border's left/right strokes between y=18..73.
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">` +
      `<rect width="200" height="100" fill="#000"/>` +
      inlineNested(parts.header,      0,  2, 200,  16) +
      inlineNested(parts.freqDisplay, 0, 18, 200,  55) +
      inlineNested(parts.snrBar,     22, 77, 150,   6) +
      inlineNested(parts.rssiBar,    22, 85, 150,   6) +
      `<text x="11"  y="82" fill="${parts.textColor}" font-size="10" font-family="Helvetica,sans-serif" text-anchor="middle">N</text>` +
      `<text x="196" y="82" fill="${parts.textColor}" font-size="10" font-family="Helvetica,sans-serif" text-anchor="end">${xmlEsc(parts.snrNum)}</text>` +
      `<text x="11"  y="91" fill="${parts.textColor}" font-size="9"  font-family="Helvetica,sans-serif" text-anchor="middle">S</text>` +
      `<text x="196" y="91" fill="${parts.textColor}" font-size="9"  font-family="Helvetica,sans-serif" text-anchor="end">${xmlEsc(parts.rssiNum)}</text>` +
      inlineRaw(parts.border) +
      `</svg>`;
    fs.writeFileSync('/tmp/deck-rx-lcd-tune.svg', svg);
  } catch { /* swallow */ }
}

export interface FreqParts { num: string; unit: string; }

export function freqParts(hz: number): FreqParts {
  if (hz >= 30_000_000) return { num: (hz / 1_000_000).toFixed(2), unit: 'MHz' };
  if (hz >= 1_000_000)  return { num: (hz / 1_000).toFixed(0),     unit: 'kHz' };
  return { num: (hz / 1_000).toFixed(1), unit: 'kHz' };
}

export function formatFreqLabel(hz: number): string {
  const { num, unit } = freqParts(hz);
  return `${num} ${unit}`;
}

const SEGS: Record<string, string> = {
  '0': 'abcdef', '1': 'bc',     '2': 'abdeg',  '3': 'abcdg',
  '4': 'bcfg',   '5': 'acdfg',  '6': 'acdefg', '7': 'abc',
  '8': 'abcdefg','9': 'abcdfg', '.': '.',       '-': 'g',
  'A': 'abcefg', 'B': 'bcdefg', 'C': 'adef',   'F': 'aefg',
  'H': 'bcefg',  'L': 'def',    'M': 'abcef',  'V': 'bcdef',
  'W': 'bcdef',
};

export function seg7svg(numStr: string, unit: string, svgW: number, svgH: number, extraT = 0, scale = 1.0, clockHHMM = ''): string {
  const n = (v: number) => v.toFixed(1);
  const DH  = svgH * 0.65 * scale;
  const DW  = DH * 0.56;
  const T   = Math.max(3, DH * 0.10) + extraT;
  const DOT = T * 1.6;
  const CG  = 3;

  const poly = (pts: [number,number][], fill: string) =>
    `<polygon points="${pts.map(([px,py]) => `${n(px)},${n(py)}`).join(' ')}" fill="${fill}"/>`;
  const seg = (x: number, y: number, w: number, h: number, fill: string) => {
    const c = Math.min(w, h) / 2;
    return poly([[x,y],[x+w,y],[x+w,y+h-c],[x+w-c,y+h],[x+c,y+h],[x,y+h-c]], fill);
  };

  let numTotalW = 0;
  for (const c of numStr) numTotalW += (c === '.' ? DOT : DW) + CG;
  const unitSize = DH * 0.50;
  const unitW = unit.length * unitSize * 0.68;
  const totalW = numTotalW + 4 + unitW;

  let cx = (svgW - totalW) / 2;
  const oy = (svgH - DH) / 2;
  let out = `<rect width="${svgW}" height="${svgH}" fill="#000000"/>`;
  // Optional clock above the frequency unit (MHz/kHz) — small grey HH:MM
  // pinned to the right edge so it sits above the unit text without
  // competing with the 7-seg digits. Renders even in offline mode so the
  // user always has a sense of time on the dial.
  if (clockHHMM) {
    // Clock above the freqDisplay's unit text (right-aligned). Menlo is
    // a macOS system font available to both Stream Deck SDK (Core Text)
    // and rsvg-convert (fontconfig resolves Menlo.ttc) — same physical
    // font on both render paths.
    //
    // letter-spacing="-0.3" tightens the inter-glyph tracking. Pango
    // (rsvg's text layout) renders Menlo with slightly more tracking
    // than Core Text does, which made the dump's clock look stretched
    // and crowd the right edge of the 7-seg digits. Empirically, -0.3
    // pulls the dump leftmost ~10 px right (PNG x=280 -> x=260) and
    // Core Text honours it as a small cosmetic tightening that's still
    // readable on-device.
    out += `<text x="${n(svgW - 4)}" y="20" fill="#ffffff" font-size="13" font-family="Menlo,Liberation Mono,monospace" letter-spacing="-0.3" text-anchor="end">${clockHHMM}</text>`;
  }

  for (const c of numStr) {
    if (c === '.') {
      out += `<rect x="${n(cx)}" y="${n(oy+DH-DOT)}" width="${n(DOT)}" height="${n(DOT)}" fill="white" rx="1"/>`;
      cx += DOT + CG;
    } else {
      const on = SEGS[c] ?? '';
      const G = 0;
      const f = (id: string) => on.includes(id) ? 'white' : '#1e1e1e';
      out += seg(cx+T+G,  oy,             DW-2*(T+G), T,              f('a'));
      out += seg(cx+DW-T, oy+T+G,         T,          DH/2-3*T/2-2*G, f('b'));
      out += seg(cx+DW-T, oy+DH/2+T/2+G, T,          DH/2-3*T/2-2*G, f('c'));
      out += seg(cx+T+G,  oy+DH-T,       DW-2*(T+G), T,              f('d'));
      out += seg(cx,      oy+DH/2+T/2+G, T,          DH/2-3*T/2-2*G, f('e'));
      out += seg(cx,      oy+T+G,         T,          DH/2-3*T/2-2*G, f('f'));
      out += seg(cx+T+G,  oy+DH/2-T/2,   DW-2*(T+G), T,              f('g'));
      cx += DW + CG;
    }
  }

  out += `<text x="${n(cx+4)}" y="${n(oy+DH-1)}" font-family="monospace" font-size="${n(unitSize)}" fill="white">${unit}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}">${out}</svg>`;
}

export function makeHeaderSvg(label: string, stereo = false): string {
  const charW = 8.5;
  const textW = label.length * charW;
  const BADGE_W = 44, GAP = 5;
  const groupW = stereo ? textW + GAP + BADGE_W : textW;
  const groupStart = 100 - groupW / 2;
  const textX = (groupStart + textW / 2).toFixed(1);
  const badgeX = Math.round(groupStart + textW + GAP);
  const badge = stereo
    ? `<rect x="${badgeX}" y="1" width="${BADGE_W}" height="13" rx="3" fill="none" stroke="#ff3333" stroke-width="1.2"/>` +
      `<text x="${badgeX + BADGE_W / 2}" y="11" font-family="monospace" font-size="9" fill="#ff3333" text-anchor="middle">STEREO</text>`
    : '';
  return svgB64(`<svg width="200" height="16" xmlns="http://www.w3.org/2000/svg">` +
    `<text x="${textX}" y="13" font-family="monospace" font-size="14" fill="white" text-anchor="middle">${label}</text>` +
    `${badge}</svg>`);
}

// Direct port of ATS-Mini plugin's bar parameters (src/dialDisplay.ts).
const SEG_W = 4, SEG_GAP = 1, SEG_STEP = SEG_W + SEG_GAP;
const N_SEGS = 30;

/**
 * RSSI bar — green up to ~76% (S9-equivalent for our wider dynamic range), red beyond.
 * pct: 0..100 (caller maps dB to 0..100).
 */
export function rssiBandSvg(pct: number): string {
  const W = 150, H = 6;
  const filled = Math.round(Math.max(0, Math.min(100, pct)) / 100 * N_SEGS);
  const split = Math.round(10 / 17 * N_SEGS);  // 59% — matches ATS-Mini S9 boundary
  let out = `<rect width="${W}" height="${H}" fill="#111111"/>`;
  for (let i = 0; i < N_SEGS; i++) {
    const x = i * SEG_STEP;
    const color = i < filled ? (i < split ? '#00ff00' : '#ff0000') : '#2a2a2a';
    out += `<rect x="${x}" y="0" width="${SEG_W}" height="${H}" fill="${color}"/>`;
  }
  return svgB64(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${out}</svg>`);
}

/** SNR bar — all green, no split. */
export function snrBarSvg(pct: number): string {
  const W = 150, H = 6;
  const filled = Math.round(Math.max(0, Math.min(100, pct)) / 100 * N_SEGS);
  let out = `<rect width="${W}" height="${H}" fill="#111111"/>`;
  for (let i = 0; i < N_SEGS; i++) {
    const x = i * SEG_STEP;
    const color = i < filled ? '#00ff00' : '#2a2a2a';
    out += `<rect x="${x}" y="0" width="${SEG_W}" height="${H}" fill="${color}"/>`;
  }
  return svgB64(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${out}</svg>`);
}

/** ATS-Mini style horizontal volume bar (filled portion in cyan-blue). */
export function volBarSvg(pct: number, muted = false): string {
  const W = 168, H = 8;
  const clamp = Math.max(0, Math.min(100, pct));
  const fillX = Math.round(W * clamp / 100);
  const bg = `<rect width="${W}" height="${H}" fill="#333333" rx="1"/>`;
  const color = muted ? '#666666' : (pct > 100 ? '#ff7733' : '#55aaff');
  const bar = fillX > 0 ? `<rect width="${fillX}" height="${H}" fill="${color}" rx="1"/>` : '';
  return svgB64(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${bg}${bar}</svg>`);
}

export function makeBorderSvg(side: 'left' | 'right' | 'center' | 'none'): string {
  // Rounded grey frame matching optionsPanelSvg's panel border. The `side`
  // param is kept for caller compatibility but no longer changes the result —
  // every Stream Deck + LCD now wears the same R=4 frame for a uniform look.
  void side;
  const C = '#888888';
  // Bottom edge nudged up 1 px (height 99 → 98) — at h=99 the line landed at
  // y=99.5 which the device clips, leaving the frame open at the bottom.
  return svgB64(
    `<svg width="200" height="100" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="0.5" y="0.5" width="199" height="98" rx="4" ry="4" fill="none" stroke="${C}" stroke-width="1"/>` +
    `</svg>`,
  );
}

