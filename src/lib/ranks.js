// 榜单数据加载层（纯前端运行时）：从构建产物里的静态 public/ranks.json 读取「每日热门榜快照」。
// 数据来源：scripts/fetch-ranks.mjs（本地手动或 GitHub Actions 每日定时）抓取 → 写入 public/ranks.json → 随站点一起部署。
// 本应用运行时【不发起任何跨域抓取】，只读同源静态快照，因此不受 CORS 限制、不触碰反爬、不存储任何正文。
//
// 关键：vite.config.js 里 base:'./'，构建后站点可能挂在 GitHub Pages 子路径（/repo/）下，
// 故必须用【相对 base 拼出的 URL】而非绝对 '/ranks.json'，否则子路径部署时会 404。

// 依据 Vite 注入的 BASE_URL 拼出 ranks.json 的正确 URL：
//   base='./'   → './ranks.json'（相对当前文档目录，dev 与 GH Pages 子路径都对）
//   base='/repo/' → '/repo/ranks.json'
//   base='/'    → '/ranks.json'
export function ranksUrl() {
  const b = import.meta.env.BASE_URL || './'
  return b.endsWith('/') ? `${b}ranks.json` : `${b}/ranks.json`
}

// 拉取并解析榜单快照。任何异常（文件缺失/网络失败/JSON 非法）都降级为 { ok:false, error }，绝不抛出。
export async function loadRanks(signal) {
  try {
    const res = await fetch(ranksUrl(), { signal, cache: 'no-cache' })
    if (!res.ok) return { ok: false, data: null, error: `榜单数据加载失败（HTTP ${res.status}）` }
    const data = await res.json()
    return { ok: true, data: normalizeRanks(data), error: null }
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, data: null, error: 'aborted' }
    return { ok: false, data: null, error: '未找到榜单快照（public/ranks.json），请先运行抓取脚本生成。' }
  }
}

// 防御性归一化：把外部脚本产出的 JSON 收敛成 UI 可安全渲染的结构（字段可多不可少，缺失一律兜底）。
export function normalizeRanks(data) {
  const d = data && typeof data === 'object' ? data : {}
  const sources = Array.isArray(d.sources) ? d.sources : []
  return {
    schemaVersion: Number(d.schemaVersion) || 1,
    generatedAt: typeof d.generatedAt === 'string' ? d.generatedAt : '',
    generatedAtLocal: typeof d.generatedAtLocal === 'string' ? d.generatedAtLocal : '',
    note: typeof d.note === 'string' ? d.note : '',
    sources: sources.map(normalizeSource),
  }
}

function normalizeSource(s) {
  const src = s && typeof s === 'object' ? s : {}
  const lists = Array.isArray(src.lists) ? src.lists : []
  return {
    platform: String(src.platform || ''),
    platformName: String(src.platformName || src.platform || '未知平台'),
    home: String(src.home || ''),
    ok: src.ok === true,
    error: src.error == null ? null : String(src.error),
    robotsAllowed: src.robotsAllowed !== false,
    fetchedAt: typeof src.fetchedAt === 'string' ? src.fetchedAt : '',
    lists: lists.map((l) => ({
      listId: String((l && l.listId) || 'hot'),
      listName: String((l && l.listName) || '榜单'),
      category: String((l && l.category) || ''),
      // 男频 / 女频 / 全部：部分平台（番茄/七猫/QQ阅读/书旗等）榜单按频道性别划分，供 UI 过滤。
      gender: normalizeGender(l && l.gender),
      books: (Array.isArray(l && l.books) ? l.books : []).map((b, i) => ({
        rank: Number(b && b.rank) || i + 1,
        title: String((b && b.title) || '（无书名）'),
        author: String((b && b.author) || ''),
        cover: b && typeof b.cover === 'string' && b.cover ? b.cover : '',
        intro: String((b && b.intro) || ''),
        category: String((b && b.category) || ''),
        officialUrl: String((b && b.officialUrl) || ''),
        extra: b && b.extra && typeof b.extra === 'object' ? b.extra : {},
      })),
    })),
  }
}

// 频道性别归一化：只认「男频 / 女频」，其余（含空值、'全部'、未知）一律收敛为「全部」。
export const GENDERS = ['全部', '男频', '女频']
export function normalizeGender(g) {
  const s = String(g || '').trim()
  return s === '男频' || s === '女频' ? s : '全部'
}

// 某平台下实际出现过的频道（按 GENDERS 顺序去重）——供 UI 决定要不要显示性别过滤 tab。
// 只有一个频道（如全站「全部」）时返回单元素，UI 据此隐藏过滤条。
export function gendersOf(source) {
  const lists = (source && Array.isArray(source.lists)) ? source.lists : []
  const set = new Set(lists.map((l) => normalizeGender(l && l.gender)))
  return GENDERS.filter((g) => g !== '全部' && set.has(g)).length
    ? GENDERS.filter((g) => set.has(g) || g === '全部')
    : ['全部']
}

// 按频道过滤榜单：gender='全部' 返回全部；否则返回该频道 + 未标频道（'全部'）的榜单。
export function listsByGender(source, gender) {
  const lists = (source && Array.isArray(source.lists)) ? source.lists : []
  if (!gender || gender === '全部') return lists
  return lists.filter((l) => normalizeGender(l.gender) === gender || normalizeGender(l.gender) === '全部')
}

// 汇总统计：成功平台数、总书目数——供 UI 顶部概览展示。
export function ranksSummary(data) {
  const sources = (data && Array.isArray(data.sources)) ? data.sources : []
  const okCount = sources.filter((s) => s && s.ok).length
  const failCount = sources.length - okCount
  const bookCount = sources.reduce((n, s) => n + ((s && s.lists) || []).reduce((m, l) => m + ((l && l.books) || []).length, 0), 0)
  return { platformCount: sources.length, okCount, failCount, bookCount }
}

// 把 generatedAtLocal 缺失时用 generatedAt(ISO) 兜底成可读本地时间串。
export function generatedLabel(data) {
  if (!data) return ''
  if (data.generatedAtLocal) return data.generatedAtLocal
  if (data.generatedAt) {
    const t = new Date(data.generatedAt)
    if (!Number.isNaN(t.getTime())) return t.toLocaleString('zh-CN', { hour12: false })
  }
  return ''
}
