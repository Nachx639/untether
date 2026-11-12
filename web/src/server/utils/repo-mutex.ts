/**
 * One queue per repository: work that moves a repository's branches (merging a task into its
 * base) runs one at a time per repository, in the order it asked, while other repositories go
 * on in parallel. A failing job never blocks the ones after it.
 */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  /** Run `job` once every earlier job for `key` has settled. */
  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(job, job);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Whether `key` has a job running or waiting. */
  isBusy(key: string): boolean {
    return this.tails.has(key);
  }
}

/** Shared by the merge pipeline: merges into one repository never overlap. */
export const repoMutex = new KeyedMutex();
