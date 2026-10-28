// Small promise wrapper around IndexedDB. Recordings are stored as Blobs, which IndexedDB keeps on disk.
//   kv        settings, flags and the metadata of recordings in progress ("session:<id>")
//   courses   { id, name, emoji, color, lecturer, room, slots, archived }
//   lectures  { id, courseId, title, date, durationMs, bookmarks, notes, … }
//   audio     lecture id → Blob
//   chunks    [session id, seq] → Blob — a recording is saved every few seconds while it runs

const NAME = 'lectern';
let opening = null;

export function open() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('kv');
      db.createObjectStore('courses', { keyPath: 'id' });
      db.createObjectStore('lectures', { keyPath: 'id' });
      db.createObjectStore('audio');
      db.createObjectStore('chunks');
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Close Lectern in your other tabs and try again.'));
  });
  return opening;
}

/**
 * Runs `fn(stores)` inside one transaction and resolves once it has committed.
 * If `fn` returns an IDBRequest (or an object of them) the result(s) are resolved too.
 */
export async function run(names, mode, fn) {
  const db = await open();
  const tx = db.transaction(names, mode);
  const stores = Object.fromEntries([names].flat().map((n) => [n, tx.objectStore(n)]));
  const out = fn(stores);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Saving failed'));
  });
  if (out instanceof IDBRequest) return out.result;
  if (out && typeof out === 'object' && Object.values(out).every((v) => v instanceof IDBRequest)) {
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.result]));
  }
  return out;
}

/** Key range covering every chunk of one recording session. */
export const sessionRange = (id) => IDBKeyRange.bound([id, 0], [id, Infinity]);
