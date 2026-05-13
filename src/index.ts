import fs from 'fs';
import streamDeck from '@elgato/streamdeck';
import { spyService } from './spyService.js';
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
streamDeck.connect();

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
