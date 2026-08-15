const DEFAULT_LOBBY_COUNTDOWN_SECONDS = 30;

export async function lobbyCountdownSeconds(flags: Flagship): Promise<number> {
    return flags.getNumberValue("lobby-countdown-seconds", DEFAULT_LOBBY_COUNTDOWN_SECONDS);
}

export function lobbyEndsAt(now: number, countdownSeconds: number): number {
    return now + countdownSeconds * 1000;
}

export function lobbyRemainingMs(endsAt: number | null, now: number = Date.now()): number | null {
    return endsAt === null ? null : Math.max(0, endsAt - now);
}
