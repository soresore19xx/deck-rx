import fs from 'fs';
import streamDeck from '@elgato/streamdeck';
import { SpyTune } from './actions/spyTune.js';
import { SpyDialTune } from './actions/spyDialTune.js';
import { SpyDialOptions } from './actions/spyDialOptions.js';
import { SpyDialVolume } from './actions/spyDialVolume.js';
import { SpyDialAmOptions } from './actions/spyDialAmOptions.js';

const PID_FILE = '/tmp/spyserver-ex.pid';
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

process.stdout.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') throw err; });
const safeLog = (msg: string) => { try { process.stderr.write(msg + '\n'); } catch {} };
process.on('uncaughtException', (err) => { safeLog(`[spyserver-ex] uncaughtException: ${err}`); });
process.on('unhandledRejection', (r)  => { safeLog(`[spyserver-ex] unhandledRejection: ${r}`); });

streamDeck.actions.registerAction(new SpyTune());
streamDeck.actions.registerAction(new SpyDialTune());
streamDeck.actions.registerAction(new SpyDialOptions());
streamDeck.actions.registerAction(new SpyDialVolume());
streamDeck.actions.registerAction(new SpyDialAmOptions());
streamDeck.connect();
