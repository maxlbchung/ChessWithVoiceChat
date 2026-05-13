import { FinishAvatar } from './EndScreenAvatars';

type Props = {
  whiteAvatar: string | null;
  whiteHandle: string;
  whiteRating: number;
  blackAvatar: string | null;
  blackHandle: string;
  blackRating: number;
  onDone: () => void;
};

// Brief intro overlay shown on the board the moment both players are
// connected. Fades in, holds, fades out via CSS animation; calls onDone
// when the animation completes so the caller can start the white clock.
export function StartOverlay({
  whiteAvatar,
  whiteHandle,
  whiteRating,
  blackAvatar,
  blackHandle,
  blackRating,
  onDone,
}: Props) {
  return (
    <div
      className="board-start-overlay"
      onAnimationEnd={(e) => {
        // Fire only on the wrapper's own animation, not bubbled child anims.
        if (e.target === e.currentTarget) onDone();
      }}
    >
      <div className="start-vs">
        <StartPlayer
          color="white"
          avatar={whiteAvatar}
          handle={whiteHandle}
          rating={whiteRating}
        />
        <div className="start-divider">vs</div>
        <StartPlayer
          color="black"
          avatar={blackAvatar}
          handle={blackHandle}
          rating={blackRating}
        />
      </div>
    </div>
  );
}

function StartPlayer({
  color,
  avatar,
  handle,
  rating,
}: {
  color: 'white' | 'black';
  avatar: string | null;
  handle: string;
  rating: number;
}) {
  return (
    <div className="start-player">
      <FinishAvatar src={avatar} handle={handle} />
      <div className="start-handle">{handle}</div>
      <div className="start-rating">{rating}</div>
      <div className={`start-color-banner ${color}-banner`}>
        {color === 'white' ? 'White' : 'Black'}
      </div>
    </div>
  );
}
