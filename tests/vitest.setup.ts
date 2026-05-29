// Global Vitest setup. Loaded before any test file imports.
//
// Polyfills IndexedDB so the real `lib/firebase.ts` can call
// `initializeFirestore(app, { localCache: persistentLocalCache({ tabManager:
// persistentMultipleTabManager() }) })` verbatim under Node. Without this,
// Firestore's persistent cache init throws ("IndexedDB is not available").
//
// `fake-indexeddb/auto` registers a complete IndexedDB API on globalThis
// (Database/Transaction/ObjectStore/etc.), backed by an in-memory store.
// That's a closer mirror of production behavior than swapping the cache
// type — the multi-tab manager, the persistence write path, and the cache
// query layer all run the same code path they would in a browser.
import 'fake-indexeddb/auto'
