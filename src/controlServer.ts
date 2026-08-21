import http from 'http';
import { log } from './log.js';
import { spyService, TUNE_STEP_VALUES } from './spyService.js';
import { nextFreqForTicks, nextPresetSlot } from './tuneMath.js';
import { loadPresets } from './presetList.js';
import { autoStationLabel } from './stationLabel.js';
import { getAudioOutputDevices } from './audioDevices.js';
import { importFromSdrpp } from './presets.js';
import { clearPresetsCache } from './presetList.js';
import { JP_REGIONS, isJpRegion } from './japanStations.js';
import { spectrumSettings, setSpectrumSettings } from './spectrumFeed.js';

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

/** Apply one option by name. Returns false for a name or value we don't know. */
async function applyOption(name: string, raw: string, asBool: boolean, asNum: number): Promise<boolean> {
  const num = Number.isFinite(asNum) ? asNum : null;
  switch (name) {
    case 'fm.bandwidth':  if (num === null) return false; await spyService.setFMOption('bandwidth', num); return true;
    case 'fm.deemphasis': if (raw !== '50us' && raw !== '75us' && raw !== 'off') return false;
                          await spyService.setFMOption('deemphasis', raw as never); return true;
    case 'fm.ifnr':       await spyService.setFMOption('ifnr', asBool); return true;
    case 'fm.highPass':   await spyService.setFMOption('highPass', asBool); return true;
    case 'fm.lowPass':    await spyService.setFMOption('lowPass', asBool); return true;
    case 'fm.stereo':     await spyService.setFMOption('stereo', asBool); return true;
    case 'am.bandwidth':  if (num === null) return false; await spyService.setAMOption('bandwidth', num); return true;
    case 'am.carrierAgc': await spyService.setAMOption('carrierAgc', asBool); return true;
    case 'am.sync':       await spyService.setAMOption('sync', asBool); return true;
    case 'am.agcAttack':  if (num === null) return false; await spyService.setAMOption('agcAttack', num); return true;
    case 'am.agcDecay':   if (num === null) return false; await spyService.setAMOption('agcDecay', num); return true;
    case 'ssb.bandwidth': if (num === null) return false; await spyService.setSSBOption('bandwidthHz', num); return true;
    case 'ssb.bfo':       if (num === null) return false; await spyService.setSSBOption('bfoPitchHz', num); return true;
    // One gain control, routed to whichever the live mode uses: the receiver
    // keeps AM and FM gain apart, and a front-end should not have to know.
    case 'gain': {
      if (num === null) return false;
      const m = spyService.getDemodMode();
      if (m === 1 || m === 0) await spyService.setFmGain(num); else await spyService.setAmGain(num);
      return true;
    }
    default: return false;
  }
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
      // `d` steps, `v` sets outright — a front-end with a volume bar needs to
      // jump to where the user clicked, which no number of relative steps can
      // express without knowing the current value first and racing it.
      const v = num(q.get('v'));
      const d = num(q.get('d'));
      if (v !== null) {
        spyService.setVolume(v);
      } else if (d !== null) {
        spyService.setVolume(spyService.getVolume() + d * VOLUME_STEP);
      } else { bad(); return; }
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
    case '/spectrum': {
      // Display settings for the spectrum feed. With no parameters it reports
      // what is in force, so a front-end can render its controls from the
      // receiver rather than from its own assumptions.
      const wanted: { fftSize?: number; fps?: number; smoothSpeed?: number } = {};
      const fft = num(q.get('fft'));
      const fps = num(q.get('fps'));
      // `smooth` is SDR++'s smoothing speed, not a raw coefficient: lower is
      // smoother, and the averaging window stays fixed in seconds as fps moves.
      const smooth = num(q.get('smooth'));
      if (q.has('fft')) { if (fft === null) { bad(); return; } wanted.fftSize = fft; }
      if (q.has('fps')) { if (fps === null) { bad(); return; } wanted.fps = fps; }
      if (q.has('smooth')) { if (smooth === null) { bad(); return; } wanted.smoothSpeed = smooth; }
      // Reports the clamped result either way, so the caller never has to guess
      // how its request was adjusted.
      const now = Object.keys(wanted).length > 0 ? setSpectrumSettings(wanted) : spectrumSettings();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(now));
      return;
    }
    case '/receiver': {
      // Settings that belong to the receiver as a whole rather than to the
      // demod: how the tune dial behaves, which JP region names stations, where
      // the audio goes, and the SDR++ bookmark import. The deck exposes these
      // across its Property Inspector; without them here a front-end can drive
      // the radio but not configure it.
      const action = q.get('action');
      if (action === 'importSdrpp') {
        const r = await importFromSdrpp().catch((e) => {
          log.warn(`[controlServer] importSdrpp failed: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        });
        if (!r) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('import failed'); return; }
        clearPresetsCache();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r));
        return;
      }
      const set = q.get('set');
      if (set !== null) {
        const raw = q.get('value');
        if (raw === null) { bad(); return; }
        switch (set) {
          case 'tuneMode':
            if (raw !== 'preset' && raw !== 'vfo') { bad(); return; }
            spyService.setTuneMode(raw);
            break;
          case 'jpRegion':
            if (!isJpRegion(raw)) { bad(); return; }
            await spyService.setJpActiveRegion(raw);
            clearPresetsCache();
            break;
          case 'autoSyncSdrpp':
            await spyService.setAutoSyncSdrpp(raw === '1' || raw === 'true');
            break;
          case 'audioEnabled':
            await spyService.updateAudioConfig({ audioEnabled: raw === '1' || raw === 'true' });
            break;
          case 'audioDevice':
            // Empty string means "system default" — the same thing the PI's
            // blank selection does.
            await spyService.updateAudioConfig({ naudiodon: { deviceName: raw } });
            break;
          case 'outputMode':
            if (raw !== 'local' && raw !== 'icecast') { bad(); return; }
            await spyService.updateAudioConfig({ ffmpeg: { mode: raw } });
            break;
          default: bad(); return;
        }
      }
      const devices = await getAudioOutputDevices().catch(() => []);
      const server = await spyService.getServerConfigPersisted().catch(() => ({ host: '', port: 0 }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        tuneMode: spyService.getTuneMode(),
        jpRegion: spyService.getJpActiveRegion(),
        regions: JP_REGIONS,
        autoSyncSdrpp: spyService.isAutoSyncSdrpp(),
        audioDevice: spyService.getAudioDeviceName(),
        audioDevices: devices.map((d) => d.name),
        audioSink: spyService.getAudioSink(),
        host: server.host,
        port: server.port,
      }));
      return;
    }
    case '/options': {
      // The demod's own settings — the panel the deck exposes across several
      // dials, in one place for a front-end. With no parameters it reports
      // everything for the live mode; `set=<name>&value=<v>` changes one.
      //
      // Names are flat and mode-scoped (fm.stereo, am.sync, ssb.bandwidth,
      // gain) rather than a nested body: a knob or a checkbox changes exactly
      // one of these, and a GET that a browser or curl can type is worth more
      // here than a tidy document.
      const set = q.get('set');
      if (set !== null) {
        const raw = q.get('value');
        if (raw === null) { bad(); return; }
        const asBool = raw === '1' || raw === 'true';
        const asNum = Number(raw);
        const ok = await applyOption(set, raw, asBool, asNum);
        if (!ok) { bad(); return; }
      }
      const fm = spyService.getFMOptions();
      const am = spyService.getAMOptions();
      const ssb = spyService.getSSBOptions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        mode: spyService.getDemodMode(),
        fm: {
          bandwidth: fm.bandwidth, deemphasis: fm.deemphasis, ifnr: fm.ifnr,
          highPass: fm.highPass, lowPass: fm.lowPass, stereo: fm.stereo,
        },
        am: {
          bandwidth: am.bandwidth, carrierAgc: am.carrierAgc,
          agcAttack: am.agcAttack, agcDecay: am.agcDecay, sync: am.sync,
        },
        ssb: { bandwidthHz: ssb.bandwidthHz, bfoPitchHz: ssb.bfoPitchHz },
        gain: { am: spyService.getAmGain(), fm: spyService.getFmGain(), max: spyService.getMaxGain() },
      }));
      return;
    }
    case '/stations': {
      // Broadcaster names for the frequencies a front-end is about to label on
      // its spectrum. Resolved HERE, through the same JP DB lookup that names
      // the station above the frequency readout, so the label on the trace and
      // the label in the header can never disagree. A preset's own name is the
      // user's bookmark text ("MW TBS"), which is not what the station is
      // called.
      const from = num(q.get('from'));
      const to = num(q.get('to'));
      const presets = await loadPresets(spyService.getJpActiveRegion()).catch(() => []);
      const region = spyService.getJpActiveRegion();
      const out = presets
        .filter(p => (from === null || p.freq >= from) && (to === null || p.freq <= to))
        .map(p => ({ freq: p.freq, name: autoStationLabel(p.freq, region) ?? p.name }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
      return;
    }
    case '/mode': {
      // Demod mode. Without this a front-end can move the receiver to an FM
      // frequency but not out of AM, which is silence rather than a station —
      // the preset lists carry a mode per entry for exactly this reason.
      const m = num(q.get('m'));
      if (m !== null) {
        if (!Number.isInteger(m) || m < 0 || m > 7) { bad(); return; }
        spyService.setDemodMode(m);
        // The Tune dial caches its own view of the receiver; the same force
        // render that keeps /tune honest applies here.
        spyService.notifyForceRender();
      } else if (q.has('m')) { bad(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mode: spyService.getDemodMode() }));
      return;
    }
    case '/step': {
      // The VFO step. Without this a front-end can only tune in whatever step
      // the deck last selected — which is how you end up unable to land on a
      // 9 kHz-spaced medium-wave channel from a 10 kHz step.
      const hz = num(q.get('hz'));
      const d = num(q.get('d'));
      if (hz !== null) {
        if (!(hz > 0)) { bad(); return; }
        spyService.setTuneStepHz(hz);
      } else if (d !== null) {
        // Cycle the same ladder the dial cycler uses, wrapping at both ends.
        const list = TUNE_STEP_VALUES;
        const cur = list.indexOf(spyService.getTuneStepHz());
        const dir = d > 0 ? 1 : -1;
        const next = (((cur < 0 ? 0 : cur) + dir) + list.length) % list.length;
        spyService.setTuneStepHz(list[next]);
      } else if (q.has('hz') || q.has('d')) { bad(); return; }
      // Report the step in force plus the ladder, so a front-end can build its
      // menu from the receiver instead of hard-coding a list that will drift.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stepHz: spyService.getTuneStepHz(), values: TUNE_STEP_VALUES }));
      return;
    }
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
