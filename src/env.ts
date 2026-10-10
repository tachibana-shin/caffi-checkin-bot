/**
 * Where the runtime keeps its environment — the one thing three platforms do
 * differently.
 *
 * `polling` (local) and the Deno Deploy shape have `Deno.env`. The Cloudflare
 * Workers shape has no `Deno` global at all: it hands a per-invocation `env`
 * binding to the handler, and anything read at module scope would run before
 * that. So this module is the indirection — it holds nothing else, because
 * `src/worker.ts` imports it while the global scope is being evaluated, before
 * the bindings exist.
 *
 * The two shapes also *read* differently: `Deno.env` exposes `get()` (plain
 * property access on it yields undefined), while Cloudflare's binding is a
 * plain record. `envValue` speaks both.
 */
type EnvSource =
  | Record<string, string | undefined>
  | { get(name: string): string | undefined };

/** `Deno.env` when the runtime has one; an empty object on workerd. */
function nativeEnv(): EnvSource {
  const g = globalThis as unknown as { Deno?: { env?: EnvSource } };
  return g.Deno?.env ?? {};
}

let env: EnvSource = nativeEnv();

/** Point the config at a different environment — the Cloudflare `env` binding. */
export function useEnv(source: EnvSource): void {
  env = source;
}

export function envValue(name: string): string | undefined {
  const source = env as EnvSource & { get?: (n: string) => string | undefined };
  return typeof source.get === "function"
    ? source.get(name)
    : (source as Record<string, string | undefined>)[name];
}
