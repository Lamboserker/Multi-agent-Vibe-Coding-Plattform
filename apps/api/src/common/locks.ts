/** Serializes async critical sections (read-modify-write on persisted state). */
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn)
    this.tail = result.catch(() => undefined)
    return result
  }
}

/** One mutex per key (task, execution, session); idle keys are released again. */
export class KeyedMutex {
  private readonly locks = new Map<string, { mutex: AsyncMutex; users: number }>()

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let entry = this.locks.get(key)
    if (!entry) {
      entry = { mutex: new AsyncMutex(), users: 0 }
      this.locks.set(key, entry)
    }
    entry.users += 1
    try {
      return await entry.mutex.run(fn)
    } finally {
      entry.users -= 1
      if (entry.users === 0) this.locks.delete(key)
    }
  }
}
