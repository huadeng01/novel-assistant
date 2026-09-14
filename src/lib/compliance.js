// #3 平台合规叠加扫描（市场规则 + 内容红线）
// 对标 novel-distiller「平台规则扫描：适配番茄 / 起点等不同平台的审核与留人规则」。
// 命门：同一部稿子投不同平台，市场规则天差地别——
//   · 番茄（免费阅读）：黄金三章定生死、每章强钩子、爽点/冲突密集，忌慢热与长铺垫；
//   · 起点（付费订阅）：章末钩子直接决定次章订阅、升级感节奏要稳，世界观可铺陈但须与剧情咬合；
//   · 知乎盐选（短中篇付费）：前 300 字决定完读率、反转密度高、第一人称代入强，忌注水。
// 另外所有平台都有内容红线（涉赌 / 涉毒 / 血腥 / 封建迷信 / 露骨性描写），踩线直接屏蔽或限流。
// 本模块做纯前端确定性【叠加扫描】：结构/市场规则（字数 / 章末钩子 / 黄金三章 / 悬念密度）+ 轻量敏感题材提示。
// 只报警不阻断（findings/warn，绝不 blocker），尊重作者最终拍板。叶子模块：不依赖 longform.js。纯前端、零 AI、确定性。

const arr = (x) => (Array.isArray(x) ? x : [])
const countChars = (t) => String(t || '').replace(/\s/g, '').length

// 平台规则包：words=[下限,上限]，hookRequired=章末钩子必需，goldenThree=前 3 章开篇钩子，suspenseMin=悬念密度下限。
export const PLATFORMS = [
  {
    id: 'fanqie',
    name: '番茄小说',
    model: '免费阅读',
    words: [1800, 3500],
    hookRequired: true,
    goldenThree: true,
    suspenseMin: 2,
    notes: '免费阅读靠广告分成，读者耐心极低：黄金三章定生死，每章必须有强钩子，爽点/冲突要密集，忌大段世界观铺垫与慢热。',
  },
  {
    id: 'qidian',
    name: '起点中文网',
    model: '付费订阅',
    words: [2000, 4000],
    hookRequired: true,
    goldenThree: true,
    suspenseMin: 2,
    notes: '付费订阅靠追更留存：章末钩子直接决定次章订阅，升级感/爽点节奏要稳，世界观可铺陈但需与剧情咬合。',
  },
  {
    id: 'zhihu',
    name: '知乎盐选',
    model: '短篇付费',
    words: [3000, 6000],
    hookRequired: true,
    goldenThree: false,
    suspenseMin: 3,
    notes: '盐选偏短中篇、第一人称代入强：前 300 字必须抛钩子/悬念决定完读率，反转密度要高，忌注水。',
  },
]

export function platformById(id) {
  return PLATFORMS.find((p) => p.id === id) || null
}

// 章末钩子 / 开篇钩子标记：问句、感叹、省略号、破折号，或典型悬念/转折引导词。
const HOOK_MARKERS = /(？|\?|！|!|……|——|突然|忽然|就在这时|却不知|然而|可是|难道|竟|居然|下一秒|骤然|霎时|不知何时|谁能想到|可怕的是|更让他|就在这时|话音未落|异变陡生)/
// 悬念密度标记（信息差 / 危机 / 未解问题）
const SUSPENSE_RE = /(？|\?|秘密|真相|不对劲|诡异|可疑|蹊跷|难道|究竟|为何|偏偏|竟然|居然|殊不知|暗中|悄悄|背后|阴谋|危机|杀机|埋伏|不解|疑惑|隐约|仿佛|似乎)/g

// 内容红线轻量代表词（非穷举，仅覆盖高频踩线表述）：命中即提示「可能触发平台审核」，建议侧面化/弱化。
// 定位是帮作者【规避】平台屏蔽与限流，不是审查创作自由——只提示、从不阻断。
const SENSITIVE_LEXICON = [
  { category: '涉赌', words: ['赌博', '赌场', '开盘口', '六合彩', '私彩', '聚众赌'] },
  { category: '涉毒', words: ['毒品', '吸毒', '贩毒', '冰毒', '海洛因', '摇头丸', '制毒'] },
  { category: '血腥暴力', words: ['肢解', '虐杀', '开膛破肚', '活剥', '剥皮', '碎尸', '剖腹'] },
  { category: '封建迷信', words: ['养小鬼', '下降头', '请神上身', '算命改运', '作法害人'] },
  { category: '露骨性描写', words: ['性交', '口交', '做爱', '阴道', '阴茎', '射精', '春药'] },
]

