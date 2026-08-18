import fs from 'fs';
import { dirname, join } from 'path';
import streamDeck from '@elgato/streamdeck';
import { spyService } from './spyService.js';

/**
 * Live status feed for the companion app (mac-app/, /Applications/deck-rx.app).
 *
 * Design constraints, in order of importance:
 *
 *  1. **Nothing is written unless somebody is reading.** The companion app
 *     refreshes an "alive" flag; we only write while that flag is fresh. No
 *     app running -> zero writes, zero syscalls beyond one stat per tick.
 *  2. **Prefer RAM over disk.** /Volumes/RAMDisk is a RAM-backed volume on
 *     this host, so the feed costs no SSD wear at all there. /tmp is the
 *     fallback for hosts without it (e.g. mini4).
 *  3. **No new leak surface.** One timer and one subscription, both created
 *     once at process start — never per willAppear, which is how duplicate
 *     timers and growing listener sets happen in dial code.
 *
 * Payload carries its own write accounting (`writes` / `bytesWritten`) so the
 * cost of the feed can be read straight off the feed itself.
 */

const RAMDISK = '/Volumes/RAMDisk';

function defaultDir(): string {
  try {
    if (fs.statSync(RAMDISK).isDirectory()) return RAMDISK;
  } catch { /* not mounted */ }
  return '/tmp';
}

const STATUS_PATH = process.env.DECK_RX_STATUS_PATH ?? join(defaultDir(), 'deck-rx-status.json');
const ALIVE_PATH = process.env.DECK_RX_STATUS_ALIVE ?? join(dirname(STATUS_PATH), 'deck-rx-app.alive');
const INTERVAL_MS = Number(process.env.DECK_RX_STATUS_INTERVAL_MS ?? 250);
// The app refreshes the flag every 5 s; 15 s of silence means it is gone
// (quit, crashed, or the machine slept) and we stop writing.
const ALIVE_MAX_AGE_MS = 15_000;
// Even with an unchanged payload, refresh at this interval so a reader can
// tell "feed is idle" from "feed is dead" by looking at the timestamp.
const HEARTBEAT_MS = 2_000;

let timer: ReturnType<typeof setInterval> | null = null;
let writes = 0;
let bytesWritten = 0;
let lastCore = '';
let lastWriteAt = 0;

function readerIsAlive(): boolean {
  try {
    return Date.now() - fs.statSync(ALIVE_PATH).mtimeMs < ALIVE_MAX_AGE_MS;
  } catch {
    return false;
  }
}

function tick(): void {
  if (!readerIsAlive()) return;

  const live = spyService.isEnabled() && spyService.isConnected();
  const addr = spyService.getServerAddress();
  // Meter values only mean something while the radio is actually receiving;
  // mirror the Tune dial, which blanks them when master is OFF or TCP is down.
  const core = {
    connected: spyService.isConnected(),
    enabled: spyService.isEnabled(),
    audio: spyService.isAudioRunning(),
    freqHz: spyService.currentFreq,
    mode: spyService.getDemodMode(),
    volume: spyService.getVolume(),
    muted: spyService.isMuted(),
    rssiDbfs: live ? Math.round(spyService.getRssiDbfs() * 10) / 10 : null,
    snrDb: live ? Math.round(spyService.getSnrDb() * 10) / 10 : null,
    host: addr.host,
    port: addr.port,
  };

  const coreJson = JSON.stringify(core);
  const now = Date.now();
  // Skip identical payloads: when the radio is off or the link is down the
  // values freeze, and rewriting them buys nothing.
  if (coreJson === lastCore && now - lastWriteAt < HEARTBEAT_MS) return;

  const payload = JSON.stringify({
    ...core,
    ts: now,
    seq: writes + 1,
    intervalMs: INTERVAL_MS,
    writes: writes + 1,
    bytesWritten: bytesWritten,
    path: STATUS_PATH,
  });

  try {
    // Write-then-rename so a reader never catches a half-written file.
    const tmp = `${STATUS_PATH}.tmp`;
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, STATUS_PATH);
    writes += 1;
    bytesWritten += Buffer.byteLength(payload);
    lastCore = coreJson;
    lastWriteAt = now;
  } catch (e) {
    // A broken feed must never take the radio down with it.
    streamDeck.logger.warn(`[statusFeed] write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Start the feed. Safe to call once at startup; repeat calls are ignored. */
export function startStatusFeed(): void {
  if (timer) return;
  timer = setInterval(tick, INTERVAL_MS);
  // Never hold the event loop open on our account.
  timer.unref?.();
  streamDeck.logger.info(`[statusFeed] path=${STATUS_PATH} gate=${ALIVE_PATH} interval=${INTERVAL_MS}ms`);
  process.on('exit', () => {
    try { fs.unlinkSync(STATUS_PATH); } catch { /* already gone */ }
  });
}
