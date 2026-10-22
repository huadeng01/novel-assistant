// 数据备份：导出/导入全部个人数据（小说 + 文风档案 + 向导草稿 + 续写页草稿），以及「清空全部数据」。
// 纯前端应用的数据只存在浏览器里，这个模块用于换设备或清缓存后恢复。
import { getAll, getById, put, del, clearStore } from './db.js'
import { downloadText } from './utils.js'

// 新手写作草稿的 localStorage 首屏键，向导页与备份共用这一个常量
export const WIZARD_LS_KEY = 'na_wizard_draft'
// 备份格式版本。v5 起把 localStorage 里的轻量草稿（改写页 + 新手向导）一并收进备份；
// v4 起草稿统一用 drafts 数组导出。导入对 v4 及更早版本向后兼容（没有轻量草稿字段就跳过）。
const BACKUP_VERSION = 5
// 续写页工作草稿在 drafts 表里固定一条记录（不按书分槽）：原文可能长达数十万字，localStorage 的 5MB 配额会直接抛错。
const CONTINUE_DRAFT_ID = 'continue'
const CONTINUE_DRAFT_VERSION = 1
// 改写页草稿的 localStorage 键（改写页持有：原文 + 4 个改写版本，含用户原文属隐私面）
const REVISE_LS_KEY = 'na_revise_draft'

