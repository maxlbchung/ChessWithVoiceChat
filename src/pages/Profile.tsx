import { useEffect, useRef, useState } from 'react';
import { useIdentityStore } from '../store/identityStore';
import { loadSummaries } from '../lib/storage';
import type { LocalGameSummary } from '../lib/types';
import { exportIdentity, importIdentity } from '../lib/identity';
import { getTimeControl } from '../lib/timeControls';
import { fileToAvatarDataUrl } from '../lib/avatar';

export function Profile() {
  const { identity, rating, avatar, setIdentity, setHandle, setAvatar } = useIdentityStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [summaries, setSummaries] = useState<LocalGameSummary[]>([]);
  const [exportText, setExportText] = useState<string | null>(null);
  const [importText, setImportText] = useState('');
  const [editingHandle, setEditingHandle] = useState(false);
  const [handleDraft, setHandleDraft] = useState('');

  useEffect(() => {
    loadSummaries().then(setSummaries);
  }, []);

  if (!identity) {
    return (
      <div className="page-narrow">
        <h1 className="page-title">No identity yet</h1>
        <p className="muted">Head back to the lobby to create one.</p>
      </div>
    );
  }

  const wins = summaries.filter((s) => s.outcome === s.myColor).length;
  const losses = summaries.filter(
    (s) => s.outcome !== 'draw' && s.outcome !== s.myColor,
  ).length;
  const draws = summaries.filter((s) => s.outcome === 'draw').length;

  return (
    <div className="page">
      <h1 className="page-title">Profile</h1>

      <section className="profile-card">
        <div className="profile-row">
          <div className="profile-field">
            <div className="muted small">Profile picture</div>
            <div className="avatar-edit">
              <div className="player-avatar large">
                {avatar ? (
                  <img src={avatar} alt={identity.handle} />
                ) : (
                  <span className="player-avatar-initial">
                    {(identity.handle[0] ?? '?').toUpperCase()}
                  </span>
                )}
              </div>
              <div className="avatar-actions">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    try {
                      const dataUrl = await fileToAvatarDataUrl(file);
                      await setAvatar(dataUrl);
                    } catch {
                      alert('Failed to load image.');
                    } finally {
                      if (fileInputRef.current) fileInputRef.current.value = '';
                    }
                  }}
                />
                <button
                  className="secondary-btn"
                  onClick={() => fileInputRef.current?.click()}
                >
                  {avatar ? 'Change' : 'Upload'}
                </button>
                {avatar && (
                  <button className="link-btn" onClick={() => setAvatar(null)}>
                    Remove
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="profile-row">
          <div className="profile-field">
            <div className="muted small">Handle</div>
            {editingHandle ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setHandle(handleDraft);
                  setEditingHandle(false);
                }}
              >
                <input
                  className="text-input"
                  value={handleDraft}
                  onChange={(e) => setHandleDraft(e.target.value)}
                  maxLength={20}
                  autoFocus
                />
                <button className="primary-btn" type="submit">Save</button>
              </form>
            ) : (
              <div className="profile-value">
                {identity.handle}
                <button
                  className="link-btn"
                  onClick={() => {
                    setHandleDraft(identity.handle);
                    setEditingHandle(true);
                  }}
                >
                  edit
                </button>
              </div>
            )}
          </div>
          <div className="profile-field">
            <div className="muted small">Rating</div>
            <div className="profile-value big">{rating}</div>
          </div>
          <div className="profile-field">
            <div className="muted small">Record</div>
            <div className="profile-value">
              {wins}W / {losses}L / {draws}D
            </div>
          </div>
        </div>

        <div className="profile-row">
          <div className="profile-field grow">
            <div className="muted small">Public key</div>
            <div className="mono break">{identity.publicKeyHex}</div>
          </div>
        </div>

        <div className="profile-row identity-actions">
          {!exportText ? (
            <button
              className="secondary-btn"
              onClick={() => setExportText(exportIdentity(identity))}
            >
              Export identity
            </button>
          ) : (
            <div className="profile-field grow">
              <div className="muted small">
                Save this string somewhere safe. It IS your account.
              </div>
              <textarea
                className="text-input mono"
                readOnly
                rows={3}
                value={exportText}
                onClick={(e) => (e.target as HTMLTextAreaElement).select()}
              />
              <button className="link-btn" onClick={() => setExportText(null)}>
                hide
              </button>
            </div>
          )}
        </div>

        <details className="import-block">
          <summary>Import identity from another device</summary>
          <p className="muted small">
            Pasting an identity string overwrites your current one. Game history & rating on this
            device stay unless you clear browser storage.
          </p>
          <textarea
            className="text-input mono"
            rows={3}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder="paste exported identity string"
          />
          <button
            className="primary-btn"
            disabled={!importText.trim()}
            onClick={async () => {
              try {
                const id = await importIdentity(importText.trim());
                setIdentity(id);
                setImportText('');
              } catch (e) {
                alert('Invalid identity string');
              }
            }}
          >
            Import
          </button>
        </details>
      </section>

      <section className="history-section">
        <h2>Recent games</h2>
        {summaries.length === 0 ? (
          <div className="muted">No games yet — go play one.</div>
        ) : (
          <table className="history-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Color</th>
                <th>Opponent</th>
                <th>Result</th>
                <th>Δ</th>
                <th>Rating</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((s) => {
                const tc = getTimeControl(s.timeControlId);
                const delta = s.ratingAfter - s.ratingBefore;
                const myResult =
                  s.outcome === 'draw' ? '½' : s.outcome === s.myColor ? '1' : '0';
                return (
                  <tr key={s.gameId}>
                    <td>{tc?.label ?? s.timeControlId}</td>
                    <td>{s.myColor}</td>
                    <td>
                      <span className="mono small">{s.opponentHandle}</span>
                    </td>
                    <td className={`result-${myResult === '1' ? 'win' : myResult === '0' ? 'loss' : 'draw'}`}>
                      {myResult}
                    </td>
                    <td className={delta >= 0 ? 'pos' : 'neg'}>
                      {delta >= 0 ? '+' : ''}{delta}
                    </td>
                    <td>{s.ratingAfter}</td>
                    <td className="muted small">{s.reason}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
