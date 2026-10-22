// 落库三表解析 + 关系网绑定(links)。
// 容错：段标题兼容 markdown 前缀(## 【势力】)；分隔符兼容全角｜与 ASCII |；缺字段填默认；解析失败行跳过；不抛错。
// 绑定系统：①行内绑定列(道具持有者→holds、地点控制方→controlled_by) ②名字共现自动建边(buildLinks)
//          ③关系网步封闭名册建边(parseRelations, 在 LongFormPage merge)。悬空边由 computeAssetWarnings 标红。
// 依赖口径：只 import prompts.js 的一个常量（ASSET_TYPE_WORDS，提示词与解析共用的类型词表）；
//   **不 import assets.js**（assets.js import 本文件，反向引入会成环）——中文类型词→英文 key 的归一仍由 assets.js typeKeyOf 单一出处负责。
import { ASSET_TYPE_WORDS } from './prompts.js'

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
const cnToNum = (s) => {
  if (CN_NUM[s]) return CN_NUM[s]
  if (s.startsWith('十')) return 10 + (CN_NUM[s[1]] || 0)
  if (s.includes('十')) {
    const [a, b] = s.split('十')
    return (CN_NUM[a] || 1) * 10 + (CN_NUM[b] || 0)
  }
  return 0
}
const num = (s) => {
  const t = String(s == null ? '' : s).trim()
  const zhang = t.match(/第\s*([0-9]+|[一二三四五六七八九十]+)\s*章/)
  if (zhang) return /[0-9]+/.test(zhang[1]) ? parseInt(zhang[1], 10) : cnToNum(zhang[1])
  const m = t.match(/[0-9]+/)
  if (m) return parseInt(m[0], 10)
  const cm = t.match(/[一二三四五六七八九十]+/)
  if (cm) return cnToNum(cm[0])
  return 0
}
// 卷章表的「章行」→ 章号（number）；非章行 / 区间 / 散文行返回 0。
// 认：「21｜」「第21章｜」「第21章 章名」「第21章」「21 ｜」「｜21｜」「第一章｜」「第二十章｜」；
// 排（返回 0）：区间/散文「第21章至本卷末」「第21章到第30章」「第21章-/--/～/〜/全角－」「第21章、30章」「第21章/30章」，以及行首非章号的普通文本。
// ⚠ 与 backfillChapterNos 的章号解析无关（那是回填清单第 2/3 列 num(c[1])，非章行首列）。
export function chapLineNo(line) {
  const raw = String(line == null ? '' : line).trim()
  if (!raw) return 0
  const s = raw.replace(/^[｜|\s]+/, '') // 去前导分隔符/空白（「｜21｜」「| 21 |」）
  // 区间/散文尾部（紧跟章号）：至/到 + 半角 -–—~ + 全角 ～〜(U+FF5E/U+301C)－ + 顿号、 + 斜杠 /
  const RANGE_TAIL = /^\s*(?:至|到|[-–—~～〜－、/])/
  // 形式1：第 N 章（N = 阿拉伯或中文数字，复用 cnToNum）
  const m1 = s.match(/^第\s*([0-9]+|[一二三四五六七八九十]+)\s*章/)
  if (m1) {
    if (RANGE_TAIL.test(s.slice(m1[0].length))) return 0 // 「第21章至/到/-/、//…」判为区间散文，不当章行
    return /[0-9]+/.test(m1[1]) ? parseInt(m1[1], 10) : cnToNum(m1[1])
  }
  // 形式2：裸章号（阿拉伯/中文）开头，其后须是分隔符或行尾——区间「21-30」「21至30」的尾符非分隔符 ⟹ 天然排除
  const m2 = s.match(/^([0-9]+|[一二三四五六七八九十]+)\s*(?=[｜|]|\s*$)/)
  if (m2) return /[0-9]+/.test(m2[1]) ? parseInt(m2[1], 10) : cnToNum(m2[1])
  return 0
}
const splitList = (s) =>
  String(s || '')
    .split(/[,，、/]/)
    .map((x) => x.trim())
    .filter(Boolean)
