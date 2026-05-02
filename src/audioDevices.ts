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

// Cache device list to avoid 3-second lookups on every ffmpeg respawn.
let deviceMapCache: Map<string, number> | null = null;
let deviceMapCacheTime = 0;

/**
 * Build a name → ffmpeg-audiotoolbox-index map by querying ffmpeg.
 * Some devices report display name as "(null)"; in that case parse the UID
 * (e.g., `AppleUSBAudioEngine:Topping:DX7s:8311000:1`) to recover a usable
 * key matching what SwitchAudioSource exposes.
 * Cached for 30 s.
 */
export async function getFfmpegDeviceIndexMap(): Promise<Map<string, number>> {
  if (deviceMapCache && Date.now() - deviceMapCacheTime < 30000) {
    return deviceMapCache;
  }
  const out = await runProc(FFMPEG, [
    '-f', 's16le', '-ar', '48000', '-ac', '1', '-i', '/dev/zero',
    '-f', 'audiotoolbox', '-list_devices', 'true', '',
  ], true);
  const map = new Map<string, number>();
  // Format: [AudioToolbox @ ...] [N]  display_name, UID
  const re = /\[AudioToolbox[^\]]*\] \[(\d+)\]\s+(.*?),\s+(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out)) !== null) {
    const idx = parseInt(m[1], 10);
    const name = m[2].trim();
    const uid = m[3].trim();
    if (name && name !== '(null)') {
      map.set(name, idx);
    }
    // Extract product name from UID for "(null)" entries:
    //   AppleUSBAudioEngine:<Vendor>:<Product>:<Serial>:<Channel>
    const um = uid.match(/AppleUSBAudioEngine:[^:]+:([^:]+):/);
    if (um) map.set(um[1], idx);
  }
  deviceMapCache = map;
  deviceMapCacheTime = Date.now();
  return map;
}
