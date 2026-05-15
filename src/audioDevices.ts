import { spawn } from 'child_process';

const SAS = '/opt/local/bin/SwitchAudioSource';

export interface AudioDevice { name: string; }

function runProc(cmd: string, args: string[], timeoutMs = 4000): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    proc.on('error', () => resolve(''));
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
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
