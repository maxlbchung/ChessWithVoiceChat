import { useEffect, useRef, useState } from 'react';
import { QUICK_EMOJIS } from '../lib/inGameEmojis';

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSend: (text: string, options?: { clearInput?: boolean; emoji?: boolean }) => void;
  emojiEnabled?: boolean;
};

export function ChatComposer({ value, onChange, onSend, emojiEnabled = true }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const sendEmoji = (emoji: string) => {
    onSend(emoji, { clearInput: false, emoji: true });
    setOpen(false);
  };

  return (
    <form
      className="chat-input-row"
      onSubmit={(e) => {
        e.preventDefault();
        onSend(value, { clearInput: true });
      }}
    >
      <div className="chat-input-shell" ref={wrapRef}>
        <input
          className="text-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="say something..."
          maxLength={200}
        />
        {emojiEnabled && (
          <button
            className="chat-emoji-btn"
            data-no-sfx
            type="button"
            aria-label="Pick an emoji"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            ☺
          </button>
        )}
        {emojiEnabled && open && (
          <div className="chat-emoji-popover" role="menu" aria-label="Emoji reactions">
            {QUICK_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                className="chat-emoji-option"
                data-no-sfx
                type="button"
                role="menuitem"
                aria-label={`Send ${emoji}`}
                onClick={() => sendEmoji(emoji)}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>
      <button className="secondary-btn" data-no-sfx type="submit">Send</button>
    </form>
  );
}
