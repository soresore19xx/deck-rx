// Render every individual dial's LCD into docs/lcd-<tag>.png for use in
// README + docs. Companion to scripts/render-combo-modes.mjs (which only
// covered the Combo dial in 6 modes, composited into a single PNG).
//
// Usage: npx tsx scripts/render-all-dials.mjs
//
// Mechanism: the dial's render path calls dumpAndB64() / dumpTuneLcd() which
// writes SVG to /tmp/deck-rx-lcd-<tag>.svg whenever /tmp/deck-rx-lcd-dump is
// touched. We touch the flag, willAppearDial each plugin under a sensible
// default config, settle, copy /tmp/<tag>.svg → docs/lcd-<tag>.png after
// rsvg-convert.

import { startPlugin } from '../test/harness/streamDeckMock.ts';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

// Strip the offline-dim wrapper added by dimSvg so the README screenshots
// show the dial in its bright "running" colour scheme rather than the
// offline grey-out (the harness has no SpyServer so connected is always
// false and dim is always on). Tune dial in particular has MULTIPLE
// `<g opacity="0.30">` wrappers (one per region — header, freq, meters)
// so element removal would mangle nesting; instead just rewrite each
// dim opacity to fully opaque.
function stripDim(svg) {
  return svg.replace(/opacity="0\.30"/g, 'opacity="1"');
}

// Each entry spawns a fresh harness with the requested config, willAppearDial
// the named plugin, then copies /tmp/deck-rx-lcd-<dumpTag>.svg.
const DIALS = [
  { uuid: 'com.hogehoge.deck-rx.dial-tune',           dumpTag: 'tune',          config: { demodMode: 1 }, label: 'tune' },
  { uuid: 'com.hogehoge.deck-rx.dial-volume',         dumpTag: 'volume',        config: { demodMode: 1 }, label: 'volume' },
  { uuid: 'com.hogehoge.deck-rx.dial-options',        dumpTag: 'options',       config: { demodMode: 1 }, label: 'options-fm' },
  { uuid: 'com.hogehoge.deck-rx.dial-am-options',     dumpTag: 'am-options',    config: { demodMode: 2 }, label: 'options-am' },
  { uuid: 'com.hogehoge.deck-rx.dial-options-combo',  dumpTag: 'options-combo', config: { demodMode: 1 }, label: 'options-combo' },
  { uuid: 'com.hogehoge.deck-rx.dial-band-select',    dumpTag: 'band-select',   config: { demodMode: 1 }, label: 'band-select' },
  { uuid: 'com.hogehoge.deck-rx.dial-options-auto',   dumpTag: 'options-auto',  config: { demodMode: 1 }, label: 'options-auto' },
  { uuid: 'com.hogehoge.deck-rx.dial-options-2col',   dumpTag: 'options-2col',  config: { demodMode: 1 }, label: 'options-2col' },
  { uuid: 'com.hogehoge.deck-rx.dial-ssb-options',    dumpTag: 'ssb-options',   config: { demodMode: 4 }, label: 'options-ssb' },
];

const CTX = 'ctx-render-all';
const DUMP_FLAG = '/tmp/deck-rx-lcd-dump';
writeFileSync(DUMP_FLAG, '');

for (const d of DIALS) {
  console.error(`>> rendering ${d.label} (uuid=${d.uuid})`);
  const harness = await startPlugin({ config: {
    enabled: true,
    host: '10.255.255.1',
    port: 1,
    audioEnabled: false,
    ...d.config,
  } });
  await harness.willAppearDial(d.uuid, CTX);
  await harness.settle(2500);
  const svgPath = `/tmp/deck-rx-lcd-${d.dumpTag}.svg`;
  if (!existsSync(svgPath)) {
    console.error(`   ✗ ${svgPath} not produced`);
    await harness.shutdown();
    continue;
  }
  const stripped = stripDim(readFileSync(svgPath, 'utf-8'));
  const strippedPath = `/tmp/deck-rx-lcd-${d.dumpTag}-bright.svg`;
  writeFileSync(strippedPath, stripped);
  const pngPath = `docs/lcd-${d.label}.png`;
  execSync(`rsvg-convert -z 2 ${strippedPath} -o ${pngPath}`);
  console.error(`   wrote ${pngPath}`);
  await harness.shutdown();
}

console.error('>> all done');
