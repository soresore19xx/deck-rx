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
    // Dump-only fixup for the seg7svg-emitted clock <text>.
    // The on-device clock uses font-family="monospace" + x=svgW-4, which
    // Core Text + Menlo render correctly (verified). rsvg-convert with
    // Pango falls back to Liberation Mono, which tracks wider, so the
    // same SVG renders with the clock crowding the 7-seg digits in the
    // ~/ICON dump. Override font-family to explicitly Menlo (fc-match
    // Menlo resolves /System/Library/Fonts/Menlo.ttc on macOS, matching
    // the SDK's font) and shift the right edge by 2 px (svgW-2 = 198)
    // to give breathing room. Applied ONLY when inlining freqDisplay
    // for the dump SVG; seg7svg's output going to setFeedback is
    // unchanged.
    const fixupClockForDump = (svgBody: string): string =>
      svgBody.replace(
        /<text [^>]*>([0-9][0-9]:[0-9][0-9][^<]*)<\/text>/,
        '<text x="189" y="20" fill="#ffffff" font-size="13" font-family="Menlo" letter-spacing="-2" text-anchor="end">$1</text>',
      );
    const inlineNested = (dataUrl: string, x: number, y: number, w: number, h: number, fixupClock = false): string => {
      if (!dataUrl || !dataUrl.startsWith(PFX)) return '';
      const inner = Buffer.from(dataUrl.slice(PFX.length), 'base64').toString('utf8');
      const m = inner.match(/^\s*<svg([^>]*)>([\s\S]*)<\/svg>\s*$/);
      if (!m) return '';
      const attrs = m[1];
      const body = fixupClock ? fixupClockForDump(m[2]) : m[2];
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
      inlineNested(parts.freqDisplay, 0, 18, 200,  55, true /* fixup clock for dump */) +
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

export function seg7svg(numStr: string, unit: string, svgW: number, svgH: number, extraT = 0, scale = 1.0, clockHHMM = '', modeLabel = '', stereo = false, subDigits = ''): string {
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

  // Mode label stays pinned to the left (x = MODE_LEFT_PAD) so the
  // user's eye finds it in a constant position regardless of freq
  // length. The digit + unit cluster centres in the *remaining* width
  // (from MODE_RESERVE to svgW), so the digits shift slightly right
  // when there's a Mode label — making room for 3-char labels (NFM /
  // WFM / VFO) without colliding with the leftmost digit. Without a
  // Mode label, the cluster centres in the full svg width unchanged.
  const MODE_FS = 14;
  const MODE_GLYPH_W = 9.5;          // Pango monospace 14 pt glyph advance
  const MODE_LEFT_PAD = 2;
  const MODE_RESERVE = modeLabel
    ? MODE_LEFT_PAD + modeLabel.length * MODE_GLYPH_W + 4   // +4 px gap before digits
    : 0;
  const usableW = svgW - MODE_RESERVE;
  let cx = MODE_RESERVE + (usableW - totalW) / 2;
  const oy = (svgH - DH) / 2;
  let out = `<rect width="${svgW}" height="${svgH}" fill="#000000"/>`;
  // Top-right corner: STEREO badge (FM stereo lock) takes priority over an
  // optional clock — when both are requested only the badge renders. Coords
  // pinned to the same area the clock used so dumpTuneLcd's Pango font
  // fixup keeps aligning correctly when only the clock is shown.
  if (stereo) {
    const BADGE_W = 44, BADGE_H = 13;
    const bx = svgW - BADGE_W - 4;
    out += `<rect x="${bx}" y="3" width="${BADGE_W}" height="${BADGE_H}" rx="3" fill="none" stroke="#ff3333" stroke-width="1.2"/>` +
           `<text x="${bx + BADGE_W / 2}" y="13" font-family="monospace" font-size="9" fill="#ff3333" text-anchor="middle">STEREO</text>`;
  } else if (clockHHMM) {
    // Clock above the freqDisplay's unit text (right-aligned). On-device
    // SDK renders monospace as Menlo; the dump path (Pango → Liberation
    // Mono) needs a font fixup, applied per-copy in dumpTuneLcd.
    out += `<text x="${n(svgW - 4)}" y="20" fill="#ffffff" font-size="13" font-family="monospace" text-anchor="end">${clockHHMM}</text>`;
  }
  // Mode label is right-anchored exactly MODE_GAP px before the first
  // digit. Pango (rsvg-convert path) renders monospace wider than the
  // SDK's Menlo, so the previous left-anchored width estimate (MODE_CW)
  // let "AM"/"WFM"/"NFM" glyphs visually overlap the leftmost digit on
  // common freqs (7325 kHz AM, 80.00 MHz WFM, 145.00 MHz NFM). Pinning
  // the right edge instead removes the dependency on a glyph-width
  // guess: no overlap regardless of font, modeLabel may clip on the
  // left for the rare wide-mode + wide-freq combination (NFM + 145
  // MHz), which is preferable to digit collision.
  if (modeLabel) {
    const my = oy + DH / 2 + MODE_FS * 0.35;
    out += `<text x="${n(MODE_LEFT_PAD)}" y="${n(my)}" fill="#aaaaaa" font-size="${MODE_FS}" font-family="monospace">${modeLabel}</text>`;
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
  // Sub-kHz fractional digits for SSB / CW modes — sit just above the
  // unit text, right of the 7-seg block, so the eye reads them as a
  // continuation of the freq cluster instead of a corner ornament.
  // Same x-anchor as the unit so they line up vertically.
  if (subDigits) {
    out += `<text x="${n(cx + 4)}" y="${n(oy + 9)}" font-family="monospace" font-size="11" fill="#ffffff">.${subDigits}</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}">${out}</svg>`;
}

// CJK full-width chars (CJK punctuation/symbols, hiragana, katakana, ideographs,
// fullwidth ASCII variants) render at roughly Menlo-half-width × 1.7 in the
// `monospace` fallback chain (Core Text → Hiragino on-device, fontconfig →
// Hiragino/Noto CJK in the dump path). Plain `label.length` underestimates the
// label width and would let the STEREO badge collide with the trailing
// character (observed on "WFM ニッポン放送" before this fix). Halfwidth
// katakana (FF61–FFEF) is excluded — those render narrow.
const CJK_WIDE_RE = /[　-ヿ㐀-鿿＀-｠￠-￯]/;
function effectiveCharCount(s: string): number {
  let n = 0;
  for (const ch of s) n += CJK_WIDE_RE.test(ch) ? 1.7 : 1;
  return n;
}

export function makeHeaderSvg(label: string, stereo = false): string {
  // Adaptive header text sizing — keeps short labels at the original 14 px
  // monospace size, drops to 12 px when needed, and falls back to horizontal
  // squeeze (SVG textLength + lengthAdjust="spacingAndGlyphs") only when even
  // 12 px overflows. The STEREO badge reserves 49 px (44 + 5 gap) on the right
  // when shown, so a long FM-band station label with the stereo lock badge
  // (the worst case in practice) still fits without clipping at the LCD edge.
  const W = 200;
  const BADGE_W = 44, GAP = 5;
  const reservedForBadge = stereo ? GAP + BADGE_W : 0;
  const maxTextW = W - reservedForBadge;

  const CHAR_W_14 = 8.5;
  const CHAR_W_12 = 7.3;  // ≈ 8.5 × 12/14
  const charCount = effectiveCharCount(label);
  const naturalW14 = charCount * CHAR_W_14;

  let fontSize: number;
  let renderedTextW: number;
  let lengthAttr = '';
  if (naturalW14 <= maxTextW) {
    fontSize = 14;
    renderedTextW = naturalW14;
  } else {
    fontSize = 12;
    const naturalW12 = charCount * CHAR_W_12;
    if (naturalW12 <= maxTextW) {
      renderedTextW = naturalW12;
    } else {
      renderedTextW = maxTextW;
      lengthAttr = ` textLength="${renderedTextW.toFixed(1)}" lengthAdjust="spacingAndGlyphs"`;
    }
  }

  const groupW = renderedTextW + reservedForBadge;
  const groupStart = (W - groupW) / 2;
  const textX = (groupStart + renderedTextW / 2).toFixed(1);
  const badgeX = Math.round(groupStart + renderedTextW + GAP);
  // Baseline shifts a hair when font drops to 12 — pull y up by 1 so the
  // visual centre of the text stays roughly mid-row (16 px row height).
  const textY = fontSize === 14 ? 13 : 12;
  const badge = stereo
    ? `<rect x="${badgeX}" y="1" width="${BADGE_W}" height="13" rx="3" fill="none" stroke="#ff3333" stroke-width="1.2"/>` +
      `<text x="${badgeX + BADGE_W / 2}" y="11" font-family="monospace" font-size="9" fill="#ff3333" text-anchor="middle">STEREO</text>`
    : '';
  return svgB64(`<svg width="${W}" height="16" xmlns="http://www.w3.org/2000/svg">` +
    `<text x="${textX}" y="${textY}" font-family="monospace" font-size="${fontSize}" fill="white" text-anchor="middle"${lengthAttr}>${label}</text>` +
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

