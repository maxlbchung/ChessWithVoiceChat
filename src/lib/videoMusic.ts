// Music loading for the video editor. Two sources: a small bundled set served
// from public/music/, and user-uploaded files (decoded in-memory, never saved
// into the project JSON). Both yield a { url, buffer } pair — `url` feeds the
// preview <audio> element, `buffer` (an AudioBuffer) feeds the export mux.
import * as sfx from './sfx';

export type BundledTrack = { id: string; name: string; file: string };

// The actual audio files are user-supplied (drop them into public/music/). If a
// file is missing, loading that track simply rejects and the UI surfaces it;
// uploaded tracks work regardless.
export const BUNDLED_TRACKS: BundledTrack[] = [
  { id: 'track-a', name: 'Track A', file: 'track-a.mp3' },
  { id: 'track-b', name: 'Track B', file: 'track-b.mp3' },
];

export function bundledTrackUrl(track: BundledTrack): string {
  // BASE_URL is '/' in dev and '/ChessWithVoiceChat/' on the GH Pages mirror.
  return import.meta.env.BASE_URL + 'music/' + track.file;
}

export type LoadedMusic = {
  // For the preview <audio> element. Object URL for uploads, static URL for bundled.
  url: string;
  // Decoded PCM for the export mux.
  buffer: AudioBuffer;
  // True when `url` is an object URL we created and should revoke on replace.
  isObjectUrl: boolean;
};

// Decode into the SFX synthesis context so music and SFX share one context —
// the export muxer combines both (plus the canvas video) into a single stream.
export function getAudioContext(): AudioContext {
  return sfx.audioContext();
}

async function decode(data: ArrayBuffer): Promise<AudioBuffer> {
  const ctx = getAudioContext();
  // decodeAudioData detaches the buffer; callers pass a fresh ArrayBuffer.
  return await ctx.decodeAudioData(data);
}

export async function loadUploadedMusic(file: File): Promise<LoadedMusic> {
  const url = URL.createObjectURL(file);
  const buffer = await decode(await file.arrayBuffer());
  return { url, buffer, isObjectUrl: true };
}

export async function loadBundledMusic(track: BundledTrack): Promise<LoadedMusic> {
  const url = bundledTrackUrl(track);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load "${track.name}" (${res.status}). Is ${url} present?`);
  const buffer = await decode(await res.arrayBuffer());
  return { url, buffer, isObjectUrl: false };
}
