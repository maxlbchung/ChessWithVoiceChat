import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useIdentityStore } from '../store/identityStore';
import {
  loadAggregateStats,
  loadDaySummaries,
  loadGameRecord,
  loadHistoryIndex,
  loadPinnedSummaries,
  togglePinnedGame,
  type AggregateStats,
} from '../lib/storage';
import type { LocalGameSummary } from '../lib/types';
import { getTimeControl, type GameVariant } from '../lib/timeControls';
import { fileToAvatarDataUrl } from '../lib/avatar';
import { buildGameExport, downloadGameExport } from '../lib/gameExport';

export function Profile() {
  const { identity, rating, avatar, setHandle, setAvatar } = useIdentityStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [editingHandle, setEditingHandle] = useState(false);
  const [handleDraft, setHandleDraft] = useState('');

  // History pagination state. `dates` is the manifest of dates that have at
  // least one game, newest first. `viewIdx` is which date we're currently
  // showing. `daySummaries` is that date's bucket. Aggregate stats come from
  // their own counter key so we don't have to walk every bucket.
  const [dates, setDates] = useState<string[]>([]);
  const [viewIdx, setViewIdx] = useState(0);
  const [daySummaries, setDaySummaries] = useState<LocalGameSummary[]>([]);
  const [aggregate, setAggregate] = useState<AggregateStats>({ wins: 0, losses: 0, draws: 0, total: 0 });
  // Pinned games — a starred shortlist shown above history, persisted on its
  // own key so it survives day-bucket navigation and reloads.
  const [pinned, setPinned] = useState<LocalGameSummary[]>([]);
  const pinnedIds = useMemo(() => new Set(pinned.map((p) => p.gameId)), [pinned]);

  useEffect(() => {
    Promise.all([loadHistoryIndex(), loadAggregateStats(), loadPinnedSummaries()]).then(([d, a, p]) => {
      setDates(d);
      setAggregate(a);
      setPinned(p);
    });
  }, []);

  const togglePin = async (summary: LocalGameSummary) => {
    setPinned(await togglePinnedGame(summary));
  };

  // Load the currently-viewed day's bucket whenever the cursor moves.
  useEffect(() => {
    if (dates.length === 0) {
      setDaySummaries([]);
      return;
    }
    const date = dates[Math.min(viewIdx, dates.length - 1)];
    loadDaySummaries(date).then(setDaySummaries);
  }, [dates, viewIdx]);

  if (!identity) {
    return (
      <div className="page-narrow">
        <h1 className="page-title">No profile yet</h1>
        <p className="muted">Head back to the lobby to pick a handle.</p>
      </div>
    );
  }

  // Pull a stored record and trigger a JSON download. Hero matches saved
  // before hero-pick storage can't be exported for replay (the export would
  // be missing its heroes and fail to re-import).
  const exportGame = async (gameId: string) => {
    const rec = await loadGameRecord(gameId);
    if (!rec) {
      alert('That game record is no longer in local storage.');
      return;
    }
    const tc = getTimeControl(rec.timeControlId);
    if (!tc) {
      alert('Unknown time control on that record.');
      return;
    }
    if (tc.variant === 'hero' && !rec.heroes) {
      alert('This hero match was saved before hero picks were stored, so it can’t be exported for replay.');
      return;
    }
    const exp = buildGameExport({
      variant: tc.variant,
      gameId: rec.gameId,
      timeControlId: rec.timeControlId,
      white: rec.white,
      black: rec.black,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
      outcome: rec.outcome,
      reason: rec.reason,
      moves: rec.moves,
      heroes: rec.heroes,
      heroBackRanks: rec.heroBackRanks,
    });
    downloadGameExport(exp);
  };

  const currentDate = dates[Math.min(viewIdx, Math.max(0, dates.length - 1))];
  const canPrev = viewIdx < dates.length - 1; // older
  const canNext = viewIdx > 0; // newer

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
              {aggregate.wins}W / {aggregate.losses}L / {aggregate.draws}D
              <span className="muted small"> ({aggregate.total} total)</span>
            </div>
          </div>
        </div>
      </section>

      <section className="history-section">
        <h2>Pinned games</h2>
        {pinned.length === 0 ? (
          <div className="muted">No pinned games yet — use the Pin button in your history below to keep games here.</div>
        ) : (
          <DaySummaryTable
            summaries={pinned}
            pinnedIds={pinnedIds}
            onExport={(id) => void exportGame(id)}
            onTogglePin={(s) => void togglePin(s)}
          />
        )}
      </section>

      <section className="history-section">
        <h2>Game history</h2>
        {dates.length === 0 ? (
          <div className="muted">No games yet — go play one.</div>
        ) : (
          <>
            <DateNav
              dates={dates}
              viewIdx={viewIdx}
              onPrev={() => canPrev && setViewIdx((i) => i + 1)}
              onNext={() => canNext && setViewIdx((i) => i - 1)}
              onJump={(date) => {
                const idx = dates.indexOf(date);
                if (idx >= 0) setViewIdx(idx);
              }}
              onLatest={() => setViewIdx(0)}
              currentDate={currentDate}
            />
            <DaySummaryTable
              summaries={daySummaries}
              pinnedIds={pinnedIds}
              onExport={(id) => void exportGame(id)}
              onTogglePin={(s) => void togglePin(s)}
            />
          </>
        )}
      </section>
    </div>
  );
}

