// The sync hub: one small HTTP server on mini4 that the plugin, Solo and the
// iPad all sync presets and per-station gains through. Rules in syncCore.ts.
//
//   POST /sync   {since, records}  → {seq, records}   take a side's changes,
//                                                     answer with everything newer
//   GET  /health                   → {ok, seq, counts}
//
// Run by a LaunchAgent on mini4 (docs/sync.md). Listens on every interface:
// the Macs reach it at 192.168.0.51, the iPad's segment at 192.168.1.51.

import http from 'http';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import os from 'os';
import { HubStore, emptyHub, hubMerge, hubSince, SyncRecord } from './syncCore.js';

const PORT = Number(process.env.DECK_RX_SYNC_PORT ?? 8772);
const STORE = process.env.DECK_RX_SYNC_STORE ??
  join(os.homedir(), 'Library', 'Application Support', 'deck-rx-sync', 'store.json');

function load(): HubStore {
  try {
    const s = JSON.parse(readFileSync(STORE, 'utf-8')) as HubStore;
    if (typeof s.seq === 'number' && s.recs && typeof s.recs === 'object') return s;
  } catch { /* first run */ }
  return emptyHub();
}

const store = load();

function save(): void {
  mkdirSync(dirname(STORE), { recursive: true });
  writeFileSync(`${STORE}.tmp`, JSON.stringify(store, null, 1) + '\n', 'utf-8');
  renameSync(`${STORE}.tmp`, STORE);
}

function isRecord(r: unknown): r is SyncRecord {
  const x = r as SyncRecord;
  return !!x && typeof x.c === 'string' && typeof x.k === 'string' && typeof x.t === 'number' &&
    (x.v === null || typeof x.v === 'number' || typeof x.v === 'object');
}

function log(msg: string): void {
  process.stdout.write(`${new Date().toISOString()} ${msg}\n`);
}

const server = http.createServer((req, res) => {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url ?? '/', 'http://hub');
  if (req.method === 'GET' && url.pathname === '/health') {
    const counts: Record<string, number> = {};
    for (const [c, coll] of Object.entries(store.recs)) {
      counts[c] = Object.values(coll).filter(e => e.v !== null).length;
    }
    send(200, { ok: true, seq: store.seq, counts });
    return;
  }
  if (req.method !== 'POST' || url.pathname !== '/sync') { send(404, { error: 'not found' }); return; }
  let body = '';
  req.setEncoding('utf-8');
  req.on('data', (d: string) => {
    body += d;
    if (body.length > 8_000_000) req.destroy();
  });
  req.on('end', () => {
    let q: { since?: unknown; records?: unknown; who?: unknown };
    try { q = JSON.parse(body || '{}'); } catch { send(400, { error: 'bad json' }); return; }
    const since = typeof q.since === 'number' ? q.since : 0;
    const records = Array.isArray(q.records) ? q.records.filter(isRecord) : [];
    const before = store.seq;
    const rejected = hubMerge(store, records);
    if (store.seq !== before) {
      try { save(); } catch (e) { log(`save failed: ${e}`); send(500, { error: 'save failed' }); return; }
    }
    if (records.length > 0) {
      log(`${String(q.who ?? req.socket.remoteAddress)}: ${records.length} in, ` +
          `${store.seq - before} taken, ${rejected.length} turned down`);
    }
    send(200, { seq: store.seq, records: hubSince(store, since, rejected) });
  });
});

server.listen(PORT, '0.0.0.0', () => log(`deck-rx sync hub on :${PORT}, store ${STORE}, seq ${store.seq}`));
