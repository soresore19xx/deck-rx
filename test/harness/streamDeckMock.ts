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
}

export interface StartPluginOptions {
  /** If true, dump plugin stdout / stderr to the test runner's console for
   *  debugging. Default false (silent). */
  verbose?: boolean;
  /** Initial config.json contents. Defaults to enabled=false so the plugin
   *  does NOT try to reach a SpyServer during the test. */
  config?: Record<string, unknown>;
}

const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  port: 8888,
  enabled: false,         // master OFF — no SpyClient.connect
  audioEnabled: false,    // no ffmpeg spawn
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

  // Sandbox dir for PID + config so we don't collide with the production instance
  const sandboxDir = mkdtempSync(resolve(tmpdir(), 'deck-rx-test-'));
  const configPath = resolve(sandboxDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ ...DEFAULT_CONFIG, ...(opts.config ?? {}) }, null, 2));

  // Plugin spawn
  const env = {
    ...process.env,
    DECK_RX_PID_FILE:           resolve(sandboxDir, 'deck-rx.pid'),
    DECK_RX_CONFIG_PATH:        configPath,
    DECK_RX_JP_STATIONS_PATH:   JP_STATIONS,
  };
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

  // Wait for the plugin's WS connection + register handshake
  const client = await new Promise<WebSocket>((res, rej) => {
    const timer = setTimeout(() => {
      wss.close();
      plugin.kill();
      rej(new Error('timeout: plugin did not connect / register within 5 s'));
    }, 5000);
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
    inbox.push(msg);
    for (const cap of captures) cap.push(msg);
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].pred(msg)) {
        clearTimeout(waiters[i].timer);
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
        return;
      }
    }
  });

  return {
    client,
    plugin,
    pluginUUID,
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
    },
  };
}
