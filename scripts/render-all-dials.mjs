// Render every individual dial's LCD into docs/lcd-<label>.png for use in
// README + docs, plus the Combo dial in all six demod modes composited into
// docs/lcd-combo-modes.png (the six renders scripts/render-combo-modes.mjs
// leaves in /tmp, which used to be composited by hand).
//
// Usage: npx tsx scripts/render-all-dials.mjs
//
// Mechanism: each dial gets a fresh sandboxed harness connected to the
// harness's mock SpyServer (so the dial draws its connected, undimmed colours
// and real gain values), appears once, settles, and the SVG of its last
// setFeedback payload is rasterised with rsvg-convert -z 2.
//
// The SVG is taken from the setFeedback payload, NOT from the
// /tmp/deck-rx-lcd-dump flag: that flag is global, so the production plugin
// would dump its own live panels into the same /tmp/deck-rx-lcd-<tag>.svg
// files while this script reads them.
//
// The Tune dial is not rendered: the harness cannot draw its body, so a
// harness lcd-tune.png would misrepresent the dial (see dial-layouts.md).

import { startPlugin } from '../test/harness/streamDeckMock.ts';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';

const OPTION_UUID = (name) => `com.hogehoge.deck-rx.${name}`;

// key = the setFeedback payload field the dial draws into.
const DIALS = [
  { uuid: OPTION_UUID('dial-volume'),        key: 'vol-display',     mode: 1, label: 'volume' },
  { uuid: OPTION_UUID('dial-options'),       key: 'options-display', mode: 1, label: 'options-fm' },
  { uuid: OPTION_UUID('dial-am-options'),    key: 'options-display', mode: 2, label: 'options-am' },
  { uuid: OPTION_UUID('dial-ssb-options'),   key: 'options-display', mode: 4, label: 'options-ssb' },
  { uuid: OPTION_UUID('dial-options-combo'), key: 'options-display', mode: 1, label: 'options-combo' },
  { uuid: OPTION_UUID('dial-band-select'),   key: 'options-display', mode: 1, label: 'band-select' },
  { uuid: OPTION_UUID('dial-options-auto'),  key: 'options-display', mode: 1, label: 'options-auto' },
  { uuid: OPTION_UUID('dial-options-2col'),  key: 'options-display', mode: 1, label: 'options-2col' },
];

// Combo dial, in the order of its Band column.
const COMBO_MODES = [[1, 'wfm'], [0, 'nfm'], [2, 'am'], [4, 'usb'], [6, 'lsb'], [5, 'cw']];

const CTX = 'ctx-render-all';
const work = mkdtempSync(join(tmpdir(), 'deck-rx-render-'));

const activeHarnesses = new Set();
const cleanup = (sig) => {
  console.error(`>> ${sig}: killing ${activeHarnesses.size} harness plugin(s)`);
  for (const h of activeHarnesses) { try { h.shutdown(); } catch {} }
  activeHarnesses.clear();
};
process.on('SIGINT',  () => { cleanup('SIGINT');  process.exit(130); });
process.on('SIGTERM', () => { cleanup('SIGTERM'); process.exit(143); });
process.on('uncaughtException', (e) => { console.error('uncaught:', e); cleanup('uncaught'); process.exit(1); });

function decodeSvg(msg, key) {
  const v = msg?.payload?.[key];
  if (typeof v !== 'string' || !v.startsWith('data:image/svg+xml;base64,')) return '';
  return Buffer.from(v.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf-8');
}

/** Appear `uuid` once on a harness in demod `mode` and return the PNG path. */
async function render(uuid, key, mode, label) {
  const harness = await startPlugin({ spyServer: true, config: {
    enabled: true, audioEnabled: false, demodMode: mode,
  } });
  activeHarnesses.add(harness);
  try {
    const cap = harness.startCapture();
    await harness.willAppearDial(uuid, CTX);
    await harness.settle(3000);
    const fbs = cap.stop().filter(m => m?.event === 'setFeedback' && m?.context === CTX && m?.payload?.[key]);
    const svg = fbs.length ? decodeSvg(fbs[fbs.length - 1], key) : '';
    if (!svg) throw new Error(`${label}: no ${key} feedback captured`);
    const svgPath = join(work, `${label}.svg`);
    const pngPath = join(work, `${label}.png`);
    writeFileSync(svgPath, svg);
    execFileSync('rsvg-convert', ['-z', '2', svgPath, '-o', pngPath]);
    console.error(`   ${label}: ${fbs.length} frames`);
    return pngPath;
  } finally {
    await harness.shutdown();
    activeHarnesses.delete(harness);
  }
}

for (const d of DIALS) {
  const png = await render(d.uuid, d.key, d.mode, d.label);
  execFileSync('cp', [png, `docs/lcd-${d.label}.png`]);
  console.error(`   wrote docs/lcd-${d.label}.png`);
}

const tiles = [];
for (const [mode, label] of COMBO_MODES) {
  tiles.push(await render(OPTION_UUID('dial-options-combo'), 'options-display', mode, `combo-${label}`));
}
execFileSync('magick', ['montage', ...tiles, '-tile', '3x2', '-geometry', '+4+4',
  '-background', 'black', 'docs/lcd-combo-modes.png']);
console.error('   wrote docs/lcd-combo-modes.png');

rmSync(work, { recursive: true, force: true });
console.error('>> all done');
