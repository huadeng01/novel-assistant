// IndexedDB 轻量封装：存小说全文、文风档案、续写页草稿（突破 localStorage 5MB 限制）
const DB_NAME = 'novel-assistant'
const DB_VERSION = 6

let dbPromise = null

function openDB() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('styles')) db.createObjectStore('styles', { keyPath: 'bookId' })
      // 续写页工作草稿：原文可能是整本导入的小说，localStorage 的 5MB 配额会直接抛错，所以走 IndexedDB
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'id' })
      // 拆书工作台 analyses 表已废弃（全项目无读写）：升级时清除旧库残留
      if (db.objectStoreNames.contains('analyses')) db.deleteObjectStore('analyses')
      // projects 表随暗箱流水线废弃（正常建书全进 books，无任何页面 put('projects')）：升级时清除旧库残留
      if (db.objectStoreNames.contains('projects')) db.deleteObjectStore('projects')
    }
    req.onsuccess = () => {
      const db = req.result
      // M-5：连接建立后被浏览器关闭（其他标签页升级触发 versionchange、或存储被驱逐）时，清掉缓存的 dbPromise，
      //   否则后续所有操作会复用一个已关闭的连接、事务永不 settle、无限挂起。onclose 兜住浏览器主动关闭。
      db.onversionchange = () => db.close()
      db.onclose = () => { dbPromise = null }
      resolve(db)
    }
    req.onerror = () => reject(req.error)
    // M13：升级被其他标签页的旧连接阻塞时给出人话错误，否则 promise 永不 settle、所有数据库操作无限挂起
    req.onblocked = () => reject(new Error('数据库升级被阻塞，请关闭其他打开本应用的标签页后重试'))
  })
  // M13：打开失败时清掉缓存的 rejected promise，允许下次重试；否则一次失败后所有操作永远复用同一个 rejection 直到刷新
  dbPromise.catch(() => {
    dbPromise = null
  })
  return dbPromise
}

export async function getAll(store) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })
}

export async function getById(store, id) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(id)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function put(store, value) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite')
    t.objectStore(store).put(value)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error || new Error('写入被中止（可能存储空间不足）')) // M14：事务中止也要 settle，否则 await 永久挂起
  })
}

export async function del(store, id) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite')
    t.objectStore(store).delete(id)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error || new Error('删除被中止')) // M14
  })
}

export async function clearStore(store) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite')
    t.objectStore(store).clear()
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error || new Error('清空被中止')) // M14
  })
}
