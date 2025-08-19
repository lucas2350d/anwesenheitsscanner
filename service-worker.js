/* service-worker.js */
const CACHE_NAME = "anwesenheit-v3";
const ASSETS = ["", "index.html", "manifest.json", "logo.png", "icon-192.png", "icon-512.png"];
const URLS_TO_CACHE = ASSETS.map(p => new URL(p, self.registration.scope).toString());

// ---- IndexedDB Outbox (für Offline-Queue) ----
const DB_NAME = "anwesenheit-db";
const STORE_OUTBOX = "outbox";
const STORE_META = "meta";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        db.createObjectStore(STORE_OUTBOX, { keyPath: "key", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbTxn(store, mode, fn) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const st = tx.objectStore(store);
    let res;
    try { res = fn(st); } catch (e) { reject(e); return; }
    tx.oncomplete = () => resolve(res);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
const outboxAdd = (item) => dbTxn(STORE_OUTBOX, "readwrite", st => st.add({ ...item, createdAt: Date.now(), tries: item.tries ?? 0 }));
const outboxDelete = (key) => dbTxn(STORE_OUTBOX, "readwrite", st => st.delete(key));
const outboxCount = () => dbTxn(STORE_OUTBOX, "readonly", st => st.count());
const outboxAll = () => dbTxn(STORE_OUTBOX, "readonly", st => {
  return new Promise((resolve, reject) => {
    const items = [];
    const req = st.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) { items.push(cur.value); cur.continue(); }
      else resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
});
const metaSet = (key, value) => dbTxn(STORE_META, "readwrite", st => st.put({ key, value }));
const metaGet = (key) => dbTxn(STORE_META, "readonly", st => st.get(key)).then(v => (v ? v.value : null));

// ---- Install & Precaching ----
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const url of URLS_TO_CACHE) {
      const resp = await fetch(new Request(url, { cache: "reload" }));
      if (!resp.ok) throw new Error(`Precache failed for ${url}: ${resp.status}`);
      await cache.put(url, resp.clone());
    }
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k !== CACHE_NAME ? caches.delete(k) : undefined)));
    await self.clients.claim();
  })());
});

// ---- Fetch: Cache-first für Assets, Network für API ----
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Nur GET behandeln
  if (req.method !== "GET") return;

  // Für eigene Assets: Cache-first (ignoreSearch für ?v=…)
  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      return await fetch(req);
    } catch (_) {
      // Optionaler Navigation-Fallback könnte hier zurückgegeben werden
      return cached || Response.error();
    }
  })());
});

// ---- Background Sync ----
self.addEventListener("sync", (event) => {
  if (event.tag === "sync-attendance") {
    event.waitUntil(flushQueue());
  }
});

// ---- Nachrichten vom Client ----
self.addEventListener("message", async (event) => {
  const { type, payload } = event.data || {};
  try {
    if (type === "INIT") {
      // optional: könnte API speichern; hier nicht notwendig
      return;
    }
    if (type === "ENQUEUE") {
      // payload: { api, params }
      await outboxAdd({ api: payload.api, params: payload.params, tries: 0 });
      await notifyStatus();
      // Background Sync anfordern, wenn verfügbar
      if ("sync" in self.registration) {
        try { await self.registration.sync.register("sync-attendance"); } catch {}
      }
      return;
    }
    if (type === "GET_STATUS") {
      await notifyStatus();
      return;
    }
    if (type === "FLUSH") {
      await flushQueue();
      return;
    }
  } catch (e) {
    console.error("SW message error:", e);
  }
});

// ---- Queue flushen ----
async function flushQueue() {
  const items = await outboxAll();
  const total = items.length;
  if (total === 0) {
    await notifyStatus({ info: "Keine ausstehenden Einträge" });
    return;
  }
  await notifyStatus({ info: `Synchronisiere… (0/${total})` });

  let done = 0;
  for (const item of items) {
    const { key, api, params, tries = 0 } = item;
    try {
      const url = new URL(api);
      Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
      const res = await fetch(url.toString(), { method: "GET", headers: { "Accept": "application/json" } });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data && (data.ok || data.code === "already_marked")) {
        await outboxDelete(key);
        done++;
        await notifyProgress(done, total);
      } else {
        // Fachlicher Fehler: wir löschen den Eintrag, damit die Queue nicht hängt.
        // Wenn du wiederholen willst, entferne die nächste Zeile und implementiere Backoff/Retry.
        await outboxDelete(key);
        done++;
        await notifyProgress(done, total);
      }
    } catch (e) {
      // Netzwerkproblem: Abbrechen und später erneut versuchen
      // Optional: tries inkrementieren & Backoff implementieren
      console.warn("Sync Netzwerkfehler, später erneut:", e);
      break;
    }
  }

  await metaSet("lastSync", Date.now());
  await notifyStatus({ info: "Synchronisierung abgeschlossen" });
  await broadcast({ type: "SYNC_DONE" });
}

async function notifyProgress(done, total) {
  await broadcast({ type: "SYNC_PROGRESS", done, total });
}

async function notifyStatus(extra = {}) {
  const pending = await outboxCount();
  const lastSync = await metaGet("lastSync");
  await broadcast({ type: "QUEUE_STATUS", pending, lastSync, ...extra });
}

async function broadcast(msg) {
  const clis = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  for (const c of clis) c.postMessage(msg);
}
