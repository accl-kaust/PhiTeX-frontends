// The folders kept in sync with where they are stored (any Storage: an
// Overleaf project, project.ts; memory, in tests). A change shows at once,
// and is saved shortly after with the others made meanwhile; if the stored
// copy changed since it was read (another tab, another device), the changes
// are replayed onto that copy instead of overwriting it.

import { apply, empty, type Op, type State } from "./folders.ts";

export type Storage = {
  /** The stored state, null if none yet. */
  read(): Promise<State | null>;
  write(s: State): Promise<void>;
};

export class Folders {
  /** The state shown: the last stored one, with the unsaved changes on it. */
  state: State = empty();
  private stored: State = empty();
  private pending: Op[] = [];
  private listeners = new Set<(s: State) => void>();
  private saving: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  private storage: Storage;
  private delay: number;

  /** `initial`: a copy to show until load() has read the stored one (say, the last one seen here). */
  constructor(storage: Storage, delay = 400, initial: State | null = null) {
    this.storage = storage;
    this.delay = delay;
    if (initial) this.state = this.stored = initial;
  }

  async load(): Promise<void> {
    this.stored = (await this.storage.read()) ?? empty();
    this.show();
  }

  /** Told when a save made by do() fails (its changes stay pending, saved with the next). */
  onError: (e: Error) => void = () => {};

  /** Makes a change: shown now, saved soon. */
  do(...ops: Op[]): void {
    this.pending.push(...ops);
    this.show();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save().catch((e) => this.onError(e)), this.delay);
  }

  /** Saves the pending changes (resolving once stored); a failure keeps them pending and rejects. */
  save(): Promise<void> {
    clearTimeout(this.timer);
    this.saving ??= (async () => {
      try {
        while (this.pending.length) {
          const ops = this.pending.slice();
          const remote = (await this.storage.read()) ?? empty();
          if (remote.rev !== this.stored.rev) this.stored = remote;
          const next = { ...ops.reduce(apply, this.stored), rev: this.stored.rev + 1 };
          await this.storage.write(next);
          this.stored = next;
          this.pending.splice(0, ops.length);
          this.show();
        }
      } finally {
        this.saving = null;
      }
    })();
    return this.saving;
  }

  /** Calls `fn` on every change of the state shown (and now); returns the unsubscribe. */
  subscribe(fn: (s: State) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private show() {
    this.state = this.pending.reduce(apply, this.stored);
    for (const fn of this.listeners) fn(this.state);
  }
}

/** A Storage in memory (tests, or no storage). */
export function memoryStorage(initial: State | null = null): Storage & { data: State | null } {
  return {
    data: initial,
    async read() {
      return this.data && structuredClone(this.data);
    },
    async write(s) {
      this.data = structuredClone(s);
    },
  };
}
