import { useEffect, useRef } from 'react';

type Props = {
  remoteStream: MediaStream | null;
  micOn: boolean;
  speakerOn: boolean;
  onToggleMic: () => void;
  onToggleSpeaker: () => void;
  onStartVoice: () => void;
  voiceActive: boolean;
  inline?: boolean;
};

export function VoiceControls({
  remoteStream,
  micOn,
  speakerOn,
  onToggleMic,
  onToggleSpeaker,
  onStartVoice,
  voiceActive,
  inline,
}: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (audioRef.current && remoteStream) {
      audioRef.current.srcObject = remoteStream;
      audioRef.current.muted = !speakerOn;
      audioRef.current.play().catch((e) => console.warn('autoplay', e));
    }
  }, [remoteStream, speakerOn]);

  return (
    <div className={`voice-controls${inline ? ' inline' : ''}`}>
      <audio ref={audioRef} autoPlay playsInline />
      {!voiceActive ? (
        <button className="voice-btn primary" onClick={onStartVoice}>
          🎙 Start voice chat
        </button>
      ) : (
        <>
          <button
            className={`voice-btn ${micOn ? 'on' : 'off'}`}
            onClick={onToggleMic}
            title={micOn ? 'Mute mic' : 'Unmute mic'}
          >
            {micOn ? '🎙 Mic on' : '🔇 Mic off'}
          </button>
          <button
            className={`voice-btn ${speakerOn ? 'on' : 'off'}`}
            onClick={onToggleSpeaker}
            title={speakerOn ? 'Mute speaker' : 'Unmute speaker'}
          >
            {speakerOn ? '🔊 Speaker on' : '🔈 Speaker off'}
          </button>
        </>
      )}
    </div>
  );
}
