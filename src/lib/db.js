// IndexedDB 轻量封装：存小说全文、文风档案、长篇写作项目、续写页草稿（突破 localStorage 5MB 限制）
const DB_NAME = 'novel-assistant'
const DB_VERSION = 4

let dbPromise = null

function openDB() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('styles')) db.createObjectStore('styles', { keyPath: 'bookId' })
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('analyses')) db.createObjectStore('analyses', { keyPath: 'id' }) // 拆书工作台：全局参考作品资产（只存叙事功能结论，不含原作专名）
      // 续写页工作草稿：原文可能是整本导入的小说，localStorage 的 5MB 配额会直接抛错，所以走 IndexedDB
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
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
  })
}

export async function del(store, id) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite')
    t.objectStore(store).delete(id)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}

export async function clearStore(store) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite')
    t.objectStore(store).clear()
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}