const normTier = (s) => {
  const t = String(s || '').trim()
  if (/^S/i.test(t) || t.includes('主线级')) return 'S'
  if (/^M/i.test(t) || t.includes('支线级')) return 'M'
  return 'L'
}
const INTENSITY_RE = /强度\s*[:：]?\s*([1-5])|\+([1-5])\+/
const intensityOf = (s) => {
  const m = String(s || '').match(INTENSITY_RE)
  return m ? Number(m[1] || m[2]) : 0
}
// 该列是否是「情绪」列（含强度标记）——卷章表情绪锚判据，与 intensityOf 同一出处
const hasIntensity = (s) => INTENSITY_RE.test(String(s || ''))
const cols = (line) => {
  let c = String(line).split(/[｜|]/).map((s) => s.trim())
  const hadLeading = c[0] === ''
  if (hadLeading) c = c.slice(1)
  //  · markdown 边框行（有前导分隔符，如「| a | b |」）：尾分隔符是边框，剥掉；
  //  · 数据行（无前导分隔符，如「青云城｜…｜3｜5｜」）：尾分隔符代表一个真实的空列（此处=空的知情人列），
  //    必须保留；否则按数组长度做尾列锚定(c[n-3]/c[n-2]/c[n-1])会整行左移，把传闻卷当成知情人、真值透出卷丢失。
  if (hadLeading && c.length && c[c.length - 1] === '') c = c.slice(0, -1)
  return c
}
const isSepRow = (c) => c.length && c.every((x) => x === '' || /^:?-+:?$/.test(x))
// markdown 表头行（首列是字段名）跳过，避免变成一条名为"姓名/势力名"的假资产。
const NAME_COL_WORDS = ['姓名', '势力名', '地点名', '资产名', '伏笔名']
const AMBIG_HEAD_WORDS = ['名字', '资产', '类型', '章号', '钩子编号']
// 常见列标签（供歧义首列做「第二列也是表头词」校验）——非穷举；漏网的表头列最多让该行按数据保留（宁留假资产，不误删真实资产）
const FIELD_WORDS = ['身份', '立场', '层级', '区域', '功能', '控制方', '持有者', '透出卷', '传闻卷', '知情人', '描述', '简介', '说明', '详情', '备注', '关系', '状态', '动作', '编号', '名称', '卷号', '登场', '回收', '首次']
const HEADER_WORDS = [...NAME_COL_WORDS, ...AMBIG_HEAD_WORDS, ...FIELD_WORDS]
const isHeadRow = (c) => {
  if (c.length <= 1) return false
  const cells = c.map(cleanName)
  if (NAME_COL_WORDS.includes(cells[0])) return true
  if (!AMBIG_HEAD_WORDS.includes(cells[0])) return false
  return cells.slice(1).some((x) => HEADER_WORDS.includes(x))
}
const hasPipe = (l) => l.includes('｜') || l.includes('|')
const isMdHead = (l) => l.startsWith('#') || l.startsWith('---') || /^\*\*[^｜|]*\*\*$/.test(l)
const cleanName = (s) => String(s || '').replace(/\*\*/g, '').replace(/^【[^】]*】/, '').replace(/^`|`$/g, '').replace(/[《》]/g, '').trim()
const headTagOf = (l) => String(l || '').trim().replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '').replace(/^[【[]\s*/, '').replace(/\s*[】\]]\s*$/, '').trim()
// 判断一行是否是某段的标题行：剥掉 markdown 装饰后匹配段名，且要求无竖线、有标题装饰，防散文误判。
export const isSectionHead = (l, name) => {
  if (hasPipe(l)) return false
  const raw = String(l || '').trim()
  if (!(/^#{1,6}\s/.test(raw) || raw.startsWith('【') || raw.startsWith('[') || /^\*\*[^｜|]*\*\*$/.test(raw))) return false
  return headTagOf(raw).includes(name)
}
const matchSectionHead = (l, sections) => {
  const raw = String(l || '').trim()
  if (!raw) return null
  const bm = raw.match(/^(?:\*\*)?\s*【([^】]*)】\s*(?:\*\*)?\s*(.*)$/)
  if (bm) {
    const tag = bm[1].trim()
    const rest = bm[2].trim()
    for (const s of sections) if (s.names.some((nm) => tag.includes(nm))) return { key: s.key, rest: hasPipe(rest) ? rest : '' }
    return null // 【…】但不命中本循环段名 → 未识别标题，交回调用方
  }
  for (const s of sections) if (s.names.some((nm) => isSectionHead(raw, nm))) return { key: s.key, rest: '' }
  return null
}
// 三段循环各自的段名→cur 映射（matchSectionHead 用）
const BIBLE_SECTIONS = [{ key: 'faction', names: ['势力'] }, { key: 'place', names: ['地点'] }]
const OUTLINE_SECTIONS = [{ key: 'fs', names: ['伏笔'] }, { key: 'hook', names: ['悬念账本', '悬念'] }]
const VOLUMES_SECTIONS = [{ key: 'ch', names: ['章节'] }, { key: 'bf', names: ['资产章号回填'] }]
const dash = (s) => {
  const t = String(s || '').trim()
  return t === '—' || t === '-' || t === '无' ? '' : t
}
// 空占位 token：比本文件 dash() 的「—/-/无」更宽（按设计 §3 需求7 含「无主/未知/无内容/none/null/n/a/?/？」等）。dash() 与 isBlankToken 判据不同、各自保留。
export const EMPTY_TOKENS = ['—', '-', '－', '–', '无', '无主', '未知', '无内容', 'none', 'null', 'n/a', '?', '？']
// 判断是否是空占位词（— / 无 / 无主 / 未知 / none 等宽表）。
export const isBlankToken = (s) => {
  const t = String(s == null ? '' : s).trim()
  return EMPTY_TOKENS.includes(t) || EMPTY_TOKENS.includes(t.toLowerCase())
}
// 字符串清洗：去 markdown 加粗 ** 与反引号、书名号《》——只用于「名字」类字段。
export const cleanText = (s) => String(s == null ? '' : s).replace(/\*\*/g, '').replace(/^`|`$/g, '').replace(/[《》]/g, '').trim()
// 自由文本清洗：只 trim + 空占位归空，**不去书名号**（detail / note 里可能出现《青竹剑》，删掉会失真）
export const dashOnly = (s) => (isBlankToken(s) ? '' : String(s == null ? '' : s).trim())
// 空占位归零：'—'/'无'/'无主'/'未知' → ''（名字类字段顺带去加粗与书名号）
export const dashOut = (s) => (isBlankToken(s) ? '' : cleanText(s))

// ===== 名字匹配单一出处（决策1+5：从 assets.js 下沉到此、assets.js re-export；parseAssets 只 import prompts 不 import assets ⟹ 下沉无环）=====
// 名字归一：去 **《》【】`(cleanName) + 去空白/直角引号「」+ 窄占位(dash 的 —/-/无)归空。
export const normName = (s) => {
  const t = cleanName(s).replace(/[\s「」]/g, '')
  return dash(t) === '' ? '' : t
}
// 严格名字匹配（决策1：去掉原双向 includes 松匹配——它会把「铁令」错配到「玄铁令」、短名乱命中）：归一后主名或别名**完全相等**才命中。
//   别名/《》/空格经 normName 归一后仍精确命中（不误伤正当变体），只是不再做子串包含。
export function matchesName(asset, needle) {
  const n = normName(needle)
  if (!n || !asset) return false
  const cands = [asset.name, ...(asset.aliases || [])].map(normName).filter(Boolean)
  return cands.some((c) => c === n)
}
// 按归一后的主名精确查资产。
export function findByName(assets, name) {
  const n = normName(name)
  if (!n) return null
  return (assets || []).find((a) => a && normName(a.name) === n) || null
}
// 名字解析单一出处：先精确主名、再别名容错，两页结算与悬空判定统一用它。
export function findAssetByName(assets, name) {
  return findByName(assets, name) || (assets || []).find((a) => a && matchesName(a, name)) || null
}
// 按标题查伏笔：先归一精确匹配，不中再双向包含取最长命中，兜住 AI 回填标题的改写出入。
export function findForeshadowByTitle(list, title) {
  const needle = normName(title)
  if (!needle) return null
  const arr = Array.isArray(list) ? list.filter(Boolean) : []
  const exact = arr.find((f) => f && normName(f.title) === needle)
  if (exact) return exact
  if (needle.length < 2) return null
  let best = null
  let bestLen = 0
  for (const f of arr) {
    const t = normName(f && f.title)
    if (t.length < 2) continue
    if ((t.includes(needle) || needle.includes(t)) && t.length > bestLen) { best = f; bestLen = t.length }
  }
  return best
}
const cleanDetail = (s) => String(s == null ? '' : s).replace(/\*\*/g, '').replace(/`/g, '').trim()
const numVolume = (s) => {
  const raw = String(s == null ? '' : s).trim()
  if (!raw) return 0
  // 剥掉整格包裹记号（【卷1】/[卷1]/**卷1**）再判：AI 产出的资产表普遍把卷序写成「【卷1】」，
  //   原正则不容包裹 → 整表 64 个资产 reveal 全置 0、全归 ban 桶，"按章透出"整条失效。
  //   只剥首尾成对包裹，不剥格内文字：列错位（如知情人串到本列）仍按原逻辑告警置 0。
  const t = raw
    .replace(/^\*{0,2}\s*[【\[]/, '')
    .replace(/[】\]]\s*\*{0,2}$/, '')
    .replace(/\*\*/g, '')
    .trim()
  if (!t) return 0
  const m = !/章/.test(t) && t.match(/^[第卷]*\s*([0-9]+|[一二三四五六七八九十]+)\s*卷?$/)
  if (m) return /[0-9]+/.test(m[1]) ? parseInt(m[1], 10) : cnToNum(m[1])
  if (t !== '—' && t !== '-' && t !== '无') console.warn(`[parseAssets] 透出/传闻卷列「${t.slice(0, 20)}」不是合法卷号（含「章」或夹杂文字），已置 0；该资产可能因 reveal=0 被归 ban 桶，请核对列对齐`)
  return 0
}
const safeVolume = (v) => (v >= 0 && v <= 99 ? v : 0)
// 角色状态的五个中文枚举，界面下拉与 AI 产出格式共用。
export const STATE_WORDS_CN = ['活跃', '死亡', '毁坏', '隐藏', '升迁']
// 英→中映射；中文→中文恒等部分由 STATE_WORDS_CN 派生（避免与它二次漂移），合成结果与原字面量逐项等价（normState 行为不变）。
const STATE_EN_TO_CN = { alive: '活跃', dead: '死亡', destroyed: '毁坏', hidden: '隐藏', promoted: '升迁' }
const STATE_CN = { ...STATE_EN_TO_CN, ...Object.fromEntries(STATE_WORDS_CN.map((w) => [w, w])) }
const normState = (s) => STATE_CN[String(s == null ? '' : s).trim()] || ''
// 【状态变更】段的维度中文名 → §4.1 结构化 state 的 key（第一版核心 5 类 + 迭代 3 类，用 includes 容忍「修为能力/位置行踪」等全称）
const DIM_KEYS = [['生理', 'phys'], ['修为', 'power'], ['位置', 'place'], ['持有', 'hold'], ['剧情', 'plot'], ['心理', 'mind'], ['情绪', 'mind'], ['身份', 'social'], ['社会', 'social'], ['关系', 'rel']]
const dimKeyOf = (s) => { const t = String(s || ''); const hit = DIM_KEYS.find(([k]) => t.includes(k)); return hit ? hit[1] : '' }
// 【资产流转】段的动作中文 → §4.1 hold.change 枚举
const CHANGE_KEYS = [['获得', 'gain'], ['得到', 'gain'], ['失去', 'lose'], ['丢失', 'lose'], ['损坏', 'broken'], ['毁坏', 'broken'], ['消耗', 'consumed'], ['用完', 'consumed'], ['易主', 'transferred']]
const changeKeyOf = (s) => { const t = String(s || ''); const hit = CHANGE_KEYS.find(([k]) => t.includes(k)); return hit ? hit[1] : '' }
// 【资产流转】的「资产类型」列识别：提示词(analyzeAssetsMessages)让 AI 在章号后标出这条流转的资产属于哪一类。
//   按**词形**在 c[3]/c[4] 两格里定位类型列（AI 偶尔把类型写在章号前），命中即返回词表里的规范词、否则返回 ''。
//   只认 ASSET_TYPE_WORDS 里的词、不做同义词映射：中文词→英文 key 的归一是 assets.js typeKeyOf 的单一职责
//   （applyFlowToRoster 用 typeKeyOf(fl.assetType||'item')），认不出时 assetType 留 undefined ⟹ 下游兜底 item，绝不抛错。
const flowTypeWordOf = (s) => {
  const t = cleanName(s)
  if (!t) return ''
  return ASSET_TYPE_WORDS.find((w) => t === w) || ASSET_TYPE_WORDS.find((w) => t.includes(w)) || ''
}
// 【伏笔推进】段的动作中文 → §4.6 伏笔生命周期 state（提及不动 state、只记 lastAdvancedChapter 由消费方决定）
const HOOK_MOVES = [['回收', 'resolved'], ['推翻', 'resolved'], ['推进', 'advanced'], ['推后', 'deferred'], ['推迟', 'deferred'], ['撤销', 'superseded'], ['撤稿', 'superseded'], ['提及', 'mention']]
const hookMoveOf = (s) => { const t = String(s || ''); const hit = HOOK_MOVES.find(([k]) => t.includes(k)); return hit ? hit[1] : '' }

// 把｜分列文本精简为每行前 keep 列并保留段标题，供提示词注入时控制长度。
export function digestLines(text, keep) {
  // 整行加粗且内部无竖线=段标题；首列加粗的数据行（**陆沉｜…）保留，切列前剥加粗
  const isBoldHead = (l) => /^\*\*[^｜|]*\*\*$/.test(l)
  //   否则力量体系(5列)/势力(7列)/地点(5列)/终极真相(3列)等不同列数的行混排注入、无段标签，列语义全靠 AI 猜，
  //   剧透级的【终极真相】行还会被错挂在"势力/地点/等级清单"标签下。
  const isSectionHead = (l) => !hasPipe(l) && (l.startsWith('【') || /^#{1,6}\s/.test(l) || isBoldHead(l))
  const out = []
  for (const raw of String(text || '').split('\n')) {
    const l = raw.trim()
    if (!l) continue
    if (isSectionHead(l)) {
      out.push(l.replace(/^#{1,6}\s*/, ''))
      continue
    }
    if (!hasPipe(l)) continue
    const c = cols(l.replace(/\*\*/g, ''))
    if (isSepRow(c) || isHeadRow(c)) continue
    out.push(c.slice(0, keep).join('｜'))
  }
  return out.join('\n')
}

// 分析原文 / 结算本章产出解析：【已有资产更新】【新资产】【状态变更】【资产流转】【伏笔推进】五段｜分列行。
// 返回 { updates, newAssets, stateChanges, flows, hookMoves }（契约：A 的 LongFormPage 结算 UI、C 的续写页分段分析共用）。
// 🔴 红线：本函数只做**文本→结构**的解析，不判断对错、不打分、不拦截（采纳与否由页面「预览勾选→落库」决定）。
export function parseAnalyze(text) {
  const updates = []
  const newAssets = []
  const stateChanges = []
  const flows = []
  const hookMoves = []
  const SECTION_OF = { 已有资产更新: 'up', 新资产: 'new', 状态变更: 'state', 资产流转: 'flow', 伏笔推进: 'hook' }
  let cur = null
  for (const raw of String(text || '').split('\n')) {
    let l = raw.trim()
    if (!l) continue
    //   会把同行的数据一起吃掉 → 该段静默丢失。改为剥出标题设定 cur，标题后的剩余部分继续当数据行解析。
    const sec = l.match(/【(已有资产更新|新资产|状态变更|资产流转|伏笔推进)】/)
    if (sec) {
      cur = SECTION_OF[sec[1]]
      l = l.slice(l.indexOf(sec[0]) + sec[0].length).trim()
      if (!l) continue
    } else if (l.startsWith('#') || l.startsWith('【')) {
      cur = null
      continue
    }
    if (l === '无') continue
    if (!hasPipe(l)) continue
    const c = cols(l)
    if (c.length < 2 || isSepRow(c) || isHeadRow(c)) continue
    if (cur === 'up') updates.push({ name: cleanName(c[0]), info: c[1] || '', state: normState(c[2]) })
    else if (cur === 'new') {
      // M-I1：首列应是标准类型词（提示词 analyzeAssetsMessages 要求 人物/群像/势力/地点/道具/功法/灵兽）；非类型词多半是 AI 漏写类型列致整行左移
      //   （type 取到名字、name 取到描述 ⟹ 静默落库垃圾资产）。参考 flow 段的 flowTypeWordOf 定位，这里对首列做类型词校验 + 告警；type 仍交下游 typeKeyOf 归一兜底。
      if (!flowTypeWordOf(c[0])) console.warn(`[parseAssets] 【新资产】行首列「${cleanName(c[0])}」不是标准类型词(${ASSET_TYPE_WORDS.join('/')})，可能漏写类型列致整行左移，请核对；type 已按 typeKeyOf 兜底归类`)
      newAssets.push({ type: (c[0] || 'person').trim(), name: cleanName(c[1]), desc: c[2] || '', reveal: num(c[3]) })
    }
    // 【状态变更】资产名｜维度(生理/修为/位置/持有/剧情)｜新状态词｜说明一句｜生效章
    else if (cur === 'state' && c.length >= 3) {
      const dimRaw = String(c[1] || '').trim()
      stateChanges.push({ name: cleanName(c[0]), dim: dimRaw, dimKey: dimKeyOf(dimRaw), state: String(c[2] || '').trim(), note: c[3] || '', since: num(c[4]) })
    }
    // 【资产流转】人物名｜获得/失去/损坏/消耗｜资产名｜章号｜资产类型
    else if (cur === 'flow' && c.length >= 3) {
      const changeRaw = String(c[1] || '').trim()
      // 类型列按词形定位：命中类型词的那格是类型、另一格是章号；两格都不是类型词（老格式 4 列）则章号仍取 c[3]、assetType 留 undefined
      const ti = [3, 4].find((i) => flowTypeWordOf(c[i]))
      const assetType = ti === undefined ? undefined : flowTypeWordOf(c[ti])
      flows.push({ person: cleanName(c[0]), change: changeKeyOf(changeRaw), changeRaw, asset: cleanName(c[2]), ch: num(c[ti === 3 ? 4 : 3]), assetType })
    }
    // 【伏笔推进】伏笔名｜提及/推进/回收/推后｜说明一句｜章号
    else if (cur === 'hook' && c.length >= 2) {
      const moveRaw = String(c[1] || '').trim()
      hookMoves.push({ title: cleanName(c[0]), move: hookMoveOf(moveRaw), moveRaw, note: c[2] || '', ch: num(c[3]) })
    }
  }
  return { updates, newAssets, stateChanges, flows, hookMoves }
}

// 透出/传闻章判定：精确章号优先，否则用卷号粗映射兜底；perVol 传本书卷一实际章数（缺省40）；
// UI 显示与 buckets 判定共用同一函数，避免显示0实际能透出的误导
export const revealChapterOf = (a, perVol = 40) => (!a ? 0 : a.ch_reveal > 0 ? a.ch_reveal : a.reveal_volume > 0 ? (a.reveal_volume - 1) * perVol + 1 : 0)
// 算资产的传闻章：精确章号优先，否则按传闻卷换算。
export const rumorChapterOf = (a, perVol = 40) => (!a ? 0 : a.ch_rumor > 0 ? a.ch_rumor : a.rumor_volume > 0 ? (a.rumor_volume - 1) * perVol + 1 : 0)

// 关系类型中文显示映射（存储保持英文枚举，兼容已落库数据）
export const LINK_LABEL = {
  holds: '持有',
  held_by: '被持有',
  located_in: '位于',
  belongs_to: '隶属',
  controls: '控制',
  controlled_by: '受控于',
  found_at: '出处',
  ally: '盟友',
  enemy: '敌对',
  kin: '亲属',
  rival: '对手',
  related: '关联',
  leads: '统领',
}

const linkTypeFor = (fromType, toType) => {
  if (fromType === 'person' && toType === 'item') return 'holds'
  if (fromType === 'item' && toType === 'person') return 'held_by'
  if (fromType === 'person' && toType === 'place') return 'located_in'
  if (fromType === 'person' && toType === 'faction') return 'belongs_to'
  if (fromType === 'place' && toType === 'faction') return 'controlled_by'
  if (fromType === 'faction' && toType === 'place') return 'controls'
  if (fromType === 'item' && toType === 'place') return 'found_at'
  if (fromType === 'person' && toType === 'person') return 'related'
  if (fromType === 'group' && toType === 'person') return 'related'
  if (fromType === 'faction' && toType === 'person') return 'leads'
  return null
}

// 名字共现自动建边：资产 detail 里提到其他资产名 → 建一条类型推断边
export function buildLinks(assets) {
  const list = assets || []
  //     ③ 名字至少 2 字才参与子串匹配，避免「李/京/城/剑」这类单字在任意 detail 里命中造成大量假边
  const byName = new Map()
  list.forEach((a) => {
    if (a.name && !byName.has(a.name)) byName.set(a.name, a)
  })
  return list.map((a) => {
    const links = [...(a.links || [])]
    const d = String(a.detail || '')
    byName.forEach((other, n) => {
      if (n === a.name || !n || n.length < 2 || !d.includes(n)) return
      const type = linkTypeFor(a.type, other.type)
      if (type && !links.some((l) => l.to === n && l.type === type)) links.push({ type, to: n })
    })
    return { ...a, links }
  })
}

// 关系网步边行解析：A｜关系｜B；关系接受中文词（映射回英文枚举存储）或英文枚举
const CN_TO_TYPE = { 持有: 'holds', 被持有: 'held_by', 位于: 'located_in', 隶属: 'belongs_to', 控制: 'controls', 受控于: 'controlled_by', 出处: 'found_at', 盟友: 'ally', 敌对: 'enemy', 亲属: 'kin', 对手: 'rival', 关联: 'related', 统领: 'leads' }
// 解析关系网边行（A｜关系｜B），中文关系词映射回英文枚举存储。
export function parseRelations(text) {
  const edges = []
  for (const raw of String(text || '').split('\n')) {
    const l = raw.trim()
    if (!l || !hasPipe(l) || isMdHead(l)) continue
    const c = cols(l)
    if (c.length < 3 || isSepRow(c) || isHeadRow(c)) continue
    edges.push({ from: cleanName(c[0]), type: CN_TO_TYPE[c[1].trim()] || c[1].trim(), to: cleanName(c[2]) })
  }
  return edges
}

// 从圣经/人物/大纲/卷章四段文本解析出资产、节拍、伏笔三表。
export function parseBookAssets({ bible = '', characters = '', outline = '', volumes = '' }) {
  const assets = []
  const beats = []
  const foreshadows = []
  let aid = 0
  let fid = 0
  const mk = (o) => ({
    id: `as_${++aid}_${Date.now().toString(36)}`,
    aliases: [],
    tier: 'A',
    is_public: false,
    state: '活跃',
    ch_reveal: 0,
    ch_rumor: 0,
    knowers: [],
    links: [],
    ...o,
  })

  let cur = null
  for (const rawLine of String(bible).split('\n')) {
    let l = rawLine.trim()
    if (!l) continue
    const sec = matchSectionHead(l, BIBLE_SECTIONS)
    if (sec) {
      cur = sec.key
      if (!sec.rest) continue
      l = sec.rest
    } else if (l.startsWith('###')) {
      continue // ### 子分组标题（如"### 世界框架"）只跳过
    } else if (l.startsWith('#') || l.startsWith('【')) {
      cur = null; continue // 任何一二级标题（含无方括号写法如"## 终极真相"）/未识别【】关闭区块
    }
    // 势力/地点数据行以加粗名字开头(**天庭**｜…)，不能按 markdown 标题跳过；非数据行由下一行 !hasPipe 过滤
    if (!hasPipe(l)) continue
    const c = cols(l)
    if (c.length < 2 || isSepRow(c) || isHeadRow(c)) continue
    //   圣经格式：势力 7 列「名｜立场｜关系｜功能位｜知情人｜透出卷｜传闻卷」⟹ 尾 3=知情人/透出卷/传闻卷；
    //             地点 5 列「名｜层级区域｜功能控制方｜透出卷｜传闻卷」⟹ 尾 2=透出卷/传闻卷。列数非标准时告警（仍按尾锚解析，不静默错位）。
    const n = c.length
    if (cur === 'faction') {
      if (n !== 7) console.warn(`[parseAssets] 圣经【势力】「${cleanName(c[0])}」列数=${n}（标准 7 列），已按尾列锚定解析，请核对透出/传闻卷`)
      assets.push(mk({ type: 'faction', name: cleanName(c[0]), detail: c.slice(1, Math.max(1, n - 3)).map(cleanDetail).join('｜'), knowers: splitList(c[n - 3]).map(dash).filter(Boolean), reveal_volume: safeVolume(numVolume(c[n - 2])), rumor_volume: safeVolume(numVolume(c[n - 1])) }))
    } else if (cur === 'place') {
      if (n !== 5) console.warn(`[parseAssets] 圣经【地点】「${cleanName(c[0])}」列数=${n}（标准 5 列），已按尾列锚定解析，请核对透出/传闻卷`)
      assets.push(mk({ type: 'place', name: cleanName(c[0]), detail: c.slice(1, Math.max(1, n - 2)).map(cleanDetail).join('｜'), reveal_volume: safeVolume(numVolume(c[n - 2])), rumor_volume: safeVolume(numVolume(c[n - 1])) }))
    }
  }

  for (const raw of String(characters).split('\n')) {
    const l = raw.trim()
    // 人物行可能整行加粗(**陆沉｜…**)，有管道即数据行，不按标题跳；名字由 cleanName 去加粗
    if (!l || !hasPipe(l)) continue
    const c = cols(l)
    if (c.length < 3 || isSepRow(c) || isHeadRow(c)) continue
    if (c.length >= 12) {
      // 完整人物表 17 列（WizardPage 第4步格式）：0姓名 / 1-12 描述类 / 13首次透出卷 / 14传闻卷 / 15知情人 / 16退场方式。
      const n = c.length
      const rv = safeVolume(n >= 16 ? numVolume(c[13]) : numVolume(c[n - 3]))
      const mv = safeVolume(n >= 16 ? numVolume(c[14]) : numVolume(c[n - 2]))
      const kn = splitList(n >= 16 ? c[15] : c[n - 1])
      const detailCols = n >= 16 ? c.slice(1, 13).concat(c.slice(16)) : c.slice(1, n - 3)
      assets.push(mk({ type: 'person', name: cleanName(c[0]), detail: detailCols.map(cleanDetail).join('｜'), knowers: kn, reveal_volume: rv, rumor_volume: mv }))
    } else {
      //   此前按「尾 3 列」剥 detail 会把 5 列剥成只剩身份、丢掉高光事件+高光卷序 ⟹ 改为尾 1 列锚定，detail 保留到倒数第 2 列。
      const n = c.length
      const rv = safeVolume(numVolume(c[n - 1]))
      //   该资产会因 reveal=0 被归 ban 桶永不注入 ⟹ 告警提示核对（真群像 5 列带透出卷则 rv>0、不告警）。
      if (rv === 0) console.warn(`[parseAssets] 人物表「${cleanName(c[0])}」仅 ${n} 列(<12)且透出卷解析为 0，按群像兜底；若是被截断的人物行会因 reveal=0 被归 ban 桶，请核对列数`)
      assets.push(mk({ type: 'group', name: cleanName(c[0]), detail: c.slice(1, n - 1).map(cleanDetail).join('｜'), reveal_volume: rv }))
    }
  }

  cur = null
  for (const rawLine of String(outline).split('\n')) {
    let l = rawLine.trim()
    if (!l) continue
    const sec = matchSectionHead(l, OUTLINE_SECTIONS)
    if (sec) {
      cur = sec.key
      if (!sec.rest) continue
      l = sec.rest
    } else if (l.startsWith('###')) {
      continue // ### 子标题只跳过
    } else if (l.startsWith('#') || l.startsWith('【')) {
      cur = null; continue // 任何一二级标题（终局/分卷/转折/事件节点等）关闭区块
    }
    if (!hasPipe(l)) continue
    const c = cols(l)
    if (c.length < 3 || isSepRow(c) || isHeadRow(c)) continue
    const ftitle = cleanName(c[0])
    const fdesc = String(cur === 'hook' ? c[2] || c[1] : c[1] || '')
    if (foreshadows.some((f) => (ftitle && f.title === ftitle) || (fdesc && String(f.desc || '').slice(0, 32) === fdesc.slice(0, 32)))) continue
    if (cur === 'fs') foreshadows.push({ id: `fs_${++fid}`, title: ftitle, desc: c[1], plant_volume: num(c[2]), payoff_volume: num(c[3]), tier: normTier(c[4]), rumor: num(c[5]), state: 'planted', linked_assets: [], payoff_hint: '', lastAdvancedChapter: 0 })
    else if (cur === 'hook') {
      //   「已回收」的钩子会被当未回收注入成文（AI 可能把已回收的伏笔重新埋一遍）。
      const hint = cleanDetail(c[4] || '')
      const resolved = String(c[5] || '').includes('已回收')
      foreshadows.push({ id: `fs_${++fid}`, title: ftitle, desc: c[2] || c[1], plant_volume: num(c[1]), payoff_volume: num(c[3]), tier: 'M', rumor: 0, state: resolved ? 'resolved' : 'planted', linked_assets: [], payoff_hint: hint, lastAdvancedChapter: 0 })
    }
  }

  cur = null
  for (const rawLine of String(volumes).split('\n')) {
    let l = rawLine.trim()
    if (!l) continue
    const sec = matchSectionHead(l, VOLUMES_SECTIONS)
    if (sec) {
      cur = sec.key
      if (!sec.rest) continue
      l = sec.rest
    } else {
      // 区块开关只认真标题行首(# 或 【)，正文梗概里出现"章节"二字不开区块；主标题被加粗时先剥加粗再判
      const l2 = l.replace(/\*\*/g, '')
      // ### 子标题只跳过；章表区块内的一二级标题（卷末统计等）关闭区块防假节拍；
      // 回填区块内的分组标题（如"## 势力/地点/等级资产"）不关闭，否则回填行全丢
      if (l2.startsWith('###')) continue
      if (l2.startsWith('#') || l2.startsWith('【')) {
        if (cur === 'ch') cur = null
        continue
      }
      // 自愈：AI 直接以章表行开头、没写区块标题时，见到章表行自动进章表区块。
      //   两种章行写法都要认：「21｜…」(第8步后段简表) 与「第1章｜…」(第7步完整表)——原只认纯数字，
      //   第7步整段既无段头、行首又带「第N章」→ cur 永不置 'ch'、前20章零节拍(详纲/情绪曲线/防剧透失据)。
      // M-I2：自愈正则也认中文数字章号（第一章/第二十章）——此前只认「第[0-9]+章」与纯数字，AI 用中文数字且无段头时 cur 永不置 'ch' ⟹ 该卷零节拍
      if (!cur && /^(?:第\s*(?:[0-9]+|[一二三四五六七八九十百零两]+)\s*章|\d+)\s*[｜|]/.test(l2)) { cur = 'ch' }
    }
    if (!hasPipe(l)) continue
    const c = cols(l)
    if (isSepRow(c) || isHeadRow(c)) continue
    if (cur === 'ch') {
      // 章号兼容"第1章"/中文数字
      const no = num(c[0])
      if (!no) continue
      //   改以「情绪」列(含 强度[1-5])为锚相对定位：透出资产=情绪前一列（简表/完整表都成立）；
      //   视角=情绪前两列(仅完整表有，情绪列下标≥5)；出场=情绪后一列；钩子=情绪后两列。列数漂移自然吸收。
      //   误锚（如梗概「冲突强度3升级」），导致五字段整体错位且无告警；标准布局里情绪列靠后，末匹配更稳。
      let moodIdx = -1
      for (let i = c.length - 1; i >= 0; i--) { if (hasIntensity(c[i])) { moodIdx = i; break } }
      let mood_raw, intensity, pov, reveal_assets, cast, hook
      if (moodIdx >= 0) {
        if (moodIdx < 3) console.warn(`[parseAssets] 卷章表第 ${no} 章「强度」标记出现在第 ${moodIdx} 列（异常靠前），情绪锚可能误锚、节拍字段存疑`)
        mood_raw = String(c[moodIdx] || '').slice(0, 60)
        intensity = intensityOf(c[moodIdx])
        reveal_assets = c[moodIdx - 1] || ''
        pov = moodIdx >= 5 ? c[moodIdx - 2] || '' : ''
        cast = splitList(c[moodIdx + 1])
        hook = c[moodIdx + 2] || ''
      } else {
        // 找不到「强度」标记列：退回列数启发（旧口径），并对异常列数显式告警而非静默错位
        const simple = c.length < 6
        if (c.length !== 5 && c.length !== 8) console.warn(`[parseAssets] 卷章表第 ${no} 章列数异常(${c.length} 列)且未找到「强度[1-5]」情绪标记，节拍字段可能不准`)
        mood_raw = String((simple ? c[4] || c[2] : c[5]) || '').slice(0, 60)
        intensity = simple ? intensityOf(c[4]) : intensityOf(c[5])
        pov = simple ? '' : c[3] || ''
        reveal_assets = simple ? c[3] || '' : c[4] || ''
        cast = simple ? [] : splitList(c[6])
        hook = simple ? '' : c[7] || ''
      }
      const beat = { chapter_no: no, mood_raw, intensity, pov, reveal_assets, cast, hook }
      const di = beats.findIndex((b) => b.chapter_no === no)
      if (di >= 0) beats[di] = beat
      else beats.push(beat)
    }
  }

  //   backfillChapterNos 同样处理资产 ch_reveal/ch_rumor 与伏笔 plant_ch/rumor_ch，且带 >0 守卫（空 /「—」不清零已有精确章号）。
  backfillChapterNos(assets, foreshadows, volumes)
  return { assets: buildLinks(assets), beats, foreshadows }
}

// 资产扩充解析：【次要人物】【地点】【道具】【次要势力】；行内绑定列直接建边
export function parseExpandAssets(text) {
  const out = []
  let aid = 0
  let cur = null
  const mk = (o) => ({
    id: `ex_${Date.now().toString(36)}_${++aid}`,
    aliases: [],
    tier: 'B',
    is_public: false,
    state: '活跃',
    ch_reveal: 0,
    ch_rumor: 0,
    knowers: [],
    links: [],
    ...o,
  })
  for (const raw of String(text || '').split('\n')) {
    const l = raw.trim()
    if (!l) continue
    if (l.includes('【次要人物】')) { cur = 'person'; continue }
    if (l.includes('【道具】') || l.includes('【物品】')) { cur = 'item'; continue }
    if (l.includes('【次要势力】')) { cur = 'faction'; continue }
    if (l.includes('【地点】')) { cur = 'place'; continue }
    if (l.startsWith('###')) continue
    if (isMdHead(l) && cur) { cur = null; continue }
    if (l.startsWith('【')) {
      if (cur) console.warn(`[parseAssets] 扩充资产：未识别的段标题「${l.slice(0, 20)}」，其下数据行按当前段类型继续解析（未丢弃）`)
      continue
    }
    if (!hasPipe(l)) continue
    const c = cols(l)
    if (c.length < 3 || isSepRow(c) || isHeadRow(c)) continue
    const n = c.length
    const rv = safeVolume(numVolume(c[n - 1]))
    if (cur === 'person') out.push(mk({ type: 'person', name: cleanName(c[0]), detail: c.slice(1, n - 1).map(cleanDetail).join('｜'), reveal_volume: rv }))
    else if (cur === 'place') {
      const ctrl = dashOut(c[n - 2])
      out.push(mk({ type: 'place', name: cleanName(c[0]), detail: c.slice(1, n - 2).map(cleanDetail).join('｜'), reveal_volume: rv, links: ctrl ? [{ type: 'controlled_by', to: cleanName(ctrl) }] : [] }))
    } else if (cur === 'item') {
      const holder = dashOut(c[1])
      // detail 从 c[2] 起、到倒数第 2 列止（跳过持有者 c[1] 与尾部透出卷），否则持有者名既建 held_by 边又重复灌进 detail
      out.push(mk({ type: 'item', name: cleanName(c[0]), holder: cleanName(holder), detail: c.slice(2, n - 1).map(cleanDetail).join('｜'), reveal_volume: rv, links: holder ? [{ type: 'held_by', to: cleanName(holder) }] : [] }))
    } else if (cur === 'faction') out.push(mk({ type: 'faction', name: cleanName(c[0]), detail: c.slice(1, n - 1).map(cleanDetail).join('｜'), reveal_volume: rv }))
  }
  //   局限（A 区）：这里只在**本批扩充资产内部**建边；扩充资产 ↔ 已有名册资产的跨批共现边需在 LongFormPage.appendExpand 合并后重算（appendExpand 目前只按名册裁剪边、不重建）。
  return buildLinks(out)
}

// 独立资产表解析（新手写作「资产表」步）：分段【主角】【配角】【普通角色】【地点】【势力】【道具】【群组】。
// 设计要点：①每行尾部统一锚定三列「透出卷｜传闻卷｜知情人」，中间字段数不定、一律拼进 detail，解析对列数漂移鲁棒；
//          ②人物按段分级 tier（主角 S / 配角 M / 普通角色 L），复用原本闲置的 tier 字段承载"主角/配角/普通角色"分层；
//          ③数量宁多，专治"从圣经/人物顺带解析导致资产单薄、成文时可用资产不够"。
// 资产透出仍走 reveal_volume/rumor_volume → revealChapterOf/rumorChapterOf → LongFormPage buckets，无需改动下游。
export function parseAssetTable(text) {
  const out = []
  let aid = 0
  let cur = null
  let curTier = 'M'
  const mk = (o) => ({
    id: `at_${Date.now().toString(36)}_${++aid}`,
    aliases: [],
    tier: 'M',
    is_public: false,
    state: '活跃',
    ch_reveal: 0,
    ch_rumor: 0,
    knowers: [],
    links: [],
    ...o,
  })
  for (const raw of String(text || '').split('\n')) {
    const l = raw.trim()
    if (!l) continue
    if (l.includes('【主角】')) { cur = 'person'; curTier = 'S'; continue }
    if (l.includes('【配角】')) { cur = 'person'; curTier = 'M'; continue }
    if (l.includes('【普通角色】') || l.includes('【次要角色】') || l.includes('【龙套】')) { cur = 'person'; curTier = 'L'; continue }
    if (l.includes('【地点】')) { cur = 'place'; curTier = 'M'; continue }
    if (l.includes('【势力】')) { cur = 'faction'; curTier = 'M'; continue }
    if (l.includes('【道具】') || l.includes('【物品】')) { cur = 'item'; curTier = 'M'; continue }
    if (l.includes('【群组】') || l.includes('【组织】') || l.includes('【群像】')) { cur = 'group'; curTier = 'L'; continue }
    if (l.startsWith('###')) continue
    if (isMdHead(l) && cur) { cur = null; continue }
    if (l.startsWith('【')) {
      if (cur) console.warn(`[parseAssets] 资产表：未识别的段标题「${l.slice(0, 20)}」，其下数据行按当前段类型继续解析（未丢弃）`)
      continue
    }
    if (!hasPipe(l)) continue
    const c = cols(l)
    // 至少要有 名字 + 尾部三列(透出卷｜传闻卷｜知情人) = 4 列
    if (c.length < 4 || isSepRow(c) || isHeadRow(c)) continue
    const n = c.length
    const name = cleanName(c[0])
    if (!name) continue
    const knowers = splitList(c[n - 1]).map(dash).filter(Boolean)
    const reveal_volume = safeVolume(numVolume(c[n - 3]))
    const rumor_volume = safeVolume(numVolume(c[n - 2]))
    const detail = c.slice(1, n - 3).map((x) => dash(cleanDetail(x))).filter(Boolean).join('｜')
    const base = { name, detail, reveal_volume, rumor_volume, knowers }
    if (cur === 'person') out.push(mk({ type: 'person', tier: curTier, ...base }))
    else if (cur === 'group') out.push(mk({ type: 'group', tier: curTier, ...base }))
    else if (cur === 'place') {
      //   与 reveal/rumor/knowers 的尾锚口径一致；此前固定 c[4] 在列数漂移时会抓错列、建出错误/悬空的 controlled_by 边。
      //   c[n-4] 会误把区域当控制方建错边，此时宁可不建边（错边/悬空边比缺边代价高，缺边仍可靠 buildLinks 共现或手动补）。
      const ctrl = n >= 8 ? dashOut(c[n - 4]) : ''
      out.push(mk({ type: 'place', ...base, links: ctrl ? [{ type: 'controlled_by', to: cleanName(ctrl) }] : [] }))
    } else if (cur === 'faction') out.push(mk({ type: 'faction', ...base }))
    else if (cur === 'item') {
      const holder = dashOut(c[1])
      const itemDetail = c.slice(2, n - 3).map((x) => dash(cleanDetail(x))).filter(Boolean).join('｜')
      out.push(mk({ type: 'item', holder: cleanName(holder), ...base, detail: itemDetail, links: holder ? [{ type: 'held_by', to: cleanName(holder) }] : [] }))
    }
  }
  return buildLinks(out)
}

// 从卷章表的「资产章号回填」段，把精确章号回填进给定的 assets/foreshadows。
// 续排下一卷后复用：新章表带来的透出章/传闻章写回已落库资产，让 buckets 按精确章号过滤（而非只靠卷号换算）。
export function backfillChapterNos(assets, foreshadows, volumes) {
  let cur = null
  for (const raw of String(volumes || '').split('\n')) {
    const l = raw.trim()
    if (!l) continue
    const l2 = l.replace(/\*\*/g, '')
    if ((l2.startsWith('#') || l2.startsWith('【')) && l2.includes('资产章号回填')) { cur = 'bf'; continue }
    if ((l2.startsWith('#') || l2.startsWith('【')) && l2.includes('章节')) { cur = 'ch'; continue }
    if (l2.startsWith('###')) continue
    if (l2.startsWith('#') || l2.startsWith('【')) { if (cur === 'ch') cur = null; continue }
    if (cur !== 'bf' || !hasPipe(l)) continue
    const c = cols(l)
    if (c.length < 3 || isSepRow(c) || isHeadRow(c)) continue
    const rc = num(c[1])
    const mc = num(c[2])
    //   原 `x.name === cleanName(c[0])` 精确相等：cleanName 不去内部空白、不认别名 ⟹ 回填清单写「陆 沉」或用别名时漏回填章号。与结算/流转/悬空判定同口径。
    const a = findAssetByName(assets, c[0])
    // 仅在解析出正整数章号时写入：空格 /「—」会被 num 解析成 0，不应抹掉已有的精确章号或用户手改值
    if (a) { if (rc > 0) a.ch_reveal = rc; if (mc > 0) a.ch_rumor = mc }
    const f = findForeshadowByTitle(foreshadows, c[0])
    if (f) { if (rc > 0) f.plant_ch = rc; if (mc > 0) f.rumor_ch = mc }
  }
  return { assets, foreshadows }
}

// 关系网警告：悬空绑定边(目标未建档) + 地点地域挂钩。只提示不阻断。
export function computeAssetWarnings(assets) {
  const warns = []
  const list = assets || []
  const placeNames = list.filter((a) => a && a.type === 'place').map((a) => a.name)
  list.forEach((a) => {
    if (!a) return
    ;(a.links || []).forEach((l) => {
      // 决策5：悬空判定用下沉的严格匹配 findAssetByName（认别名/《》/空格归一），修此前 names.includes(l.to) 只认精确主名、别名边误报悬空的口径
      if (l.to && !findAssetByName(list, l.to)) warns.push({ name: a.name, msg: `绑定 ${l.type}→「${l.to}」目标未建档` })
    })
    if (a.type === 'place') {
      // 地域取「区域：」后的真实值；地域候选含 place 与 faction（地点可挂在势力辖区下）
      const region = (String(a.detail || '').match(/区域[:：]([^｜/]+)/) || [])[1]?.trim()
      const regionNames = [...placeNames, ...list.filter((x) => x && x.type === 'faction').map((x) => x.name)]
      //   否则双向 includes 会让短名在任意名字里命中，产生大量假警告(或漏报)，警告失信噪比后用户会开始忽略这唯一的关系完整性提示
      if (region && region.length >= 2 && !regionNames.some((n) => n !== a.name && n.length >= 2 && (n.includes(region) || region.includes(n)))) {
        warns.push({ name: a.name, msg: `所属地域「${region}」无地域资产挂钩` })
      }
    }
  })
  return warns
}
