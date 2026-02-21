export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private size = 0;

  constructor(private capacity: number) {
    this.buffer = Array.from<T | undefined>({ length: capacity });
  }

  push(item: T) {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  getAll(): T[] {
    if (this.size === 0) return [];
    const result: T[] = [];
    const start = (this.head - this.size + this.capacity) % this.capacity;
    for (let i = 0; i < this.size; i++) {
      result.push(this.buffer[(start + i) % this.capacity] as T);
    }
    return result;
  }

  clear() {
    this.buffer = Array.from<T | undefined>({ length: this.capacity });
    this.head = 0;
    this.size = 0;
  }

  get length(): number {
    return this.size;
  }
}
