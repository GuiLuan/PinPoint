const DB_NAME = 'pinpoint_cache_v1';
const DB_VERSION = 1;
const STORE_CANVASES = 'canvases';
const STORE_META = 'meta';

class IndexedDBCache {
  constructor() {
    this._dbPromise = null;
    this._memCanvases = new Map();
    this._memMeta = new Map();
  }

  _open() {
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_CANVASES)) {
            db.createObjectStore(STORE_CANVASES, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(STORE_META)) {
            db.createObjectStore(STORE_META);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
    return this._dbPromise;
  }

  async getCanvas(canvasId) {
    if (!canvasId) return null;
    if (this._memCanvases.has(canvasId)) {
      return JSON.parse(JSON.stringify(this._memCanvases.get(canvasId)));
    }
    const db = await this._open();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_CANVASES, 'readonly');
        const req = tx.objectStore(STORE_CANVASES).get(canvasId);
        req.onsuccess = () => {
          const val = req.result || null;
          if (val) this._memCanvases.set(canvasId, val);
          resolve(val ? JSON.parse(JSON.stringify(val)) : null);
        };
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  async putCanvas(canvasObj) {
    if (!canvasObj || !canvasObj.id) return;
    const copy = JSON.parse(JSON.stringify(canvasObj));
    this._memCanvases.set(copy.id, copy);
    const db = await this._open();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_CANVASES, 'readwrite');
        tx.objectStore(STORE_CANVASES).put(copy);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (e) {
        resolve();
      }
    });
  }

  async deleteCanvas(canvasId) {
    if (!canvasId) return;
    this._memCanvases.delete(canvasId);
    const db = await this._open();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_CANVASES, 'readwrite');
        tx.objectStore(STORE_CANVASES).delete(canvasId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (e) {
        resolve();
      }
    });
  }

  async getAllCanvases() {
    const db = await this._open();
    if (!db) {
      return [...this._memCanvases.values()].map(v => JSON.parse(JSON.stringify(v)));
    }
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_CANVASES, 'readonly');
        const req = tx.objectStore(STORE_CANVASES).getAll();
        req.onsuccess = () => {
          const list = Array.isArray(req.result) ? req.result : [];
          list.forEach(item => {
            if (item?.id) this._memCanvases.set(item.id, item);
          });
          resolve(list);
        };
        req.onerror = () => resolve([...this._memCanvases.values()]);
      } catch (e) {
        resolve([...this._memCanvases.values()]);
      }
    });
  }

  async clearCanvases() {
    this._memCanvases.clear();
    const db = await this._open();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_CANVASES, 'readwrite');
        tx.objectStore(STORE_CANVASES).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (e) {
        resolve();
      }
    });
  }

  async getMeta(key) {
    if (this._memMeta.has(key)) {
      return JSON.parse(JSON.stringify(this._memMeta.get(key)));
    }
    const db = await this._open();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_META, 'readonly');
        const req = tx.objectStore(STORE_META).get(key);
        req.onsuccess = () => {
          const val = req.result !== undefined ? req.result : null;
          if (val !== null) this._memMeta.set(key, val);
          resolve(val !== null ? JSON.parse(JSON.stringify(val)) : null);
        };
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  async setMeta(key, value) {
    const copy = value === undefined ? null : JSON.parse(JSON.stringify(value));
    this._memMeta.set(key, copy);
    const db = await this._open();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_META, 'readwrite');
        tx.objectStore(STORE_META).put(copy, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (e) {
        resolve();
      }
    });
  }
}

export const idbCache = new IndexedDBCache();
