// 数据备份：导出/导入全部个人数据（小说 + 文风档案 + 向导进度 + 续写页草稿）
// 纯前端应用数据只存在浏览器里，此功能用于换设备或清缓存后恢复
import { getAll, getById, put, del, clearStore } from './db.js'
import { downloadText } from './utils.js'

const WIZARD_KEY = 'na_wizard_state'
// 续写页工作草稿存在 IndexedDB 的 drafts 库里，固定一条记录（不是每个项目一条）：
// 原文可能长达数十万字，localStorage 的 5MB 配额会在写入时直接抛 QuotaExceededError。
const CONTINUE_DRAFT_ID = 'continue'
const CONTINUE_DRAFT_VERSION = 1

export async function exportBackup() {
  const [books, styles, projects, continueDraft] = await Promise.all([
    getAll('books'),
    getAll('styles'),
    getAll('projects'),
    loadContinueDraft(),
  ])
  let wizard = null
  try {
    wizard = JSON.parse(localStorage.getItem(WIZARD_KEY) || 'null')
  } catch {
    /* 忽略 */
  }
  const data = { app: 'novel-assistant', version: 3, exportedAt: new Date().toISOString(), books, styles, projects, wizard, continueDraft }
  downloadText(`novel-assistant-备份-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json')
}

export async function importBackup(file) {
  const data = JSON.parse(await file.text())
  if (data.app !== 'novel-assistant' || !Array.isArray(data.books)) {
    throw new Error('备份文件格式不正确，请选择本项目导出的备份文件。')
  }
  await Promise.all([clearStore('books'), clearStore('styles'), clearStore('projects')])
  for (const b of data.books) await put('books', b)
  for (const s of data.styles || []) await put('styles', s)
  for (const p of data.projects || []) await put('projects', p)
  if (data.wizard) localStorage.setItem(WIZARD_KEY, JSON.stringify(data.wizard))
  // 旧版备份（version 2）没有 continueDraft 字段，此时不动现有草稿，避免把用户正在写的原文清成空
  if (data.continueDraft && typeof data.continueDraft === 'object') await saveContinueDraft(data.continueDraft)
}

export function loadWizardState() {
  try {
    return JSON.parse(localStorage.getItem(WIZARD_KEY) || 'null')
  } catch {
    return null
  }
}

export function saveWizardState(state) {
  localStorage.setItem(WIZARD_KEY, JSON.stringify(state))
}

// ---------- 续写页工作草稿（原文 + 分析结果 + 文风结果 + 续写指令）----------
// 对标新手写作的 loadWizardState/saveWizardState：意外退出、刷新、切 tab 回来都能接着写。
// 三个函数全部 best-effort：隐私模式 / IndexedDB 不可用 / 配额不足时静默降级，绝不把写作流程抛错中断。

export async function loadContinueDraft() {
  try {
    const rec = await getById('drafts', CONTINUE_DRAFT_ID)
    if (!rec || rec.version !== CONTINUE_DRAFT_VERSION) return null
    return rec
  } catch {
    return null
  }
}

export async function saveContinueDraft(state) {
  try {
    await put('drafts', { id: CONTINUE_DRAFT_ID, version: CONTINUE_DRAFT_VERSION, ...state, savedAt: Date.now() })
    return true
  } catch {
    return false
  }
}

export async function clearContinueDraft() {
  try {
    await del('drafts', CONTINUE_DRAFT_ID)
  } catch {
    /* 已不存在也算清除成功 */
  }
}

export async function wipeAll() {
  await Promise.all([clearStore('books'), clearStore('styles'), clearStore('projects'), clearStore('drafts')])
  localStorage.removeItem(WIZARD_KEY)
}
