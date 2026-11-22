// Everything ScanText remembers lives in this browser's IndexedDB — nothing is sent
// anywhere.
//
//   documents     extracted words per page, keyed by SHA-256 of the file + OCR languages.
//                 Only text and bounding boxes are stored, never page images.
//   translations  one entry per translated chunk, keyed by engine, languages and a hash
//                 of the source text — so re-translating the same text is instant.
//   settings      small key/value preferences (OCR languages, engine, theme…).
//
// Every call degrades to a no-op if IndexedDB is unavailable (private windows, blocked
// site data): the cache is a convenience and must never stop the app working.

const DB_NAME = "scantext-cache";
const DB_VERSION = 3;
const DOC_STORE = "documents";
const SETTINGS_STORE = "settings";
const TRANSLATION_STORE = "translations";

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of [DOC_STORE, SETTINGS_STORE, TRANSLATION_STORE]) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("IndexedDB upgrade blocked by another tab"));
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

async function read(store, key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(store, "readonly").objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function write(store, key, value) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* best effort */
  }
}

export async function hashBuffer(buf) {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// OCR output depends on which languages were loaded, so the language set is part of
// the key — otherwise switching Settings to Hindi would silently serve the old English
// read of the same file.
export function docCacheKey(hash, langs) {
  return `${hash}:${[...langs].sort().join("+")}`;
}

export const getCachedDoc = (key) => read(DOC_STORE, key);
export const saveCachedDoc = (key, data) => write(DOC_STORE, key, data);

export const getSetting = (key) => read(SETTINGS_STORE, key);
export const setSetting = (key, value) => write(SETTINGS_STORE, key, value);

// Translation chunk cache: an in-memory Map in front of IndexedDB.
const memory = new Map();
export const translationCache = {
  async get(key) {
    if (memory.has(key)) return memory.get(key);
    const v = await read(TRANSLATION_STORE, key);
    if (typeof v === "string") memory.set(key, v);
    return typeof v === "string" ? v : null;
  },
  async set(key, value) {
    memory.set(key, value);
    await write(TRANSLATION_STORE, key, value);
  },
};

export async function clearTranslationMemory() {
  memory.clear();
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(TRANSLATION_STORE, "readwrite");
      tx.objectStore(TRANSLATION_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
}
