import http from 'http';
import { log } from './log.js';
import { spyService } from './spyService.js';
import { nextFreqForTicks, nextPresetSlot } from './tuneMath.js';
import { loadPresets } from './presetList.js';

/**
 * Local control endpoint, so an external knob can drive the receiver the way
 * the Stream Deck+ dials do.
 *
 * The current client is `knobctl` (the BRIMFORD two-tier knob daemon in
 * ~/dev/Vol): upper knob = frequency, lower knob = volume, short press =
 * mute. It fires one HTTP GET per event and never reads the response body.
 *
 * Why HTTP inside the plugin, rather than the plugin reading the knob itself:
 * node-hid here would need Input Monitoring granted to the Stream Deck app and
 * would fight knobctl over the same HID device. A command file on the RAMDisk
 * was rejected too — polling adds latency to every tick.
 *
 * Security posture: bound to 127.0.0.1, no auth. Same trust level as the
 * clip-search GUI endpoint on 8770 — anything that can reach it can already
 * run code as this user.
 */

const PORT = Number(process.env.DECK_RX_CONTROL_PORT ?? 8771);
const HOST = '127.0.0.1';

// One knob tick of the lower ring. setVolume clamps to 0..1 and quantizes to
// 1 %, so 0.02 lands on exact percentages and gives ~50 ticks end to end.
const VOLUME_STEP = 0.02;

let server: http.Server | null = null;

function num(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Apply a relative or absolute retune. Returns the freq we landed on, or null. */
function tune(params: URLSearchParams): number | null {
  const dev = spyService.getDeviceInfo();
  const hz = num(params.get('hz'));
  const ticks = num(params.get('ticks'));
  let next: number;
  if (hz !== null) {
    // Absolute: still run it through the shared math so an out-of-band freq
    // snaps to a covered band instead of parking the SDR in its dead zone.
    next = nextFreqForTicks(hz, 0, 0, dev);
  } else if (ticks !== null) {
    const base = spyService.currentFreq;
    // Nothing tuned yet (no config-restored freq, no connect seed) — there is
    // no meaningful base to step from, so drop the tick rather than guess.
    if (base <= 0) return null;
    next = nextFreqForTicks(base, ticks, spyService.getTuneStepHz(), dev);
  } else {
    return null;
  }
  // No debounce here on purpose. setFrequency already updates currentFreq
  // synchronously and debounces the wire write by 50 ms, so calling it per
  // tick keeps the LCD in step with the knob while still coalescing the
  // retunes. (The Tune dial's own extra 200 ms timer predates that internal
  // debounce and exists to defer its render, which we don't need here.)
  spyService.setFrequency(next, { smooth: true });
  // The Tune dial caches the freq inside the action, so a retune from here is
  // invisible on the LCD until something makes it re-read the service.
  spyService.notifyForceRender();
  return next;
}

/**
 * Step the preset list, the way the Tune dial's preset-mode rotate does.
 *
 * The dial keeps its slot inside the action, out of reach here, so the current
 * slot is derived from what the receiver is actually tuned to. A retune that
 * lands on a preset is reconciled back onto that slot by the Tune dial's
 * force-render listener, which keeps the two views agreeing without this
 * endpoint reaching into the action.
 *
 * Reports WHY it could not step, so the caller can answer with a status the
 * knob daemon will log. A silent 200 on "nothing to land on" hides a dead
 * control path until a human notices the knob does nothing.
 */
type PresetStep = 'ok' | 'no-presets' | 'none-receivable';

async function stepPreset(d: number): Promise<PresetStep> {
  const presets = await loadPresets(spyService.getJpActiveRegion()).catch(() => []);
  if (presets.length === 0) return 'no-presets';
  const liveMode = spyService.getDemodMode();
  const freq = spyService.currentFreq;
  // Prefer an exact freq+mode match; fall back to freq alone so a preset whose
  // stored mode has since been changed still anchors the walk. When the
  // receiver roamed off every preset (knob VFO tuning), start outside the list
  // so the first step lands on its first / last entry.
  let cur = presets.findIndex(p => p.freq === freq && p.mode === liveMode);
  if (cur < 0) cur = presets.findIndex(p => p.freq === freq);
  const from = cur >= 0 ? cur : (d > 0 ? -1 : 0);
  const next = nextPresetSlot(presets, from, d, spyService.getDeviceInfo());
  if (next === null) return 'none-receivable';
  const p = presets[next];
  // Mode first, then freq — matching the dial's preset cycle. On a mode change
  // the Tune dial's demodListener runs its own auto-jump (this call does not
  // come from the dial, so the dial's suppression window doesn't cover it);
  // the setFrequency below lands after it and the force render reconciles the
  // slot, so the receiver still ends on the preset we picked.
  if (p.mode !== liveMode) spyService.setDemodMode(p.mode);
  spyService.setFrequency(p.freq);
  spyService.notifyForceRender();
  return 'ok';
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const q = url.searchParams;
  const ok = (body = 'ok') => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(body); };
  const bad = () => { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad request'); };

  if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }

  switch (url.pathname) {
    case '/health': {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        freq: spyService.currentFreq,
        volume: spyService.getVolume(),
        muted: spyService.isMuted(),
        enabled: spyService.isEnabled(),
      }));
      return;
    }
    case '/tune': {
      const landed = tune(q);
      if (landed === null) { bad(); return; }
      ok();
      return;
    }
    case '/volume': {
      const d = num(q.get('d'));
      if (d === null) { bad(); return; }
      spyService.setVolume(spyService.getVolume() + d * VOLUME_STEP);
      ok();
      return;
    }
    case '/mute': {
      if (q.get('toggle') !== '1') { bad(); return; }
      spyService.setMuted(!spyService.isMuted());
      ok();
      return;
    }
    case '/power': {
      if (q.get('toggle') !== '1') { bad(); return; }
      // Same meaning as the Tune dial's long press: tear the SpyServer
      // connection down or bring it back up.
      spyService.toggleEnabled().catch((e) => {
        log.warn(`[controlServer] power toggle failed: ${e instanceof Error ? e.message : String(e)}`);
      });
      ok();
      return;
    }
    case '/preset': {
      // Press-and-turn on the knob. Discrete slots, so knobctl sends ±1 with
      // no acceleration; anything else is a caller bug worth surfacing.
      const d = num(q.get('d'));
      if (d !== 1 && d !== -1) { bad(); return; }
      const step = await stepPreset(d);
      if (step !== 'ok') {
        // 409: the request was well-formed, the receiver just has nowhere to
        // go. Answering 200 here would leave the knob silently dead.
        const why = step === 'no-presets'
          ? 'the preset list is empty'
          : 'no preset in the list is receivable on the connected device';
        log.warn(`[controlServer] /preset?d=${d} ignored: ${why}`);
        res.writeHead(409, { 'Content-Type': 'text/plain' });
        res.end(step);
        return;
      }
      ok();
      return;
    }
    // /step is reserved for the knob's second press-and-turn slot, which
    // knobctl still silences. Left unrouted until that lands.
    default:
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
  }
}

