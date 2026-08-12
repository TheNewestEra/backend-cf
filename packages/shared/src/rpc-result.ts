import {err, ok, type Result} from "neverthrow";

/** The wire-safe shape any fallible Durable Object RPC method or
 * `WorkerEntrypoint` service-binding method should actually return, instead
 * of a live `neverthrow` `Result` instance. Every such method — reachable
 * via `env.SOME_DO.getByName(id).method(...)` or `env.SOME_SERVICE.method(...)`
 * from a different Worker, and in some cases also same-instance from within
 * the owning class itself (see e.g. `apps/puzzle`'s `webSocketMessage()`
 * calling `this.join()`) — crosses Workers RPC's structural serialization at
 * least once in its life. A class instance crossing that boundary arrives on
 * the other side stripped of its prototype: `.match()`/`.isOk()`/`.andThen()`
 * are gone, a dead value masquerading as a live one. Each method builds its
 * `Result`/`Option` internally via neverthrow as usual (chaining
 * `.andThen()`, `.map()`, etc.) and only flattens to this shape at its very
 * last step, via `toRpcResult()`; a caller — whether across the RPC boundary
 * or same-instance — immediately rehydrates it back into a real `Result` via
 * `fromRpcResult()` and carries on matching/chaining as usual. This plain
 * shape is the one place either side ever steps outside neverthrow's own
 * types, and only because the RPC hop leaves no choice. Mirrors the pattern
 * first worked out in `apps/puzzle/src/puzzle.rpc.ts`, generalized here so
 * every service can share it instead of re-deriving its own copy. */
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function toRpcResult<T>(result: Result<T, string>): RpcResult<T> {
    return result.match(
        (value): RpcResult<T> => ({ok: true, value}),
        (error): RpcResult<T> => ({ok: false, error}),
    );
}

export function fromRpcResult<T>(result: RpcResult<T>): Result<T, string> {
    return result.ok ? ok(result.value) : err(result.error);
}
