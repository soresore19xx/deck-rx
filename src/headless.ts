/**
 * Headless entry: the receiver without the Stream Deck.
 *
 * Same core as the plugin — SpyServer client, demodulator, audio chain,
 * control endpoint, status feed — started from a plain Node process instead of
 * from `streamDeck.connect()`. This is what a native front-end (mac-app/)
 * talks to: it drives the receiver over the control endpoint and reads the
 * status feed, exactly as the companion app already does.
 *
 * Run it with the SAME Node the native modules were built against (the Stream
 * Deck app's bundled Node — see scripts/rebuild-native.sh), or naudiodon and
 * deck-rx-asrc fail to load with an ABI error.
 *
 * Only ONE of {plugin, headless} should own the receiver at a time: they would
 * otherwise both open the audio device and both answer on the control port.
 * The second one to start finds the port taken, logs it and runs without a
 * control endpoint.
 */

import fs from 'fs';
import { spyService } from './spyService.js';
import { startControlServer, stopControlServer } from './controlServer.js';
import { startStatusFeed } from './statusFeed.js';
import { startSpectrumFeed, stopSpectrumFeed } from './spectrumFeed.js';
import { log } from './log.js';

// Its own lockfile: /tmp/deck-rx.pid belongs to the plugin, and reusing it
// would make each start SIGTERM the other's process.
const PID_FILE = process.env.DECK_RX_HEADLESS_PID_FILE ?? '/tmp/deck-rx-headless.pid';
(function claimSingleInstance() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  } catch { /* no file */ }
  fs.writeFileSync(PID_FILE, String(process.pid));
  process.on('exit', () => { try { fs.unlinkSync(PID_FILE); } catch { /* already gone */ } });
})();

process.stdout.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') throw err; });
process.on('uncaughtException',  (e) => log.error(`[headless] uncaughtException: ${e}`));
process.on('unhandledRejection', (r) => log.error(`[headless] unhandledRejection: ${r}`));

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`[headless] ${signal} — shutting down`);
  // Close the endpoint, then just exit. Deliberately NOT setEnabled(false):
  // that persists master OFF to config.json, so the next start would come up
  // idle — a stop would silently reconfigure the receiver. Exiting releases
  // the SpyServer socket and the audio device anyway, which is exactly what
  // the plugin does when the Stream Deck app stops it.
  stopControlServer();
  stopSpectrumFeed();
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

startControlServer();
startStatusFeed();
startSpectrumFeed();

(async () => {
  // ready resolves once config.json is hydrated, so the enabled flag and the
  // restored frequency are known before we decide whether to bring the link up.
  await spyService.ready;
  if (!spyService.isEnabled()) {
    log.info('[headless] master OFF in config — idle, waiting for /power?toggle=1');
    return;
  }
  await spyService.connect().catch((e) => log.error(`[headless] connect failed: ${e}`));
  log.info(`[headless] running — freq=${spyService.currentFreq} mode=${spyService.getDemodMode()}`);
})();
