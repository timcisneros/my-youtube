// IndexedDB helpers for offline format file storage (chunk-based).
// Used by both app.js (window) and sw.js (importScripts).
// Global namespace — no modules.
var IDBHelpers = (function () {
  var DB_NAME = 'my-youtube-offline';
  var DB_VERSION = 2;
  var CHUNK_STORE = 'format-chunks';
  var META_STORE = 'format-meta';
  var CHUNK_SIZE = 2097152; // 2MB

  function open() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (event) {
        var db = req.result;
        // Drop old v1 store if upgrading
        if (event.oldVersion < 2 && db.objectStoreNames.contains('format-files')) {
          db.deleteObjectStore('format-files');
        }
        if (!db.objectStoreNames.contains(CHUNK_STORE)) {
          db.createObjectStore(CHUNK_STORE);
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE);
        }
        // Clear stale v1 meta entries (they reference deleted format-files blobs)
        if (event.oldVersion < 2 && db.objectStoreNames.contains(META_STORE)) {
          var metaStore = req.transaction.objectStore(META_STORE);
          var cursor = metaStore.openCursor();
          cursor.onsuccess = function () {
            var c = cursor.result;
            if (c) {
              // v1 meta has bytesDownloaded but no downloadedChunks
              if (c.value && !c.value.downloadedChunks && c.value.bytesDownloaded !== undefined) {
                c.delete();
              }
              c.continue();
            }
          };
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function putChunk(formatKey, index, blob) {
    var chunkKey = formatKey + ':' + index;
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(CHUNK_STORE, 'readwrite');
        tx.objectStore(CHUNK_STORE).put(blob, chunkKey);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function getChunk(formatKey, index) {
    var chunkKey = formatKey + ':' + index;
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(CHUNK_STORE, 'readonly');
        var req = tx.objectStore(CHUNK_STORE).get(chunkKey);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // Read chunks covering byte range [startByte, endByte] and assemble into a Blob.
  // Returns null if any required chunk is missing.
  function getChunksForRange(formatKey, startByte, endByte, meta) {
    var chunkSize = meta.chunkSize || CHUNK_SIZE;
    var startChunk = Math.floor(startByte / chunkSize);
    var endChunk = Math.floor(endByte / chunkSize);

    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(CHUNK_STORE, 'readonly');
        var store = tx.objectStore(CHUNK_STORE);
        var chunks = [];
        var pending = endChunk - startChunk + 1;
        var failed = false;

        for (var i = startChunk; i <= endChunk; i++) {
          (function (idx) {
            var req = store.get(formatKey + ':' + idx);
            req.onsuccess = function () {
              if (failed) return;
              if (!req.result) {
                failed = true;
                resolve(null);
                return;
              }
              chunks[idx - startChunk] = req.result;
              pending--;
              if (pending === 0) {
                // Assemble: slice first and last chunks to match exact byte range
                var parts = [];
                for (var j = 0; j < chunks.length; j++) {
                  var chunk = chunks[j];
                  var chunkStart = (startChunk + j) * chunkSize;
                  var sliceStart = (j === 0) ? startByte - chunkStart : 0;
                  var chunkEnd = chunkStart + chunk.size;
                  var sliceEnd = (j === chunks.length - 1) ? endByte - chunkStart + 1 : chunk.size;
                  if (sliceEnd > chunk.size) sliceEnd = chunk.size;
                  if (sliceStart === 0 && sliceEnd === chunk.size) {
                    parts.push(chunk);
                  } else {
                    parts.push(chunk.slice(sliceStart, sliceEnd));
                  }
                }
                resolve(new Blob(parts, { type: meta.contentType || 'application/octet-stream' }));
              }
            };
            req.onerror = function () {
              if (!failed) { failed = true; reject(req.error); }
            };
          })(i);
        }
      });
    });
  }

  // Read all chunks and assemble into a single Blob (for non-Range requests).
  // Returns null if any chunk is missing.
  function getAllChunks(formatKey, meta) {
    if (!meta || !meta.totalChunks) return Promise.resolve(null);
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(CHUNK_STORE, 'readonly');
        var store = tx.objectStore(CHUNK_STORE);
        var chunks = [];
        var pending = meta.totalChunks;
        var failed = false;

        for (var i = 0; i < meta.totalChunks; i++) {
          (function (idx) {
            var req = store.get(formatKey + ':' + idx);
            req.onsuccess = function () {
              if (failed) return;
              if (!req.result) {
                failed = true;
                resolve(null);
                return;
              }
              chunks[idx] = req.result;
              pending--;
              if (pending === 0) {
                resolve(new Blob(chunks, { type: meta.contentType || 'application/octet-stream' }));
              }
            };
            req.onerror = function () {
              if (!failed) { failed = true; reject(req.error); }
            };
          })(i);
        }
      });
    });
  }

  function putMeta(key, meta) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(META_STORE, 'readwrite');
        tx.objectStore(META_STORE).put(meta, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function getMeta(key) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(META_STORE, 'readonly');
        var req = tx.objectStore(META_STORE).get(key);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function deleteAllForVideo(videoId) {
    var prefix = videoId + ':';
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction([CHUNK_STORE, META_STORE], 'readwrite');
        var chunkStore = tx.objectStore(CHUNK_STORE);
        var metaStore = tx.objectStore(META_STORE);

        // Iterate all keys and delete those matching the videoId prefix
        var cursorReq = chunkStore.openCursor();
        cursorReq.onsuccess = function () {
          var cursor = cursorReq.result;
          if (cursor) {
            if (typeof cursor.key === 'string' && cursor.key.indexOf(prefix) === 0) {
              cursor.delete();
            }
            cursor.continue();
          }
        };

        var metaCursorReq = metaStore.openCursor();
        metaCursorReq.onsuccess = function () {
          var cursor = metaCursorReq.result;
          if (cursor) {
            if (typeof cursor.key === 'string' && cursor.key.indexOf(prefix) === 0) {
              cursor.delete();
            }
            cursor.continue();
          }
        };

        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  return {
    CHUNK_SIZE: CHUNK_SIZE,
    open: open,
    putChunk: putChunk,
    getChunk: getChunk,
    getChunksForRange: getChunksForRange,
    getAllChunks: getAllChunks,
    putMeta: putMeta,
    getMeta: getMeta,
    deleteAllForVideo: deleteAllForVideo
  };
})();
