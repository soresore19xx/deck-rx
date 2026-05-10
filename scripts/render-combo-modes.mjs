// Render the F-2 Combo Options dial for each of the 6 demod modes
// (WFM/NFM/AM/USB/LSB/CW) using the test harness. Writes an SVG per mode
// to /tmp/combo-<label>.svg.
//
// Usage: npx tsx scripts/render-combo-modes.mjs
//
// The harness spawns a sandboxed plugin per call (with enabled=false so it
// doesn't try to reach a SpyServer), points its Tune dial at config.demod
// Mode, lets willAppearDial fire one render, and snapshots the resulting
// setFeedback payload's SVG.

import { startPlugin } from '../test/harness/streamDeckMock.ts';
import { writeFileSync } from 'fs';

const COMBO_UUID = 'com.hogehoge.deck-rx.dial-options-combo';
const CTX = 'ctx-render';

// (mode_number, label) tuples — same order as the LCD's Band column display.
const MODES = [
  [1, 'wfm'], [0, 'nfm'], [2, 'am'],
  [4, 'usb'], [5, 'cw'], [6, 'lsb'],
];

function decodeSvg(msg) {
  const v = msg?.payload?.['options-display'];
  if (typeof v !== 'string' || !v.startsWith('data:image/svg+xml;base64,')) return '';
  return Buffer.from(v.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf-8');
}

// Strip the offline-dim opacity so docs/lcd-combo-modes.png shows the bright
// running colour scheme. The harness has no SpyServer so connected is
// always false and dimSvg wraps every render in opacity="0.30"; for static
// documentation we want the same look users see when actually receiving.
function stripDim(svg) {
  return svg.replace(/opacity="0\.30"/g, 'opacity="1"');
}

for (const [mode, label] of MODES) {
  console.error(`>> rendering ${label} (mode=${mode})`);
  // enabled=true so spyService.connect() runs the demodMode hydration step
  // (it's gated behind `if (!this.enabled) return;`); host points at an
  // unroutable address so the actual TCP connect just times out without
  // touching the network. The hydration happens before the TCP attempt, so
  // the render reflects the requested mode well before the timeout fires.
  const harness = await startPlugin({ config: {
    enabled: true,
    demodMode: mode,
    host: '10.255.255.1',
    port: 1,
    audioEnabled: false,
  } });
  // Capture every setFeedback while the dial is appearing — the listener
  // fires twice on startup (default-1 init paint, then post-config-hydration
  // paint), and we want the final one.
  const cap = harness.startCapture();
  await harness.willAppearDial(COMBO_UUID, CTX);
  await harness.settle(2500);
  const fbs = cap.stop().filter(m => m?.event === 'setFeedback' && m?.context === CTX);
  const last = fbs.length > 0 ? decodeSvg(fbs[fbs.length - 1]) : '';
  console.error(`   captured ${fbs.length} setFeedback frames`);
  if (last) {
    writeFileSync(`/tmp/combo-${label}.svg`, stripDim(last));
    console.error(`   wrote /tmp/combo-${label}.svg (${last.length} chars)`);
  } else {
    console.error(`   ! no setFeedback captured for ${label}`);
  }
  await harness.shutdown();
}

// ── Legacy single-mode dials ────────────────────────────────────────────
// Render FM Options + AM Options once each so the title-bar update can be
// inspected separately. demodMode is set to the dial's "native" mode so
// the title is the simple "FM Options" / "AM Options" form.
const LEGACY = [
  { uuid: 'com.hogehoge.deck-rx.dial-options',     mode: 1, label: 'fm-options' },
  { uuid: 'com.hogehoge.deck-rx.dial-am-options',  mode: 2, label: 'am-options' },
];
for (const d of LEGACY) {
  console.error(`>> rendering ${d.label} (mode=${d.mode})`);
  const harness = await startPlugin({ config: {
    enabled: true,
    demodMode: d.mode,
    host: '10.255.255.1',
    port: 1,
    audioEnabled: false,
  } });
  const cap = harness.startCapture();
  await harness.willAppearDial(d.uuid, CTX);
  await harness.settle(2500);
  const fbs = cap.stop().filter(m => m?.event === 'setFeedback' && m?.context === CTX);
  const last = fbs.length > 0 ? decodeSvg(fbs[fbs.length - 1]) : '';
  if (last) {
    writeFileSync(`/tmp/${d.label}.svg`, stripDim(last));
    console.error(`   wrote /tmp/${d.label}.svg (${last.length} chars, ${fbs.length} frames)`);
  }
  await harness.shutdown();
}

console.error('>> all done');