// 单章合规扫描：返回 {findings:[{rule,severity,platform,category?,where?,what,fix_hint}], platform}。
// severity='finding'（市场规则建议）/ 'warn'（内容红线，更醒目）。ctx={platform,chapterNo,title,wordCount}。
export function complianceScan(text, ctx = {}) {
  const t = String(text || '')
  const findings = []
  const p = platformById(ctx.platform)
  if (!t.trim() || !p) return { findings, platform: p ? p.name : String(ctx.platform || '') }
  const chapterNo = Number(ctx.chapterNo) || 0
  const wc = ctx.wordCount != null && ctx.wordCount !== '' ? Number(ctx.wordCount) : countChars(t)

  // ① 字数区间
  const [lo, hi] = p.words
  if (wc && wc < lo) {
    findings.push({ rule: '字数偏少', severity: 'finding', platform: p.name, what: `本章约 ${wc} 字，低于 ${p.name}（${p.model}）建议下限 ${lo} 字`, fix_hint: `${p.name}读者习惯 ${lo}~${hi} 字/章，过短显单薄：可补充场景细节 / 对话回合 / 心理活动。` })
  } else if (wc && wc > hi) {
    findings.push({ rule: '字数偏多', severity: 'finding', platform: p.name, what: `本章约 ${wc} 字，高于 ${p.name} 建议上限 ${hi} 字`, fix_hint: '过长易掉追读：可拆章或压缩铺垫，把高潮留在章末钩子前。' })
  }

  // ② 章末钩子
  if (p.hookRequired) {
    const tail = t.slice(-80)
    HOOK_MARKERS.lastIndex = 0
    if (!HOOK_MARKERS.test(tail)) {
      findings.push({ rule: '章末钩子弱', severity: 'finding', platform: p.name, where: '结尾', what: '本章结尾无明显悬念 / 钩子标记', fix_hint: `${p.name}${p.model === '付费订阅' ? '章末钩子直接决定次章订阅' : '靠钩子留人'}：结尾抛一个未解问题 / 突发转折 / 危机悬置。` })
    }
  }

  // ③ 黄金三章开篇（仅前 3 章）
  if (p.goldenThree && chapterNo >= 1 && chapterNo <= 3) {
    const head = t.slice(0, 300)
    HOOK_MARKERS.lastIndex = 0
    if (!HOOK_MARKERS.test(head)) {
      findings.push({ rule: '黄金三章开篇平', severity: 'finding', platform: p.name, where: '开篇', what: `第 ${chapterNo} 章属黄金三章，前 300 字未见钩子 / 冲突`, fix_hint: `${p.name}黄金三章定生死：开篇即抛冲突 / 悬念 / 反差，忌环境与背景长铺垫。` })
    }
  }

  // ④ 悬念密度
  const susp = (t.match(SUSPENSE_RE) || []).length
  if (susp < p.suspenseMin) {
    findings.push({ rule: '悬念密度低', severity: 'finding', platform: p.name, what: `本章悬念 / 冲突标记 ${susp} 处，低于 ${p.name} 建议 ${p.suspenseMin} 处`, fix_hint: '节奏偏平：增加未解问题 / 信息差 / 危机预兆，维持读者好奇心。' })
  }

  // ⑤ 内容红线（敏感题材）
  for (const grp of SENSITIVE_LEXICON) {
    const hit = grp.words.find((w) => t.includes(w))
    if (hit) {
      findings.push({ rule: '内容红线', severity: 'warn', platform: '全平台', category: grp.category, where: `「${hit}」`, what: `出现${grp.category}相关表述「${hit}」，可能触发平台内容审核`, fix_hint: '建议侧面化 / 弱化处理（留白、暗示、转场），避免直白描写导致屏蔽或限流。' })
    }
  }

  return { findings, platform: p.name }
}

// 全书合规扫描：逐已归档章跑 complianceScan，汇总 [{chapterNo,title,rule,severity,...}] + 各规则计数。
export function scanBookCompliance(project, platformId) {
  const p = platformById(platformId)
  const chapters = arr(project && project.chapters).filter((c) => c && typeof c.content === 'string' && c.content.length)
  const out = []
  const counts = {}
  if (!p) return { platform: null, chapters: out, counts }
  for (const ch of chapters) {
    const no = Number(ch.chapterNo) || 0
    const res = complianceScan(ch.content, { platform: platformId, chapterNo: no, title: ch.title, wordCount: ch.wordCount })
    for (const f of res.findings) {
      out.push({ chapterNo: no, title: ch.title || '', ...f })
      counts[f.rule] = (counts[f.rule] || 0) + 1
    }
  }
  out.sort((a, b) => a.chapterNo - b.chapterNo || 0)
  return { platform: p, chapters: out, counts }
}
