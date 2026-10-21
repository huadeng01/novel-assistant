// 数据备份：导出/导入全部个人数据（小说 + 文风档案 + 向导进度 + 续写页草稿）
// 纯前端应用数据只存在浏览器里，此功能用于换设备或清缓存后恢复
import { getAll, getById, put, del, clearStore } from './db.js'
import { downloadText } from './utils.js'

// 新手写作草稿的 localStorage 首屏键（与 WizardPage 的 DRAFT_KEY 一致；旧代码误用的 na_wizard_state 已废弃）
const WIZARD_LS_KEY = 'na_wizard_draft'
// 备份格式版本：v5 起把 localStorage 轻量草稿（改写页 na_revise_draft + 新手 na_wizard_draft）收进 data.local 一并备份；
//   v4 起草稿统一用 drafts 数组导出（含新手 + 续写 continue）。导入对 v4 及更早向后兼容（无 data.local 则跳过）。
const BACKUP_VERSION = 5
// 续写页工作草稿存在 IndexedDB 的 drafts 库里，固定一条记录（不是每个项目一条）：
// 原文可能长达数十万字，localStorage 的 5MB 配额会在写入时直接抛 QuotaExceededError。
const CONTINUE_DRAFT_ID = 'continue'
const CONTINUE_DRAFT_VERSION = 1
// 改写页草稿的 localStorage 键（RevisePage 持有：原文 + 4 个改写版本，隐私面）
const REVISE_LS_KEY = 'na_revise_draft'

