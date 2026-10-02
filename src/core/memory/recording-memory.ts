import type { MemoryStore } from "./json-memory.js"

/** Observe completed mutations at the storage boundary, never planned writes. */
export class RecordingMemory implements MemoryStore {
  constructor(
    private readonly inner: MemoryStore,
    private readonly record: (key: string) => void,
  ) {}

  async save<T>(key: string, value: T): Promise<void> {
    await this.inner.save(key, value)
    this.record(key)
  }

  async remove(key: string): Promise<void> {
    await this.inner.remove(key)
    this.record(key)
  }

  get<T>(key: string): Promise<T | null> {
    return this.inner.get<T>(key)
  }
  readRaw(key: string): Promise<string | null> {
    return this.inner.readRaw(key)
  }
  search(query: string): Promise<unknown[]> {
    return this.inner.search(query)
  }
  keys(): Promise<string[]> {
    return this.inner.keys()
  }
}
