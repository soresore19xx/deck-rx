// Stream Deck mock harness — spawns the production plugin entry under
// sandboxed env vars (PID file / config / jp-stations path) and stands in
// for the Stream Deck app at the WebSocket protocol level so tests can:
//   - assert that registration completes
//   - inject fake events (dialRotate / didReceiveSettings / sendToPlugin / …)
//   - capture every outbound message from the plugin (setImage / setFeedback /
//     setSettings / sendToPropertyInspector / …) and assert against them
//
// Stream Deck plugin protocol (per docs.elgato.com/streamdeck/sdk/references):
//   plugin is the WS *client*. Stream Deck app gives it `-port`, `-pluginUUID`,
//   `-registerEvent`, `-info` on the command line. Plugin connects to
//   ws://127.0.0.1:<port>, then sends `{ event, uuid }` to register.
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import net from 'net';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { WebSocketServer, type WebSocket } from 'ws';

const PROJECT_ROOT  = resolve(__dirname, '..', '..');
const PLUGIN_ROOT   = resolve(PROJECT_ROOT, 'com.hogehoge.deck-rx.sdPlugin');
const PLUGIN_ENTRY  = resolve(PLUGIN_ROOT, 'bin', 'index.js');
const JP_STATIONS   = resolve(PLUGIN_ROOT, 'data', 'jp-stations.json');

export interface MockSDInfo {
  application: { language: string; platform: string; platformVersion: string; version: string };
  plugin: { uuid: string; version: string };
  devicePixelRatio: number;
  devices: unknown[];
  colors: Record<string, string>;
}

export interface MockHarness {
  /** WebSocket connection from the spawned plugin (ws library Server-side). */
  client: WebSocket;
  /** Plugin child process. */
  plugin: ChildProcess;
  /** UUID assigned to this plugin instance for registration. */
  pluginUUID: string;
  /** Send a JSON event to the plugin (the plugin sees it as an SD-app message). */
  send(event: object): void;
  /** Wait for the next message from the plugin matching the predicate. */
  awaitMessage<T = unknown>(pred: (msg: unknown) => boolean, timeoutMs?: number): Promise<T>;
  /** Capture every message from the plugin from `start` onward into an array — useful for
   *  assertions that need to inspect the sequence (mute → setFeedback → setImage etc). */
  startCapture(): { stop(): unknown[] };
  /** Tear down: kill plugin, close server, await both. */
  shutdown(): Promise<void>;

  /** Helper: dispatch willAppear for an Encoder action and wait for the
   *  initial setFeedback/setImage so the test can proceed knowing the
   *  action is fully rendered. */
  willAppearDial(uuid: string, context: string, settings?: Record<string, unknown>): Promise<void>;
  /** Helper: synthetic dialRotate (Encoder rotate). `ticks` > 0 = CW, < 0 = CCW. */
  dialRotate(uuid: string, context: string, ticks: number, pressed?: boolean): void;
  /** Helper: synthetic dialDown (Encoder push down). Always paired with dialUp. */
  dialDown(uuid: string, context: string): void;
  /** Helper: synthetic dialUp (Encoder push release). Pair with dialDown. */
  dialUp(uuid: string, context: string): void;
  /** Helper: tells the SDK that the Property Inspector is now visible for
   *  the given action context. The SDK gates sendToPropertyInspector on
   *  this — without it, plugin replies to sendToPlugin events will be
   *  silently dropped by the SDK's UI service. */
  showPropertyInspector(uuid: string, context: string): void;
  /** Helper: PI sendToPlugin payload (for getJpRegion / setTuneMode / etc.) */
  sendToPlugin(uuid: string, context: string, payload: Record<string, unknown>): void;
  /** Helper: short delay so the plugin's async handlers settle before the next event. */
  settle(ms?: number): Promise<void>;

