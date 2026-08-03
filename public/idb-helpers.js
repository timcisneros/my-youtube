// IndexedDB helpers for offline format file storage (chunk-based).
// Used by both app.js (window) and sw.js (importScripts).
// Global namespace — no modules.
var IDBHelpers = (function () {
  var DB_NAME = 'my-youtube-offline';
  var DB_VERSION = 4;
  var CHUNK_STORE = 'format-chunks';
  var META_STORE = 'format-meta';
  var CATALOG_STORE = 'download-catalog';
  var CHUNK_SIZE = 2097152; // 2MB
  var openPromise = null;
  var openDatabase = null;

  function open() {
    if (openDatabase) return Promise.resolve(openDatabase);
    if (openPromise) return openPromise;
    openPromise = new Promise(function (resolve, reject) {
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
        var catalogStore;
        if (!db.objectStoreNames.contains(CATALOG_STORE)) {
          catalogStore = db.createObjectStore(CATALOG_STORE, { keyPath: 'video_id' });
          catalogStore.createIndex('prepared', 'prepared', { unique: false });
        } else {
          catalogStore = req.transaction.objectStore(CATALOG_STORE);
        }
        if (!catalogStore.indexNames.contains('prepared_updated_at')) {
          catalogStore.createIndex('prepared_updated_at', ['prepared', 'updated_at', 'video_id'], { unique: false });
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
      req.onsuccess = function () {
        openDatabase = req.result;
        openDatabase.onversionchange = function () {
          openDatabase.close();
          openDatabase = null;
          openPromise = null;
        };
        resolve(openDatabase);
      };
      req.onerror = function () {
        openPromise = null;
        reject(req.error);
      };
      req.onblocked = function () {
        openPromise = null;
        reject(new Error('IndexedDB upgrade blocked by another tab'));
      };
    });
    return openPromise;
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

  // Produce a sequential stream instead of loading a complete format into
  // memory. This is used by the service worker for full-file responses.
  function createChunkStream(formatKey, startByte, endByte, meta) {
    var chunkSize = meta.chunkSize || CHUNK_SIZE;
    var currentChunk = Math.floor(startByte / chunkSize);
    var endChunk = Math.floor(endByte / chunkSize);
    var cancelled = false;

    return new ReadableStream({
      pull: function (controller) {
        if (cancelled) return;
        if (currentChunk > endChunk) {
          controller.close();
          return;
        }
        var index = currentChunk++;
        return getChunk(formatKey, index).then(function (chunk) {
          if (!chunk) throw new Error('Offline format chunk is missing');
          var absoluteStart = index * chunkSize;
          var sliceStart = index === Math.floor(startByte / chunkSize) ? startByte - absoluteStart : 0;
          var sliceEnd = index === endChunk ? endByte - absoluteStart + 1 : chunk.size;
          if (sliceEnd > chunk.size) sliceEnd = chunk.size;
          return chunk.slice(sliceStart, sliceEnd).arrayBuffer();
        }).then(function (bytes) {
          if (cancelled) return;
          controller.enqueue(new Uint8Array(bytes));
          if (currentChunk > endChunk) controller.close();
        }).catch(function (error) {
          if (!cancelled) controller.error(error);
        });
      },
      cancel: function () { cancelled = true; }
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

  function upsertDownloadRecords(records) {
    if (!Array.isArray(records) || records.length === 0) return Promise.resolve();
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(CATALOG_STORE, 'readwrite');
        var store = tx.objectStore(CATALOG_STORE);
        records.forEach(function (record) {
          if (!record || !record.video_id) return;
          var req = store.get(String(record.video_id));
          req.onsuccess = function () {
            var existing = req.result || {};
            store.put({
              video_id: String(record.video_id),
              title: String(record.title || existing.title || ''),
              channel_title: String(record.channel_title || existing.channel_title || ''),
              prepared: record.prepared || existing.prepared ? 1 : 0,
              updated_at: Number(record.updated_at) || Date.now()
            });
          };
        });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('IndexedDB transaction aborted')); };
      });
    });
  }

  function getDownloadRecord(videoId) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(CATALOG_STORE, 'readonly');
        var req = tx.objectStore(CATALOG_STORE).get(String(videoId));
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function getDownloadRecords(videoIds) {
    var ids = Array.isArray(videoIds)
      ? videoIds.map(String).filter(function (id, index, values) {
          return id && values.indexOf(id) === index;
        }).slice(0, 200)
      : [];
    if (ids.length === 0) return Promise.resolve([]);
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(CATALOG_STORE, 'readonly');
        var store = tx.objectStore(CATALOG_STORE);
        var records = new Array(ids.length);
        var pending = ids.length;
        var failed = false;
        ids.forEach(function (id, index) {
          var req = store.get(id);
          req.onsuccess = function () {
            if (failed) return;
            records[index] = req.result || null;
            pending--;
            if (pending === 0) resolve(records.filter(Boolean));
          };
          req.onerror = function () {
            if (failed) return;
            failed = true;
            reject(req.error);
          };
        });
      });
    });
  }

  function getPreparedDownloadPage(options) {
    options = options || {};
    var limit = Math.min(100, Math.max(1, Number(options.limit) || 50));
    var cursor = options.cursor && Number.isFinite(Number(options.cursor.updated_at))
      && typeof options.cursor.video_id === 'string'
      ? { updated_at: Number(options.cursor.updated_at), video_id: options.cursor.video_id }
      : null;
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(CATALOG_STORE, 'readonly');
        var index = tx.objectStore(CATALOG_STORE).index('prepared_updated_at');
        var lower = [1, 0, ''];
        var upper = cursor
          ? [1, cursor.updated_at, cursor.video_id]
          : [1, Number.MAX_SAFE_INTEGER, '\uffff'];
        var range = IDBKeyRange.bound(lower, upper, false, Boolean(cursor));
        var req = index.openCursor(range, 'prev');
        var records = [];
        req.onsuccess = function () {
          var current = req.result;
          if (!current || records.length >= limit + 1) {
            var hasMore = records.length > limit;
            var items = hasMore ? records.slice(0, limit) : records;
            var last = items[items.length - 1];
            resolve({
              items: items,
              nextCursor: hasMore && last
                ? { updated_at: Number(last.updated_at) || 0, video_id: String(last.video_id) }
                : null
            });
            return;
          }
          records.push(current.value);
          current.continue();
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function getPreparedDownloadRecords() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(CATALOG_STORE, 'readonly');
        var req = tx.objectStore(CATALOG_STORE).index('prepared').getAll(IDBKeyRange.only(1));
        req.onsuccess = function () {
          var records = req.result || [];
          records.sort(function (a, b) { return (b.updated_at || 0) - (a.updated_at || 0); });
          resolve(records);
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function setDownloadPrepared(videoId, prepared) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(CATALOG_STORE, 'readwrite');
        var store = tx.objectStore(CATALOG_STORE);
        var req = store.get(String(videoId));
        req.onsuccess = function () {
          var existing = req.result || {
            video_id: String(videoId),
            title: '',
            channel_title: ''
          };
          existing.prepared = prepared ? 1 : 0;
          existing.updated_at = Date.now();
          store.put(existing);
        };
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('IndexedDB transaction aborted')); };
      });
    });
  }

  function deleteDownloadRecord(videoId) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(CATALOG_STORE, 'readwrite');
        tx.objectStore(CATALOG_STORE).delete(String(videoId));
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function deleteFormat(formatKey) {
    var chunkPrefix = formatKey + ':';
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction([CHUNK_STORE, META_STORE], 'readwrite');
        tx.objectStore(CHUNK_STORE).delete(IDBKeyRange.bound(chunkPrefix, chunkPrefix + '\uffff'));
        tx.objectStore(META_STORE).delete(formatKey);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('IndexedDB transaction aborted')); };
      });
    });
  }

  function deleteAllForVideo(videoId) {
    var prefix = videoId + ':';
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction([CHUNK_STORE, META_STORE, CATALOG_STORE], 'readwrite');
        var chunkStore = tx.objectStore(CHUNK_STORE);
        var metaStore = tx.objectStore(META_STORE);

        // String keys are ordered, so a bounded key range deletes only this
        // video's records without scanning the complete offline library.
        var range = IDBKeyRange.bound(prefix, prefix + '\uffff');
        chunkStore.delete(range);
        metaStore.delete(range);
        tx.objectStore(CATALOG_STORE).delete(String(videoId));

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
    createChunkStream: createChunkStream,
    putMeta: putMeta,
    getMeta: getMeta,
    upsertDownloadRecords: upsertDownloadRecords,
    getDownloadRecord: getDownloadRecord,
    getDownloadRecords: getDownloadRecords,
    getPreparedDownloadPage: getPreparedDownloadPage,
    getPreparedDownloadRecords: getPreparedDownloadRecords,
    setDownloadPrepared: setDownloadPrepared,
    deleteDownloadRecord: deleteDownloadRecord,
    deleteFormat: deleteFormat,
    deleteAllForVideo: deleteAllForVideo
  };
})();