/** Start the control endpoint. Safe to call once at startup; repeat calls are ignored. */
export function startControlServer(): void {
  if (server) return;
  // Test-harness instances run sandboxed via DECK_RX_CONFIG_PATH. They must not
  // grab the shared port — a spawned test plugin would either collide with the
  // real receiver or, worse, answer the knob in its place. An explicit
  // DECK_RX_CONTROL_PORT opts a sandbox back in on a port of its own.
  if (process.env.DECK_RX_CONFIG_PATH && !process.env.DECK_RX_CONTROL_PORT) {
    log.info('[controlServer] sandboxed instance — control endpoint disabled');
    return;
  }
  const srv = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log.warn(`[controlServer] request failed: ${e instanceof Error ? e.message : String(e)}`);
      try { res.writeHead(500); res.end(); } catch { /* already sent */ }
    });
  });
  srv.on('error', (e: NodeJS.ErrnoException) => {
    // EADDRINUSE means another plugin instance still holds the port. The
    // single-instance guard in index.ts SIGTERMs the old process first, so
    // this is a losing race we simply sit out — the radio must keep working
    // without the knob.
    log.warn(`[controlServer] disabled: ${e.code ?? e.message}`);
    server = null;
    try { srv.close(); } catch { /* already down */ }
  });
  srv.listen(PORT, HOST, () => {
    log.info(`[controlServer] listening on ${HOST}:${PORT}`);
  });
  // Never hold the event loop open on our account.
  srv.unref?.();
  server = srv;
}

/** Stop the endpoint. Used by tests; production tears down with the process. */
export function stopControlServer(): void {
  if (!server) return;
  try { server.close(); } catch { /* already down */ }
  server = null;
}
