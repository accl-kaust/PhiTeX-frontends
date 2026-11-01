// The WASI (preview 1) the core needs, on every thread alike, in a browser
// or Node: the clock, randomness, sleeping, stderr, and the environment
// the host gives (core.ts's `env`); no files (the core's come from the
// host, files.rs). A call std
// makes that the core never needs answers ENOSYS or, for a descriptor,
// EBADF, so std's start (its preopens' scan) finds nothing and goes on.

const EBADF = 8;
const ENOSYS = 52;

/** Thrown by `proc_exit`: the thread's wasm stops there. */
export class Exit extends Error {
  code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

/**
 * A sleep's wait (poll_oneoff): on a flag nobody sets; made at the first
 * sleep, and none where there is no shared memory (Firefox's single-threaded
 * core): there a sleep waits on the clock.
 */
let sleeper: Int32Array | null | undefined;
function sleep(ms: number): void {
  sleeper ??= typeof SharedArrayBuffer === "function" ? new Int32Array(new SharedArrayBuffer(4)) : null;
  if (sleeper) return void Atomics.wait(sleeper, 0, 0, ms);
  for (const end = performance.now() + ms; performance.now() < end; );
}

/** WASI on `memory`; `environ` as `NAME=value` (the engine's switches, e.g. PHITEX_TEX_TIME=1). */
export function wasi(memory: WebAssembly.Memory, stderr: (s: string) => void, environ: string[] = []): Record<string, (...a: any[]) => number> {
  const view = () => new DataView(memory.buffer);
  // (TextDecoder and getRandomValues take no views of shared memory: copies)
  const copy = (p: number, n: number) => new Uint8Array(memory.buffer).slice(p, p + n);
  const dec = new TextDecoder();
  // (each NUL-terminated)
  const env = environ.map((e) => new TextEncoder().encode(e + "\0"));
  const now = (id: number): bigint =>
    id === 0 ? BigInt(Date.now()) * 1_000_000n : BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
  const calls: Record<string, (...a: any[]) => number> = {
    environ_sizes_get(count: number, size: number) {
      view().setUint32(count, env.length, true);
      view().setUint32(size, env.reduce((a, e) => a + e.length, 0), true);
      return 0;
    },
    environ_get(ptrs: number, buf: number) {
      const v = view();
      const m = new Uint8Array(memory.buffer);
      env.forEach((e, i) => {
        v.setUint32(ptrs + 4 * i, buf, true);
        m.set(e, buf);
        buf += e.length;
      });
      return 0;
    },
    args_sizes_get(count: number, size: number) {
      view().setUint32(count, 0, true);
      view().setUint32(size, 0, true);
      return 0;
    },
    args_get: () => 0,
    clock_time_get(id: number, _precision: bigint, out: number) {
      view().setBigUint64(out, now(id), true);
      return 0;
    },
    random_get(p: number, n: number) {
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, i + 65536));
      new Uint8Array(memory.buffer).set(b, p);
      return 0;
    },
    fd_write(fd: number, iovs: number, n: number, written: number) {
      if (fd !== 1 && fd !== 2) return EBADF;
      const v = view();
      let total = 0;
      let s = "";
      for (let i = 0; i < n; i++) {
        const [p, len] = [v.getUint32(iovs + 8 * i, true), v.getUint32(iovs + 8 * i + 4, true)];
        s += dec.decode(copy(p, len), { stream: true });
        total += len;
      }
      stderr(s);
      v.setUint32(written, total, true);
      return 0;
    },
    // (a sleep: its subscriptions' first clock, waited for; one event)
    poll_oneoff(subs: number, events: number, n: number, count: number) {
      const v = view();
      let ns = 0n;
      for (let i = 0; i < n; i++) {
        const s = subs + 48 * i;
        if (v.getUint8(s + 8) === 0) {
          const t = v.getBigUint64(s + 24, true);
          ns = i === 0 || t < ns ? t : ns;
        }
      }
      if (ns > 0n) sleep(Number(ns / 1_000_000n));
      v.setBigUint64(events, v.getBigUint64(subs, true), true);
      v.setUint16(events + 8, 0, true);
      v.setUint8(events + 10, 0);
      v.setUint32(count, 1, true);
      return 0;
    },
    sched_yield: () => 0,
    proc_exit(code: number): number {
      throw new Exit(code);
    },
    fd_prestat_get: () => EBADF,
    fd_prestat_dir_name: () => EBADF,
    fd_close: () => EBADF,
    fd_fdstat_get: () => EBADF,
    fd_filestat_get: () => EBADF,
    fd_read: () => EBADF,
    fd_seek: () => EBADF,
  };
  return new Proxy(calls, { get: (c, name: string) => (c[name] ? unsigned(c[name]) : () => ENOSYS) });
}

/**
 * `f` with its number arguments as wasm's unsigned 32-bit values: JS sees
 * an i32 as signed, so a pointer at or above 2 GiB comes as a negative
 * number (a DataView offset that throws, a slice that counts from the
 * end). Every preview1 integer is unsigned (pointers, sizes, fds, the exit
 * code), and so are the core's own imports' (pointers and lengths).
 */
export function unsigned<F extends (...a: any[]) => any>(f: F): F {
  return ((...a: unknown[]) => f(...a.map((x) => (typeof x === "number" ? x >>> 0 : x)))) as F;
}
