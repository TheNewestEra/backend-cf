// Shared color generation for anything that needs a stable, readable
// display color without necessarily having an account behind it — used at
// account registration (see apps/accounts' `users.color`, generated once
// and stored forever) and, since the same need shows up per-game, by
// `GameDO`/`PuzzleDO` to give anonymous/guest participants a color of their
// own to broadcast alongside their name (see packages/shared/src/lobby.ts's
// doc comment for the broader lobby concept this supports).

/** Picks a random display color, e.g. "#4f9d69". Fixed saturation/lightness
 * (not a fully random hex) so every generated color reads well as text/
 * avatar fill against a light or dark background — only the hue varies. */
export function generateColor(): string {
  const [hueRoll] = crypto.getRandomValues(new Uint32Array(1));
  const hue = (hueRoll ?? 0) % 360;
  return hslToHex(hue, 65, 55);
}

function hslToHex(h: number, s: number, l: number): string {
  const sFrac = s / 100;
  const lFrac = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sFrac * Math.min(lFrac, 1 - lFrac);
  const f = (n: number) => lFrac - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (n: number) => Math.round(f(n) * 255).toString(16).padStart(2, "0");
  return `#${toHex(0)}${toHex(8)}${toHex(4)}`;
}
