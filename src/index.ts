import fs from 'fs';
import streamDeck from '@elgato/streamdeck';
import { SpyTune } from './actions/spyTune.js';
import { SpyDialTune } from './actions/spyDialTune.js';
import { SpyDialOptions } from './actions/spyDialOptions.js';
import { SpyDialVolume } from './actions/spyDialVolume.js';
import { SpyDialAmOptions } from './actions/spyDialAmOptions.js';
import { SpyDialOptionsCombo } from './actions/spyDialOptionsCombo.js';
import { SpyDialBandSelect } from './actions/spyDialBandSelect.js';
import { SpyDialOptionsAuto } from './actions/spyDialOptionsAuto.js';
import { SpyDialOptions2Col } from './actions/spyDialOptions2Col.js';
import { SpyDialSsbOptions } from './actions/spyDialSsbOptions.js';

// PID_FILE defaults to /tmp/deck-rx.pid for the production plugin instance.
// Overridable via DECK_RX_PID_FILE so the integration-test harness can spawn
// a sandboxed plugin under a different lockfile without colliding with a
// running production instance.
const PID_FILE = process.env.DECK_RX_PID_FILE ?? '/tmp/deck-rx.pid';
(function claimSingleInstance() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    }
  } catch { /* no file */ }
  fs.writeFileSync(PID_FILE, String(process.pid));
  process.on('exit', () => { try { fs.unlinkSync(PID_FILE); } catch {} });
})();

// GC a stale LCD-dump flag from a previous run. dump-lcd.sh touches the
// flag right before bouncing the plugin, so a fresh mtime keeps it alive;
// anything older than 10 minutes is treated as a leftover (forgotten /
// abnormal shutdown) and removed so /tmp doesn't keep getting written on
// every render.
(function gcStaleDumpFlag() {
  const FLAG = '/tmp/deck-rx-lcd-dump';
  try {
    const ageMs = Date.now() - fs.statSync(FLAG).mtimeMs;
    if (ageMs > 10 * 60 * 1000) fs.unlinkSync(FLAG);
  } catch { /* no flag → nothing to GC */ }
})();

process.stdout.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') throw err; });
const safeLog = (msg: string) => { try { process.stderr.write(msg + '\n'); } catch {} };
process.on('uncaughtException', (err) => { safeLog(`[deck-rx] uncaughtException: ${err}`); });
process.on('unhandledRejection', (r)  => { safeLog(`[deck-rx] unhandledRejection: ${r}`); });

streamDeck.actions.registerAction(new SpyTune());
streamDeck.actions.registerAction(new SpyDialTune());
streamDeck.actions.registerAction(new SpyDialOptions());
streamDeck.actions.registerAction(new SpyDialVolume());
streamDeck.actions.registerAction(new SpyDialAmOptions());
streamDeck.actions.registerAction(new SpyDialOptionsCombo());
streamDeck.actions.registerAction(new SpyDialBandSelect());
streamDeck.actions.registerAction(new SpyDialOptionsAuto());
streamDeck.actions.registerAction(new SpyDialOptions2Col());
streamDeck.actions.registerAction(new SpyDialSsbOptions());
streamDeck.connect();
