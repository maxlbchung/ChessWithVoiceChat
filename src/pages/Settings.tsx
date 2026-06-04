import { useSettingsStore, type MobileLayoutMode } from '../store/settingsStore';

export function Settings() {
  const {
    volume,
    showOpponentNames,
    showOpponentAvatars,
    chatEnabled,
    animationsEnabled,
    mobileLayout,
    setVolume,
    setShowOpponentNames,
    setShowOpponentAvatars,
    setChatEnabled,
    setAnimationsEnabled,
    setMobileLayout,
  } = useSettingsStore();

  return (
    <div className="page">
      <h1 className="page-title">Settings</h1>

      <section className="settings-card">
        <div className="settings-row">
          <div className="settings-label">
            <div className="settings-title">Volume</div>
            <div className="muted small">Applies to UI clicks, move/capture/check, and end-of-game cues.</div>
          </div>
          <div className="settings-control volume-control">
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              aria-label="Volume"
            />
            <span className="volume-readout">{Math.round(volume * 100)}%</span>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-label">
            <div className="settings-title">Show opponent name</div>
            <div className="muted small">When off, your opponent appears as "Opponent" everywhere.</div>
          </div>
          <Toggle
            checked={showOpponentNames}
            onChange={setShowOpponentNames}
            label="Show opponent name"
          />
        </div>

        <div className="settings-row">
          <div className="settings-label">
            <div className="settings-title">Show opponent profile picture</div>
            <div className="muted small">When off, opponent avatars fall back to a generic placeholder.</div>
          </div>
          <Toggle
            checked={showOpponentAvatars}
            onChange={setShowOpponentAvatars}
            label="Show opponent profile picture"
          />
        </div>

        <div className="settings-row">
          <div className="settings-label">
            <div className="settings-title">Chat</div>
            <div className="muted small">Show the in-game text chat panel.</div>
          </div>
          <Toggle
            checked={chatEnabled}
            onChange={setChatEnabled}
            label="Chat enabled"
          />
        </div>

        <div className="settings-row">
          <div className="settings-label">
            <div className="settings-title">Mobile mode</div>
            <div className="muted small">
              Restructures the game screen into a single column — board with
              player blocks above and below, and the shop / ability menu under
              it. "Auto" turns on for small screens.
            </div>
          </div>
          <Segmented
            value={mobileLayout}
            onChange={setMobileLayout}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
            label="Mobile mode"
          />
        </div>

        <div className="settings-row">
          <div className="settings-label">
            <div className="settings-title">Animations</div>
            <div className="muted small">
              Smooth peice movement, ability effects, merge animation.
            </div>
          </div>
          <Toggle
            checked={animationsEnabled}
            onChange={setAnimationsEnabled}
            label="Animations"
          />
        </div>
      </section>
    </div>
  );
}

function Segmented({
  value,
  onChange,
  options,
  label,
}: {
  value: MobileLayoutMode;
  onChange: (v: MobileLayoutMode) => void;
  options: { value: MobileLayoutMode; label: string }[];
  label: string;
}) {
  return (
    <div className="settings-segmented" role="radiogroup" aria-label={label}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          className={`settings-segment ${value === opt.value ? 'on' : ''}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`settings-toggle ${checked ? 'on' : 'off'}`}
      onClick={() => onChange(!checked)}
    >
      <span className="settings-toggle-knob" />
    </button>
  );
}
