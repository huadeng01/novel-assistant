// 数据备份：导出/导入全部个人数据（小说 + 文风档案 + 向导进度）
// 纯前端应用数据只存在浏览器里，此功能用于换设备或清缓存后恢复
import { getAll, put, clearStore } from './db.js'
import { downloadText } from './utils.js'

const WIZARD_KEY = 'na_wizard_state'

export async function exportBackup() {
  const [books, styles] = await Promise.all([getAll('books'), getAll('styles')])
  let wizard = null
  try {
    wizard = JSON.parse(localStorage.getItem(WIZARD_KEY) || 'null')
  } catch {
    /* 忽略 */
  }
  const data = { app: 'novel-assistant', version: 1, exportedAt: new Date().toISOString(), books, styles, wizard }
  downloadText(`novel-assistant-备份-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json')
}

export async function importBackup(file) {
  const data = JSON.parse(await file.text())
  if (data.app !== 'novel-assistant' || !Array.isArray(data.books)) {
    throw new Error('备份文件格式不正确，请选择本项目导出的备份文件。')
  }
  await Promise.all([clearStore('books'), clearStore('styles')])
  for (const b of data.books) await put('books', b)
  for (const s of data.styles || []) await put('styles', s)
  if (data.wizard) localStorage.setItem(WIZARD_KEY, JSON.stringify(data.wizard))
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

export async function wipeAll() {
  await Promise.all([clearStore('books'), clearStore('styles')])
  localStorage.removeItem(WIZARD_KEY)
}
