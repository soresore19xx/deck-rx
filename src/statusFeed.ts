import fs from 'fs';
import { dirname, join } from 'path';
import { log } from './log.js';
import { spyService } from './spyService.js';
import { autoStationLabel } from './stationLabel.js';

/**
 * Live status feed for the native app (native-app/, /Applications/Deck RX.app).
 *
 * Design constraints, in order of importance:
 *
 *  1. **Nothing is written unless somebody is reading.** The native app
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
// Station lookup walks the JP table and (below 30 MHz) the EIBI schedule, so
// it is not something to run at the tick rate. Cache per frequency+region,
// with a TTL because EIBI matches on day and time of day: a schedule boundary
// must eventually change the name even while parked on one frequency.
let stationKey = '';
let stationAt = 0;
let stationName: string | null = null;
const STATION_TTL_MS = 30_000;

function station(freqHz: number): string | null {
  const region = spyService.getJpActiveRegion();
  const key = `${freqHz}/${region}`;
  const now = Date.now();
  if (key !== stationKey || now - stationAt > STATION_TTL_MS) {
    stationName = autoStationLabel(freqHz, region);
    stationKey = key;
    stationAt = now;
  }
  return stationName;
}
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
    station: station(spyService.currentFreq),
    // Demodulated bandwidth, so a front-end can draw the passband over the
    // spectrum instead of guessing it from the mode. SSB is one-sided; the
    // consumer offsets it by sideband, which is why the sign is not folded in
    // here.
    bandwidthHz: bandwidthForMode(),
    // Same condition the Tune dial's LCD uses for its badge: the pilot has to
    // be locked, the live demod has to be WFM, and the user has to have stereo
    // switched on — pilot detection keeps running in other modes, and a badge
    // lit over a mono output would be a lie.
    stereo: live
      && spyService.getStereoBadgeLock()
      && spyService.getDemodMode() === 1
      && spyService.getFMOptions().stereo,
    tuneStepHz: spyService.getTuneStepHz(),
    // Front-of-house diagnostics: what the receiver is, how wide its IQ is,
    // how hard it is decimating, whether the audio sink is losing buffers, and
    // where the audio is going. All cheap reads of state the service already
    // holds — a front-end should not have to parse the log for them.
    device: deviceLabel(),
    iqRateHz: spyService.getCurrentIQRate(),
    decStage: spyService.getDecStage(),
    audioDrops: spyService.getAudioDrops(),
    audioDevice: spyService.getAudioDeviceName(),
    audioSink: spyService.getAudioSink(),
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
    log.warn(`[statusFeed] write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Human name for the connected front-end, from the protocol's deviceType. */
function deviceLabel(): string {
  const info = spyService.getDeviceInfo();
  if (!info) return '';
  switch (info.deviceType) {
    case 1:  return 'AIRSPY R2/MINI';
    case 2:  return 'AIRSPY HF+';
    case 3:  return 'RTL-SDR';
    default: return `DEVICE ${info.deviceType}`;
  }
}

/** The bandwidth the active demod is actually using, in Hz. */
function bandwidthForMode(): number {
  switch (spyService.getDemodMode()) {
    case 1:  return spyService.getFMOptions().bandwidth;      // WFM
    case 0:  return spyService.getFMOptions().bandwidth;      // NFM
    case 2:  return spyService.getAMOptions().bandwidth;      // AM
    case 4: case 6: case 5: return spyService.getSSBOptions().bandwidthHz;
    default: return 0;
  }
}

/** Start the feed. Safe to call once at startup; repeat calls are ignored. */
export function startStatusFeed(): void {
  if (timer) return;
  // Test-harness instances run sandboxed via DECK_RX_CONFIG_PATH. They must not
  // publish to the shared path — with the native app open the gate is wide
  // open, and a spawned test plugin would overwrite the real receiver's status.
  // An explicit DECK_RX_STATUS_PATH opts a sandbox back in.
  if (process.env.DECK_RX_CONFIG_PATH && !process.env.DECK_RX_STATUS_PATH) {
    log.info('[statusFeed] sandboxed instance — feed disabled');
    return;
  }
  timer = setInterval(tick, INTERVAL_MS);
  // Never hold the event loop open on our account.
  timer.unref?.();
  log.info(`[statusFeed] path=${STATUS_PATH} gate=${ALIVE_PATH} interval=${INTERVAL_MS}ms`);
  process.on('exit', () => {
    try { fs.unlinkSync(STATUS_PATH); } catch { /* already gone */ }
  });
}
