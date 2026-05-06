import { readFileSync } from 'fs';
import { join } from 'path';

declare const __dirname: string;

// eibi.txt lives inside the plugin bundle (next to bin/) so the deployed plugin
// can find it via __dirname (= <plugin>/bin/).
const EIBI_PATH = join(__dirname, '..', 'data', 'eibi.txt');

export interface EibiEntry {
  freqKhz: number;   // rounded to integer kHz to match ATS-Mini's uint16_t storage
  startMin: number;  // UTC minute-of-day, 0..1440
  endMin: number;    // UTC minute-of-day, 0..1440 — may be < startMin (wraps midnight)
  dayCode: string;   // EIBI Days field, '' = daily
  name: string;
}

let entries: EibiEntry[] | null = null;

function parseLine(line: string): EibiEntry | null {
  // sscanf("%14c%9c%11c%24c") in ATS-Mini's EIBI.cpp — but unlike ATS-Mini we
  // also extract the Days field (slice 23..34 contains optional days + ITU code).
  if (line.length < 50) return null;
  const freqStr = line.slice(0, 14).trim();
  const timeStr = line.slice(14, 23).trim();
  const daysItuStr = line.slice(23, 34);
  const nameStr = line.slice(34, 58).trim();

  const freq = parseFloat(freqStr);
  if (!freq || !Number.isFinite(freq)) return null;

  const tm = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(timeStr);
  if (!tm) return null;
  const sh = +tm[1], sm = +tm[2], eh = +tm[3], em = +tm[4];

  if (!nameStr || nameStr.includes('Jammer')) return null;

  // Days+ITU column: when the line is " Mo-Fr J  " the leading token is the
  // days field; the trailing alpha token is the ITU country code we don't use.
  // When the line is "       FIN" there's no days (single token = ITU only).
  const dItu = daysItuStr.trim().split(/\s+/).filter(s => s.length > 0);
  const dayCode = dItu.length >= 2 ? dItu[0] : '';

  // Drop spurious emissions ("spur") — these are records of parasitic transmissions
  // (intermod products, harmonics) catalogued by EIBI for reference, not actual
  // broadcasts you'd tune to. Keeping them lets a wrong "station name" surface
  // when no real broadcaster is on a frequency.
  if (dayCode === 'spur') return null;

  return {
    freqKhz: Math.round(freq),
    startMin: sh * 60 + sm,
    endMin: eh * 60 + em,
    dayCode,
    name: nameStr,
  };
}

function load(): EibiEntry[] {
  if (entries) return entries;
  let text: string;
  try {
    text = readFileSync(EIBI_PATH, 'utf-8');
  } catch {
    entries = [];
    return entries;
  }
  const list = parseEibiText(text);
  list.sort((a, b) => a.freqKhz - b.freqKhz);
  entries = list;
  return list;
}

function isActive(e: EibiEntry, nowMin: number): boolean {
  if (e.startMin <= e.endMin) return nowMin >= e.startMin && nowMin <= e.endMin;
  return nowMin >= e.startMin || nowMin <= e.endMin;
}

// JS getUTCDay(): Sun=0, Mon=1, ..., Sat=6. EIBI digits: 1=Mon..7=Sun.
const DAY_CODES: Record<string, number> = {
  Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6,
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function digitToDow(c: string): number {
  const n = +c;
  if (n >= 1 && n <= 6) return n;  // Mon..Sat → 1..6
  if (n === 7) return 0;            // Sun → 0
  return -1;
}

// Returns true if the EIBI dayCode applies to the given UTC date.
// Unrecognized codes return true (fail-open) so a parsing surprise never
// hides a legitimate match — wrong matches are easier to spot than missing
// ones, and the parser already filters on freq + time.
export function dayMatches(code: string, when: Date): boolean {
  if (!code) return true;
  // Informational tags — no real day constraint.
  if (code === 'irr' || code === 'spur' || code === 'tent' || code === 'alt') return true;
  if (code === 'Last7' || code === 'Tests' || code === 'Days') return true;

  const dow = when.getUTCDay();

  // Date-of-month + month name: "4May", "10Oct"
  const dm = /^(\d{1,2})([A-Z][a-z]{2})$/.exec(code);
  if (dm) {
    const mday = +dm[1];
    const monthIdx = MONTHS.indexOf(dm[2]);
    if (monthIdx < 0) return true;
    return when.getUTCDate() === mday && when.getUTCMonth() === monthIdx;
  }

  // Nth occurrence of weekday in month: "1.Sa" = first Saturday
  const nth = /^(\d)\.([A-Z][a-z])$/.exec(code);
  if (nth) {
    const n = +nth[1];
    const target = DAY_CODES[nth[2]];
    if (target === undefined) return true;
    if (dow !== target) return false;
    return Math.floor((when.getUTCDate() - 1) / 7) + 1 === n;
  }

  // Day range: "Mo-Fr", "We-Mo" (wraps), "Su-Th"
  const range = /^([A-Z][a-z])-([A-Z][a-z])$/.exec(code);
  if (range) {
    const from = DAY_CODES[range[1]];
    const to   = DAY_CODES[range[2]];
    if (from === undefined || to === undefined) return true;
    if (from <= to) return dow >= from && dow <= to;
    return dow >= from || dow <= to;
  }

  // Comma list: "Tu,Fr", "Mo,We,Fr"
  if (code.includes(',')) {
    return code.split(',').some(part => dayMatches(part, when));
  }

  // Digit string: "157" = Mon+Fri+Sun, "12356" = Mon+Tue+Wed+Fri+Sat
  if (/^\d+$/.test(code)) {
    for (const c of code) {
      if (digitToDow(c) === dow) return true;
    }
    return false;
  }

  // Concatenated 2-letter pairs: "SaSu", "MoTu" (only seen for SaSu in current eibi.txt)
  if (code.length >= 4 && code.length % 2 === 0 && /^([A-Z][a-z])+$/.test(code)) {
    for (let i = 0; i < code.length; i += 2) {
      if (DAY_CODES[code.slice(i, i + 2)] === dow) return true;
    }
    return false;
  }

  // Single 2-letter day: "Mo", "We"
  if (DAY_CODES[code] !== undefined) {
    return DAY_CODES[code] === dow;
  }

  // Unknown — fail-open
  return true;
}

function windowLength(e: EibiEntry): number {
  let n = e.endMin - e.startMin;
  if (n <= 0) n += 1440;
  return n;
}

export function lookupEibi(freqHz: number, when: Date = new Date()): EibiEntry | null {
  const all = load();
  if (all.length === 0) return null;

  const freqKhz = Math.round(freqHz / 1000);
  let lo = 0, hi = all.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (all[mid].freqKhz < freqKhz) lo = mid + 1;
    else hi = mid;
  }

  const nowMin = when.getUTCHours() * 60 + when.getUTCMinutes();
  const matches: EibiEntry[] = [];
  for (let i = lo; i < all.length && all[i].freqKhz === freqKhz; i++) {
    if (isActive(all[i], nowMin) && dayMatches(all[i].dayCode, when)) matches.push(all[i]);
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => windowLength(a) - windowLength(b));
  return matches[0];
}

export function eibiEntryCount(): number {
  return load().length;
}

export function getEibiPath(): string {
  return EIBI_PATH;
}

export function clearEibiCache(): void {
  entries = null;
}

export function parseEibiText(text: string): EibiEntry[] {
  const list: EibiEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const e = parseLine(line);
    if (e) list.push(e);
  }
  return list;
}