function DateNav({
  dates,
  viewIdx,
  onPrev,
  onNext,
  onJump,
  onLatest,
  currentDate,
}: {
  dates: string[];
  viewIdx: number;
  onPrev: () => void;
  onNext: () => void;
  onJump: (date: string) => void;
  onLatest: () => void;
  currentDate: string | undefined;
}) {
  const canPrev = viewIdx < dates.length - 1;
  const canNext = viewIdx > 0;
  // Min and max for the date picker: oldest and newest in the manifest.
  const min = dates[dates.length - 1];
  const max = dates[0];

  const label = useMemo(() => {
    if (!currentDate) return '';
    // YYYY-MM-DD → local Date at midnight. Use components to avoid the TZ
    // shift that `new Date('2026-05-21')` would inject (it'd parse as UTC).
    const [y, m, d] = currentDate.split('-').map((n) => parseInt(n, 10));
    const date = new Date(y, (m - 1), d);
    return date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }, [currentDate]);

  // Position in the manifest, presented as "newer side has lower index" so
  // the user sees Page 1 = today and Page N = oldest.
  const pageNumber = dates.length - viewIdx;
  return (
    <div className="history-date-nav">
      <button
        className="free-play-btn"
        type="button"
        onClick={onPrev}
        disabled={!canPrev}
        title="Older day with games"
      >
        ← Older
      </button>
      <div className="history-date-center">
        <div className="history-date-label">{label}</div>
        <div className="muted small">
          {currentDate} · day {pageNumber} of {dates.length}
        </div>
      </div>
      <button
        className="free-play-btn"
        type="button"
        onClick={onNext}
        disabled={!canNext}
        title="Newer day with games"
      >
        Newer →
      </button>
      <div className="history-date-tools">
        <input
          type="date"
          className="text-input"
          value={currentDate ?? ''}
          min={min}
          max={max}
          onChange={(e) => onJump(e.target.value)}
          title="Jump to a specific day"
        />
        <button
          className="free-play-btn"
          type="button"
          onClick={onLatest}
          disabled={viewIdx === 0}
          title="Jump to the most recent day with games"
        >
          Latest
        </button>
      </div>
    </div>
  );
}

const VARIANT_LABEL: Record<GameVariant, string> = {
  normal: 'Normal',
  merge: 'Merge',
  two: 'Guerrilla',
  cash: 'Cash Money',
  hero: 'Hero',
};

function DaySummaryTable({
  summaries,
  pinnedIds,
  onExport,
  onTogglePin,
}: {
  summaries: LocalGameSummary[];
  pinnedIds: Set<string>;
  onExport: (gameId: string) => void;
  onTogglePin: (summary: LocalGameSummary) => void;
}) {
  const supported = summaries
    .map((summary) => ({ summary, timeControl: getTimeControl(summary.timeControlId) }))
    .filter((row): row is { summary: LocalGameSummary; timeControl: NonNullable<ReturnType<typeof getTimeControl>> } => !!row.timeControl);

  if (supported.length === 0) {
    return <div className="muted">No games on this day.</div>;
  }
  return (
    <table className="history-table">
      <thead>
        <tr>
          <th>Variant</th>
          <th>Time control</th>
          <th>Opponent</th>
          <th>Color</th>
          <th>Result</th>
          <th>Δ</th>
          <th>Rating</th>
          <th>Reason</th>
          <th>Date</th>
          <th></th>
          <th>Pin</th>
        </tr>
      </thead>
      <tbody>
        {supported.map(({ summary: s, timeControl: tc }) => {
          const variant = tc.variant;
          const delta = s.ratingAfter - s.ratingBefore;
          const myResult =
            s.outcome === 'draw' ? '½' : s.outcome === s.myColor ? '1' : '0';
          const isPinned = pinnedIds.has(s.gameId);
          return (
            <tr key={s.gameId}>
              <td>{VARIANT_LABEL[variant]}</td>
              <td>{tc.label}</td>
              <td>
                <span className="mono small">{s.opponentHandle}</span>
              </td>
              <td>{s.myColor}</td>
              <td className={`result-${myResult === '1' ? 'win' : myResult === '0' ? 'loss' : 'draw'}`}>
                {myResult}
              </td>
              <td className={delta >= 0 ? 'pos' : 'neg'}>
                {delta >= 0 ? '+' : ''}{delta}
              </td>
              <td>{s.ratingAfter}</td>
              <td className="muted small">{s.reason}</td>
              <td className="muted small">{new Date(s.endedAt).toLocaleString()}</td>
              <td>
                <div className="history-row-actions">
                  <button
                    className="link-btn"
                    type="button"
                    onClick={() => onExport(s.gameId)}
                    title="Download this game as JSON"
                  >
                    Export
                  </button>
                  <Link
                    className="link-btn"
                    to={`/review?game=${encodeURIComponent(s.gameId)}`}
                    title="Open this game in the Review page"
                  >
                    Review
                  </Link>
                </div>
              </td>
              <td>
                <button
                  className="link-btn"
                  type="button"
                  onClick={() => onTogglePin(s)}
                  title={isPinned ? 'Remove from pinned games' : 'Pin to the top of your profile'}
                >
                  {isPinned ? '★ Unpin' : '☆ Pin'}
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
