/**
 * LRU Map — drop-in replacement for Map with insertion-order eviction.
 * When size exceeds maxSize, the oldest entries are evicted.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic defaults match Map convention
class LRUMap<K = any, V = any> {
  _max: number;
  _map: Map<K, V>;

  constructor(maxSize: number) {
    this._max = maxSize;
    this._map = new Map();
  }

  get size() { return this._map.size; }

  has(key: K) { return this._map.has(key); }

  get(key: K): V | undefined {
    if (!this._map.has(key)) return undefined;
    const value = this._map.get(key)!;
    // Move to end (most recently used)
    this._map.delete(key);
    this._map.set(key, value);
    return value;
  }

  set(key: K, value: V) {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, value);
    while (this._map.size > this._max) {
      this._map.delete(this._map.keys().next().value!);
    }
    return this;
  }

  delete(key: K) { return this._map.delete(key); }

  clear() { this._map.clear(); }

  keys() { return this._map.keys(); }
  values() { return this._map.values(); }
  entries() { return this._map.entries(); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches Map.forEach signature
  forEach(fn: (value: V, key: K, map: Map<K, V>) => void, thisArg?: any) { this._map.forEach(fn, thisArg); }
  [Symbol.iterator]() { return this._map[Symbol.iterator](); }
}

export default LRUMap;
