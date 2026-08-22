import fs from 'fs';
import streamDeck from '@elgato/streamdeck';
import { spyService } from './spyService.js';
import { startStatusFeed } from './statusFeed.js';
import { startControlServer } from './controlServer.js';
import { startSpectrumFeed } from './spectrumFeed.js';
import { setLogger } from './log.js';
import { importFromSdrpp } from './presets.js';
import { clearPresetsCache } from './actions/spyTune.js';
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
import { SpyDialFft } from './actions/spyDialFft.js';
import { SpyDialFftLcdx2 } from './actions/spyDialFftLcdx2.js';
import { KeyFftLcdx2Ctrl } from './actions/keyFftLcdx2.js';
import { KeyVolume } from './actions/keyVolume.js';

// Core modules log through src/log.ts so they don't depend on the SDK (the
// headless entry reuses them). Bind that seam to the Stream Deck logger before
// anything else runs, so plugin logs keep landing in the app's log files.
setLogger(streamDeck.logger);

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

// Orphan watchdog: when the parent (Stream Deck app or the integration-test
// harness) dies, macOS / Linux reparent this process to init (PID 1). We
// detect that via a parent-pid change and exit, so a stale test harness
// can't leave a zombie plugin trying to reconnect to a dead WebSocket for
// hours (2026-05-11 incident: PID 42848 lingered 12 h after render-all-
// dials.mjs was killed mid-run, polluting logs and the local SpyServer
// connection). Polled every 5 s — negligible CPU, and a 5 s detection
// window is fine for an orphan plugin nobody is talking to.
const originalPpid = process.ppid;
setInterval(() => {
  if (process.ppid !== originalPpid) {
    safeLog(`[deck-rx] parent ${originalPpid} died, reparented to ${process.ppid} — exiting orphan`);
    process.exit(0);
  }
}, 5000);

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
streamDeck.actions.registerAction(new SpyDialFft());
streamDeck.actions.registerAction(new SpyDialFftLcdx2());
streamDeck.actions.registerAction(new KeyFftLcdx2Ctrl());
streamDeck.actions.registerAction(new KeyVolume());
streamDeck.connect();

// Live status feed for the native app. Writes only while the app is
// running (it refreshes an alive-flag), so this costs nothing when nobody
// is looking. See src/statusFeed.ts.
startStatusFeed();

// Local control endpoint (127.0.0.1:8771) so an external knob can tune,
// change volume and mute the receiver. Bound to loopback, no auth; skipped
// in sandboxed harness instances. See src/controlServer.ts.
startControlServer();

// Spectrum frames for a native front-end, over a Unix socket. Computes
// nothing while no one is connected. See src/spectrumFeed.ts.
startSpectrumFeed();

// One-shot SDR++ auto-sync at startup — opt-in via PI checkbox. Waits for
// spyService.ready so we know the autoSyncSdrpp flag has been hydrated
// from config before deciding. Failures are logged but never block plugin
// startup (SDR++ may not be installed, file may be locked while SDR++ is
// running, etc.).
(async () => {
  try {
    await spyService.ready;
    if (!spyService.isAutoSyncSdrpp()) return;
    const res = await importFromSdrpp();
    clearPresetsCache();
    streamDeck.logger.info(`[deck-rx] autoSyncSdrpp added=${res.added} skipped=${res.skipped} migrated=${res.migrated} lists=${res.lists}`);
  } catch (e) {
    streamDeck.logger.warn(`[deck-rx] autoSyncSdrpp failed: ${e instanceof Error ? e.message : String(e)}`);
  }
})();