export async function exportBackup() {
  const [books, styles, drafts] = await Promise.all([
    getAll('books'),
    getAll('styles'),
    getAll('drafts'), // 全部草稿：新手写作(na_wizard_draft) + 续写(continue)，一次导全，不再漏新手草稿
  ])
  // item10：localStorage 里的轻量草稿也要进备份——na_revise_draft（改写页原文+4版本）此前不在备份里，
  //   但 wipeAll 会删它 ⟹「导出备份 → 清空全部数据」后改写页内容不可恢复。na_wizard_draft（首屏载荷）同理。
  const local = {}
  try {
    const rev = localStorage.getItem(REVISE_LS_KEY)
    if (rev) local[REVISE_LS_KEY] = rev
    const wiz = localStorage.getItem(WIZARD_LS_KEY)
    if (wiz) local[WIZARD_LS_KEY] = wiz
  } catch {
    /* 隐私模式 / localStorage 不可用：跳过，不影响 IndexedDB 三表的备份 */
  }
  const data = { app: 'novel-assistant', version: BACKUP_VERSION, exportedAt: new Date().toISOString(), books, styles, drafts, local }
  downloadText(`novel-assistant-备份-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json')
}

export async function importBackup(file) {
  // L-12：JSON 解析失败包成人话错误，不把原始 SyntaxError 抛给用户
  let data
  try {
    data = JSON.parse(await file.text())
  } catch {
    throw new Error('备份文件格式不正确，请选择本项目导出的备份文件。')
  }
  if (!data || typeof data !== 'object' || data.app !== 'novel-assistant' || !Array.isArray(data.books)) { // L(尾批)：JSON.parse('null'/'123') 得非对象，此前 data.app 直接抛裸英文 TypeError（Cannot read properties of null）泄漏给用户
    throw new Error('备份文件格式不正确，请选择本项目导出的备份文件。')
  }
  // 极旧的备份没有 version 字段，按 0 处理；大于当前值说明备份来自更新版本的本应用。
  const version = typeof data.version === 'number' ? data.version : 0
  // 合并导入，不再清空：此前这里先 clearStore 把 books / styles 库全倒空，
  // 于是「导入一份旧备份」会让用户手上没被这份备份覆盖的书全部消失——已实测到的数据丢失路径。
  // put 走 keyPath（books = id，styles = bookId），同键天然覆盖、异键天然保留，
  // 合并语义不需要任何额外代码，把清空动作删掉即可。
  // 代价（需产品侧知情）：导入不再是「恢复到导出时的状态」，导出后新建的书不会被删掉。
  // 要那个语义请用「清空全部数据」后再导入。
  if (version > BACKUP_VERSION) {
    // 仍然导入：多出来的字段 normalize 不会删，静默丢弃用户数据比格式不识别更糟。
    console.warn(`备份格式版本 ${version} 高于本应用支持的 ${BACKUP_VERSION}，较新的字段将原样保留但可能不被识别。`)
  }
  // M-6：逐条守卫 + 独立 try/catch，单条脏数据(缺 keyPath 字段)或写入失败只跳过该条、不中断整个导入；末尾汇总失败条数。
  let failed = 0
  const safePut = async (store, val, keyField) => {
    if (!val || !val[keyField]) { failed++; return }
    try { await put(store, val) } catch (e) { failed++; console.warn(`[backup] 导入 ${store} 一条失败，已跳过：`, e) }
  }
  for (const b of data.books) await safePut('books', b, 'id')
  for (const s of data.styles || []) await safePut('styles', s, 'bookId')
  if (Array.isArray(data.drafts)) {
    // v4：drafts 数组逐条恢复（新手 + 续写草稿都在里面）
    for (const d of data.drafts) await safePut('drafts', d, 'id')
  } else {
    // 旧备份(v<=3)兼容：wizard 走 localStorage、continueDraft 走 drafts；都没有则不动现有草稿
    if (data.wizard) { try { localStorage.setItem(WIZARD_LS_KEY, JSON.stringify(data.wizard)) } catch { /* 配额不足忽略 */ } }
    if (data.continueDraft && typeof data.continueDraft === 'object') await saveContinueDraft(data.continueDraft)
  }
  // item10：对称恢复 localStorage 轻量草稿（v5 起带 data.local；v4 及更早无此字段则跳过）。
  //   只恢复白名单键（改写页/新手草稿），不从备份回写任意 localStorage 键（防注入）。
  if (data.local && typeof data.local === 'object') {
    for (const key of [REVISE_LS_KEY, WIZARD_LS_KEY]) {
      const v = data.local[key]
      if (typeof v === 'string' && v) { try { localStorage.setItem(key, v) } catch { /* 配额/隐私模式：忽略 */ } }
    }
  }
  if (failed) console.warn(`[backup] 导入完成，但有 ${failed} 条记录因缺关键字段或写入失败被跳过（其余已成功导入）`)
  return { failed }
}

// ---------- 续写页工作草稿（原文 + 分析结果 + 文风结果 + 续写指令）----------
// 对标新手写作的 loadWizardState/saveWizardState：意外退出、刷新、切 tab 回来都能接着写。
// 三个函数全部 best-effort：隐私模式 / IndexedDB 不可用 / 配额不足时静默降级，绝不把写作流程抛错中断。

export async function loadContinueDraft() {
  try {
    const rec = await getById('drafts', CONTINUE_DRAFT_ID)
    if (!rec) return null
    if (rec.version !== CONTINUE_DRAFT_VERSION) {
      // item4：版本不符的旧草稿含用户原文（隐私面），此前只 return null 不删 → 脏记录永驻 IDB。先删再返回空。
      await del('drafts', CONTINUE_DRAFT_ID).catch(() => {})
      return null
    }
    return rec
  } catch {
    return null
  }
}

export async function saveContinueDraft(state) {
  try {
    await put('drafts', { ...state, id: CONTINUE_DRAFT_ID, version: CONTINUE_DRAFT_VERSION, savedAt: Date.now() }) // L(尾批)：id/version 放在 ...state 之后，防 state 里含同名字段时覆盖掉固定的草稿主键/版本（原顺序 spread 在后会把 id/version 冲掉）
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
  // L#5：Promise.all 也包 try/catch——此前只下面 localStorage 段包了，但 item11 注释声称「不让整个 wipeAll 抛错」；
  //   某张表 clearStore 失败会裸 reject 冒泡到调用方（用户看到「清空失败」，而另两张表其实已清、状态不一致）。best-effort：清表失败也继续往下清 localStorage。
  let idbErr = null
  try {
    await Promise.all([clearStore('books'), clearStore('styles'), clearStore('drafts')])
  } catch (e) {
    idbErr = e
    console.warn('[backup] wipeAll 清空 IndexedDB 某张表失败（其余表与 localStorage 仍继续清）：', e)
  }
  // item11：所有 localStorage 操作并入同一 try/catch——隐私模式下 removeItem 会抛错，而此时 IndexedDB 三表已清完，
  //   不应让整个 wipeAll 抛错（否则用户看到「清空失败」但书其实已经没了）。best-effort 清理、失败静默。
  try {
    localStorage.removeItem(WIZARD_LS_KEY)
    // H8：改写页草稿 na_revise_draft 含用户原文 + 4 个改写版本（隐私面），「清空全部数据」必须一并清掉
    localStorage.removeItem(REVISE_LS_KEY)
    // M17：清掉诊断缓存 na_diag_*（键名内含用户原文片段 text.slice(0/-16)，属隐私面）——此前不清它，原文片段会残留；
    //   DiagnosePanel 每次按「字数+原文片段」建**新键**（多键、非固定单键），写入时按本页前缀(na_diag_cont_/na_diag_rev_)清掉同类旧快照(见 DiagnosePanel.jsx #11)；
    //   但跨页残留与异常退出仍可能遗留旧键 ⟹ 此处按 na_diag_ 前缀全清兜底。先收集再删，避免遍历中 removeItem 索引位移漏删。
    const diagKeys = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith('na_diag_')) diagKeys.push(k)
    }
    for (const k of diagKeys) localStorage.removeItem(k)
  } catch {
    /* 隐私模式 / localStorage 不可用：IndexedDB 已清，localStorage 清理失败不阻断 */
  }
  // item6：IDB 清表失败时，best-effort 已把 localStorage 清完（L#5 意图保留），此处在末尾 rethrow，
  //   让调用方 ProfilePage（唯一调用点、已包 try/catch）据实报"清空失败"，不再假报"已清空"——
  //   否则含用户原文的脏数据残留 IDB 而用户以为清了（隐私）。宁可报"部分未清"也不报假成功。
  if (idbErr) throw idbErr
}
