// Standard ELO calculation. K=32 for new players, K=24 for established (>30 games).
const K_NEW = 32;
const K_ESTABLISHED = 24;
export const STARTING_ELO = 1200;

export function expectedScore(myRating: number, oppRating: number): number {
  return 1 / (1 + Math.pow(10, (oppRating - myRating) / 400));
}

export function eloDelta(
  myRating: number,
  oppRating: number,
  result: 1 | 0.5 | 0,
  gamesPlayed: number,
): number {
  const k = gamesPlayed < 30 ? K_NEW : K_ESTABLISHED;
  const expected = expectedScore(myRating, oppRating);
  return Math.round(k * (result - expected));
}

export function newRating(
  myRating: number,
  oppRating: number,
  result: 1 | 0.5 | 0,
  gamesPlayed: number,
): number {
  return myRating + eloDelta(myRating, oppRating, result, gamesPlayed);
}
