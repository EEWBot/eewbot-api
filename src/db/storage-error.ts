/** Intentionally omits the original D1 error/cause, which can contain bound secrets. */
export class StorageError extends Error {
  override readonly name = 'StorageError'

  constructor() {
    super('Storage operation failed')
  }
}

/** Runs a D1 operation, replacing any failure with a sanitized StorageError. */
export async function storage<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch {
    throw new StorageError()
  }
}