  /** Path of the sandboxed config.json the plugin reads AND persists to —
   *  tests can re-read it to assert on debounced persistFields writes
   *  (lastFrequency / demodMode / ...). */
  configPath: string;
  /** SET_SETTING commands received by the mock SpyServer (empty and never
   *  populated unless startPlugin was given `spyServer`). Live array —
   *  read it after a settle. setting 101 = IQ_FREQUENCY. */
  spySettings: Array<{ setting: number; value: number }>;
}

export interface StartPluginOptions {
  /** If true, dump plugin stdout / stderr to the test runner's console for
   *  debugging. Default false (silent). */
  verbose?: boolean;
  /** Initial config.json contents. Defaults to enabled=false so the plugin
   *  does NOT try to reach a SpyServer during the test. */
  config?: Record<string, unknown>;
  /** Optional override for DECK_RX_PRESETS_PATH (deck-rx-owned preset
   *  store). Tests that exercise the SDR++ Import flow point this at a
   *  sandbox file so they observe the import side-effect without touching
   *  the production data dir. */
  presetsPath?: string;
  /** Optional override for DECK_RX_SDR_CONFIG_PATH (SDR++ source file the
   *  Import button reads from). */
  sdrConfigPath?: string;
  /** Start a mock SpyServer and point the plugin's config host/port at it.
   *  The mock completes the handshake (DEVICE_INFO — default Airspy HF+,
   *  deviceType 2, so the 31–60 MHz hardware-gap logic is exercised), feeds
   *  the client's 5 s rx watchdog with periodic CLIENT_SYNC frames, and
   *  records every SET_SETTING command into harness.spySettings. Needed by
   *  any test that asserts on connect-time behaviour (connectListeners only
   *  fire after a successful handshake). */
  spyServer?: boolean | { deviceType?: number };
  /** Port for the plugin's control endpoint (src/controlServer.ts). Sandboxed
   *  instances keep it disabled unless a test asks for one, so a test plugin
   *  never answers the external knob in the production instance's place. */
  controlPort?: number;
  /** Socket path for the plugin's spectrum feed. Sandboxed instances keep it
   *  disabled unless a test asks for one, so a test plugin never serves frames
   *  on the path the native front-end is watching. */
  spectrumSocket?: string;
}

const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  port: 8888,
  enabled: false,         // master OFF — no SpyClient.connect
  audioEnabled: false,    // no audio sink spawn
  demodMode: 1,
  jpRegion: 'kanto',
};

