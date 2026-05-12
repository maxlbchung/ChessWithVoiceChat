type Props = {
  src: string | null;
  handle: string;
};

export function FinishAvatar({ src, handle }: Props) {
  const initial = (handle?.[0] ?? '?').toUpperCase();
  return src ? (
    <img className="finish-avatar" src={src} alt={handle} />
  ) : (
    <span className="finish-avatar" aria-hidden>{initial}</span>
  );
}

export function ResultAvatar({ src, handle }: Props) {
  const initial = (handle?.[0] ?? '?').toUpperCase();
  return src ? (
    <img className="result-avatar" src={src} alt={handle} />
  ) : (
    <span className="result-avatar" aria-hidden>{initial}</span>
  );
}
