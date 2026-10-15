/** Bounds even an adapter that ignores its signal, without leaving an abort listener behind. */
export async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) { void promise.catch(() => undefined); signal.throwIfAborted() }
  let abort!: () => void
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason ?? new Error('Operation cancelled.'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally { signal.removeEventListener('abort', abort) }
}
