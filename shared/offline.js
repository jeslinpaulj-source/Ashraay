(function (global) {
  "use strict";

  const databaseName = "ashraay-mobile";
  const storeName = "outbox";
  const allowedPaths = new Set(["/reports", "/check-ins"]);
  let databasePromise;
  let flushing = false;

  function database() {
    if (!("indexedDB" in global)) {
      return Promise.reject(new Error("Offline storage is not available in this browser."));
    }
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = global.indexedDB.open(databaseName, 1);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore(storeName, { keyPath: "id" });
          store.createIndex("createdAt", "createdAt");
        };
        request.onsuccess = () => {
          request.result.onversionchange = () => {
            request.result.close();
            databasePromise = undefined;
          };
          resolve(request.result);
        };
        request.onerror = () => {
          databasePromise = undefined;
          reject(request.error || new Error("Could not open offline storage."));
        };
      });
    }
    return databasePromise;
  }

  async function transaction(mode, action) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const request = action(tx.objectStore(storeName));
      let result;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error || new Error("Offline storage operation failed."));
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error("Offline storage transaction failed."));
    });
  }

  async function enqueue(path, body, idempotencyKey, ownerSubject) {
    if (!allowedPaths.has(path)) throw new Error("Only citizen reports and safety check-ins can be queued offline.");
    if (!body || body.consent !== true) throw new Error("Consent is required before saving an offline submission.");
    if (typeof ownerSubject !== "string" || !ownerSubject.trim()) {
      throw new Error("Sign-in is required before saving an offline submission.");
    }
    if (typeof idempotencyKey !== "string" || !idempotencyKey || idempotencyKey.length > 128) {
      throw new Error("A valid idempotency key is required.");
    }
    if (
      typeof body.landmark !== "string" || body.landmark.length < 3 || body.landmark.length > 160 ||
      (path === "/reports" && (
        typeof body.description !== "string" || body.description.length < 10 || body.description.length > 1000 ||
        !Number.isInteger(body.people) || body.people < 0 || body.people > 500
      )) ||
      (path === "/check-ins" && !["safe", "at_risk", "need_help"].includes(body.status))
    ) throw new Error("Invalid offline report or check-in. Check the form fields.");
    const entry = {
      id: idempotencyKey,
      path,
      body,
      ownerSubject,
      createdAt: new Date().toISOString(),
      attempts: 0,
      lastError: null
    };
    await transaction("readwrite", (store) => store.add(entry));
    global.dispatchEvent(new CustomEvent("ashraay:offline-queue-change"));
    return entry;
  }

  async function entries() {
    return transaction("readonly", (store) => store.index("createdAt").getAll());
  }

  async function clear(ownerSubject) {
    if (typeof ownerSubject !== "string" || !ownerSubject.trim()) throw new Error("Sign-in is required before clearing offline submissions.");
    for (const entry of await entries()) {
      if (entry.ownerSubject === ownerSubject) {
        await transaction("readwrite", (store) => store.delete(entry.id));
      }
    }
    global.dispatchEvent(new CustomEvent("ashraay:offline-queue-change"));
  }

  async function flush(send, ownerSubject) {
    if (typeof ownerSubject !== "string" || !ownerSubject.trim()) throw new Error("Sign-in is required before syncing offline submissions.");
    if (flushing) return { sent: 0, queued: (await entries()).length };
    flushing = true;
    let sent = 0;
    try {
      for (const entry of await entries()) {
        if (entry.ownerSubject !== ownerSubject) continue;
        try {
          await send(entry);
          await transaction("readwrite", (store) => store.delete(entry.id));
          sent += 1;
        } catch (error) {
          entry.attempts += 1;
          entry.lastError = error.message;
          await transaction("readwrite", (store) => store.put(entry));
          throw error;
        }
      }
    } finally {
      flushing = false;
      global.dispatchEvent(new CustomEvent("ashraay:offline-queue-change"));
    }
    return { sent, queued: (await entries()).length };
  }

  global.ashraayOffline = { enqueue, entries, flush, clear };
})(window);
