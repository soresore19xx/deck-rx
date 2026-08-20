// Output-device enumeration for the Tune dial PI dropdown.
//
// Backed by naudiodon's PortAudio binding, which queries CoreAudio's HAL
// directly. Earlier revisions shelled out to MacPorts `SwitchAudioSource`
// (a separate child process per call); naudiodon returns the same set of
// devices via an in-process API and additionally exposes the current
// system default output via `getHostAPIs()`. The binding is loaded lazily
// (require inside each function) so a missing or ABI-mismatched .node
// doesn't crash the plugin at module-load time — the PI dropdown just
// shows up empty and `currentAudioOutput` falls back to '' until the user
// runs `npm run rebuild-native`.

import { log } from './log.js';

export interface AudioDevice { name: string; }

interface NaudiodonDevice {
  id: number;
  name: string;
  maxOutputChannels: number;
}
interface NaudiodonHostAPI {
  id: number;
  name: string;
  type: string;
  deviceCount: number;
  defaultInput: number;
  defaultOutput: number;
}
interface NaudiodonModule {
  getDevices: () => NaudiodonDevice[];
  getHostAPIs: () => { defaultHostAPI: number; HostAPIs: NaudiodonHostAPI[] };
}

function loadNaudiodon(): NaudiodonModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('naudiodon') as NaudiodonModule;
  } catch (e) {
    log.warn(`[audioDevices] naudiodon require failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** CoreAudio output device names via naudiodon (PortAudio).
 *  Some USB DAC names carry trailing whitespace at the HAL level (e.g.
 *  "DX7s "); trimmed here so the PI dropdown matches what SwitchAudioSource
 *  used to show and what `config.json` typically stores. */
export async function getAudioOutputDevices(): Promise<AudioDevice[]> {
  const pa = loadNaudiodon();
  if (!pa) return [];
  return pa.getDevices()
    .filter((d) => d.maxOutputChannels > 0)
    .map((d) => ({ name: d.name.trim() }));
}

/** Name of the current system default output device. Looks up the
 *  PortAudio default via `getHostAPIs().HostAPIs[0].defaultOutput` and
 *  finds the matching device name. Returns '' if naudiodon is missing or
 *  no host API is reported. */
export async function getCurrentAudioOutput(): Promise<string> {
  const pa = loadNaudiodon();
  if (!pa) return '';
  const hosts = pa.getHostAPIs();
  const host = hosts.HostAPIs[0];
  if (!host) return '';
  const defaultId = host.defaultOutput;
  if (defaultId < 0) return '';
  const dev = pa.getDevices().find((d) => d.id === defaultId);
  return dev ? dev.name.trim() : '';
}