// 导出备份：三张表全量 + localStorage 里的轻量草稿，打包成 JSON 文件下载。
// 轻量草稿也要进备份，否则「导出备份 → 清空全部数据」后改写页与向导页的内容不可恢复。
export async function exportBackup() {
  const [books, styles, drafts] = await Promise.all([
    getAll('books'),
    getAll('styles'),
    getAll('drafts'),
  ])
  const local = {}
  try {
    const rev = localStorage.getItem(REVISE_LS_KEY)
    if (rev) local[REVISE_LS_KEY] = rev
    const wiz = localStorage.getItem(WIZARD_LS_KEY)
    if (wiz) local[WIZARD_LS_KEY] = wiz
  } catch {
    /* 隐私模式 / localStorage 不可用：跳过，不影响三张表的备份 */
  }
  const data = { app: 'novel-assistant', version: BACKUP_VERSION, exportedAt: new Date().toISOString(), books, styles, drafts, local }
  downloadText(`novel-assistant-备份-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json')
}

// 导入备份：合并写入而不是先清空——清空语义会让用户手上没被这份备份覆盖的书全部消失，是已实测到的数据丢失路径。
// 合并靠主键天然覆盖（同键覆盖、异键保留），代价是导入不等于「恢复到导出时的状态」；要那个语义请先「清空全部数据」再导入。
// 单条脏数据或写入失败只跳过该条、不中断整个导入，末尾汇总失败条数返回。
export async function importBackup(file) {
  // JSON 解析失败与格式不符都包成人话错误，不把原始异常抛给用户
  let data
  try {
    data = JSON.parse(await file.text())
  } catch {
    throw new Error('备份文件格式不正确，请选择本项目导出的备份文件。')
  }
  if (!data || typeof data !== 'object' || data.app !== 'novel-assistant' || !Array.isArray(data.books)) {
    throw new Error('备份文件格式不正确，请选择本项目导出的备份文件。')
  }
  // 极旧的备份没有版本字段按 0 处理；高于当前版本说明备份来自更新的本应用
  const version = typeof data.version === 'number' ? data.version : 0
  if (version > BACKUP_VERSION) {
    // 仍然导入：多出来的字段静默丢弃比整份不识别更糟
    console.warn(`备份格式版本 ${version} 高于本应用支持的 ${BACKUP_VERSION}，较新的字段将原样保留但可能不被识别。`)
  }
  let failed = 0
  const safePut = async (store, val, keyField) => {
    if (!val || !val[keyField]) { failed++; return }
    try { await put(store, val) } catch (e) { failed++; console.warn(`[backup] 导入 ${store} 一条失败，已跳过：`, e) }
  }
  for (const b of data.books) await safePut('books', b, 'id')
  for (const s of data.styles || []) await safePut('styles', s, 'bookId')
  if (Array.isArray(data.drafts)) {
    // v4 及以后：草稿数组逐条恢复（向导 + 续写草稿都在里面）
    for (const d of data.drafts) await safePut('drafts', d, 'id')
  } else {
    // 旧备份兼容：向导草稿走 localStorage、续写草稿单独字段；都没有则不动现有草稿
    if (data.wizard) { try { localStorage.setItem(WIZARD_LS_KEY, JSON.stringify(data.wizard)) } catch { /* 配额不足忽略 */ } }
    if (data.continueDraft && typeof data.continueDraft === 'object') await saveContinueDraft(data.continueDraft)
  }
  // 对称恢复 localStorage 轻量草稿。只恢复白名单键，不从备份回写任意 localStorage 键（防注入）。
  if (data.local && typeof data.local === 'object') {
    for (const key of [REVISE_LS_KEY, WIZARD_LS_KEY]) {
      const v = data.local[key]
      if (typeof v === 'string' && v) { try { localStorage.setItem(key, v) } catch { /* 配额/隐私模式：忽略 */ } }
    }
  }
  if (failed) console.warn(`[backup] 导入完成，但有 ${failed} 条记录因缺关键字段或写入失败被跳过（其余已成功导入）`)
  return { failed }
}

// ---------- 续写页工作草稿（原文 + 分析结果 + 续写指令 + 已生成版本）----------
// 三个函数全部 best-effort：隐私模式 / IndexedDB 不可用 / 配额不足时静默降级，绝不把写作流程抛错中断。

// 读续写页草稿。版本不符的旧草稿含用户原文（隐私面），先删掉再返回空，不让脏记录永驻数据库。
export async function loadContinueDraft() {
  try {
    const rec = await getById('drafts', CONTINUE_DRAFT_ID)
    if (!rec) return null
    if (rec.version !== CONTINUE_DRAFT_VERSION) {
      await del('drafts', CONTINUE_DRAFT_ID).catch(() => {})
      return null
    }
    return rec
  } catch {
    return null
  }
}

// 写续写页草稿，返回是否成功。固定主键与版本放在展开之后，防草稿内容里含同名字段时把主键/版本冲掉。
export async function saveContinueDraft(state) {
  try {
    await put('drafts', { ...state, id: CONTINUE_DRAFT_ID, version: CONTINUE_DRAFT_VERSION, savedAt: Date.now() })
    return true
  } catch {
    return false
  }
}

// 删续写页草稿，已不存在也算清除成功
export async function clearContinueDraft() {
  try {
    await del('drafts', CONTINUE_DRAFT_ID)
  } catch {
    /* 已不存在也算清除成功 */
  }
}

// 清空全部数据：三张表 + 向导/改写草稿 + 诊断缓存（键名内含用户原文片段，属隐私面）。
// 全程 best-effort：某张表或某段 localStorage 清理失败也继续清其余部分；
// 但数据库清表失败会在末尾重新抛出，让调用方据实报「清空失败」而不是假报「已清空」——
// 否则含用户原文的脏数据残留数据库而用户以为清了。宁可报「部分未清」也不报假成功。
export async function wipeAll() {
  let idbErr = null
  try {
    await Promise.all([clearStore('books'), clearStore('styles'), clearStore('drafts')])
  } catch (e) {
    idbErr = e
    console.warn('[backup] wipeAll 清空 IndexedDB 某张表失败（其余表与 localStorage 仍继续清）：', e)
  }
  try {
    localStorage.removeItem(WIZARD_LS_KEY)
    localStorage.removeItem(REVISE_LS_KEY)
    // 诊断缓存是多键（每次按字数+原文片段建新键），跨页残留与异常退出可能遗留旧键，按前缀全清兜底。
    // 先收集再删，避免遍历中 removeItem 造成索引位移漏删。
    const diagKeys = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith('na_diag_')) diagKeys.push(k)
    }
    for (const k of diagKeys) localStorage.removeItem(k)
  } catch {
    /* 隐私模式 / localStorage 不可用：数据库已清，localStorage 清理失败不阻断 */
  }
  if (idbErr) throw idbErr
}
