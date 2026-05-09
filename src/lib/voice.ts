export async function getMicStream(): Promise<MediaStream> {
  return await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
}

export function setStreamMuted(stream: MediaStream | null, muted: boolean) {
  if (!stream) return;
  for (const track of stream.getAudioTracks()) {
    track.enabled = !muted;
  }
}

export function stopStream(stream: MediaStream | null) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    track.stop();
  }
}
