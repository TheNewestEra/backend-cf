export function generateColor(): string {
    const [hueRoll] = crypto.getRandomValues(new Uint32Array(1));
    const hue = (hueRoll ?? 0) % 360;
    return hslToHex(hue, 65, 55);
}

export const isValidHexColor = (color: string): boolean => /^#[0-9a-f]{6}$/i.test(color);

function hslToHex(h: number, s: number, l: number): string {
    const sFrac = s / 100;
    const lFrac = l / 100;
    const k = (n: number) => (n + h / 30) % 12;
    const a = sFrac * Math.min(lFrac, 1 - lFrac);
    const f = (n: number) => lFrac - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const toHex = (n: number) => Math.round(f(n) * 255).toString(16).padStart(2, "0");
    return `#${toHex(0)}${toHex(8)}${toHex(4)}`;
}
