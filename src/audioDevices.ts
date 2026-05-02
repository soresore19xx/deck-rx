import { spawn } from 'child_process';
import fs from 'fs';

const SAS = '/opt/local/bin/SwitchAudioSource';
const FFMPEG = (() => {
  for (const p of ['/opt/local/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg']) {
    try { fs.accessSync(p); return p; } catch {}
  }
  return 'ffmpeg';
})();

export interface AudioDevice { name: string; }

function runProc(cmd: string, args: string[], captureStderr = false, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    const proc = spawn(cmd, args, { stdio: ['ignore', captureStderr ? 'ignore' : 'pipe', captureStderr ? 'pipe' : 'ignore'] });
    proc.on('error', () => resolve(''));
    const stream = captureStderr ? proc.stderr : proc.stdout;
    stream?.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('close', () => resolve(out));
    setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
  });
}

/** Output device names via SwitchAudioSource (one per line). */
export async function getAudioOutputDevices(): Promise<AudioDevice[]> {
  const out = await runProc(SAS, ['-t', 'output', '-a']);
  return out.split('\n').map(s => s.trim()).filter(Boolean).map(name => ({ name }));
}

export async function getCurrentAudioOutput(): Promise<string> {
  const out = await runProc(SAS, ['-t', 'output', '-c']);
  return out.trim();
}

/**
 * Build a name → ffmpeg-audiotoolbox-index map by querying ffmpeg.
 * ffmpeg's audiotoolbox output requires the numeric index from its own enumeration.
 */
export async function getFfmpegDeviceIndexMap(): Promise<Map<string, number>> {
  const out = await runProc(FFMPEG, [
    '-f', 's16le', '-ar', '48000', '-ac', '1', '-i', '/dev/zero',
    '-f', 'audiotoolbox', '-list_devices', 'true', '',
  ], true);
  const map = new Map<string, number>();
  const re = /\[AudioToolbox[^\]]*\] \[(\d+)\]\s+(.*?),\s/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out)) !== null) {
    const idx = parseInt(m[1], 10);
    const name = m[2].trim();
    if (name && name !== '(null)') map.set(name, idx);
  }
  return map;
}
