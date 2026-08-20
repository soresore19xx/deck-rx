/**
 * Logger seam, so the signal path can run without the Stream Deck SDK.
 *
 * The core (spyService, the SpyServer client, the audio chain, the control
 * server, the status feed) used to call `streamDeck.logger` directly, which
 * pinned every one of those files to `@elgato/streamdeck` — importing any of
 * them dragged in the plugin runtime even when nothing was plugged into a
 * Stream Deck. The core now logs through here instead:
 *
 *   - the plugin entry binds this to `streamDeck.logger`, so plugin logs keep
 *     landing in the Stream Deck app's log files exactly as before;
 *   - the headless entry leaves the default, which writes to stderr.
 *
 * Deliberately the same four levels the SDK exposes, so binding is a
 * straight hand-off with no adapter.
 */

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

function stamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

/** Default sink: stderr. stdout belongs to whatever pipes the process. */
const stderrLogger: Logger = {
  info:  (m) => { try { process.stderr.write(`${stamp()} INFO  ${m}\n`); } catch { /* EPIPE */ } },
  warn:  (m) => { try { process.stderr.write(`${stamp()} WARN  ${m}\n`); } catch { /* EPIPE */ } },
  error: (m) => { try { process.stderr.write(`${stamp()} ERROR ${m}\n`); } catch { /* EPIPE */ } },
  debug: (m) => { try { process.stderr.write(`${stamp()} DEBUG ${m}\n`); } catch { /* EPIPE */ } },
};

let sink: Logger = stderrLogger;

/** Point the core's logging at a different sink (the plugin passes the SDK's). */
export function setLogger(next: Logger): void { sink = next; }

/** The core logs through this. Late-bound on purpose: modules capture `log`
 *  at import time, long before the entry point has chosen a sink. */
export const log: Logger = {
  info:  (m) => sink.info(m),
  warn:  (m) => sink.warn(m),
  error: (m) => sink.error(m),
  debug: (m) => sink.debug(m),
};