export async function startPlugin(opts: StartPluginOptions = {}): Promise<MockHarness> {
  const pluginUUID = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const registerEvent = 'registerPlugin';
  // Stream Deck +  has type 7 (4 columns × 2 rows + encoder dials).
  // Tests address this single device with id 'dev-test-sdplus' — actions
  // dispatched on a device id NOT present in the info payload trigger an
  // "Failed to initialize action; device <id> not found" error inside the
  // SDK's ActionContext, so the device must be declared up-front.
  const info: MockSDInfo = {
    application: { language: 'en', platform: 'mac', platformVersion: '14.0', version: '6.0.0' },
    plugin: { uuid: 'com.hogehoge.deck-rx', version: '0.1.0' },
    devicePixelRatio: 2,
    devices: [
      { id: 'dev-test-sdplus', name: 'Test Stream Deck +', size: { columns: 4, rows: 2 }, type: 7 },
    ],
    colors: {},
  };

  // Random free port (ws choses one when port: 0)
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(res => wss.once('listening', () => res()));
  const port = (wss.address() as { port: number }).port;

  // Optional mock SpyServer — SpyServer protocol is trivial for our needs:
  // the client sends 8-byte-header commands (HELLO / SET_SETTING); the
  // server only has to answer with one DEVICE_INFO message (20-byte header
  // + 48-byte body) for spyService's waitForDeviceInfo → handshake →
  // connectListeners to run. Periodic CLIENT_SYNC frames keep the client's
  // 5 s no-rx watchdog from declaring the link dead mid-test.
  const spySettings: Array<{ setting: number; value: number }> = [];
  let spyServer: net.Server | null = null;
  let spyPort = 0;
  if (opts.spyServer) {
    const devOpts = typeof opts.spyServer === 'object' ? opts.spyServer : {};
    const deviceType = devOpts.deviceType ?? 2; // Airspy HF+
    // Last freq the plugin asked for, echoed back in CLIENT_SYNC frames.
    let tunedFreq = 0;
    spyServer = net.createServer((sock) => {
      sock.on('error', () => {});
      let buf = Buffer.alloc(0);
      sock.on('data', (c: Buffer) => {
        buf = Buffer.concat([buf, c]);
        while (buf.length >= 8) {
          const cmd = buf.readUInt32LE(0);
          const len = buf.readUInt32LE(4);
          if (buf.length < 8 + len) break;
          const body = buf.subarray(8, 8 + len);
          buf = buf.subarray(8 + len);
          if (cmd === 2 && len >= 8) {  // CMD_SET_SETTING
            const setting = body.readUInt32LE(0), value = body.readUInt32LE(4);
            spySettings.push({ setting, value });
            // A real SpyServer echoes the tuned freq back in every CLIENT_SYNC.
            // Reporting 0 forever (the original mock) made the Tune dial's vfo
            // syncListener zero its own freq once a second.
            if (setting === 101) tunedFreq = value;
          }
        }
      });
      // Message header: ProtocolID | MessageType | StreamType | Sequence | BodySize
      const devBody = Buffer.alloc(48);
      devBody.writeUInt32LE(deviceType,   0);   // deviceType
      devBody.writeUInt32LE(0,            4);   // deviceSerial
      devBody.writeUInt32LE(912_000,      8);   // maxSampleRate
      devBody.writeUInt32LE(768_000,     12);   // maxBandwidth
      devBody.writeUInt32LE(8,           16);   // decimationStages
      devBody.writeUInt32LE(0,           20);   // gainStages
      devBody.writeUInt32LE(8,           24);   // maxGainIndex
      devBody.writeUInt32LE(500_000,     28);   // minFrequency
      devBody.writeUInt32LE(260_000_000, 32);   // maxFrequency
      devBody.writeUInt32LE(16,          36);   // resolution
      devBody.writeUInt32LE(1,           40);   // minIQDecimation
      devBody.writeUInt32LE(0,           44);   // forcedIQFormat
      const devHdr = Buffer.alloc(20);
      devHdr.writeUInt32LE(0,  4);              // MSG_DEVICE_INFO
      devHdr.writeUInt32LE(48, 16);
      sock.write(Buffer.concat([devHdr, devBody]));
      const syncTimer = setInterval(() => {
        if (sock.destroyed) return;
        const syncBody = Buffer.alloc(36);
        syncBody.writeUInt32LE(1, 0);           // canControl
        syncBody.writeUInt32LE(tunedFreq,  8);  // deviceCenterFreq
        syncBody.writeUInt32LE(tunedFreq, 12);  // iqCenterFreq
        syncBody.writeUInt32LE(500_000,   20);  // minIQCenterFreq
        syncBody.writeUInt32LE(260_000_000, 24); // maxIQCenterFreq
        const syncHdr = Buffer.alloc(20);
        syncHdr.writeUInt32LE(1,  4);           // MSG_CLIENT_SYNC
        syncHdr.writeUInt32LE(36, 16);
        sock.write(Buffer.concat([syncHdr, syncBody]));
      }, 1000);
      sock.on('close', () => clearInterval(syncTimer));
    });
    await new Promise<void>(res => spyServer!.listen(0, '127.0.0.1', () => res()));
    spyPort = (spyServer.address() as net.AddressInfo).port;
  }

  // Sandbox dir for PID + config so we don't collide with the production instance
  const sandboxDir = mkdtempSync(resolve(tmpdir(), 'deck-rx-test-'));
  const configPath = resolve(sandboxDir, 'config.json');
  const cfgOverrides: Record<string, unknown> = { ...(opts.config ?? {}) };
  if (spyServer) { cfgOverrides.host = '127.0.0.1'; cfgOverrides.port = spyPort; }
  writeFileSync(configPath, JSON.stringify({ ...DEFAULT_CONFIG, ...cfgOverrides }, null, 2));

  // Plugin spawn
  const env: Record<string, string | undefined> = {
    ...process.env,
    DECK_RX_PID_FILE:           resolve(sandboxDir, 'deck-rx.pid'),
    DECK_RX_CONFIG_PATH:        configPath,
    DECK_RX_JP_STATIONS_PATH:   JP_STATIONS,
  };
  if (opts.presetsPath)   env.DECK_RX_PRESETS_PATH    = opts.presetsPath;
  if (opts.sdrConfigPath) env.DECK_RX_SDR_CONFIG_PATH = opts.sdrConfigPath;
  if (opts.controlPort)   env.DECK_RX_CONTROL_PORT   = String(opts.controlPort);
  if (opts.spectrumSocket) env.DECK_RX_SPECTRUM_SOCKET = opts.spectrumSocket;
  const plugin = spawn('node', [
    PLUGIN_ENTRY,
    '-port',          String(port),
    '-pluginUUID',    pluginUUID,
    '-registerEvent', registerEvent,
    '-info',          JSON.stringify(info),
  ], {
    stdio: 'pipe',
    env,
    // The Stream Deck SDK reads manifest.json relative to cwd; running from
    // the .sdPlugin root mirrors how Stream Deck app launches the plugin.
    cwd: PLUGIN_ROOT,
  });

  if (opts.verbose) {
    plugin.stdout?.on('data', d => process.stderr.write(`[plugin stdout] ${d}`));
    plugin.stderr?.on('data', d => process.stderr.write(`[plugin stderr] ${d}`));
  }

  // Wait for the plugin's WS connection + register handshake.
  //
  // 5 s was tight even one at a time on a loaded machine. The real fix for
  // the failures was fileParallelism: false in vitest.config.ts; this is
  // headroom, overridable so a slower machine needs no edit here.
  const startupMs = Number(process.env.DECK_RX_TEST_STARTUP_MS ?? 10000);
  const client = await new Promise<WebSocket>((res, rej) => {
    const timer = setTimeout(() => {
      wss.close();
      plugin.kill();
      rej(new Error(`timeout: plugin did not connect / register within ${startupMs} ms`));
    }, startupMs);
    wss.once('connection', (sock) => {
      sock.once('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.event === registerEvent && msg.uuid === pluginUUID) {
          clearTimeout(timer);
          res(sock);
        } else {
          clearTimeout(timer);
          rej(new Error(`unexpected registration message: ${JSON.stringify(msg)}`));
        }
      });
    });
  });

  // Subsequent messages collected for awaitMessage / startCapture consumers.
  const inbox: unknown[] = [];
  const waiters: Array<{ pred: (m: unknown) => boolean; resolve: (m: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
  const captures: Set<unknown[]> = new Set();
  client.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (opts.verbose) {
      const summary = (msg as { event?: string }).event ?? 'unknown';
      process.stderr.write(`[harness recv] ${summary} ${data.toString().slice(0, 120)}\n`);
    }
    for (const cap of captures) cap.push(msg);
    // Try to hand the message to a waiting awaitMessage caller first. If
    // matched, it is "consumed" and does NOT enter the inbox — otherwise
    // a stale already-resolved message would resurface in a later
    // awaitMessage call against the same predicate.
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].pred(msg)) {
        clearTimeout(waiters[i].timer);
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
        return;
      }
    }
    // No waiter matched — buffer for the next awaitMessage call.
    inbox.push(msg);
  });

  return {
    client,
    plugin,
    pluginUUID,
    configPath,
    spySettings,
    send: (event) => client.send(JSON.stringify(event)),
    awaitMessage: <T,>(pred, timeoutMs = 3000) => {
      // First check inbox for already-arrived match
      const idx = inbox.findIndex(pred);
      if (idx >= 0) {
        const [m] = inbox.splice(idx, 1);
        return Promise.resolve(m as T);
      }
      return new Promise<T>((res, rej) => {
        const timer = setTimeout(() => {
          const i = waiters.findIndex(w => w.timer === timer);
          if (i >= 0) waiters.splice(i, 1);
          rej(new Error(`awaitMessage timeout (${timeoutMs} ms)`));
        }, timeoutMs);
        waiters.push({ pred, resolve: (m) => res(m as T), reject: rej, timer });
      });
    },
    startCapture: () => {
      const arr: unknown[] = [];
      captures.add(arr);
      return { stop: () => { captures.delete(arr); return arr; } };
    },
    shutdown: async () => {
      for (const w of waiters) { clearTimeout(w.timer); w.reject(new Error('harness shutting down')); }
      waiters.length = 0;
      plugin.kill('SIGTERM');
      await new Promise<void>((res) => {
        const t = setTimeout(() => { plugin.kill('SIGKILL'); res(); }, 2000);
        plugin.once('exit', () => { clearTimeout(t); res(); });
      });
      wss.close();
      await new Promise<void>(res => wss.once('close', () => res()));
      if (spyServer) {
        await new Promise<void>(res => spyServer!.close(() => res()));
      }
    },

    // Convenience helpers for tests. Encoder coordinates default to (0,0) —
    // tests using more than one action on the same context should pass
    // distinct context IDs (the SDK keys actions on context, not coordinates).
    willAppearDial: async (uuid, context, settings = {}) => {
      const payload = {
        controller: 'Encoder' as const,
        coordinates: { column: 0, row: 0 },
        isInMultiAction: false,
        settings,
      };
      const sock = client;
      sock.send(JSON.stringify({
        event: 'willAppear', action: uuid, context, device: 'dev-test-sdplus', payload,
      }));
      // Wait for the dial's first render so callers can rely on a fully
      // initialised action when the helper resolves. setImage on the encoder
      // image (knob graphic) is universal; some dials skip setFeedback on the
      // very first onWillAppear under certain modes, so we key on setImage
      // which every dial sends as part of the knob render.
      // 10 s upper bound: only reached on genuine failure, but generous
      // enough that a fully parallel vitest run (many plugin processes
      // spawning at once) doesn't trip it on a slow first render.
      await new Promise<void>((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`willAppearDial: no setImage for ${context} within 10 s`)), 10_000);
        const pred = (m: unknown) => {
          const msg = m as { event?: string; context?: string };
          return msg?.event === 'setImage' && msg?.context === context;
        };
        const idx = inbox.findIndex(pred);
        if (idx >= 0) { inbox.splice(idx, 1); clearTimeout(timer); res(); return; }
        waiters.push({ pred, resolve: () => { clearTimeout(timer); res(); }, reject: rej, timer });
      });
    },
    dialRotate: (uuid, context, ticks, pressed = false) => {
      client.send(JSON.stringify({
        event: 'dialRotate',
        action: uuid,
        context,
        device: 'dev-test-sdplus',
        payload: {
          controller: 'Encoder',
          coordinates: { column: 0, row: 0 },
          settings: {},
          ticks,
          pressed,
        },
      }));
    },
    dialDown: (uuid, context) => {
      client.send(JSON.stringify({
        event: 'dialDown',
        action: uuid,
        context,
        device: 'dev-test-sdplus',
        payload: {
          controller: 'Encoder',
          coordinates: { column: 0, row: 0 },
          settings: {},
        },
      }));
    },
    dialUp: (uuid, context) => {
      client.send(JSON.stringify({
        event: 'dialUp',
        action: uuid,
        context,
        device: 'dev-test-sdplus',
        payload: {
          controller: 'Encoder',
          coordinates: { column: 0, row: 0 },
          settings: {},
        },
      }));
    },
    showPropertyInspector: (uuid, context) => {
      client.send(JSON.stringify({
        event: 'propertyInspectorDidAppear',
        action: uuid,
        context,
        device: 'dev-test-sdplus',
      }));
    },
    sendToPlugin: (uuid, context, payload) => {
      client.send(JSON.stringify({
        event: 'sendToPlugin',
        action: uuid,
        context,
        payload,
      }));
    },
    settle: (ms = 50) => new Promise<void>(res => setTimeout(res, ms)),
  };
}
