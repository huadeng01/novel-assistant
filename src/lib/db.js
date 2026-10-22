// IndexedDB 轻量封装：存小说全文、文风档案、各页工作草稿（这些内容可能远超 localStorage 的 5MB 配额）。
// 库名 novel-assistant，三张表：books（keyPath id）、styles（keyPath bookId）、drafts（keyPath id）。
// 连接是模块级单例；所有操作在隐私模式或存储被禁用时会给出人话错误而不是裸的英文异常。
const DB_NAME = 'novel-assistant'
const DB_VERSION = 6

let dbPromise = null

function openDB() {
  // 隐私/无痕模式或禁用存储的浏览器里 indexedDB 未定义，直接调用会抛 ReferenceError 泄漏到界面变成看不懂的英文报错，
  // 所以先判存在性、给人话错误。不缓存这个 rejection，存储恢复后下次调用可正常打开。
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('当前浏览器禁用了本地存储（IndexedDB），无法保存书籍数据。请退出隐私/无痕模式，或更换浏览器后重试。'))
  }
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    // 打开请求可能永久挂起（浏览器存储异常、其它标签页占用升级锁等），调用方会无限等下去：
    // 书库永久转圈、草稿门禁永不放行导致刷新丢内容。8 秒超时给出人话错误，让上层走失败分支自愈。
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      dbPromise = null
      reject(new Error('本地数据库无响应（可能被其它标签页占用或浏览器存储异常）。请关闭其它本应用标签页、重启浏览器后重试。'))
    }, 8000)
    const done = (fn) => (...args) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      fn(...args)
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('styles')) db.createObjectStore('styles', { keyPath: 'bookId' })
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'id' })
      // 两张废弃表（analyses / projects）随旧流水线删除，升级时清掉旧库残留
      if (db.objectStoreNames.contains('analyses')) db.deleteObjectStore('analyses')
      if (db.objectStoreNames.contains('projects')) db.deleteObjectStore('projects')
    }
    req.onsuccess = done(() => {
      const db = req.result
      // 连接可能被浏览器关闭（其他标签页升级触发 versionchange、或存储被驱逐）。此时必须同步清掉缓存的连接，
      // 否则后续所有操作会复用已关闭的连接、事务同步抛 InvalidStateError，且不会自愈、只能刷新页面。
      // 显式 close() 不触发 onclose 事件，所以 onversionchange 分支要在 close 后自己置空缓存；onclose 只兜浏览器异常关闭。
      db.onversionchange = () => { db.close(); dbPromise = null }
      db.onclose = () => { dbPromise = null }
      resolve(db)
    })
    req.onerror = done(() => reject(req.error))
    // 升级被其他标签页的旧连接阻塞时给出人话错误，否则打开请求永不结束、所有数据库操作无限挂起
    req.onblocked = done(() => reject(new Error('数据库升级被阻塞，请关闭其他打开本应用的标签页后重试')))
  })
  // 打开失败时清掉缓存的失败结果，允许下次重试；否则一次失败后所有操作永远复用同一个失败直到刷新
  dbPromise.catch(() => {
    dbPromise = null
  })
  return dbPromise
}

// 读整张表，返回记录数组。读事务被中止时也拒绝而不是挂起，否则调用方永久等待、界面永久转圈。
export async function getAll(store) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readonly')
    const req = t.objectStore(store).getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
    t.onabort = () => reject(req.error || new Error('读取被中止'))
  })
}

// 按主键读单条记录，不存在时 resolve undefined。读事务被中止时拒绝而不是挂起。
export async function getById(store, id) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readonly')
    const req = t.objectStore(store).get(id)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    t.onabort = () => reject(req.error || new Error('读取被中止'))
  })
}

// 写一条记录（同主键覆盖）。事务中止（如配额不足）时拒绝而不是挂起，否则调用方的 await 永久不返回。
export async function put(store, value) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite')
    t.objectStore(store).put(value)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error || new Error('写入被中止（可能存储空间不足）'))
  })
}

// 按主键删一条记录。事务中止时拒绝而不是挂起。
export async function del(store, id) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite')
    t.objectStore(store).delete(id)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error || new Error('删除被中止'))
  })
}

// 清空整张表。事务中止时拒绝而不是挂起。
export async function clearStore(store) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite')
    t.objectStore(store).clear()
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error || new Error('清空被中止'))
  })
}
