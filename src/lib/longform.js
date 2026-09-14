// 长篇一致性系统：章后档案更新流水线 + 本地关键词检索
// 核心思想：模型每次只看到精心组装的小上下文，连贯性由这套外部档案保证
import { chatJSON, chatStream, glmEmbed, cosine } from './llm.js'
import { uid, countWords } from './utils.js'
// 预置文风基调语料（静态打包的 6 本蒸馏档案，纯数据叶子模块，不反向 import）
import { PRESET_STYLES } from '../corpus/presetStyles.js'
// 机制一/二/三：连贯性硬约束纯函数（叶子模块，不反向 import 本文件）
import { ensureCharacterUids, withStateBits, matchEntities, speakerStateScan, commitFacts, factsAt, validateFacts, FACT_PREDICATES, powerRuleAudit, injuryContradictionScan, crossChapterDupScan, runOnParagraphScan, foreshadowEndgameGate, closurePlan, assembleReview } from './continuity.js'
// P0 影响分析：归档时为每章建反向索引 refs（出场人物/伏笔/事实/规则），供改设定后反查受影响章节（叶子模块，仅依赖 continuity.js）
import { buildRefsFor } from './impact.js'
// P0 角色知识状态：秘密知情人门 + 读者已见回填（叶子模块，仅依赖 continuity.js）
import { knowerGate, assembleSecrets, applyReaderSeen } from './knowledge.js'
// P1 世界一致性门：地点/势力一等实体 + 时序门 + 缺席门 + 外貌一致性（叶子模块，仅依赖 continuity.js）
import { worldGateAll } from './worldgate.js'
// P0+ 角色声音一致性门（OOC）：台词串味 + 自称漂移（叶子模块，仅依赖 continuity.js）
import { assembleVoices, voiceGate } from './voice.js'
// #2 暗线追踪台账 + 遗忘预警门（叶子模块，不依赖 longform.js）
import { advanceThreads } from './darkthread.js'
// #3 平台合规叠加扫描（叶子模块，不依赖 longform.js）
import { complianceScan } from './compliance.js'
import {
  chapterSummaryMessages,
  rollingSummaryMessages,
  stateUpdateMessages,
  stateFactFixMessages,
  foreshadowMessages,
  consistencyCheckMessages,
  volumeMemoryMessages,
  volumePlanMessages,
  storylineUpdateMessages,
  searchExpandMessages,
  worldSplitMessages,
  styleTrialMessages,
  polishChapterMessages,
  SCENE_SIM_AGENTS,
  sceneSimAgentMessages,
  sceneSimSynthesisMessages,
  TEMPLATE_RULES,
} from './prompts.js'

// 每 20 章压缩一卷"卷志"进入长时记忆，防止早期剧情被滚动摘要遗忘
export const VOLUME_SIZE = 20
// 伏笔默认保护期（埋设后最早允许回收的章距）：主线更长，支线也要发酵（旧字段，归档自动登记沿用）
export const PROTECT_GAP = { 主线: 8, 支线: 5 }
// 四层伏笔默认保护期下限：短线日常爽点、中线卷中反转、长线主角身世级、终极锚定终卷（见 anchorForeshadowResolve）
export const TIER_GAP = { 短: 10, 中: 50, 长: 150 }
// 圣经终极真相四类固定槽位（新手写作按此生成；truth 层永不进写作上下文，只有 clues 可注入）
export const BIBLE_TRUTH_KINDS = ['终极世界观真相', '主角终极宿命', '金手指真实来源', '终极反派真实目的']

// ---------- 卷节奏模板与卷角色：打破「均分卷 + 每卷同构四幕」的模板化节奏 ----------
// 权重为相对占比：快头（开卷短而密快速立钩子）肥中（腹地卷承载地图扩张与中长伏笔）快尾（收割卷加速回收）。
// 模板长度为 6 卷基准，实际卷数不同时由 resampleWeights 等比重采样适配，无需降级均分。
export const RHYTHM_TEMPLATES = {
  '快头肥中快尾': [1, 2, 3, 2, 1, 1],
  '橄榄肥中': [1, 2, 3, 3, 2, 1],
  '渐进加速': [1, 1, 2, 2, 3, 3],
  '缓起急收': [1, 1, 1, 2, 3, 4],
  '双高潮': [2, 1, 3, 1, 3, 2],
  '均匀': [1, 1, 1, 1, 1, 1],
}

// 把权重模板重采样到指定卷数：任意模板适配任意卷数（按区间重叠比例重新分箱，形状保持）；
// 每卷权重至少 1（短卷也得有章），取整用最大余数法保形状。
export function resampleWeights(weights, n) {
  const w = (Array.isArray(weights) && weights.length ? weights : [1]).map(Number).filter((x) => x > 0)
  if (!Number.isFinite(n) || n <= 0) return []
  if (w.length === n) return w
  const L = w.length
  const raw = []
  for (let j = 0; j < n; j++) {
    const s = (j * L) / n
    const e = ((j + 1) * L) / n
    let acc = 0
    for (let i = 0; i < L; i++) {
      const overlap = Math.min(i + 1, e) - Math.max(i, s)
      if (overlap > 0) acc += overlap * w[i]
    }
    raw.push(acc)
  }
  const out = raw.map((x) => Math.max(1, Math.floor(x)))
  let sum = out.reduce((a, b) => a + b, 0)
  const target = Math.max(n, Math.round(raw.reduce((a, b) => a + b, 0)))
  const order = raw.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac)
  let k = 0
  while (sum < target && order.length) {
    out[order[k % order.length].i] += 1
    sum += 1
    k += 1
  }
  return out
}

// 按权重把总章数切成各卷章数（最大余数法，总和严格等于总章数）；权重长度与卷数不匹配时调用方自行均分兜底。
export function chaptersByRhythm(total, weights) {
  const sum = (weights || []).reduce((a, b) => a + b, 0)
  const n = (weights || []).length
  if (!sum || !n || total < n) return Array.from({ length: n }, () => Math.max(1, Math.floor(total / Math.max(1, n))))
  const raw = weights.map((w) => (w / sum) * total)
  const floors = raw.map(Math.floor)
  let rest = total - floors.reduce((a, b) => a + b, 0)
  const order = raw.map((r, i) => [r - floors[i], i]).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (rest <= 0) break
    floors[i] += 1
    rest -= 1
  }
  return floors
}

// 卷的叙事角色（决定四幕比例参考与提示词侧重）：首卷=开卷；末两卷=收割；其余按权重分腹地深耕/扩张过渡。
export function volumeRole(volumeNo, weights) {
  const n = (weights || []).length
  if (!n) return '腹地'
  if (volumeNo <= 1) return '开卷'
  if (volumeNo >= n - 1) return '收割'
  const avg = weights.reduce((a, b) => a + b, 0) / n
  return weights[volumeNo - 1] > avg ? '腹地深耕' : '扩张过渡'
}

// 四幕比例参考（仅供 AI 参考，鼓励按剧情打破；硬规则只有"禁止每卷同构均分"）
export const ACT_RATIO_GUIDE = {
  开卷: '起幕约10%（快入局不慢热），发展幕约30%，冲突幕约35%（核心冲突提前引爆），高潮落幕约25%',
  腹地深耕: '起幕约20%，发展幕约40%（地图与伏笔的主要发酵区），冲突幕约25%，高潮落幕约15%',
  扩张过渡: '起幕约15%（新地图探索为主），发展幕约35%，冲突幕约30%，高潮落幕约20%',
  收割: '起幕约10%，发展幕约20%，冲突幕约45%（终极对决主战场），高潮落幕约25%（加速回收高密度）',
}
// 章节审核：每写满 5 章解锁一次审核机会（GLM 审核剧情连贯性，只查硬性矛盾不挑刺）
export const REVIEW_WINDOW = 5

// 卷级情感走向库：每题材 2~3 条 + 每基调 2 条，题材×基调笛卡尔积即覆盖全部组合；
// AI 未生成时的确定性兜底（按卷号轮转 + 已用去重，卷间不撞车），也供设定页一键补全/换一换。
export const EMOTION_ARCS_GENRE = {
  玄幻: ['憋屈蛰伏→逆袭爆发→锋芒初露→强敌压顶→登顶畅快', '孤身闯荡→屡败不甘→奇遇翻身→宿命对决→豪迈登顶', '热血集结→并肩鏖战→牺牲刺痛→复仇怒火→破境狂喜'],
  仙侠: ['尘世困顿→机缘得道→问道孤旅→劫难淬心→羽化释然', '宗门冷暖→师门变故→独行问道→斩断尘缘→大道澄明'],
  修真: ['资质平庸→苦修不甘→资源争夺→突破狂喜→心魔拷问', '门派倾轧→外出历练→生死一线→归来得悟→境界飞跃'],
  都市: ['底层窘迫→机遇试探→名利浮沉→情感拉扯→站稳脚跟', '平凡日常→意外卷入→多方周旋→真相逼近→城市新生'],
  现实: ['生计重压→尊严受挫→微光互助→咬牙坚持→苦尽回甘', '故乡羁绊→进城漂泊→理想碰壁→和解回望→扎根生长'],
  科幻: ['认知安稳→异象冲击→探寻真相→信念动摇→新宇宙观', '技术乐观→失控征兆→自救挣扎→牺牲抉择→文明续火'],
  末世: ['安逸骤碎→求生恐慌→同伴聚拢→人性试炼→废墟立誓', '物资紧缺→据点攻防→背叛刺痛→绝地反击→重建曙光'],
  奇幻: ['异世新奇→盟友结识→阴谋浮现→远征艰险→史诗凯歌', '平凡入局→血统觉醒→王国倾覆→流亡复起→加冕回响'],
  悬疑: ['平静假象→疑点刺入→追查胶着→误导反转→真相窒息', '旧案重提→故人疑云→线索断裂→险境逼近→尘埃落定'],
  推理: ['谜面惊艳→排查受挫→灵光乍现→推理收网→揭晓快感', '委托上门→证词矛盾→暗流浮现→设局引凶→正义落槌'],
  恐怖: ['日常渗入→寒意渐浓→逃避失败→直面梦魇→余悸难消', '新家异象→传闻拼图→仪式失控→孤身对抗→天亮幸存'],
  言情: ['初遇心动→误会疏离→双向试探→深情剖白→相守笃定', '重逢旧爱→克制拉扯→心结揭开→破镜重圆→岁月温柔'],
  古代言情: ['闺阁波澜→命运错嫁→深宅周旋→情根深种→并肩破局', '江湖偶遇→恩怨纠缠→生死相护→身份揭晓→白首之约'],
  历史: ['庙堂暗涌→站队抉择→权谋缠斗→忠义两难→青史回响', '乱世离歌→投身洪流→建功立业→代价沉重→天下初定'],
  武侠: ['少年意气→师门恩怨→江湖险恶→侠义抉择→事了拂衣', '退隐不甘→旧敌重临→快意恩仇→生死一诺→相忘江湖'],
  军事: ['新兵磨砺→战友情深→战局胶着→血战突围→凯旋与哀思', '沙盘推演→情报暗战→决战部署→牺牲换胜→和平守望'],
  游戏: ['新手吃瘪→钻研翻盘→副本鏖战→版本风暴→登顶封神', '战队组建→磨合挫败→强敌压制→绝地翻盘→荣光加冕'],
  无限流: ['初入惊悚→规则摸索→队友聚散→高难绝境→破局升华', '副本轮回→积分博弈→真相线索→终局试炼→挣脱系统'],
  竞技: ['低谷复出→刻苦训练→首胜振奋→强敌连败→决赛燃魂', '新人出道→团队磨合→质疑风暴→联赛逆袭→捧杯时刻'],
  轻小说: ['日常欢乐→天降变故→羁绊加深→中二对决→青春无悔', '转生错愕→金手指试水→伙伴集结→魔王讨伐→后日谈余韵'],
}
export const EMOTION_ARCS_TONE = {
  轻松幽默: ['啼笑皆非→歪打正着→欢喜冤家→笑中带泪→圆满收场', '插科打诨→麻烦滚雪球→荒诞破局→相视大笑→轻松过关'],
  热血燃向: ['屈辱蓄力→誓约立旗→恶战连场→绝境怒吼→登顶畅快', '败而不服→特训蜕变→宿命再战→燃尽全力→痛快胜利'],
  细腻治愈: ['孤独疏离→微光相遇→彼此治愈→风雨守护→温柔归宿', '旧伤回避→缓慢靠近→信任交付→共同和解→心有所安'],
  暗黑沉重: ['希望微光→接连失去→信念拷问→深渊边缘→血路抉择', '隐忍负重→真相残酷→孤注一掷→代价沉重→余烬微明'],
  悬疑烧脑: ['疑云密布→线索诱饵→逻辑反转→认知崩塌→真相重构', '信息迷宫→层层误导→关键时刻→全局推演→豁然惊雷'],
}

// 确定性选一卷情感走向：题材池在前（风味优先）、基调池殿后；按卷号轮转且跳过已用的，保证卷间不重复。
// 库内条目均为 4~5 拍结构（用 → 分隔），与 AI 生成的卷情感走向同形。
export function fallbackVolumeEmotion({ genre, tone, volumeNo = 1, used = [] }) {
  const pool = [...(EMOTION_ARCS_GENRE[genre] || []), ...(EMOTION_ARCS_TONE[tone] || [])]
  if (!pool.length) return ''
  const avail = pool.filter((a) => !used.includes(a))
  const src = avail.length ? avail : pool
  return src[(Math.max(1, volumeNo) - 1) % src.length]
}

// 创建新书项目（长篇写作的持久化实体：设定 + 章节 + 摘要 + 伏笔 + 时间线归属同一本书）
export function newProject(name) {
  return {
    id: uid(),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    idea: '',
    genre: '玄幻',
    synopsis: '',
    world: '',
    worldBlocks: [], // 世界手册结构化块 [{id, name, aliases, kind, content}]；kind='规则' 永不省略；非空时按章选择性注入替代全量 world
    outline: '', // 精简地图（60~120 字/章）：职责是全书/全卷走向与边界感知，不是单章写作依据
    outlineDetail: {}, // 逐章详纲 { [chapterNo]: '500~700 字结构化详纲' }：写章前按需细化、是本章唯一写作依据；与 outline 分开存，避免精简地图与详纲混在一个大字符串里（续纲与编辑 UI 都难维护）
    outlineDriven: false, // 细纲驱动开关：为真时写章上下文走精简分支（只依赖本章详纲+世界规则块+出场人物卡+文风+前文尾部）；关闭时逐字节等同原有全量上下文
    volumes: [], // 显式卷档案 [{id, volumeNo, name, strategy, startChapter, length}]；写作时注入本卷战略，自动连写超出末卷范围时自动断卷规划新卷
    volumeLength: 20, // 断卷时每卷默认计划章数（卷结构区可改；0 = 开放式）
    protagonist: '', // 主角姓名（视角约束的依据，在设定页选择）
    rollingSummary: '', // 全书滚动摘要（随每章滚动更新）
    memory: [], // 卷级长时记忆 [{text, upTo}]，不可变，随写作沉淀
    memoryUpTo: 0, // 已压入卷志的章数
    storylines: [], // {name, type, progress, lastChapter} 持久化故事线档案（进展随每章回写）
    characters: [], // {uid, name, aliases, identity, personality, description, status, alive, canSpeak, location, mutableInjuries}；uid=canonical 身份主键（随机铸造、一次分配永不变、不由名字派生，机制一），alive(alive/dying/dead)/canSpeak/location/mutableInjuries 为受控状态位
    chapters: [], // {id, chapterNo, title, content, wordCount, summary, pov, issueCount, createdAt}
    foreshadows: [], // {id, content, relatedChars, importance, plantedChapter, minResolveChapter, status, resolveChapter}
    events: [], // {chapter, text} 事件级时间线
    facts: [], // 受控谓词事实库（机制二·双时态）：{id, uid, subject, predicate, value, validFrom, validTo, sourceChapter}；按 uid 索引（同名角色不合并），新值关闭旧区间而非覆盖，是消歧后的权威记忆（优先级高于名字键 chronicles）
    chronicles: {}, // 人物编年史 {姓名: [{chapter, text}]}，每章自动追加，写新章时按需注入，防百万字时遗忘早期经历（保持名字键以兼容既有档案/UI；uid 级消歧由 facts[] 承接）
    styleBookId: '', // 绑定的文风档案所属书库书籍 id（写法引擎）；空 = 不绑定，写作不注入文风
    ruleIds: null, // 启用的反模板规则 id 列表；null = 全部预设默认启用（见 activeStyleRules）
    customRules: [], // 自定义反模板规则 [{id, name, text}]，与预设并列注入
    bible: null, // 小说圣经 {world, powerRules[], truths:[{id,kind,truth,clues,locked}], anchors:[...], mapLayers:[{id,name,summary,truth,rumor,unlockVolume,locked}]}；truths[].truth 与 mapLayers[].truth 永不进写作上下文（真相隔离），powerRules 建书时并入 worldBlocks 规则块
    chapterSkeleton: [], // 全书章名骨架 [{chapterNo, title, task}]：每章一行的方向锚点，进卷时再细化为完整细纲
    refAnalysisId: '', // 绑定的参考作品拆书资产 id（全局资产、书级可切换/解绑）；空 = 不借鉴
    review: { usedCount: 0, current: null }, // 审核机会计数 + 当前审核结果（持久化，刷新不丢）
  }
}

// 中文/阿拉伯数字章号归一（细纲按需注入用）；解析失败返回 NaN
const CN_DIGITS = { 〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
export function cnToNumber(s) {
  if (/^\d+$/.test(s)) return Number(s)
  if (!s) return NaN
  if (s.length === 1) return s === '十' ? 10 : s in CN_DIGITS ? CN_DIGITS[s] : NaN
  let result = 0
  if (s.includes('百')) {
    const [head, tail] = s.split('百')
    if (!(head in CN_DIGITS)) return NaN
    result = CN_DIGITS[head] * 100
    return tail ? result + cnToNumber(tail) : result
  }
  if (s.includes('十')) {
    const [a, b] = s.split('十')
    result = (a ? (a in CN_DIGITS ? CN_DIGITS[a] : NaN) : 1) * 10 + (b ? (b in CN_DIGITS ? CN_DIGITS[b] : 0) : 0)
    return result
  }
  for (const ch of s) {
    if (!(ch in CN_DIGITS)) return NaN
    result = result * 10 + CN_DIGITS[ch]
  }
  return result
}

// 把细纲按「第N章」拆段，返回章头位置列表（按需注入与耗尽检测共用）
function outlineHeads(outline) {
  const heads = []
  String(outline || '')
    .split('\n')
    .forEach((line, i) => {
      const m = line.match(/^第\s*([0-9〇零一二三四五六七八九十百两]+)\s*章/)
      if (m) {
        const no = cnToNumber(m[1])
        if (Number.isFinite(no)) heads.push({ index: i, no })
      }
    })
  return heads
}

// 细纲覆盖到的最大章号（无可识别章头返回 0，供耗尽检测提示续写细纲）
export function outlineMaxChapter(outline) {
  const heads = outlineHeads(outline)
  return heads.length ? Math.max(...heads.map((h) => h.no)) : 0
}

// 逐场景扩写拼接去重：模型偶尔会把前文复述进新段（整段重复的生成事故），分两层兜底：
// 1) 新段开头的段落若已出现在已有正文里（哪怕只是短句衔接），视为复述丢弃；
// 2) 新段中部与已有正文完全相同的长段落（≥30 字）也剔除——重复只发生在段首之外时同样拦下。
// 归一化（去重专用）：去除所有空白/标点/符号并转小写，只留文字，用于近似重复比对
export function normalizeForDedup(s) {
  return String(s || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
}
// 字符二元组集合与 Jaccard 相似度：判定「近似重复」（改词/改标点也能识别）
function dedupBigrams(s) {
  const set = new Set()
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
  if (s.length === 1) set.add(s)
  return set
}
function dedupJaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

// 整章尾部近似重复检测（确定性、零成本）：LLM 复读时常在章末把前文整段重吐。
// 从末句向前找「最长的连续尾部重复句段」（每句都在更早处出现过），命中即裁剪。
// 双护栏防误删：尾部重复段归一化长度须 ≥ MIN_DUP_CHARS，裁剪量不得超过全章 MAX_CUT_RATIO。
export function dedupeChapterTail(text, opts = {}) {
  const MIN_DUP_CHARS = opts.minDupChars ?? 60
  const MAX_CUT_RATIO = opts.maxCutRatio ?? 0.4
  const SIM = opts.sim ?? 0.85
  const raw = String(text || '')
  if (!raw.trim()) return { text: raw, removed: '', flagged: false }
  const sentences = []
  const re = /[^。！？；…\n]+[。！？；…\n]?/g
  let m
  while ((m = re.exec(raw)) !== null) {
    const s = m[0]
    if (!s.trim()) continue
    const n = normalizeForDedup(s)
    sentences.push({ start: m.index, n, bg: dedupBigrams(n) })
  }
  if (sentences.length < 3) return { text: raw, removed: '', flagged: false }
  const totalNorm = normalizeForDedup(raw).length || 1
  // 某句是否在「更早的句子」里出现过（归一化相等，或二元组 Jaccard ≥ SIM）
  const isDupOfEarlier = (idx) => {
    const cur = sentences[idx]
    if (cur.n.length < 10) return false
    for (let j = 0; j < idx; j++) {
      const prev = sentences[j]
      if (prev.n.length < 10) continue
      if (prev.n === cur.n || dedupJaccard(cur.bg, prev.bg) >= SIM) return true
    }
    return false
  }
  // 从末句向前找出最长的连续尾部重复段起点 k
  let k = sentences.length
  while (k - 1 >= 0 && isDupOfEarlier(k - 1)) k--
  if (k >= sentences.length) return { text: raw, removed: '', flagged: false }
  const removedNorm = sentences.slice(k).reduce((sum, x) => sum + x.n.length, 0)
  if (removedNorm < MIN_DUP_CHARS) return { text: raw, removed: '', flagged: false } // 护栏1：太短不裁
  if (removedNorm / totalNorm > MAX_CUT_RATIO) return { text: raw, removed: '', flagged: false } // 护栏2：裁太多不裁
  const cutStart = sentences[k].start
  const keptText = raw.slice(0, cutStart).replace(/\s+$/, '')
  if (!keptText.trim()) return { text: raw, removed: '', flagged: false }
  return { text: keptText, removed: raw.slice(cutStart), flagged: true }
}

// 整章「句级」近重复去除（确定性、零成本）：补 dedupeChapterTail（只裁连续章尾）与 dedupeScenePiece（按段落粒度、只比对新场景 vs 前文）的盲区——
// 逐场景生成时，模型常把同一句师父教诲/同一处描写，改几个字后散落地重复在章节中段的不同段落里（实测 hard 级泄漏到成稿）。
// 本函数把整章拆成句子，凡是与「更早已保留的某句」归一化相等或二元组 Jaccard≥SIM 的长句，删掉后面那次重复，保留最早出现的一处。
// 三重护栏防误删：只处理归一化长度≥MIN_CHARS 的长句（短对话/提示语/口号不碰）；相似度阈值高（近原样才算）；总删除量超过全章 MAX_CUT_RATIO 则整体放弃。
export function dedupeChapterSentences(text, opts = {}) {
  const SIM = opts.sim ?? 0.82
  const MIN_CHARS = opts.minChars ?? 14
  const MAX_CUT_RATIO = opts.maxCutRatio ?? 0.3
  const raw = String(text || '')
  if (!raw.trim()) return { text: raw, removedCount: 0, removed: '', flagged: false }
  const sentences = []
  const re = /[^。！？；…\n]+[。！？；…\n]?/g
  let m
  while ((m = re.exec(raw)) !== null) {
    const s = m[0]
    if (!s.trim()) continue
    const n = normalizeForDedup(s)
    sentences.push({ start: m.index, end: m.index + m[0].length, n, bg: dedupBigrams(n) })
  }
  if (sentences.length < 4) return { text: raw, removedCount: 0, removed: '', flagged: false }
  const kept = []
  const removeSpans = []
  for (const cur of sentences) {
    if (cur.n.length < MIN_CHARS) { kept.push(cur); continue } // 短句直接保留，也不作为比对源
    let dup = false
    for (const prev of kept) {
      if (prev.n.length < MIN_CHARS) continue
      if (prev.n === cur.n || dedupJaccard(cur.bg, prev.bg) >= SIM) { dup = true; break }
    }
    if (dup) removeSpans.push([cur.start, cur.end])
    else kept.push(cur)
  }
  if (!removeSpans.length) return { text: raw, removedCount: 0, removed: '', flagged: false }
  const totalNorm = normalizeForDedup(raw).length || 1
  const removedText = removeSpans.map(([s, e]) => raw.slice(s, e)).join('')
  if (normalizeForDedup(removedText).length / totalNorm > MAX_CUT_RATIO) {
    return { text: raw, removedCount: 0, removed: '', flagged: false } // 护栏：删太多疑似误伤，整体放弃
  }
  let out = raw
  for (let i = removeSpans.length - 1; i >= 0; i--) { // 从后往前删，避免索引错位
    const [s, e] = removeSpans[i]
    out = out.slice(0, s) + out.slice(e)
  }
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').replace(/^\s+/, '')
  if (!out.trim()) return { text: raw, removedCount: 0, removed: '', flagged: false }
  return { text: out, removedCount: removeSpans.length, removed: removedText, flagged: true }
}

// Fix B（Round-5 重新标定）：把「每章字数预算」折算成 API max_tokens 硬上限，防模型无视提示词里的篇幅要求逐场景膨胀。
// 旧公式按「1 字 ≈ 1.5 token」折算（cw×1.5/n），但通义中文散文实测约「1 字 ≈ 1.0 token」
// （Round-5 全流程：3487 字 / 3000 tokens = 1.16 字每 token；受控实验 1580 字 / 1500 tokens = 1.05），
// 等于把预算放大 ~1.7 倍 → 终稿 3487/2621/3617 字 vs 目标 2000（+74%/+31%/+81%），§1 #9 全线超标。
// 新机制：①每场景字数预算 = 章目标/场景数（sceneWordBudget，场景数由规划自适应，预算随之自适应）；
//         ②已写超支时压缩后续场景、欠支时放宽（上下限 ±50%），使整章收敛到目标 ±20% 内——即「分场景硬闸」；
//         ③token 上限 = 预算 × 1.15 余量：既让上限真成为硬闸，又留余量避免正常收尾被截断；
//         ④真被截断时由 trimToSentenceEnd 兜底，不把正文留在半句上。
export const TOKENS_PER_CHAR = 1.0
export const CAP_HEADROOM = 1.15

// 每场景字数预算（自适应硬闸）：index=已写完的场景数，writtenWords=已写成正文字数。
// 理想均分 even = cw/n；剩余预算按剩余场景数均摊，再用 even 的 0.5~1.5 倍夹住，防单场景被压得过碎或放得过胖。
export function sceneWordBudget(chapterWords = 2000, sceneCount = 1, index = 0, writtenWords = 0) {
  const cw = Number(chapterWords) > 0 ? Number(chapterWords) : 2000
  const n = Math.max(1, Math.floor(Number(sceneCount) || 1))
  const i = Math.min(Math.max(0, Math.floor(Number(index) || 0)), n - 1)
  const written = Math.max(0, Number(writtenWords) || 0)
  const even = cw / n
  const left = Math.max(1, n - i)
  const ideal = (cw - written) / left
  return Math.round(Math.min(even * 1.5, Math.max(even * 0.5, ideal)))
}

// 字数预算 → token 上限（带余量与上下界；上限 1600 防单场景无限放大，下限 500 防碎场景写不出完整过程）
export function tokenCapForWords(wordBudget, headroom = CAP_HEADROOM) {
  const w = Number(wordBudget) > 0 ? Number(wordBudget) : 2000
  const h = Number(headroom) > 0 ? Number(headroom) : CAP_HEADROOM
  return Math.min(1600, Math.max(500, Math.round(w * TOKENS_PER_CHAR * h)))
}

export function sceneTokenCap(chapterWords = 2000, sceneCount = 1) {
  return tokenCapForWords(sceneWordBudget(chapterWords, sceneCount, 0, 0))
}

export function singleTokenCap(chapterWords = 2000) {
  const cw = Number(chapterWords) > 0 ? Number(chapterWords) : 2000
  return Math.min(2700, Math.max(1600, Math.round(cw * TOKENS_PER_CHAR * CAP_HEADROOM)))
}

// 截断安全网：max_tokens 触顶时正文会停在半句上（读感崩坏、且下游去重/自检按句切分会误判）。
// 只在结尾不是句末标点时，回退到最后一个完整句末（。！？…，含其后的收引号），确定性丢掉残句；
// 保守护栏：保留长度 < minKeep 字则不动（宁可留残句，也不把短场景删空）。不改字、不删完整句。
export function trimToSentenceEnd(text, opts = {}) {
  const raw = String(text || '')
  const minKeep = opts.minKeep ?? 200
  const t = raw.replace(/\s+$/, '')
  if (!t) return { text: raw, trimmed: 0, flagged: false }
  if (/[。！？…][”’』」）)]?$/.test(t)) return { text: raw, trimmed: 0, flagged: false }
  let cut = -1
  for (let i = t.length - 1; i >= 0; i--) {
    if ('。！？…'.includes(t[i])) {
      cut = i + 1
      while (cut < t.length && '”’』」）)'.includes(t[cut])) cut++
      break
    }
  }
  if (cut < minKeep) return { text: raw, trimmed: 0, flagged: false }
  const kept = t.slice(0, cut)
  return { text: kept, trimmed: t.length - kept.length, flagged: true }
}

// 截断兜底的调用闸门：只有「产出字数已贴近本场景预算」时才认为是 max_tokens 触顶造成的残句，
// 否则模型可能只是用一句短对白（如「明天见」）自然收场，回退到上一个句号会误删完整句。
// nearRatio 默认 0.85：低于该比例视为未触顶，原样返回（不改字、不删句）。
export function trimTruncatedScene(piece, wordBudget, opts = {}) {
  const raw = String(piece || '')
  const nearRatio = opts.nearRatio ?? 0.85
  const budget = Number(wordBudget) > 0 ? Number(wordBudget) : 0
  const chars = raw.replace(/\s/g, '').length
  if (!budget || chars < Math.max(120, Math.round(budget * nearRatio))) return { text: raw, trimmed: 0, flagged: false }
  return trimToSentenceEnd(raw, { minKeep: opts.minKeep ?? 120 })
}
// 确定性去除「大段重复子句」：后句与某个靠前句共享 ≥hardLen 字的公共子串（整段重吐），
// 或共享 ≥minLen 字且该子串占后句归一化长度 ≥dominate（后句基本是前句的复刻），则删除后句、只保留最先出现的一处。
// 补 dedupeChapterSentences（整句 bigram Jaccard≥0.82）之不足：专治嵌在不同长句里、句级相似度不达标、
// 但存在长公共子串的重复——LLM 自检在超长章无法可靠重写全章时的确定性兜底。
export function dedupeRepeatedClauses(text, opts = {}) {
  const minLen = opts.minLen ?? 18
  const dominate = opts.dominate ?? 0.5
  const hardLen = opts.hardLen ?? 30
  const raw = String(text || '')
  if (!raw.trim()) return { text: raw, removedCount: 0, removed: '', flagged: false }
  const re = /[^。！？；…\n]+[。！？；…\n]?/g
  const clauses = []
  let m
  while ((m = re.exec(raw)) !== null) {
    if (m[0].trim()) clauses.push({ s: m[0], n: normalizeForDedup(m[0]) })
  }
  if (clauses.length < 3) return { text: raw, removedCount: 0, removed: '', flagged: false }
  const kept = []
  const removed = []
  for (const c of clauses) {
    if (c.n.length < minLen) { kept.push(c); continue }
    let dup = false
    for (const p of kept) {
      if (p.n.length < minLen) continue
      const common = longestCommonSubstring(p.n, c.n)
      if (common.length >= hardLen || (common.length >= minLen && common.length / c.n.length >= dominate)) { dup = true; break }
    }
    if (dup) removed.push(c.s.trim())
    else kept.push(c)
  }
  if (!removed.length) return { text: raw, removedCount: 0, removed: '', flagged: false }
  return { text: kept.map((c) => c.s).join(''), removedCount: removed.length, removed: removed.join('｜').slice(0, 500), flagged: true }
}

// 确定性「重复长短语」扫描（补 dedupeChapterSentences 的粒度盲区）：《剑来》式 40~80 字长复句里，
// 模型常把同一短语（师父教诲/签名比喻/口头禅）改几个字后散落在不同段落重复，整句 Jaccard 被稀释到阈值下抓不到（round-3 实测泄漏到成稿）。
// 本函数跨句找出字面高度雷同的长短语（归一化后 ≥ minLen 字），只做「确定性检测」交给落库前自检精准改写——
// 检测靠代码（可靠）、修复靠模型（不破坏长复句语法），不做句中删除手术。只报告不改动，误报无害（模型自行判断是否真需改）。
export function findRepeatedPhrases(text, opts = {}) {
  const minLen = opts.minLen ?? 12
  const maxReport = opts.maxReport ?? 8
  const raw = String(text || '')
  if (!raw.trim()) return []
  const norms = []
  const re = /[^。！？；…\n]+/g
  let m
  while ((m = re.exec(raw)) !== null) {
    const n = normalizeForDedup(m[0])
    if (n.length >= minLen) norms.push(n)
  }
  if (norms.length < 2) return []
  const found = new Set()
  for (let i = 0; i < norms.length; i++) {
    for (let j = i + 1; j < norms.length; j++) {
      const lcs = longestCommonSubstring(norms[i], norms[j])
      if (lcs.length >= minLen) found.add(lcs)
    }
  }
  if (!found.size) return []
  // 去冗余：短短语若是已选更长短语的子串则丢弃；按长度降序取前 maxReport
  const out = []
  for (const p of [...found].sort((a, b) => b.length - a.length)) {
    if (out.some((q) => q.includes(p))) continue
    out.push(p)
    if (out.length >= maxReport) break
  }
  return out
}

// 最长公共子串（滚动双数组 DP，避免逐行分配）：跨句检测字面重复长短语的底座
function longestCommonSubstring(a, b) {
  if (!a || !b) return ''
  const lb = b.length
  let prev = new Array(lb + 1).fill(0)
  let cur = new Array(lb + 1).fill(0)
  let maxLen = 0
  let endA = 0
  for (let i = 1; i <= a.length; i++) {
    cur.fill(0)
    const ca = a[i - 1]
    for (let j = 1; j <= lb; j++) {
      if (ca === b[j - 1]) {
        cur[j] = prev[j - 1] + 1
        if (cur[j] > maxLen) { maxLen = cur[j]; endA = i }
      }
    }
    const tmp = prev; prev = cur; cur = tmp
  }
  return maxLen > 0 ? a.slice(endA - maxLen, endA) : ''
}

// 收束点越界的确定性截断（治「节奏提前」）：自检模型只负责【定位】本章应保留的最后一句(anchor)，
// 代码据此【确定性删除】其后的越界内容——把 round-3 实测不可靠的「模型改写越界」（单次常删不干净）换成「模型定位边界 + 代码截断」。
// 双护栏：anchor 须匹配到全章后段某句（越界只在结尾，归一化 Jaccard≥SIM）；删除量超过 MAX_CUT_RATIO 视为锚点错配，放弃不删。
export function truncateAfterAnchor(text, anchor, opts = {}) {
  const SIM = opts.sim ?? 0.55
  const MAX_CUT_RATIO = opts.maxCutRatio ?? 0.5
  const raw = String(text || '')
  const anc = normalizeForDedup(anchor)
  if (!raw.trim() || anc.length < 6) return { text: raw, flagged: false, removed: '' }
  const sentences = []
  const re = /[^。！？；…\n]+[。！？；…\n]?/g
  let m
  while ((m = re.exec(raw)) !== null) {
    const s = m[0]
    if (!s.trim()) continue
    const n = normalizeForDedup(s)
    sentences.push({ end: m.index + m[0].length, n, bg: dedupBigrams(n) })
  }
  if (sentences.length < 3) return { text: raw, flagged: false, removed: '' }
  const ancBg = dedupBigrams(anc)
  const searchFrom = Math.max(0, Math.floor(sentences.length * 0.35)) // 只在全章后 65% 找锚点（越界必在结尾附近）
  let best = -1
  let bestSim = 0
  for (let i = searchFrom; i < sentences.length; i++) {
    const sim = sentences[i].n === anc ? 1 : dedupJaccard(sentences[i].bg, ancBg)
    if (sim > bestSim) { bestSim = sim; best = i }
  }
  if (best < 0 || bestSim < SIM || best >= sentences.length - 1) return { text: raw, flagged: false, removed: '' }
  const cutStart = sentences[best].end
  const kept = raw.slice(0, cutStart).replace(/\s+$/, '')
  const removed = raw.slice(cutStart)
  if (!kept.trim()) return { text: raw, flagged: false, removed: '' }
  const totalNorm = normalizeForDedup(raw).length || 1
  if (normalizeForDedup(removed).length / totalNorm > MAX_CUT_RATIO) return { text: raw, flagged: false, removed: '' } // 护栏：删太多疑似锚点错配
  return { text: kept, flagged: true, removed }
}

export function dedupeScenePiece(base, piece) {
  const text = String(piece || '').trim()
  if (!base || !text) return text
  // 归一化匹配：改掉精确 base.includes 的脆性——改标点/空白/个别词的近似重复也能拦
  const normBase = normalizeForDedup(base)
  const baseParas = base.split(/\n+/).filter(Boolean).map((p) => normalizeForDedup(p)).filter((n) => n.length >= 12)
  const isDup = (rawPara) => {
    const n = normalizeForDedup(rawPara)
    if (n.length >= 10 && normBase.includes(n)) return true
    if (n.length >= 12) {
      const bg = dedupBigrams(n)
      for (const bp of baseParas) if (dedupJaccard(bg, dedupBigrams(bp)) >= 0.85) return true
    }
    return false
  }
  const paras = text.split(/\n+/).filter(Boolean)
  let i = 0
  while (i < paras.length) {
    const t = paras[i].trim()
    if (t.length >= 12 && isDup(t)) i++
    else break
  }
  const kept = []
  for (; i < paras.length; i++) {
    const t = paras[i].trim()
    if (t.length >= 30 && isDup(t)) continue
    kept.push(paras[i])
  }
  const out = kept.join('\n\n').trim()
  return out || text
}

// 细纲按需注入：把细纲按"第N章"拆段，只取本章及后续 windowSize 章，避免百万字细纲全量进上下文
export function outlineForChapter(outline, chapterNo, windowSize = 3) {
  if (!outline) return ''
  const lines = String(outline).split('\n')
  const heads = outlineHeads(outline)
  if (!heads.length) return outline // 没有可识别章号，降级全量注入（短细纲场景）
  const kept = heads.filter((h) => h.no >= chapterNo && h.no < chapterNo + windowSize)
  // 细纲未覆盖本章（耗尽或断档）：返回空而不是全量，防止长细纲撞爆上下文；由界面提示续写细纲
  if (!kept.length) return ''
  return kept
    .map((h) => {
      // 右边界取「全量 heads 里紧跟其后的那个章头」，而不是 kept 的下一项、更不是 lines.length：
      // 末块若取 lines.length，会把本章之后的全部细纲一并夹带进来，窗口形同虚设（与 skeletonTextForRange 同口径）。
      const hi = heads.indexOf(h)
      const end = hi + 1 < heads.length ? heads[hi + 1].index : lines.length
      return lines.slice(h.index, end).join('\n')
    })
    .join('\n\n')
}

// 本章详纲（逐章按需细化的产物）：优先取 project.outlineDetail[chapterNo]（500~700 字结构化详纲，含 [任务]/[场景N]/[边界]/[钩子]/[字数] 行），
// 旧书无详纲或本章未细化时降级到精简地图的本章切片（约 60~120 字）。
// 注意降级路径的窗口口径：outlineForChapter 修正末块右边界之前，windowSize=1 实际会带回「本章到全书结尾」的所有章纲
// （写章上下文里摊着后续全部剧情，是节奏提前最硬的一个泄漏源）；修正后严格只有本章这一段。
// 写章/自检/归档等所有「取本章细纲」的地方统一走本函数，不再直调 outlineForChapter。
export function detailOutlineFor(project, chapterNo) {
  const d = project?.outlineDetail?.[chapterNo]
  if (d && String(d).trim()) return String(d)
  return outlineForChapter(project?.outline, chapterNo, 1)
}

// ---------- 详纲确定性解析：详纲已切好场景时，跳过场景清单那次 LLM 调用 ----------
// 详纲格式（章头行 + [标签] 行，由 prompts.chapterOutlineDetailMessages 产出）：
//   第12章【承】夜访旧档
//   [任务] 一句话，来自章名骨架，硬约束
//   [场景1] 地点/在场人物 → 发生什么 → 落点
//   [边界] 本章允许揭示：…；本章严禁触及：…
//   [钩子] 章末悬念
//   [字数] 2000（场景1:700 / 场景2:700 / 场景3:600）
// 返回与「场景清单请求」同形的 { scenes, participants, locations, factLedger, proposals }（另附 task/boundary/hook 供 UI 预览），
// 调用方可直接拿它替代 planScenesOnce 的结果：省一次请求，且场景切分与详纲 100% 对齐
// （根治「详纲切 3 场景、清单要 5 场景」的错配——那种错配会把详纲的字数分配全部打乱）。
// proposals 固定为空数组：细纲驱动模式下重大分支已在详纲生成阶段由作者确认过，这是该模式的设计前提。
// 一个 [场景N] 行都解析不出（详纲非结构化 / 旧书只有 60~120 字精简细纲）时返回 null，调用方降级走原场景清单请求。
const DETAIL_ARROW = /→|->|=>|＞|➔/
export function parseDetailScenes(detailText, project = null, chapterNo = 0) {
  const lines = String(detailText || '').split('\n')
  // 标签行解析：[任务]/[边界]/[钩子] 与 [场景N] 共用一套方括号口径（全角【】同样认）
  const tagOf = (line) => {
    const m = String(line).trim().match(/^[\[【]\s*([^\]】]{1,8}?)\s*[\]】]\s*[:：]?\s*([\s\S]*)$/)
    return m ? { tag: m[1].trim(), body: m[2].trim() } : null
  }
  const pick = (name) => {
    for (const line of lines) {
      const t = tagOf(line)
      if (t && t.tag === name && t.body) return t.body
    }
    return ''
  }
  const rawScenes = []
  for (const line of lines) {
    const t = tagOf(line)
    if (!t || !t.body) continue
    const m = t.tag.match(/^场景\s*([0-9〇零一二三四五六七八九十]+)$/)
    if (m) rawScenes.push({ no: cnToNumber(m[1]), body: t.body })
  }
  if (!rawScenes.length) return null

  // 人名索引：participants 与 locations 都靠它把「地点/在场人物」段里的人名剔出去（否则人物名会被当地点注入世界手册匹配）
  const nameIndex = (Array.isArray(project?.characters) ? project.characters : [])
    .filter((c) => c && c.name)
    .map((c) => ({ name: c.name, keys: [c.name, ...aliasesOf(c)].filter(Boolean) }))
  // 世界手册块名索引：地点命中档案时用原名，buildWorldBlockText 的选择性注入靠名字对齐
  const blockIndex = (Array.isArray(project?.worldBlocks) ? project.worldBlocks : [])
    .filter((b) => b && b.name)
    .map((b) => ({ name: b.name, keys: [b.name, ...String(b.aliases || '').split(/[,，、]/).map((s) => s.trim())].filter((k) => k && k.length >= 2) }))

  const participants = []
  const locations = []
  const scenes = rawScenes.map((s, i) => {
    const segs = s.body.split(DETAIL_ARROW).map((x) => x.trim()).filter(Boolean)
    const head = segs.length ? segs[0] : s.body
    for (const tokRaw of head.split(/[\/、,，|｜]/)) {
      const tok = tokRaw.trim().replace(/[：:（）()]+$/, '')
      if (tok.length < 2) continue
      const person = nameIndex.find((n) => n.keys.some((k) => tok.includes(k) || k.includes(tok)))
      if (person) {
        if (!participants.includes(person.name)) participants.push(person.name)
        continue
      }
      const blk = blockIndex.find((b) => b.keys.some((k) => tok.includes(k) || k.includes(tok)))
      const loc = blk ? blk.name : tok
      if (loc.length <= 20 && !locations.includes(loc)) locations.push(loc)
    }
    // 三段拆：≥3 段时 enter/advance/exit 各就各位，summary 取中段（三段合起来已覆盖全句，不重复整句以免注水）；
    // 不足 3 段时 summary 直接背全文、advance 留空 —— serializeSceneLine 检测到缺字段会自动降级为「title：summary」，一个字都不丢。
    let enter = ''
    let exit = ''
    let advance = ''
    let summary = s.body
    if (segs.length >= 3) {
      enter = segs[0]
      advance = segs[1]
      exit = segs[segs.length - 1]
      summary = segs.slice(1, -1).join('，')
    } else if (segs.length === 2) {
      enter = segs[0]
      exit = segs[1]
    }
    const title = (enter || summary).replace(/[\/、,，|｜]\s*$/, '').slice(0, 6) || `场景${i + 1}`
    return { title, summary: summary.slice(0, 200), enter, exit, advance }
  })

  // 事实台账仍走既有派生（确定性、零 Token）：本章出场人物当前状态 + 世界规则块 → items/numbers/constraints
  const ledger = project ? deriveFactLedger(project, chapterNo, participants).ledger : null
  return { scenes, participants, locations, factLedger: ledger, proposals: [], task: pick('任务'), boundary: pick('边界'), hook: pick('钩子'), fromDetail: true }
}

// 章头起承转合定位标签解析：细纲章头行格式「第N章【X】标题」，返回 起/承/转/合/过渡 或空（旧细纲无标签时不注入）
export function outlinePositionFor(outline, chapterNo) {
  for (const line of String(outline || '').split('\n')) {
    const m = line.match(/^第\s*([0-9〇零一二三四五六七八九十百两]+)\s*章\s*【\s*(起|承|转|合|过渡)\s*】/)
    if (m && cnToNumber(m[1]) === chapterNo) return m[2]
  }
  return ''
}

// 卷结构：判定某章属于哪一卷（按 startChapter + length 切段）；未建档返回 null。
// 末卷 length 为 0 视为开放式（不断卷），最后一卷兜底承接后续所有章节。
export function currentVolume(project, chapterNo) {
  const vols = project.volumes || []
  if (!vols.length) return null
  for (const v of vols) {
    const end = v.length ? v.startChapter + v.length - 1 : Infinity
    if (chapterNo >= v.startChapter && chapterNo <= end) return v
  }
  const last = vols[vols.length - 1]
  return chapterNo >= last.startChapter ? last : null
}

// 是否需要断卷开新卷：仅当卷档案已启用（至少一卷）且下一章超出末卷范围时为真；
// 末卷开放式（length=0）永不自动断卷。
export function needNewVolume(project, chapterNo) {
  const vols = project.volumes || []
  if (!vols.length) return false
  const last = vols[vols.length - 1]
  return last.length ? chapterNo > last.startChapter + last.length - 1 : false
}

// 本章注入用的卷战略文本（无卷档案或无战略时为空不注入）；结构化字段（起承转合结构/情感走向）存在时一并渲染，旧卷只有 strategy 字段时向后兼容。
// lean=true（细纲驱动模式）只拼 arcStory + endHook + 本卷禁回收清单：
// 跳过 mapContextFor（含后续地图层名称，是剧透源）、strategy/arc/emotion/theme/conflict/gain/location
// （本章落点已由详纲写死，这些自由文本只增噪声与漂移风险）。lean=false 时输出与改造前逐字节一致。
export function volumeStrategyText(project, chapterNo, { lean = false } = {}) {
  const v = currentVolume(project, chapterNo)
  if (!v) return ''
  if (!lean && !v.strategy) return ''
  const parts = [`第${v.volumeNo}卷《${v.name}》`]
  if (!lean) parts.push(v.strategy)
  if (v.arcStory) parts.push(`本卷故事（本章围绕它推进，不写跨卷主线）：${v.arcStory}`)
  if (!lean) {
    if (v.theme) parts.push(`本卷主题：${v.theme}`)
    if (v.conflict) parts.push(`本卷核心冲突：${v.conflict}`)
    if (v.gain) parts.push(`本卷收获：${v.gain}`)
  }
  if (v.endHook) parts.push(`卷末大悬念（仅卷末允许落在其上）：${v.endHook}`)
  if (!lean) {
    if (v.location) parts.push(`本卷主舞台：${v.location}`)
    const mapCtx = mapContextFor(project, chapterNo)
    if (mapCtx) parts.push(mapCtx)
    if (v.arc) parts.push(`起承转合结构：${v.arc}`)
    if (v.emotion) parts.push(`情感走向：${v.emotion}`)
  }
  // 本卷禁回收清单：圣经流程为每卷圈定长线伏笔，写作与场景规划必须尊重（抢收另有归档硬拦截兜底）
  const ids = new Set(v.forbiddenForeshadowIds || [])
  const banned = (project.foreshadows || []).filter((f) => ids.has(f.id)).map((f) => f.content)
  if (banned.length) parts.push(`本卷绝对不回收的长线伏笔（只许铺垫渲染）：${banned.map((b) => `「${b}」`).join('、')}`)
  return parts.length > 1 ? parts.join('\n') : ''
}

// 本卷故事注入（长篇续纲用）：给定章号区间涵盖的各卷，汇总其 arcStory，提醒续纲围绕“每卷一个独立故事”展开而非拉长同一件事
export function volumeStoryForRange(project, from, to) {
  if (!from || to < from) return ''
  const seen = new Set()
  const lines = []
  for (let n = from; n <= to; n++) {
    const v = currentVolume(project, n)
    if (!v || seen.has(v.volumeNo) || !v.arcStory) continue
    seen.add(v.volumeNo)
    lines.push(`第${v.volumeNo}卷《${v.name || ''}》本卷故事：${v.arcStory}`)
  }
  return lines.join('\n')
}

// ---------- 世界地图分层·传闻级隔离（根治"世界观困死一城"） ----------
// 圣经登记地图阶梯 [{name, summary, truth, rumor, unlockVolume}]：
// 写作上下文只能看到「已解锁层的正式设定 + 下一层的传闻」（rumor 短引），更高层与所有 truth 一律不进上下文；
// truth 仅供审核对照（见 reviewTruths），防 AI 把后续卷的大世界提前写死。
export function mapContextFor(project, chapterNo) {
  const layers = (project.bible?.mapLayers || []).filter((m) => m && m.name)
  if (!layers.length) return ''
  const v = currentVolume(project, chapterNo)
  const unlocked = (v && Number(v.unlockLayer) > 0 && Number(v.unlockLayer) <= layers.length ? Number(v.unlockLayer) : 1)
  const parts = []
  const open = layers.slice(0, unlocked).map((m, i) => `${i + 1}. ${m.name}：${m.summary || ''}`).filter(Boolean)
  if (open.length) parts.push(`世界地图·已解锁区域（可正式展开场景与细节）：\n${open.join('\n')}`)
  const nextL = layers[unlocked]
  if (nextL) parts.push(`世界地图·远方传闻（本章只允许以传闻/口耳相传/向往的形式提及，禁止展开细节与实地场景）：「${nextL.rumor || nextL.name}」`)
  const beyond = layers.slice(unlocked + 1).map((m) => m.name)
  if (beyond.length) parts.push(`世界地图·禁区（尚未进入故事，禁止提及任何细节）：${beyond.join('、')}`)
  return parts.join('\n')
}

// ---------- 卷级弧线坐标系：起承转合定位标签以「本章在本卷弧线中的位置」为准 ----------
// 无卷档案/无 arc 时的默认弧线（20 章基准：起1-5/承6-12/转13-17/合18-20），按本卷计划章数等比缩放
const ARC_WEIGHTS = [
  { pos: '起', end: 0.25 },
  { pos: '承', end: 0.6 },
  { pos: '转', end: 0.85 },
  { pos: '合', end: 1 },
]

// 自由文本 arc 的阶段名 → 定位标签映射（命中关键词即归类，否则按出现顺序兜底到 起/承/转/合）
const ARC_POS_KEYWORDS = [
  { pos: '起', kws: ['起', '铺垫', '开局', '开篇', '蓄势'] },
  { pos: '承', kws: ['承', '发展', '推进', '发酵'] },
  { pos: '转', kws: ['转', '高潮', '爆发', '反转', '冲突'] },
  { pos: '合', kws: ['合', '收束', '收尾', '兑现', '结局'] },
]
const posOfStage = (name, index) => {
  for (const p of ARC_POS_KEYWORDS) if (p.kws.some((k) => name.includes(k))) return p.pos
  return ARC_WEIGHTS[Math.min(index, 3)].pos
}

// 解析卷档案的自由文本 arc（如「铺垫(第1-5章)→发展(第6-12章)」），抽出各阶段章节范围；
// 章号为卷内相对坐标（从 1 起）；无法解析出 ≥2 段时返回 null，由调用方降级到默认弧线。
export function parseVolumeArc(arc) {
  const segs = []
  const re = /([^()（）\s→—\->,，;；]{1,10})\s*[（(]([^)）]{2,26})[)）]/g
  let m
  while ((m = re.exec(String(arc || '')))) {
    const rm = m[2].match(/(\d+)\s*[-—~至到]\s*(\d+)/)
    if (!rm) continue
    const s = Number(rm[1])
    const e = Number(rm[2])
    if (s >= 1 && e >= s) segs.push({ name: m[1], start: s, end: e })
  }
  return segs.length >= 2 ? segs : null
}

// 卷内章节范围 [from, to] 的弧线坐标：优先卷档案 arc 的结构化范围，否则默认弧线按长度缩放；
// length<=0（开放式）按 20 章基准。返回 [{pos, start, end}]（卷内相对章号）。
export function arcRanges(volume, from, to) {
  const parsed = parseVolumeArc(volume?.arc)
  if (parsed) {
    return parsed.map((seg, i) => ({ pos: posOfStage(seg.name, i), start: seg.start, end: seg.end }))
  }
  const L = Math.max(to - from + 1, volume?.length > 0 ? volume.length : 20)
  const ranges = []
  let prevEnd = 0
  for (const w of ARC_WEIGHTS) {
    if (prevEnd >= L) break // 极短卷：章数不够四段时只保留有效段，不产生倒挂区间
    const end = Math.min(L, Math.max(prevEnd + 1, Math.round(L * w.end)))
    ranges.push({ pos: w.pos, start: prevEnd + 1, end })
    prevEnd = end
  }
  return ranges
}

// 卷弧线坐标的提示词文本：供细纲生成/续写注入，使定位标签与卷结构全链路对齐；无可定位卷时返回空。
export function arcTextForRange(project, from, to) {
  if (!from || to < from) return ''
  const vols = project?.volumes || []
  if (!vols.length) {
    const ranges = arcRanges({ length: project?.volumeLength || 20 }, from, to)
    return `未建档卷，按默认弧线（随计划章数缩放）：${ranges.map((r) => `${r.pos}=第${r.start}-${r.end}章`).join('；')}`
  }
  const parts = []
  for (let n = from; n <= to; n++) {
    const v = currentVolume(project, n)
    if (!v || parts.some((p) => p.v === v)) continue
    const end = v.length ? v.startChapter + v.length - 1 : to
    const segFrom = Math.max(from, v.startChapter)
    const segTo = Math.min(to, end)
    const ranges = arcRanges(v, segFrom, segTo)
      .map((r) => `${r.pos}=第${r.start}-${r.end}章`)
      .join('；')
    const arcNote = v.arc && !parseVolumeArc(v.arc) ? `（卷弧线：${v.arc}）` : ''
    parts.push({ v, text: `第${v.volumeNo}卷《${v.name}》（第${v.startChapter}-${end === Infinity ? '…' : end}章，章号为卷内坐标）：${ranges}${arcNote}` })
  }
  return parts.map((p) => p.text).join('\n')
}

// AI 规划新卷：基于梗概/细纲开头/滚动摘要/故事线生成卷名与卷战略（手动建档与自动断卷共用）
export async function planVolume({ apiKey, project, startChapter }) {
  const volumeNo = (project.volumes || []).length + 1
  // 前面各卷已讲过的故事（供 AI 避免本卷重复同类事件/同一对手，保障“每卷一个新故事”）
  const prevVolumes = (project.volumes || [])
    .map((v) => `第${v.volumeNo}卷《${v.name || ''}》：${v.arcStory || v.theme || v.strategy || ''}`)
    .filter((s) => s.length > 6)
    .join('\n')
  const res = await chatJSON({
    apiKey,
    messages: volumePlanMessages({
      volumeNo,
      synopsis: project.synopsis,
      outline: outlineForChapter(project.outline, startChapter, 8),
      rollingSummary: project.rollingSummary,
      storylines: project.storylines || [],
      prevVolumes,
    }),
    temperature: 0.5,
  })
  if (!res.strategy) throw new Error('AI 未能生成卷战略，请重试。')
  return {
    id: uid(),
    volumeNo,
    name: String(res.title || `第${volumeNo}卷`).slice(0, 20),
    arcStory: String(res.arc_story || ''),
    strategy: String(res.strategy),
    arc: String(res.arc || ''),
    emotion: String(res.emotion || ''),
    startChapter,
    length: project.volumeLength || 20,
  }
}

// ---------- AI 味输出层验证：事后扫描（纯前端正则，零费用；规则不再只靠模型自觉） ----------
// 禁词表与提示词层 NO_AI_FLAVOR_RULE 保持一致并扩充；只报警不阻断，由作者判断。
export const AI_FLAVOR_WORDS = [
  '宛如', '犹如', '恰似', '仿佛画卷', '空气仿佛凝固', '空气凝固', '如诗如画', '意味深长',
  '嘴角勾起', '嘴角扬起', '眸光微闪', '眸光', '眼神闪过', '眼底闪过', '眸中闪过', '不禁', '不由得',
  '心中暗想', '心中五味杂陈', '一丝不易察觉',
]
// 结构层模式：过渡句/时间速写/解说式心理，是 AI 网文的高频骨架（命中附示例，供作者确认）
export const AI_FLAVOR_PATTERNS = [
  { name: '过渡句（与此同时/另一边）', regex: /与此同时|另一边[，,]|话说两头/ },
  { name: '时间速写（转眼/时间飞逝）', regex: /时间(?:飞快|飞逝|如白驹过隙)|转眼间?[，,]|不知不觉间/ },
  { name: '解说式心理（他意识到/明白了）', regex: /[他她][们]?(?:终于|这才|突然|瞬间)?(?:意识到|明白了|懂得了)[，,]/ },
]

// 扫描正文的 AI 味命中：禁词（含用户自定义禁用词）+ 结构模式；返回 [{type, word, count, name?}]
export function aiFlavorScan(text, extraForbidden = []) {
  if (!text) return []
  const hits = []
  const custom = new Set(extraForbidden || [])
  const wordHits = []
  for (const w of [...new Set([...AI_FLAVOR_WORDS, ...custom])]) {
    if (!w) continue
    const count = text.split(w).length - 1
    if (count > 0) wordHits.push({ type: custom.has(w) ? '自定义禁词' : '禁词', word: w, count })
  }
  // 去冗余：短词被同一文本中更长的命中词包含且次数相同时只留长词（如"眸光微闪"与"眸光"）
  wordHits.sort((a, b) => b.word.length - a.word.length)
  for (const h of wordHits) {
    const covered = hits.some((k) => k.type !== '结构' && k.word.includes(h.word) && k.count === h.count)
    if (!covered) hits.push(h)
  }
  for (const p of AI_FLAVOR_PATTERNS) {
    const m = String(text).match(new RegExp(p.regex.source, 'g'))
    if (m && m.length) hits.push({ type: '结构', word: m[0], count: m.length, name: p.name })
  }
  return hits
}

// ---------- P1-3 lieflat 去AI味算子（小说适配子集，软门 WARN，只报警不阻断、不接判官、不改硬门）----------
// 证据锚：lieflat-less-ai-tone/SKILL.md（11 条白名单式规则，每条有可定位触发标记）。小说适配取舍：
//  · 排除 Rule3(相邻句结构同款)/Rule7(拟人化喻体)——SKILL 明确「小说、散文等文学体裁按原有风格判断，不改」，且自陈「没有硬性触发标记」，误报高；
//  · 排除 Rule4(破折号)——已由 dashScan/codeLayerAudit 覆盖；排除 Rule5(冒号)/Rule6(序数小标题)/Rule8(数据写回概括)——非虚构/Markdown 专属，小说冒号绝大多数是对白归因(SKILL 明列不改)；
//  · 保留 Rule1(翻案腔，只收「不是…而是」以外的翻案句式——「不是…而是」是文学常用的对照结构，纳入会误伤正常叙述)/Rule9(禁用起手式)/Rule10c·e(翻译腔：前置话题壳+复述句)/Rule11(段首零主语评论)/Rule2(顿号罗列过密)；
//  · 小说适配关键：先剥离成对引号内对白（SKILL 硬约束「对话体、口语体不改」），只扫叙述/旁白，把误报压到论说文腔渗入旁白的真信号。
// 与 aiFlavorScan 互补：aiFlavorScan 治网文华丽辞藻+骨架模式，本算子治「论说文腔/翻译腔」渗入旁白。二者都是软 WARN，作者判断，均不阻断、不进 codeLayerAudit.pass。

// 剥离成对弯引号“…”与直角引号「…」内的对白；引号不成对或跨行时保守不剥（避免吞掉整段叙述）。
function stripDialogueSpans(text) {
  return String(text || '').replace(/\u201C[^\u201D\n]*\u201D|\u300C[^\u300D\n]*\u300D/g, ' ')
}

// lieflat 小说适配子集：每条 rule 编号对应 SKILL.md 的规则序号，name 为可展示的命中说明。
export const AI_TONE_RULES = [
  { rule: '1', name: '翻案腔（并非…而是/不在于…而在于/与其说…不如说/看似…实则）', regex: /并非[^。！？；]{1,20}而是|不在于[^。！？；]{1,20}而在于|与其说[^。！？；]{1,20}不如说|看似[^。！？；]{1,12}实则|表面上?[^。！？；]{1,12}实际上?/g },
  { rule: '9', name: '禁用起手式（说白了/说穿了/先说结论/综上所述）', regex: /说白了|说穿了|先说结论|一言以蔽之|综上所述|总的来说/g },
  { rule: '11', name: '段首零主语评论（值得注意的是/更重要的是/关键在于/不难看出）', regex: /值得注意的是|更重要的是|尤为关键的是|关键在于|问题在于|不难看出|由此可见|众所周知/g },
  { rule: '10c', name: '前置话题壳（对于…来说/就…而言/在…方面/从…角度）', regex: /对于[^。！？；]{1,20}来说|对于[^。！？；]{1,20}而言|对[^。！？；]{1,12}而言|就[^。！？；]{1,12}而言|在[^。！？；]{1,12}方面|从[^。！？；]{1,12}角度(?:来看|看)/g },
  { rule: '10e', name: '翻译腔复述句（这意味着/这表明/换句话说）', regex: /这意味着|这表明|这说明|换句话说|也就是说/g },
]
// 顿号罗列过密阈值（Rule2）：一个整句内顿号 ≥ 此值判命中。SKILL 触发标记为「2 个以上顿号连起三项」，
// 小说适配取更保守的 3（4 项以上并列）以压低误报——旁白里真塞进一整份清单才告警。
export const AI_TONE_DENSE_DUN = 3

// 扫描叙述腔 AI 痕迹（软门）：剥离对白后按 lieflat 子集逐条匹配 + 顿号密集罗列；返回 {hits, denseEnum, count}。
export function aiToneScan(text) {
  const raw = String(text || '')
  if (!raw.trim()) return { hits: [], denseEnum: [], count: 0 }
  const narration = stripDialogueSpans(raw)
  const hits = []
  for (const r of AI_TONE_RULES) {
    const m = narration.match(new RegExp(r.regex.source, 'g'))
    if (m && m.length) hits.push({ rule: r.rule, name: r.name, count: m.length, samples: [...new Set(m)].slice(0, 4) })
  }
  const denseEnum = []
  for (const sent of narration.split(/[。！？；\n]/)) {
    const dun = (sent.match(/、/g) || []).length
    if (dun >= AI_TONE_DENSE_DUN) denseEnum.push({ dun, text: sent.trim().slice(0, 30) })
  }
  const count = hits.reduce((a, h) => a + h.count, 0) + denseEnum.length
  return { hits, denseEnum, count }
}

// 简单本地检索：把已写章节切块，按关键词命中次数打分，返回相关片段（纯前端，不 依赖 embedding 服务）
// ---------- P0-1 检索强化：BM25 + rerank + 降级链（纯前端、零 Token、确定性；替代原布尔关键词计数）----------
// 原实现弱点：每个关键词只记「命中/未命中」(+1)，无词频(TF)/无逆文档频率(IDF)/无长度归一，且按固定 400 字偏移硬切（会切碎句子）。
// 升级为标准 Okapi BM25 相关性排序 + 段落感知切块 + 模糊降级 + rerank。契约不变：仍返回 [{chapterNo,title,text,score}]（score 降序、截断 topN），调用点零改动。

// 去空白（不用正则，避免转义歧义）：检索归一化用。
function stripWs(s) { return [...String(s || '')].filter((c) => c.trim()).join('') }
// 子串非重叠出现次数（BM25 的 TF 用）。
function countOccurrences(hay, needle) {
  if (!needle) return 0
  const h = String(hay || '')
  let count = 0
  let idx = 0
  while ((idx = h.indexOf(needle, idx)) !== -1) { count++; idx += needle.length }
  return count
}
// 字符二元组集合（模糊降级层用：关键词精确不命中时按 bigram 重叠召回形态变体/部分匹配）。
function charBigrams(s) {
  const norm = stripWs(s)
  const set = new Set()
  for (let i = 0; i < norm.length - 1; i++) set.add(norm.slice(i, i + 2))
  if (norm.length === 1) set.add(norm)
  return set
}

// BM25 排序：docs=[{text,...}] 视为文档集，queryTerms 视为查询项；返回 score>0 的 doc（附 BM25 分）。
// IDF=ln(1+(N-df+0.5)/(df+0.5))；TF 项 f(k1+1)/(f+k1(1-b+b·dl/avgdl))；默认 k1=1.5 b=0.75。
export function bm25Rank(docs, queryTerms, opts = {}) {
  const k1 = opts.k1 != null ? opts.k1 : 1.5
  const b = opts.b != null ? opts.b : 0.75
  const terms = [...new Set((queryTerms || []).filter(Boolean))]
  const list = (Array.isArray(docs) ? docs : []).filter((d) => d && typeof d.text === 'string' && d.text.length)
  if (!terms.length || !list.length) return []
  const N = list.length
  const dl = list.map((d) => stripWs(d.text).length)
  const avgdl = (dl.reduce((a, x) => a + x, 0) / N) || 1
  const idf = {}
  const tf = list.map(() => ({}))
  for (const t of terms) {
    let n = 0
    for (let i = 0; i < N; i++) { const c = countOccurrences(list[i].text, t); tf[i][t] = c; if (c > 0) n++ }
    idf[t] = Math.log(1 + (N - n + 0.5) / (n + 0.5))
  }
  const out = []
  for (let i = 0; i < N; i++) {
    let score = 0
    for (const t of terms) {
      const f = tf[i][t]
      if (!f) continue
      score += idf[t] * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl[i] / avgdl)))
    }
    if (score > 0) out.push({ ...list[i], score })
  }
  return out
}

// ==================== P2 检索混合重排（hybrid rerank / RRF）====================
// 关键词检索（BM25）擅长精确命中专名，语义向量（embedding cosine）擅长近义/意图召回，二者互补。
// RRF（Reciprocal Rank Fusion）只看各路【排名】不看原始分（免归一化、跨度量可比）：score(d)=Σ 1/(k+rank)，k 默认 60。
// 返回按融合分降序的去重列表，每项附 rrfScore。lists = [[路一命中], [路二命中], ...]。
export function rrfFuse(lists, opts = {}) {
  const k = opts.k != null ? opts.k : 60
  const keyOf = opts.key || defaultDocKey
  const byKey = new Map()
  for (const list of Array.isArray(lists) ? lists : []) {
    ;(Array.isArray(list) ? list : []).forEach((item, rank) => {
      if (!item) return
      const key = keyOf(item)
      const cur = byKey.get(key) || { item, score: 0 }
      cur.score += 1 / (k + rank + 1)
      byKey.set(key, cur)
    })
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score).map((x) => ({ ...x.item, rrfScore: +x.score.toFixed(6) }))
}
// 默认文档键：章号 + 正文前 40 字（同一片段在关键词/语义两路里能对齐；chunk 边界差异时以前缀近似归并）
function defaultDocKey(d) {
  return `${d && d.chapterNo != null ? d.chapterNo : ''}|${String((d && d.text) || '').slice(0, 40)}`
}
// 混合重排便捷入口：融合关键词命中与语义命中两路，取 topN。任一路为空则退化为另一路（零回归），两路都空返回 []。
export function hybridRerank(keywordHits, semanticHits, opts = {}) {
  const topN = opts.topN != null ? opts.topN : 4
  const kw = Array.isArray(keywordHits) ? keywordHits : []
  const sem = Array.isArray(semanticHits) ? semanticHits : []
  if (!kw.length && !sem.length) return []
  return rrfFuse([kw, sem], opts).slice(0, topN)
}
// 混合重排编排：并行跑关键词（searchChapters/BM25）与语义（semanticPassages/embedding）两路再 RRF 融合。
// 相比既有「语义→关键词降级」（只用一路），两路信号互补：关键词保专名精确命中，语义保近义/意图召回。
// glmKey 缺失或语义路失败时自动退化为纯关键词（零回归）。返回 {passages, chapters, changed}。
export async function hybridPassages({ glmKey, chapters, instruction, keywords, topN = 4, chunkSize = 400 }) {
  const all = Array.isArray(chapters) ? chapters : []
  const kws = [...new Set((keywords || []).filter(Boolean))]
  const kwHits = kws.length ? searchChapters(all, kws, topN * 2, chunkSize) : []
  let semHits = []
  let next = all
  let changed = false
  if (glmKey && (instruction || '').trim()) {
    try {
      const sem = await semanticPassages({ glmKey, chapters: all, instruction, topN: topN * 2, chunkSize })
      semHits = sem.passages || []
      next = sem.chapters || all
      changed = !!sem.changed
    } catch {
      semHits = []
    }
  }
  if (!kwHits.length && !semHits.length) return { passages: [], chapters: next, changed }
  const fused = hybridRerank(kwHits, semHits, { topN })
  const passages = fused.map((d) => ({ chapterNo: d.chapterNo, title: d.title || (d.chapterNo ? `第 ${d.chapterNo} 章` : ''), text: d.text, score: d.rrfScore }))
  return { passages, chapters: next, changed }
}

export function searchChapters(chapters, keywords, topN = 3, chunkSize = 400, opts = {}) {
  const kws = [...new Set((keywords || []).filter(Boolean))]
  const chs = (Array.isArray(chapters) ? chapters : []).filter((c) => c && typeof c.content === 'string' && c.content.length)
  if (!kws.length || !chs.length) return []
  // 段落感知切块（替代固定偏移硬切，不切碎句子；与 semanticPassages 的 chunkText/chunkSig 同源、确定性）
  const docs = []
  for (const ch of chs) for (const piece of chunkText(ch.content, chunkSize)) docs.push({ chapterNo: ch.chapterNo, title: ch.title, text: piece })
  if (!docs.length) return []
  // 降级链 Tier1：BM25（TF-IDF + 长度归一）
  let ranked = bm25Rank(docs, kws, opts)
  // 降级链 Tier2：BM25 全空 → 字符二元组 Jaccard 模糊召回（关键词形态变体/部分命中）
  if (!ranked.length) {
    const qSet = new Set(kws.flatMap((k) => [...charBigrams(k)]))
    if (qSet.size) {
      ranked = docs.map((d) => {
        const dSet = charBigrams(d.text)
        let inter = 0
        for (const x of qSet) if (dSet.has(x)) inter++
        const union = qSet.size + dSet.size - inter
        return { ...d, score: union > 0 ? inter / union : 0 }
      }).filter((d) => d.score > 0)
    }
  }
  if (!ranked.length) return []
  // rerank：分数降序；同分按章节新近度（chapterNo 大者更贴近「刚发生的事」，靠前）
  ranked.sort((a, b) => (b.score - a.score) || ((b.chapterNo || 0) - (a.chapterNo || 0)))
  // 章内多样性：每章至多 maxPerChapter 块，优先把 topN 铺到不同章避免近重复上下文；不足再用同章高分块补齐
  const maxPerChapter = opts.maxPerChapter != null ? opts.maxPerChapter : 2
  const picked = []
  const perCh = {}
  for (const d of ranked) {
    if (picked.length >= topN) break
    const key = d.chapterNo
    if ((perCh[key] || 0) >= maxPerChapter) continue
    perCh[key] = (perCh[key] || 0) + 1
    picked.push(d)
  }
  if (picked.length < topN) for (const d of ranked) { if (picked.length >= topN) break; if (!picked.includes(d)) picked.push(d) }
  return picked.map((d) => ({ chapterNo: d.chapterNo, title: d.title, text: d.text, score: +d.score.toFixed(4) }))
}

// 正文切块（块级语义召回用）：按段落聚合成约 size 字的块，段落过长时硬切；
// 切块是确定性的——同样的正文永远切出同样的块，向量缓存因此可按"块数+字数"签名判失效。
export function chunkText(text, size = 400) {
  const paras = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean)
  const chunks = []
  let cur = ''
  for (const p of paras) {
    if (cur && cur.length + p.length + 1 > size) {
      chunks.push(cur)
      cur = ''
    }
    if (p.length > size) {
      if (cur) {
        chunks.push(cur)
        cur = ''
      }
      for (let i = 0; i < p.length; i += size) chunks.push(p.slice(i, i + size))
      continue
    }
    cur += (cur ? '\n' : '') + p
  }
  if (cur) chunks.push(cur)
  return chunks
}

// 块缓存签名：正文变化（手改/重写）后向量自动失效重建，不会拿旧向量召错片段
const chunkSig = (c) => `${chunkText(c.content).length}:${c.content.length}`

// 可选向量召回（「我的」页启用智谱 Embedding-3 后生效）：按写作指令与正文块的语义相似度取回前文片段；
// 向量按 400 字正文块粒度缓存进 chapter.chunkEmbed（随书持久化，只对新增/变更章节补向量化）；
// 命中块会带上前一块做上下文，防止片段拦腰截断。服务不可用时抛错，由调用方降级回关键词检索。
export async function semanticPassages({ glmKey, chapters, instruction, topN = 4, chunkSize = 400 }) {
  const all = chapters || []
  const list = all.filter((c) => c && c.content)
  if (!list.length || !(instruction || '').trim()) return { passages: [], chapters: all, changed: false }
  let changed = false
  const vecByChapter = {}
  const todo = []
  for (const c of list) {
    const chunks = chunkText(c.content, chunkSize)
    if (!chunks.length) continue
    const cached = c.chunkEmbed
    if (Array.isArray(cached?.vecs) && cached.sig === `${chunks.length}:${c.content.length}` && cached.vecs.length === chunks.length) {
      vecByChapter[c.id] = { chunks, vecs: cached.vecs }
    } else {
      todo.push({ c, chunks })
    }
  }
  // 跨章合并分批（单请求最多 64 条），避免每章一次请求
  const flat = []
  for (const t of todo) t.chunks.forEach((ch, idx) => flat.push({ t, idx, text: ch.slice(0, 3000) }))
  for (let i = 0; i < flat.length; i += 64) {
    const batch = flat.slice(i, i + 64)
    const vecs = await glmEmbed({ apiKey: glmKey, texts: batch.map((b) => b.text) })
    batch.forEach((b, j) => {
      if (!vecByChapter[b.t.c.id]) vecByChapter[b.t.c.id] = { chunks: b.t.chunks, vecs: new Array(b.t.chunks.length) }
      vecByChapter[b.t.c.id].vecs[b.idx] = vecs[j]
    })
    changed = true
  }
  const next = changed
    ? all.map((c) =>
        vecByChapter[c.id] && todo.some((t) => t.c.id === c.id)
          ? { ...c, embed: undefined, chunkEmbed: { sig: chunkSig(c), vecs: vecByChapter[c.id].vecs } }
          : c,
      )
    : all
  const [q] = await glmEmbed({ apiKey: glmKey, texts: [instruction.slice(0, 3000)] })
  const scored = []
  for (const c of list) {
    const v = vecByChapter[c.id]
    if (!v) continue
    v.vecs.forEach((vec, idx) => {
      if (vec) scored.push({ c, idx, score: cosine(q, vec) })
    })
  }
  scored.sort((a, b) => b.score - a.score)
  // 同章命中块去重（一章最多留 2 块），取 topN 块；每块带上前一块保证语境完整
  const picked = []
  const perChapter = {}
  for (const s of scored) {
    if (picked.length >= topN) break
    if (picked.some((x) => x.c.id === s.c.id && Math.abs(x.idx - s.idx) <= 1)) continue
    perChapter[s.c.id] = (perChapter[s.c.id] || 0) + 1
    if (perChapter[s.c.id] > 2) continue
    picked.push(s)
  }
  const passages = picked.map(({ c, idx }) => {
    const v = vecByChapter[c.id]
    const text = (idx > 0 ? v.chunks[idx - 1] + '\n' : '') + v.chunks[idx]
    return { chapterNo: c.chapterNo, title: `第 ${c.chapterNo} 章 ${c.title || ''}（片段 ${idx + 1}/${v.chunks.length}）`, text }
  })
  return { passages, chapters: next, changed }
}

// 从本章写作指令 + 人物名单（含别名）提取检索关键词；
// 中文指令缺少空格分词，对长词额外切 2 字滑窗补充召回
export function keywordsOf(instruction, characters) {
  const names = []
  for (const c of characters || []) {
    if (c.name) names.push(c.name)
    names.push(...aliasesOf(c))
  }
  const words = (instruction || '')
    .split(/[\s,，。、;；:：!！?？\n"'“”‘’（）()【】]+/)
    .filter((w) => w.length >= 2)
  const grams = []
  for (const w of words) {
    if (w.length > 4) {
      for (let i = 0; i + 2 <= w.length && grams.length < 12; i += 2) grams.push(w.slice(i, i + 2))
    }
  }
  return [...new Set([...names, ...words, ...grams])].slice(0, 24)
}

// 语义检索近似：先用一次轻量 LLM 调用把写作方向扩展成检索词（人物/地点/物品/事件），
// 再叠加本地分词，失败时降级为纯本地关键词（不阻塞写作）
export async function expandKeywords({ apiKey, instruction, characters, world }) {
  const base = keywordsOf(instruction, characters)
  try {
    const res = await chatJSON({ apiKey, messages: searchExpandMessages({ instruction, characters, world }), temperature: 0.2 })
    const extra = Array.isArray(res.keywords) ? res.keywords.filter((k) => typeof k === 'string' && k.trim()).slice(0, 12) : []
    return [...new Set([...base, ...extra])]
  } catch {
    return base
  }
}

// 尾部连续非主角视角的章数（视角约束用）；未设主角或章节无 POV 记录时不计入连续段
export function povStreak(chapters, protagonist) {
  if (!protagonist) return 0
  let n = 0
  for (let i = (chapters || []).length - 1; i >= 0; i--) {
    const pov = (chapters[i].pov || '').trim()
    if (!pov || pov === '全知' || pov === protagonist) break
    n++
  }
  return n
}

// 保存本章后是否到了一卷的末尾，需要把这一卷压缩成卷志（返回待压缩章节，含本章摘要）
function pendingVolumeChapters(project, currentChapterNo, currentSummary) {
  const writtenAfter = (project.chapters || []).length + 1
  const upTo = project.memoryUpTo || 0
  if (writtenAfter < upTo + VOLUME_SIZE) return null
  const archived = (project.chapters || []).slice(upTo).map((c) => ({ chapterNo: c.chapterNo, title: c.title, summary: c.summary }))
  archived.push({ chapterNo: currentChapterNo, title: '', summary: currentSummary })
  return archived
}

// 章后档案更新流水线（并行版）：摘要 / 状态回写 / 伏笔 / 一致性校验 / 故事线五路并发，
// 只有滚动摘要与卷志依赖本章摘要故在第二波；每路独立容错，单路失败不阻塞存档，只降级。
// 检查点：传 checkpointId（书 id）时每完成一路就落盘一次，刷新/中断后可从断点续跑（见 loadArchiveCheckpoint）；
// lanes：续跑时带上已完成的步骤结果，只重跑缺失部分；
// policy：质量策略，'strict'（质量优先）时单路失败自动重试一次，'fast'（连续推进）失败直接降级不回头。
export async function runPostChapter({ apiKey, project, chapterNo, text, onStep, checkpointId = null, title = '', lanes = null, policy = 'fast', instruction = '', scenePlan = '' }) {
  const report = {
    summary: '',
    rolling: project.rollingSummary || '',
    updates: [],
    newCharacters: [],
    events: [],
    pov: '',
    newForeshadows: [],
    resolved: [],
    mentioned: [],
    issues: [],
    drift: '',
    storylines: [],
    facts: [], // 机制二：本章受控谓词事实草稿（经 validateFacts 校验后交 commitFacts 入账）
    factErrors: [], // 机制二：facts 写时校验的字段级错误（自修正重跑后仍失败的条目）
    factWarnings: [], // 机制二：facts 校验警告（扩展谓词/未建档主体等，放行不阻断）
    volumeMemory: '',
    volumeUpTo: 0,
    degraded: [], // 本次降级跳过的归档步骤（提示用户补跑，避免账本静默缺失）
  }
  const active = (project.foreshadows || []).filter((f) => f.status === '未回收' || f.status === '已提及')
  const done = lanes || {}
  const cpLanes = { ...done }
  const startedAt = Date.now()
  // 检查点落盘：整份检查点很小（正文 + 各路结果），每次整体重写即可，无需增量合并。
  const cpSave = () => {
    if (!checkpointId) return
    try {
      localStorage.setItem(`na_lf_archive_${checkpointId}`, JSON.stringify({ chapterNo, title, text, startedAt, lanes: cpLanes }))
    } catch {
      /* 检查点写失败不阻塞归档，最多丢失续跑能力 */
    }
  }
  if (checkpointId && !lanes) cpSave()
  // 单路执行器：已完成（续跑）直接返回；质量优先失败重试一次；成功后写入检查点。
  const lane = (name, fn) => {
    if (done[name] !== undefined) return Promise.resolve(done[name])
    const attempt = async () => {
      try {
        return await fn()
      } catch (e) {
        if (policy === 'strict') return await fn()
        throw e
      }
    }
    return attempt().then((v) => {
      cpLanes[name] = v
      cpSave()
      return v
    })
  }

  onStep?.(lanes ? '续跑归档：补全中断的步骤…' : '1/2 五路并行归档：章节摘要 / 人物状态 / 伏笔 / 一致性校验 / 故事线…')
  // 五路互不依赖（都只读 project + 本章正文），并发后归档耗时从“六次串行”降到约“两波往返”；
  // 一致性校验只注入本章细纲窗口，长细纲不再全量进上下文；单路失败只降级不阻塞
  const summaryP = lane('summary', async () => (await chatJSON({ apiKey, messages: chapterSummaryMessages({ text }), temperature: 0.3 })).summary || '')
  const stateP = lane('state', async () => {
    let res = await chatJSON({ apiKey, messages: stateUpdateMessages({ characters: project.characters, text }), temperature: 0.2 })
    // 机制二：facts 写时校验（无 ajv 的轻量 validateFacts）——先校验，字段级 errors+hint 触发自修正重跑一次；
    // 仍失败则记 factValid=false（进 report.degraded），非法条目在 applyReport→commitFacts 内按条拒绝，不写入矛盾 fact。
    let incoming = Array.isArray(res?.facts) ? res.facts : []
    let v = validateFacts(incoming, { characters: project.characters, existingFacts: project.facts || [] })
    if (!v.valid) {
      try {
        const res2 = await chatJSON({ apiKey, messages: stateFactFixMessages({ characters: project.characters, text, errors: v.errors }), temperature: 0.2 })
        res = { ...res, ...res2 }
        incoming = Array.isArray(res2?.facts) ? res2.facts : []
        v = validateFacts(incoming, { characters: project.characters, existingFacts: project.facts || [] })
      } catch {
        /* 自修正重跑失败：保留首轮结果与首轮校验回执，非法条交由 commitFacts 按条拒绝 */
      }
    }
    return { ...res, facts: incoming, factErrors: v.errors, factWarnings: v.warnings, factValid: v.valid }
  })
  const hookP = lane('hook', () => chatJSON({ apiKey, messages: foreshadowMessages({ active, text }), temperature: 0.2 }))
  const checkP = lane('check', () =>
    chatJSON({
      apiKey,
      messages: consistencyCheckMessages({
        world: project.world,
        characters: project.characters,
        outline: outlineForChapter(project.outline, chapterNo),
        foreshadows: active,
        text,
        chapterNo,
        instruction,
        scenePlan,
      }),
      temperature: 0.2,
    }),
  )
  const storyP = lane('story', () => chatJSON({ apiKey, messages: storylineUpdateMessages({ storylines: project.storylines, text }), temperature: 0.2 }))

  const [sR, stR, hR, cR, slR] = await Promise.allSettled([summaryP, stateP, hookP, checkP, storyP])
  if (sR.status === 'fulfilled') report.summary = sR.value
  else report.degraded.push('章节摘要')
  if (stR.status === 'fulfilled') {
    const res = stR.value
    report.updates = Array.isArray(res.character_updates) ? res.character_updates : []
    report.newCharacters = Array.isArray(res.new_characters) ? res.new_characters : []
    report.events = Array.isArray(res.events)
      ? res.events
          .map((ev) =>
            typeof ev === 'string'
              ? { text: ev, time: '' }
              : ev?.text
                ? { text: String(ev.text), time: String(ev.time || '').trim() }
                : null,
          )
          .filter(Boolean)
      : []
    report.pov = typeof res.pov === 'string' ? res.pov.trim() : ''
    // 机制二：提取受控谓词事实草稿 + 校验回执（commitFacts 在 applyReport 内按条拒绝非法事实）
    report.facts = Array.isArray(res.facts) ? res.facts : []
    report.factErrors = Array.isArray(res.factErrors) ? res.factErrors : []
    report.factWarnings = Array.isArray(res.factWarnings) ? res.factWarnings : []
    if (res.factValid === false) report.degraded.push('事实校验')
  } else report.degraded.push('状态回写')
  if (hR.status === 'fulfilled') {
    const res = hR.value
    report.newForeshadows = Array.isArray(res.new_foreshadows) ? res.new_foreshadows : []
    report.resolved = Array.isArray(res.resolved) ? res.resolved : []
    report.mentioned = Array.isArray(res.mentioned) ? res.mentioned : []
  } else report.degraded.push('伏笔检测')
  if (cR.status === 'fulfilled') {
    const res = cR.value
    // severity 归一：旧数据/模型漏填时默认 hard（宁红勿漏），soft 仅当模型明确标注
    report.issues = Array.isArray(res.issues) ? res.issues.map((it) => ({ ...it, severity: it?.severity === 'soft' ? 'soft' : 'hard' })) : []
    report.drift = res.outline_drift || ''
  } else report.degraded.push('一致性校验')
  if (slR.status === 'fulfilled') {
    report.storylines = Array.isArray(slR.value.storylines) ? slR.value.storylines : []
  } else report.degraded.push('故事线回写')

  // 第二波：滚动摘要（依赖本章摘要）与满卷卷志（依赖本章摘要）互不依赖，继续并发收尾；同样走检查点。
  onStep?.(lanes ? '续跑收尾：滚动摘要与卷志归档…' : '2/2 收尾：滚动摘要与卷志归档…')
  const pending = pendingVolumeChapters(project, chapterNo, report.summary)
  const rollP = report.summary ? lane('rolling', async () => (await chatJSON({
    apiKey,
    messages: rollingSummaryMessages({ prevSummary: project.rollingSummary, chapterSummary: report.summary }),
    temperature: 0.3,
  })).summary || '') : Promise.resolve('')
  const volP = pending?.length ? lane('volume', () => chatJSON({ apiKey, messages: volumeMemoryMessages({ chapters: pending }), temperature: 0.3 })) : Promise.resolve(null)
  const [rollR, volR] = await Promise.allSettled([rollP, volP])
  const roll = rollR.status === 'fulfilled' ? rollR.value : ''
  const vol = volR.status === 'fulfilled' ? volR.value : null
  if (report.summary) report.rolling = roll || project.rollingSummary || report.summary
  if (vol?.memory) {
    report.volumeMemory = vol.memory
    report.volumeUpTo = (project.memoryUpTo || 0) + pending.length
  } else if (pending?.length) {
    /* 卷志失败降级跳过，下一卷再补 */
    report.degraded.push('卷志归档')
  }

  return report
}

// 人物别名归一：档案里 aliases 可能是数组（手动登记）也可能是逗号分隔字符串（成书/导入时写入），统一转数组供匹配使用；
// 不统一的写法曾在重写归档时抛 "c.aliases.some is not a function"（字符串没有 some）
export function aliasesOf(c) {
  if (Array.isArray(c?.aliases)) return c.aliases.map((a) => String(a).trim()).filter(Boolean)
  if (typeof c?.aliases === 'string' && c.aliases.trim()) return c.aliases.split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
  return []
}

// 归档检查点：保存章节前开启、每完成一路归档落盘一次，刷新/中断后可从断点续跑，不必重跑全部请求。
export function loadArchiveCheckpoint(projectId) {
  try {
    return JSON.parse(localStorage.getItem(`na_lf_archive_${projectId}`))
  } catch {
    return null
  }
}

export function clearArchiveCheckpoint(projectId) {
  localStorage.removeItem(`na_lf_archive_${projectId}`)
}

// 把档案报告应用到项目，返回 { project, blocked }；blocked 为保护期内被拦截回收的伏笔（抢收拦截）
// 机制三 opt-in 硬门：opts.gateBlock=true 时入库前先过 continuityGate；有 blocker → 拒绝入库，返回 {project:原样, gate, committed:false}，
//   由调用方把 gate.blockers 交 ChapterRewriter 定点重写。默认（不传 opts）行为与旧版一致（committed 恒真、返回形状不变）。
export function applyReport(project, { chapterNo, title, text }, report, opts = {}) {
  const gate = opts.gateBlock || opts.computeGate ? continuityGate(project, chapterNo, text, opts.gateOpts || {}) : null
  if (opts.gateBlock && gate && !gate.ok) return { project, blocked: [], gate, committed: false }
  const next = { ...project }

  // 章节入库（含本章摘要、叙事视角与校验问题明细，形成章节摘要链；问题明细持久化供后续查看与定向重写）
  next.chapters = [
    ...(project.chapters || []),
    {
      id: uid(),
      chapterNo,
      title: title || `第${chapterNo}章`,
      content: text,
      wordCount: countWords(text),
      summary: report.summary,
      pov: report.pov || '',
      issueCount: report.issues.filter((i) => i.severity !== 'soft').length,
      issues: report.issues,
      createdAt: Date.now(),
    },
  ]
  next.rollingSummary = report.rolling || report.summary || project.rollingSummary

  // 卷志沉淀进长时记忆（不可变，只增不改）
  if (report.volumeMemory) {
    next.memory = [...(project.memory || []), { text: report.volumeMemory, upTo: report.volumeUpTo }]
    next.memoryUpTo = report.volumeUpTo
  }

  // 故事线档案合并：同名沿用（只更新进展与最近章节），新名称登记入档
  const slMap = new Map((project.storylines || []).map((s) => [s.name, s]))
  for (const su of report.storylines || []) {
    if (!su?.name) continue
    const exist = slMap.get(su.name)
    slMap.set(su.name, {
      name: su.name,
      type: exist?.type || (su.type === '主线' ? '主线' : '支线'),
      progress: su.progress || exist?.progress || '',
      lastChapter: chapterNo,
    })
  }
  next.storylines = [...slMap.values()]

  // 人物状态回写：按姓名或别名匹配（别名归一），状态只保留最近三条变化，避免无限膨胀；
  // 同时把每条变化追加进该人物的编年史（全量保留，百万字时早期经历不丢）
  // 机制一：既有人物缺 uid 时补铸（迁移），保证后续 facts/entity-match 有 canonical 主键
  const characters = ensureCharacterUids(project.characters || [])
  const chronicles = { ...(project.chronicles || {}) }
  for (const u of report.updates) {
    if (!u || !u.name || !u.change) continue
    const uname = String(u.name).trim()
    const i = characters.findIndex(
      (c) => (c.name || '').trim() === uname || aliasesOf(c).some((a) => a === uname),
    )
    if (i >= 0) {
      const segs = [...(characters[i].status || '').split('；').filter(Boolean), u.change].slice(-3)
      characters[i] = { ...characters[i], status: segs.join('；') }
      const canon = characters[i].name
      const list = chronicles[canon] || []
      if (!list.some((e) => e.chapter === chapterNo && e.text === u.change)) {
        chronicles[canon] = [...list, { chapter: chapterNo, text: u.change }]
      }
    }
  }
  // 新出场的重要人物自动入档
  for (const nc of report.newCharacters) {
    if (nc?.name && !characters.some((c) => c.name === nc.name)) {
      // 机制一：新人物入档即铸 uid + 补受控状态位（alive/canSpeak/location/mutableInjuries）
      characters.push(
        withStateBits({
          name: nc.name,
          aliases: [],
          identity: nc.identity || '',
          personality: nc.personality || '',
          description: '',
          status: '',
        }),
      )
    }
  }
  next.characters = characters
  next.chronicles = chronicles

  // 事件级时间线追加（含故事内时间；旧数据无 time 字段时按空处理）
  next.events = [...(project.events || []), ...report.events.filter((ev) => ev?.text).map((ev) => ({ chapter: chapterNo, text: ev.text, time: ev.time || '' }))]

  // 伏笔账本更新：抢收拦截（保护期内不允许回收）+ 状态流转 + 新伏笔登记（默认保护期）
  const blocked = []
  let foreshadows = (project.foreshadows || []).map((f) => {
    if (report.resolved.includes(f.id)) {
      if (f.minResolveChapter && chapterNo < f.minResolveChapter) {
        blocked.push(f) // 保护期未过：不回收，保持原状态，由界面提示用户
        return f
      }
      return { ...f, status: '已回收', resolveChapter: chapterNo }
    }
    if (report.mentioned.includes(f.id)) return { ...f, status: '已提及' }
    return f
  })
  for (const nf of report.newForeshadows) {
    if (!nf?.content) continue
    const importance = nf.importance === '支线' ? '支线' : '主线'
    foreshadows.push({
      id: uid(),
      content: nf.content,
      relatedChars: Array.isArray(nf.related_chars) ? nf.related_chars : [],
      importance,
      tier: '短', // 归档自动登记的多为短线伏笔；四层伏笔（短/中/长/终极）由圣经流程显式登记（见 TIER_GAP）
      plantedChapter: chapterNo,
      minResolveChapter: chapterNo + (PROTECT_GAP[importance] || 5),
      status: '未回收',
      resolveChapter: null,
    })
  }
  next.foreshadows = foreshadows

  // 机制二：受控谓词事实事务提交（state lane 产出的 report.facts 已在 runPostChapter 过写时校验；此处双时态合并入库）
  // 无 report.facts（旧流程/降级）→ commitFacts 对空数组 no-op，next.facts 沿用既有（向后兼容）
  const factCommit = commitFacts(project.facts || [], Array.isArray(report.facts) ? report.facts : [], chapterNo, { characters: next.characters })
  next.facts = factCommit.facts

  // P0 影响分析：facts/foreshadows/characters 均已提交，用最终态 next 为本章建反向索引 refs
  const _refs = buildRefsFor(next, chapterNo)
  if (_refs) next.chapters = next.chapters.map((c) => (c.chapterNo === chapterNo ? { ...c, refs: _refs } : c))

  // P0 角色知识状态：本章若首次揭示某秘密（代号命中正文）→ 回填该秘密的「读者已见」章号（仅首次，不覆盖）
  const _seenSecrets = applyReaderSeen(next, chapterNo, ((next.chapters || []).find((c) => c.chapterNo === chapterNo) || {}).content)
  if (_seenSecrets) next.bible = { ...(next.bible || {}), secrets: _seenSecrets }
  // #2 暗线追踪：本章若提及某活跃暗线（名/别名命中正文）→ 回填 lastAdvancedChapter，遗忘预警门据此算「N 章未推进」
  const _threads = advanceThreads(next, chapterNo, ((next.chapters || []).find((c) => c.chapterNo === chapterNo) || {}).content)
  if (_threads) next.darkThreads = _threads

  next.updatedAt = Date.now()
  const result = { project: next, blocked }
  if (gate) {
    result.gate = gate
    result.committed = true
    if (factCommit.rejected.length) result.factRejected = factCommit.rejected
  }
  return result
}

// 补跑归档：对已保存章节重跑章后流水线并幂等合并（状态行去重 / 事件去重 / 新伏笔按内容去重），
// 用于归档降级后的补救与用户手动改完正文后的重新建档；滚动摘要只在重跑最新章时更新，避免污染后文进度
export function reapplyReport(project, chapterNo, report) {
  const next = { ...project }
  next.chapters = (project.chapters || []).map((c) =>
    c.chapterNo === chapterNo
      ? {
          ...c,
          summary: report.summary || c.summary,
          pov: report.pov || c.pov,
          issueCount: report.issues.filter((i) => i.severity !== 'soft').length,
          issues: report.issues,
        }
      : c,
  )
  const maxNo = (project.chapters || []).reduce((m, c) => Math.max(m, c.chapterNo), 0)
  if (chapterNo === maxNo && report.rolling) next.rollingSummary = report.rolling

  // 状态与编年史：重复行跳过，避免补跑产生重复记录（编年史按章覆盖同条）
  // 机制一：既有人物缺 uid 时补铸（迁移）
  const characters = ensureCharacterUids(project.characters || [])
  const chronicles = { ...(project.chronicles || {}) }
  for (const u of report.updates) {
    if (!u?.name || !u.change) continue
    const uname = String(u.name).trim()
    const i = characters.findIndex(
      (c) => (c.name || '').trim() === uname || aliasesOf(c).some((a) => a === uname),
    )
    if (i < 0) continue
    const segs = [...(characters[i].status || '').split('；').filter(Boolean)]
    if (!segs.includes(u.change)) {
      characters[i] = { ...characters[i], status: [...segs, u.change].slice(-3).join('；') }
    }
    const canon = characters[i].name
    const list = chronicles[canon] || []
    if (!list.some((e) => e.chapter === chapterNo && e.text === u.change)) {
      chronicles[canon] = [...list, { chapter: chapterNo, text: u.change }]
    }
  }
  next.characters = characters
  next.chronicles = chronicles

  // 事件：同章同文案去重后再追加（含故事内时间）
  const evSet = new Set((project.events || []).filter((e) => e.chapter === chapterNo).map((e) => e.text))
  next.events = [...project.events, ...report.events.filter((ev) => ev?.text && !evSet.has(ev.text)).map((ev) => ({ chapter: chapterNo, text: ev.text, time: ev.time || '' }))]

  // 伏笔：回收/提及流转（同样拦截抢收）；新伏笔按内容去重，避免补跑重复登记（保护期从本章重算）
  const blocked = []
  let foreshadows = (project.foreshadows || []).map((f) => {
    if (report.resolved.includes(f.id)) {
      if (f.minResolveChapter && chapterNo < f.minResolveChapter) {
        blocked.push(f)
        return f
      }
      return { ...f, status: '已回收', resolveChapter: f.resolveChapter || chapterNo }
    }
    if (report.mentioned.includes(f.id) && f.status === '未回收') return { ...f, status: '已提及' }
    return f
  })
  for (const nf of report.newForeshadows) {
    if (!nf?.content) continue
    if (foreshadows.some((f) => f.content === nf.content)) continue
    const importance = nf.importance === '支线' ? '支线' : '主线'
    foreshadows.push({
      id: uid(),
      content: nf.content,
      relatedChars: Array.isArray(nf.related_chars) ? nf.related_chars : [],
      importance,
      tier: '短', // 归档自动登记默认短线；圣经流程显式登记的伏笔带完整分层与线索计划，此处不覆盖（按 content 去重已跳过）
      plantedChapter: chapterNo,
      minResolveChapter: chapterNo + (PROTECT_GAP[importance] || 5),
      status: '未回收',
      resolveChapter: null,
    })
  }
  next.foreshadows = foreshadows

  // 故事线：同名合并（幂等）
  const slMap = new Map((project.storylines || []).map((s) => [s.name, s]))
  for (const su of report.storylines || []) {
    if (!su?.name) continue
    const exist = slMap.get(su.name)
    slMap.set(su.name, {
      name: su.name,
      type: exist?.type || (su.type === '主线' ? '主线' : '支线'),
      progress: su.progress || exist?.progress || '',
      lastChapter: Math.max(chapterNo, exist?.lastChapter || 0),
    })
  }
  next.storylines = [...slMap.values()]

  // 机制二：补跑幂等——先剔除本章旧 facts（sourceChapter===chapterNo）再重新提交 report.facts，避免补跑重复入账
  const priorFacts = (project.facts || []).filter((f) => f && f.sourceChapter !== chapterNo)
  next.facts = commitFacts(priorFacts, Array.isArray(report.facts) ? report.facts : [], chapterNo, { characters: next.characters }).facts

  // P0 影响分析：补跑同样用最终态 next 重建本章 refs（facts/foreshadows 已幂等合并）
  const _refs = buildRefsFor(next, chapterNo)
  if (_refs) next.chapters = next.chapters.map((c) => (c.chapterNo === chapterNo ? { ...c, refs: _refs } : c))

  // P0 角色知识状态：本章若首次揭示某秘密（代号命中正文）→ 回填该秘密的「读者已见」章号（仅首次，不覆盖）
  const _seenSecrets = applyReaderSeen(next, chapterNo, ((next.chapters || []).find((c) => c.chapterNo === chapterNo) || {}).content)
  if (_seenSecrets) next.bible = { ...(next.bible || {}), secrets: _seenSecrets }
  // #2 暗线追踪：本章若提及某活跃暗线（名/别名命中正文）→ 回填 lastAdvancedChapter，遗忘预警门据此算「N 章未推进」
  const _threads = advanceThreads(next, chapterNo, ((next.chapters || []).find((c) => c.chapterNo === chapterNo) || {}).content)
  if (_threads) next.darkThreads = _threads

  next.updatedAt = Date.now()
  return { project: next, blocked }
}

// 对指定章节补跑完整归档流水线（降级补救 / 手改正文后重新建档），返回 { project, blocked, report }
export async function rerunArchive({ apiKey, project, chapterNo, onStep }) {
  const ch = (project.chapters || []).find((c) => c.chapterNo === chapterNo)
  if (!ch) throw new Error(`未找到第 ${chapterNo} 章`)
  const report = await runPostChapter({ apiKey, project, chapterNo, text: ch.content, onStep })
  const { project: next, blocked } = reapplyReport(project, chapterNo, report)
  return { project: next, blocked, report }
}

// 级联复查：重写第 N 章后，后续已写章节是基于重写前上下文写的，可能与新版脱节（人物状态/伏笔层级/细节连续）；
// 对后续每章只跑一致性校验一路（每章一次轻量调用）刷新其 issues，不动其他归档路避免重复记账；单章失败降级跳过不阻断
export async function recheckFollowing({ apiKey, project, fromChapter, onStep }) {
  const sorted = [...(project.chapters || [])].sort((a, b) => a.chapterNo - b.chapterNo)
  const targets = sorted.filter((c) => c.chapterNo > fromChapter)
  let next = project
  const results = []
  for (const c of targets) {
    onStep?.(`正在复查第 ${c.chapterNo} 章与重写后前文的连贯性…`)
    try {
      const active = (next.foreshadows || []).filter((f) => f.status === '未回收' || f.status === '已提及')
      const res = await chatJSON({
        apiKey,
        messages: consistencyCheckMessages({
          world: next.world,
          characters: next.characters,
          outline: outlineForChapter(next.outline, c.chapterNo),
          foreshadows: active,
          text: c.content,
          chapterNo: c.chapterNo,
        }),
        temperature: 0.2,
      })
      const issues = Array.isArray(res.issues) ? res.issues : []
      next = { ...next, chapters: next.chapters.map((x) => (x.chapterNo === c.chapterNo ? { ...x, issues, issueCount: issues.length } : x)) }
      results.push({ chapterNo: c.chapterNo, issues })
    } catch {
      results.push({ chapterNo: c.chapterNo, issues: null })
    }
  }
  next.updatedAt = Date.now()
  return { project: next, results }
}

// 章号校正：模型若把卷内章号从第 1 章起编（而非全局章号），顺延重编为该卷起始章号，保证全书不断号不重号
export function renumberPart(text, startNo) {
  const lines = String(text).split('\n')
  if (lines.some((l) => l.trim().startsWith(`第${startNo}章`))) return text
  let n = startNo
  return lines
    .map((l) => (/^第\s*[0-9〇零一二三四五六七八九十百两]+\s*章/.test(l.trim()) ? l.replace(/第\s*[0-9〇零一二三四五六七八九十百两]+\s*章/, `第${n++}章`) : l))
    .join('\n')
}

// 章骨架文本 → 结构化：每行「第N章 章名｜任务：本章唯一任务」
export function parseSkeleton(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(/^第\s*([0-9〇零一二三四五六七八九十百两]+)\s*章[：:\s]*(.+)$/)
    if (!m) continue
    const no = cnToNumber(m[1])
    if (!Number.isFinite(no)) continue
    let rest = m[2].trim()
    let task = ''
    const idx = rest.search(/[｜|]\s*任务[：:]|^任务[：:]/)
    if (idx >= 0) {
      task = rest.slice(idx).replace(/^[｜|]?\s*任务[：:]\s*/, '').trim()
      rest = rest.slice(0, idx).trim()
    }
    out.push({ chapterNo: no, title: rest, task })
  }
  return out
}

// 骨架区间重拼：把 [{chapterNo,title,task}] 里落在 [from,to] 的章行按「第N章 章名｜任务：…」原格式重拼成文本。
// 用途一：Step5b 生成第 1 卷细纲时只给本卷骨架——原先直传全书骨架全文且连 slice 都没有，
//   模型能看到后续所有卷的章名与任务，是已确认的剧透泄漏点；
// 用途二：逐章详纲细化取「本章 + 后 2 章」的止步红线。
// 章表尚未解析出来时降级为按原始骨架文本的章头行过滤（边界取全量 heads 的下一个章头，不会把跳过的章夹带进来）。
export function skeletonTextForRange(skeleton, from, to, fallbackText = '') {
  const list = (Array.isArray(skeleton) ? skeleton : []).filter((s) => s && Number(s.chapterNo) >= from && Number(s.chapterNo) <= to)
  if (list.length) return list.map((s) => `第${s.chapterNo}章 ${s.title || ''}${s.task ? `｜任务：${s.task}` : ''}`).join('\n')
  const text = String(fallbackText || '')
  if (!text.trim()) return ''
  const lines = text.split('\n')
  const heads = outlineHeads(text)
  const kept = heads.filter((h) => h.no >= from && h.no <= to)
  if (!kept.length) return ''
  return kept
    .map((h) => {
      const hi = heads.indexOf(h)
      const end = hi + 1 < heads.length ? heads[hi + 1].index : lines.length
      return lines.slice(h.index, end).join('\n')
    })
    .join('\n')
}

// 本章之后的骨架任务窗口（逐章详纲细化的「止步红线」）：默认取后 2 章，只给 task 不给全书骨架。
export function laterSkeletonTasks(project, chapterNo, count = 2) {
  return (Array.isArray(project?.chapterSkeleton) ? project.chapterSkeleton : [])
    .filter((s) => s && Number(s.chapterNo) > chapterNo)
    .slice(0, Math.max(0, count))
    .map((s) => String(s.task || '').trim())
    .filter(Boolean)
}

// 骨架分批：单批最多章数。超长卷一次性枚举上百章会触发复读/断号/思维链泄漏（章名骨架崩坏），
// 分批把单次生成规模压到 LLM 可靠区；批间用 prevTail 衔接、renumberPart 校正章号、skeletonMissing 校验缺口。
export const SKELETON_BATCH = 30

// 骨架完整性校验：给定解析后的章表与期望区间 [start,end]，返回缺失的章号数组（分批后补生成 / 断号预警用）。
export function skeletonMissing(parsed, start, end) {
  const have = new Set((parsed || []).map((c) => c.chapterNo))
  const miss = []
  for (let n = start; n <= end; n++) if (!have.has(n)) miss.push(n)
  return miss
}

// 把升序章号数组压缩成区间字符串数组（如 [32,33,…,53, 85] → ['32-53','85']），断号预警展示用。
export function compressRanges(nums) {
  const s = [...(nums || [])].sort((a, b) => a - b)
  const out = []
  let i = 0
  while (i < s.length) {
    let j = i
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++
    out.push(s[i] === s[j] ? `${s[i]}` : `${s[i]}-${s[j]}`)
    i = j + 1
  }
  return out
}

// ---------- 章名去重兑底（配合 A：volumeSkeletonMessages 注入 usedTitles 从源头压制跨批撞名）----------
// 背景：骨架分卷分批生成（每批 SKELETON_BATCH=30 章），后续批次之前只看得到上一批末尾 3 章（prevTail），
// 看不到全书已用章名，温度 0.7 + 同题材（尤其时间循环/升级流情节重演）→ 跨批跨卷大量撞名，触发 skeletonWarning「重复章名」。
// 本函数是确定性兑底闸门（纯函数、零 API、可测）：对与 usedTitles 或批内已出现重复的章名，追加「·其N」中文序数后缀直至唯一；
// 只改重复行的章名段，不动章号 / 任务 / 未重复行。返回 { text, newTitles }，newTitles 供调用方累积进 usedTitles。
// 正则均用字面空格与中文字符类、零反斜杠转义（避开 SearchReplace 将 \n 拆成真实换行的坑）；章号经 renumberPart 已归一为阿拉伯数字。
const SKELETON_CN_ORDINAL = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
function skeletonCnOrdinal(k) {
  if (k >= 1 && k <= 10) return SKELETON_CN_ORDINAL[k]
  if (k > 10 && k < 20) return '十' + SKELETON_CN_ORDINAL[k - 10]
  return String(k)
}
export function dedupeSkeletonBatch(batchText, usedTitles = []) {
  const seen = new Set((Array.isArray(usedTitles) ? usedTitles : []).map((t) => String(t).trim()).filter(Boolean))
  const newTitles = []
  const lineRe = /^( *第 *[0-9〇零一二三四五六七八九十百两]+ *章[ ：:]*)(.+)$/gm
  const text = String(batchText || '').replace(lineRe, (line, prefix, rest) => {
    const idx = rest.search(/[｜|] *任务[：:]|^任务[：:]/)
    const title = (idx >= 0 ? rest.slice(0, idx) : rest).trim()
    const tail = idx >= 0 ? rest.slice(idx) : ''
    if (!title) return line
    let finalTitle = title
    if (seen.has(title)) {
      let k = 2
      let cand = title + '·其' + skeletonCnOrdinal(k)
      while (seen.has(cand)) { k += 1; cand = title + '·其' + skeletonCnOrdinal(k) }
      finalTitle = cand
    }
    seen.add(finalTitle)
    newTitles.push(finalTitle)
    return finalTitle === title ? line : prefix + finalTitle + tail
  })
  return { text, newTitles }
}

// 骨架文本归并（配合「补生成缺失章」）：把已有骨架与补生成的若干段按【全局章号】归并去重、升序重排为一份完整骨架文本。
// 已有章优先（先出现的 win），补生成段只填空缺章号、不覆盖已有章；非章行忽略（与 parseSkeleton 口径一致）。
// 纯函数、零 API、可测；正则用 /gm 多行 + 中文字符类（避开 SearchReplace 把 \n 拆断的坑）。
export function mergeSkeletonTexts(texts) {
  const byNo = new Map()
  const lineRe = /^ *第 *([0-9〇零一二三四五六七八九十百两]+) *章.*$/gm
  for (const text of (Array.isArray(texts) ? texts : [texts])) {
    const s = String(text || '')
    lineRe.lastIndex = 0
    let m
    while ((m = lineRe.exec(s)) !== null) {
      const no = cnToNumber(m[1])
      if (!Number.isFinite(no)) continue
      if (!byNo.has(no)) byNo.set(no, m[0].trim())
    }
  }
  return [...byNo.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]).join('\n')
}

// 圣经字段缺失判定：部分模型（如 Qwen）会漏掉数组字段，power_rules/map_layers 缺一即视为不合格
export const bibleMissingFields = (r) =>
  !(Array.isArray(r?.power_rules) && r.power_rules.filter(Boolean).length) || !(Array.isArray(r?.map_layers) && r.map_layers.filter((m) => m?.name).length)

// 圣经缺字段兜底：首次产出缺 power_rules/map_layers 时追加纠正消息重试一次；重试仍缺则返回原结果不阻塞流程（用户可在向导手动补）
export async function bibleJsonWithRetry({ apiKey, messages, temperature = 0.7 }) {
  let res = await chatJSON({ apiKey, messages, temperature })
  if (!bibleMissingFields(res)) return res
  const retry = await chatJSON({
    apiKey,
    messages: [
      ...messages,
      { role: 'assistant', content: JSON.stringify(res) },
      { role: 'user', content: '上次输出缺少必填字段 power_rules / map_layers（或为空数组）。请重新输出完整 JSON：power_rules 至少 2 条、map_layers 至少 3 层，其余字段一并保留，不得省略任何字段。' },
    ],
    temperature,
  })
  return bibleMissingFields(retry) ? res : retry
}

// ---------- 拆书工作台：参考资产 → 写作上下文 ----------
// 只拼结构层信息（功能位/关系模式/弧线/节奏模式）；资产本身不含原作专名，注入时再加硬约束防照搬。
export function referenceContext(analysis, maxChars = 2500) {
  if (!analysis) return ''
  const parts = []
  // P2-1 认知框架层：前置为 parts[0]——它是生成表层文风/结构的底层引擎，「先像作者一样思考，再像他一样遣词」，优先级高于叙事功能/技法。
  // additive：旧分析无 cognitive_frame 时本块不 push，输出与改动前逐字节一致（零回归）。
  const cf = analysis.cognitive_frame
  if (cf && typeof cf === 'object') {
    const cfParts = []
    if (cf.causality) cfParts.push(`因果观：${cf.causality}`)
    if (cf.values) cfParts.push(`价值序列：${cf.values}`)
    if (cf.attention) cfParts.push(`注意力分配：${cf.attention}`)
    if (cf.conflict) cfParts.push(`冲突观：${cf.conflict}`)
    if (cf.worldview) cfParts.push(`世界观基调：${cf.worldview}`)
    if (cfParts.length) parts.push('认知框架（落笔前先内化这位作者如何思考世界，比模仿辞藻更重要）：\n' + cfParts.map((p) => `- ${p}`).join('\n'))
  }
  if (analysis.work_function) parts.push(`叙事功能：${analysis.work_function}`)
  if (analysis.character_functions?.length) parts.push('人物功能位：\n' + analysis.character_functions.map((c) => `- ${c.slot || '功能位'}：${c.relation || ''}；弧线：${c.arc || ''}`).join('\n'))
  if (analysis.pacing_patterns?.length) parts.push('爽点推进模式：\n' + analysis.pacing_patterns.map((p) => `- ${p}`).join('\n'))
  if (analysis.techniques?.length) parts.push('可借鉴写法：\n' + analysis.techniques.map((t) => `- ${t}`).join('\n'))
  const text = parts.join('\n\n')
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text
}

// ---------- 防照搬算法兜底：新人物与参考作品资产相似度检测 ----------
// 参考资产在拆书时已强制去掉专名（看不到的抄不走），所以这里检测的是"特点层"：
// 人物设定文本与参考作品人物功能位（关系模式 + 弧线）的文本重合度。
// 字符二元组 Dice 系数：纯前端零费用，对中文短文本稳定；同文=1，无关文本一般 <0.15。
// 局限：只能抓字面级照搬；换词改写后二元组几乎不重合，改用单字频分布兼顾词汇层重合。
export function bigramDice(a, b) {
  const gramsOf = (s) => {
    const t = String(s || '').replace(/\s+/g, '')
    const m = new Map()
    for (let i = 0; i + 2 <= t.length; i++) {
      const g = t.slice(i, i + 2)
      m.set(g, (m.get(g) || 0) + 1)
    }
    return m
  }
  const A = gramsOf(a)
  const B = gramsOf(b)
  if (!A.size || !B.size) return 0
  let ta = 0
  let tb = 0
  let inter = 0
  for (const [g, c] of A) {
    ta += c
    inter += 2 * Math.min(c, B.get(g) || 0)
  }
  for (const c of B.values()) tb += c
  return inter / (ta + tb)
}

// 单字频分布 Dice（去标点）：比二元组宽松，能抓"换词但共用大量字词"的词汇层重合，但对短文本误报偏高。
export function unigramDice(a, b) {
  const charsOf = (s) => {
    const t = String(s || '').replace(/[\s，。、；：！？（）《》「」“”…—,.:;!?()"'-]/g, '')
    const m = new Map()
    for (const ch of t) m.set(ch, (m.get(ch) || 0) + 1)
    return m
  }
  const A = charsOf(a)
  const B = charsOf(b)
  if (!A.size || !B.size) return 0
  let ta = 0
  let tb = 0
  let inter = 0
  for (const [g, c] of A) {
    ta += c
    inter += 2 * Math.min(c, B.get(g) || 0)
  }
  for (const c of B.values()) tb += c
  return inter / (ta + tb)
}

// 人物与参考作品功能位的相似度报告：二元组主检（字面级），单字频副检（词汇级）作疑似补充；
// 未绑定参考资产或无功能位时返回空。只报可疑项不阻断，命中后由作者判断是巧合还是照搬。
export function refSimilarityReport({ characters, analysis, threshold = 0.3, softThreshold = 0.3 }) {
  if (!analysis || !Array.isArray(analysis.character_functions) || !analysis.character_functions.length) return []
  const hits = []
  for (const c of characters || []) {
    const left = [c.identity, c.personality, c.description].filter(Boolean).join(' ')
    if (!left) continue
    for (const f of analysis.character_functions) {
      const right = [f.slot, f.relation, f.arc].filter(Boolean).join(' ')
      const hard = bigramDice(left, right)
      if (hard >= threshold) hits.push({ name: c.name || '未命名人物', slot: f.slot || '未命名功能位', score: Math.round(hard * 100), soft: false })
      else if (unigramDice(left, right) >= softThreshold) hits.push({ name: c.name || '未命名人物', slot: f.slot || '未命名功能位', score: Math.round(hard * 100), soft: true })
    }
  }
  return hits.sort((x, y) => (x.soft === y.soft ? y.score - x.score : x.soft ? 1 : -1))
}

// ---------- 写法引擎 v1：反模板规则聚合 ----------
// ruleIds 为 null 时全部预设默认启用；否则只启用勾选的；自定义规则永远追加。
export function activeStyleRules(project) {
  const presets = project.ruleIds == null ? TEMPLATE_RULES : TEMPLATE_RULES.filter((r) => (project.ruleIds || []).includes(r.id))
  return [...presets, ...(project.customRules || [])]
}

// 试写：用当前文风绑定与反模板规则写一段约 300 字的小片段，供用户验证写法效果再正式开写。
export async function trialWrite({ apiKey, project, styleRec }) {
  return chatStream({
    apiKey,
    messages: styleTrialMessages({
      synopsis: project.synopsis,
      style: styleRec?.profile || '',
      habits: styleRec?.habits || [],
      forbidden: styleRec?.forbidden || [],
      rules: activeStyleRules(project),
      samples: styleRec?.samples || [],
    }),
    temperature: 0.9,
  })
}

// ---------- 世界手册结构化（块级编辑 + 三层选择性注入） ----------
// 块结构：{id, name, aliases(逗号分隔别名), kind('规则'|'设定'), content}
// 三层选块：① 场景清单返回的 locations 精确匹配块名/别名（AI 定，主路）；
// ② 未跑场景清单时用「本章方向 + 上一章摘要」做确定性文本匹配（兜底）；
// ③ kind='规则' 的块永远全量注入（硬保底，设定红线不允许选择性遗忘）。
// rulesOnly=true（细纲驱动模式）只走 ③ 并立即返回，不做地点匹配与兜底文本匹配：
// 设定块里的地名/势力名可能含后续舞台（剧透源），而本章所需设定已由详纲给足，此处只留「世界硬规则」这一份红线。
export function buildWorldBlockText(project, { locations = [], fallbackText = '', maxChars = 6000, rulesOnly = false } = {}) {
  const blocks = project.worldBlocks || []
  if (!blocks.length) return ''
  const hit = new Set()
  const fmt = (b) => `【${b.name}${b.aliases ? `（${b.aliases}）` : ''}】\n${b.content}`
  const parts = []
  let total = 0
  // ③ 规则块永不省略（超长时截断内容也不整块丢弃）
  for (const b of blocks) {
    if (b.kind !== '规则') continue
    const text = fmt(b)
    parts.push(total + text.length > maxChars ? text.slice(0, Math.max(0, maxChars - total)) + '…' : text)
    total += text.length
    hit.add(b.id)
  }
  if (rulesOnly) return parts.join('\n\n')
  // ① 场景地点匹配（块名/别名包含地点名，或地点名包含块名）
  const matchHit = (s) => {
    for (const b of blocks) {
      if (hit.has(b.id)) continue
      const names = [b.name, ...(b.aliases || '').split(/[,，、]/)].filter(Boolean)
      if (names.some((n) => s.includes(n) || n.includes(s))) hit.add(b.id)
    }
  }
  for (const loc of locations || []) if (loc) matchHit(String(loc).trim())
  // ② 兜底：无地点清单时对方向+前章摘要做文本包含匹配（块内容过长时只按名称匹配，避免全文遍历）
  if (fallbackText) {
    for (const b of blocks) {
      if (hit.has(b.id)) continue
      const names = [b.name, ...(b.aliases || '').split(/[,，、]/)].filter(Boolean)
      if (names.some((n) => fallbackText.includes(n)) || (b.content.length < 800 && b.content.split('\n').some((ln) => ln.trim().length > 4 && fallbackText.includes(ln.trim())))) hit.add(b.id)
    }
  }
  for (const b of blocks) {
    if (hit.has(b.id) && b.kind !== '规则') {
      const text = fmt(b)
      if (total + text.length <= maxChars) {
        parts.push(text)
        total += text.length
      }
    }
  }
  return parts.join('\n\n')
}

// 让 AI 把整段自由文本世界观拆成结构化块（一次性转换，用户之后按块维护）
export async function splitWorldToBlocks({ apiKey, world }) {
  const res = await chatJSON({
    apiKey,
    messages: worldSplitMessages({ world }),
    temperature: 0.2,
  })
  const blocks = Array.isArray(res.blocks) ? res.blocks : []
  return blocks
    .filter((b) => b && b.name && b.content)
    .map((b) => ({ id: uid(), name: String(b.name).slice(0, 30), aliases: b.aliases || '', kind: b.kind === '规则' ? '规则' : '设定', content: String(b.content) }))
}

// 编年史注入：每人物取最早 3 条（出身/关键起点）+ 最近 8 条（近期发展），控制总量避免撞爆上下文；
// onlyNames 给定出场人物名单时只注入这些人的编年史（本章参与者筛选，进一步省上下文）。
export function chronicleContext(project, maxChars = 3000, onlyNames = null) {
  const only = Array.isArray(onlyNames) && onlyNames.length ? new Set(onlyNames) : null
  const lines = []
  let total = 0
  for (const c of project.characters || []) {
    if (only && !only.has(c.name)) continue
    const entries = project.chronicles?.[c.name] || []
    if (!entries.length) continue
    const head = entries.slice(0, 3)
    const tail = entries.slice(-8)
    // 中段均匀采样最多 4 条：写到百章后中期关键经历不再掉进注入黑洞
    const midSrc = entries.slice(3, Math.max(3, entries.length - 8))
    const mid = []
    if (midSrc.length) {
      const step = midSrc.length / Math.min(4, midSrc.length)
      for (let i = 0; i < Math.min(4, midSrc.length); i++) mid.push(midSrc[Math.floor(i * step)])
    }
    const merged = [...head, ...mid, ...tail].filter((e, i, arr) => arr.indexOf(e) === i)
    const line = `- ${c.name}：` + merged.map((e) => `第${e.chapter}章 ${e.text}`).join('；')
    if (total + line.length > maxChars) break
    lines.push(line)
    total += line.length
  }
  return lines.join('\n')
}

// ---------- 四层伏笔：回收章锚定（根治"只有短埋点"） ----------
// 圣经流程登记的伏笔带 tier 与 plannedVolume（回收卷号）；卷结构确认后把回收卷换算成具体回收章锚点，
// 保护期由此生成——模型写作时看到的不再是"别急着收"的劝告，而是"第 X 章前禁止回收"的硬边界。
// 终极层锚到最后一卷起始章（全书最大秘密只在大结局区间回收）；无卷档案或卷号对不上时按 TIER_GAP 兜底。
export function anchorForeshadowResolve(project, foreshadow) {
  const base = foreshadow.plantedChapter || 1
  if (foreshadow.tier === '终极') {
    const vols = project.volumes || []
    const last = vols[vols.length - 1]
    return last ? Math.max(base + 20, last.startChapter) : base + (TIER_GAP['长'] || 150)
  }
  const gap = TIER_GAP[foreshadow.tier] ?? 10
  const v = (project.volumes || []).find((x) => x.volumeNo === foreshadow.plannedVolume)
  if (!v) return base + gap
  // 回收锚点 = 计划回收卷的中后段（卷内 70% 位置），卷内坐标再换算回全书章号；开放式末卷按 20 章估算，可人工微调
  const len = v.length || 20
  return Math.max(base + gap, v.startChapter + Math.max(0, Math.floor(len * 0.7) - 1))
}

// 卷结构确认后批量锚定：只处理「已选回收卷但尚未锚定」的伏笔，已锚定的不动（尊重人工微调）
export function anchorForeshadows(project) {
  const next = { ...project }
  next.foreshadows = (project.foreshadows || []).map((f) =>
    (f.tier === '终极' || (f.tier && f.plannedVolume)) && !f.resolveAnchored
      ? { ...f, minResolveChapter: anchorForeshadowResolve(project, f), resolveAnchored: true }
      : f,
  )
  next.updatedAt = Date.now()
  return next
}

// 本章核心任务（来自全书章名骨架，圣经流程产物）：注入写章与场景规划，硬约束"每章只完成一个任务"；
// 无骨架（旧书）时返回空不注入。返回格式：章名 + 任务。
export function chapterTaskOf(project, chapterNo) {
  const s = (project.chapterSkeleton || []).find((x) => Number(x.chapterNo) === Number(chapterNo))
  if (!s) return ''
  return [s.title && `章名：${s.title}`, s.task && `任务：${s.task}`].filter(Boolean).join('\n')
}

// ---------- 导入分章：按「第N章」章头把整段文本切成章节（长篇页导入与新手写作导入共用） ----------
// 兼容中文/阿拉伯数字章号（复用 cnToNumber）；识别不到章头时降级为单章，由调用方提示手动处理。
export function splitChapters(text) {
  const lines = String(text || '').split('\n')
  const heads = []
  lines.forEach((line, i) => {
    const m = line.trim().match(/^第\s*([0-9〇零一二三四五六七八九十百两]+)\s*章[：:\s]*(.*)$/)
    if (m) {
      const no = cnToNumber(m[1])
      if (Number.isFinite(no)) heads.push({ index: i, no, title: m[2].trim() })
    }
  })
  if (!heads.length) {
    const body = String(text || '').trim()
    return body ? [{ no: 1, title: '', text: body }] : []
  }
  const chapters = []
  heads.forEach((h, idx) => {
    const end = idx + 1 < heads.length ? heads[idx + 1].index : lines.length
    const body = lines.slice(h.index + 1, end).join('\n').trim()
    if (body) chapters.push({ no: h.no, title: h.title, text: body })
  })
  // 章号不连续或重复时重排为 1..N（导入后章号必须连续，否则保护期/审核窗口等按章计数的机制全部错位）
  return chapters.map((c, i) => ({ ...c, no: i + 1 }))
}

// 导入章节轻量归档：只做章节摘要 + 伏笔检测两路（各自容错），供导入流程逐章建档；
// cur 必须传累积后的项目，前文伏笔才能在后续章节被检测为"提及/回收"
export async function archiveImportedChapter({ apiKey, project: cur, chapterNo, title, text }) {
  let summary = ''
  try {
    summary = (await chatJSON({ apiKey, messages: chapterSummaryMessages({ text }), temperature: 0.3 })).summary || ''
  } catch {
    /* 摘要失败不阻塞导入，该章摘要留空可后续补跑 */
  }
  let hook = { new_foreshadows: [], resolved: [], mentioned: [] }
  try {
    hook = await chatJSON({ apiKey, messages: foreshadowMessages({ active: (cur.foreshadows || []).filter((f) => f.status === '未回收' || f.status === '已提及'), text }), temperature: 0.2 })
  } catch {
    /* 伏笔检测失败降级跳过 */
  }
  const report = { summary, updates: [], newCharacters: [], events: [], pov: '', newForeshadows: Array.isArray(hook.new_foreshadows) ? hook.new_foreshadows : [], resolved: Array.isArray(hook.resolved) ? hook.resolved : [], mentioned: Array.isArray(hook.mentioned) ? hook.mentioned : [], issues: [], drift: '', storylines: [], rolling: '' }
  const { project: next, blocked } = applyReport(cur, { chapterNo, title, text }, report)
  return { project: next, blocked, summary }
}

// 应用伏笔节奏规划结果：只延长保护期，不缩短（防止规划反而导致抢收）
export function applyForeshadowPlans(project, plans) {
  const next = { ...project }
  next.foreshadows = (project.foreshadows || []).map((f) => {
    const p = (plans || []).find((x) => String(x.id) === String(f.id))
    if (!p || !Number.isFinite(Number(p.min_resolve_chapter))) return f
    return {
      ...f,
      minResolveChapter: Math.max(f.minResolveChapter || 0, Math.floor(Number(p.min_resolve_chapter))),
      planAdvice: p.advice || f.planAdvice || '',
    }
  })
  next.updatedAt = Date.now()
  return next
}

// ---------- 11. 章末钩子检查（纯前端启发式，零费用）：网文每章结尾必须留下悬念/期待 ----------
// 强信号：悬念标点收尾、钩子关键词、对话戛然而止；无任何信号且平铺句号收尾判为偏弱（只提醒不阻断）。
// Fix9（Round-5）：原悬念词表只覆盖「突变型」钩子（突然/猛地/就在这时/变故…），漏了网文另两类常见钩子，
// 造成假阴性（Round-5 实测 3/3 章被判「平铺直叙」，人工复核发现 ch1 结尾是未解问句、ch3 结尾是静态对峙）：
//   ① 未解问句型：末句是陈述句，但紧邻的前一句是问句（「师父到底死在哪条巷子里？…线索到这里彻底断了。」）；
//   ② 僵持/对峙型：结尾定格在双方对峙、僵持、无人开口的静态张力上（与「突变型」并列的另一类钩子）。
// 同时补「未知型」悬念词（到底/究竟/难道/无人知晓/生死未卜/下落不明）。判据只扩不改，原本通过的仍通过。
export function hookCheck(text) {
  const tail = String(text || '').replace(/\s+$/, '').slice(-220)
  if (!tail) return { ok: true, reason: '' }
  const lastChar = tail.slice(-1)
  const lastLine = tail.split(/\n/).filter(Boolean).pop() || ''
  const suspenseWords = /却|竟然|竟|突然|猛地|不对|等等|可是|然而|就在这时|话音未落|下一秒|变故|异变|心头一(紧|沉|凛)|到底|究竟|难道|无人知晓|没人知道|生死未卜|下落不明/
  // 僵持型钩子：对峙/盯住/僵持/无人开口（静态张力，不带突变词）
  const stalemate = /(盯住|盯着对方|对峙|僵持|剑拔弩张|谁也没有|谁都没|没有人说话|没人说话|沉默)/
  if ('？?…'.includes(lastChar) || lastChar === '—') return { ok: true, reason: '以悬念标点收尾' }
  if (suspenseWords.test(tail.slice(-80))) return { ok: true, reason: '结尾带悬念词' }
  if (/[」』”"』」]$/.test(lastLine) && /[？?…—]$|[，,]$/.test(lastLine.slice(0, -1))) return { ok: true, reason: '对话戛然而止' }
  if ('！!'.includes(lastChar)) return { ok: true, reason: '强情绪收尾' }
  // ① 未解问句型：结尾两句内出现问句（问句不在末位也算钩子——末句常是对该问句的悬置/否定回答）
  const tailSents = tail.split(/(?<=[。！？；…])/).map((s) => s.trim()).filter(Boolean).slice(-2)
  if (tailSents.some((s) => /[？?]/.test(s))) return { ok: true, reason: '结尾带未解问句' }
  // ② 僵持/对峙型：末句定格在对峙/僵持/无人开口（限 ≤60 字，长句多为铺陈而非定格收束）
  const lastSent = tailSents[tailSents.length - 1] || ''
  if (lastSent.length <= 60 && stalemate.test(lastSent)) return { ok: true, reason: '以对峙/僵持定格收尾' }
  return { ok: false, reason: '结尾平铺直叙（句号收束、无悬念词、无断句），建议落在悬念、反转预告或未解的问题上' }
}

// ---------- 6. 专名一致性扫描（纯前端零费用）：抓"林峰/林锋"式错字变体 ----------
// 思路：对每个人名/别名，在正文里找同长度、只差一个字的串，且与所有已知专名都不是同一个词；
// 出现 ≥2 次才报（偶发单字重合噪音太大）。只扫草稿级文本，百万字全文请分章使用。
export function properNounScan(text, characters = [], minLength = 2) {
  const t = String(text || '')
  if (t.length < 50) return []
  const known = new Set()
  for (const c of characters || []) {
    if (c.name) known.add(String(c.name).trim())
    for (const a of aliasesOf(c)) known.add(a)
  }
  const names = [...known].filter((n) => n.length >= minLength)
  if (!names.length) return []
  const dist1 = (a, b) => {
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) return false
    return diff === 1
  }
  const hits = new Map()
  for (const name of names) {
    const L = name.length
    for (let i = 0; i + L <= t.length; i++) {
      const sub = t.slice(i, i + L)
      if (known.has(sub)) continue
      if (!/^[\u4e00-\u9fa5]+$/.test(sub)) continue
      if (!dist1(sub, name)) continue
      const key = `${sub}=>${name}`
      if (!hits.has(key)) hits.set(key, { candidate: sub, likely: name, count: 0 })
      hits.get(key).count += 1
      i += L - 1
    }
  }
  return [...hits.values()].filter((h) => h.count >= 2).sort((a, b) => b.count - a.count).slice(0, 10)
}

// ---------- 9. 完稿对账：决定"这卷怎么收"之前的一页总账 ----------
// 超期伏笔（埋设超 20 章未收）/ 休眠支线（超 10 章未推进）/ 失联人物（超 15 章无经历沉淀），纯前端计算零请求。
export function settlementReport(project, overdueChapters = 20) {
  const chs = project.chapters || []
  const current = chs.reduce((m, c) => Math.max(m, c.chapterNo), 0)
  const active = (project.foreshadows || []).filter((f) => f.status === '未回收' || f.status === '已提及')
  const overdueHooks = active.filter((f) => (f.plantedChapter || 0) > 0 && current - f.plantedChapter > overdueChapters)
  const staleStorylines = (project.storylines || []).filter((s) => s.type !== '主线' && s.lastChapter > 0 && current - s.lastChapter > 10)
  const dormantChars = (project.characters || []).filter((c) => {
    const entries = project.chronicles?.[c.name] || []
    return entries.length > 0 && current - entries[entries.length - 1].chapter > 15
  })
  // 四层伏笔健康度：按层分组统计，未分层（旧数据/归档自动登记）归入"未分层"，长时未动的分层伏笔单独提醒（防死伏笔）
  const byTier = {}
  for (const f of active) {
    const key = f.tier || '未分层'
    byTier[key] = (byTier[key] || 0) + 1
  }
  const dormantTiered = active.filter((f) => f.tier && f.tier !== '短' && (f.plantedChapter || 0) > 0 && current - f.plantedChapter > overdueChapters * 2)
  // P0-3 追读力债务系统（additive 扩展，不改既有字段）：按层级到期窗 TIER_GAP 计算逾期债务 + 近章章末钩子命中率
  const debt = narrativeDebts(project)
  const hookRate = recentHookRate(project, 5)
  return {
    current, overdueHooks, staleStorylines, dormantChars, byTier, dormantTiered,
    debts: debt.debts, overdueDebts: debt.overdueCount, openDebts: debt.openCount,
    recentHookRate: hookRate.rate, recentHookHits: hookRate.hits, recentHookChecked: hookRate.checked,
  }
}

// ---------- P0-3 追读力债务系统：每笔未回收伏笔 = 对读者的叙事债务，按层级 TIER_GAP 定「到期章」 ----------
// 追读力（读者留存拉力）来自「开了钩子就要兑现」的承诺；债务逾期未偿 = 读者等不到兑现 → 弃书风险。
// 到期窗按伏笔层级（TIER_GAP 短10/中50/长150）而非一刀切，比 flat overdueChapters 更贴合叙事节奏；
// 未分层（旧数据）gap=null → 不按层级判逾期（交回 settlementReport.overdueHooks 的 flat 判），避免误伤。
// 纯前端零请求：返回 { current, debts:[{content,tier,plantedChapter,age,dueChapter,overdue,overdueBy,urgency,status}], overdueCount, openCount }。
export function narrativeDebts(project) {
  const chs = (project && project.chapters) || []
  const current = chs.reduce((m, c) => Math.max(m, c.chapterNo || 0), 0)
  const active = ((project && project.foreshadows) || []).filter((f) => f && (f.status === '未回收' || f.status === '已提及'))
  const debts = active.map((f) => {
    const tier = f.tier || '未分层'
    const gap = TIER_GAP[tier] != null ? TIER_GAP[tier] : null
    const planted = f.plantedChapter || 0
    const age = planted > 0 ? Math.max(0, current - planted) : 0
    const dueChapter = gap != null && planted > 0 ? planted + gap : null
    const overdue = dueChapter != null && current > dueChapter
    const overdueBy = overdue ? current - dueChapter : 0
    const urgency = overdue && gap ? +((overdueBy / gap).toFixed(2)) : 0
    return { content: f.content, tier, plantedChapter: planted, age, dueChapter, overdue, overdueBy, urgency, status: f.status }
  }).sort((a, b) => (b.urgency - a.urgency) || (b.age - a.age))
  return { current, debts, overdueCount: debts.filter((d) => d.overdue).length, openCount: debts.length }
}

// 近 n 章章末钩子命中率：追读力的「即时拉力」——每章结尾是否留悬念（复用已有 hookCheck）。
// 返回 { checked, hits, rate }；rate=null 表示无可检章节（无正文）。纯前端零请求。
export function recentHookRate(project, n = 5) {
  const chs = (((project && project.chapters) || []).filter((c) => c && typeof c.content === 'string' && c.content.length))
    .sort((a, b) => (a.chapterNo || 0) - (b.chapterNo || 0)).slice(-n)
  if (!chs.length) return { checked: 0, hits: 0, rate: null }
  const hits = chs.filter((c) => hookCheck(c.content).ok).length
  return { checked: chs.length, hits, rate: +(hits / chs.length).toFixed(2) }
}

// 圣经真相层 → 审核对照表：只供审核判断终极秘密是否被提前揭示（写作上下文永远拿不到，真相隔离）；
// 揭示红线默认取终卷起始章（终极伏笔的回收区间），无卷档案时不带章号约束。
// 地图分层真相层同样进对照表（红线 = 解锁卷起始章），防写作方地图越界提前写死大世界。
export function reviewTruths(project) {
  const out = []
  const vols = project.volumes || []
  const last = vols[vols.length - 1]
  for (const t of project.bible?.truths || []) {
    if (t.truth) out.push({ kind: t.kind, truth: t.truth, minResolveChapter: last?.startChapter || null })
  }
  for (const m of project.bible?.mapLayers || []) {
    if (!m.truth) continue
    const v = vols.find((x) => x.volumeNo === m.unlockVolume)
    out.push({ kind: `地图分层真相·${m.name}`, truth: m.truth, minResolveChapter: v?.startChapter || null })
  }
  return out
}

// ==================== P2 记忆可编辑（卷级长时记忆的人工修订）====================
// 卷志由归档自动压缩产出（append-only），但 AI 压缩可能失真/漏关键伏笔——开放人工编辑/删除，作者对长时记忆有最终裁量权。
// 纯函数：返回新 project（不写盘，由调用方 saveProject）；idx 越界或无 memory 时原样返回（零副作用）。
export function setMemoryEntry(project, idx, patch) {
  const mem = Array.isArray(project && project.memory) ? project.memory : []
  const i = Number(idx)
  if (!mem.length || !(i >= 0 && i < mem.length)) return project
  const next = mem.map((m, j) => (j === i ? { ...m, ...(patch || {}) } : m))
  return { ...project, memory: next, updatedAt: Date.now() }
}
export function removeMemoryEntry(project, idx) {
  const mem = Array.isArray(project && project.memory) ? project.memory : []
  const i = Number(idx)
  if (!mem.length || !(i >= 0 && i < mem.length)) return project
  return { ...project, memory: mem.filter((_, j) => j !== i), updatedAt: Date.now() }
}

// ==================== P2 全书润色终 pass（对标 show-me-the-story 的 final polish）====================
// 成书后对【已归档章节】逐章做一次「保持剧情/人物不变」的定稿润色：去 AI 味、修语病、跨章连贯。
// 非破坏性：只返回润色结果供预览，不自动覆盖正文（作者逐章确认后再用 applyPolishResults 采用），与项目「只提醒不阻断」一致。
// 顺序处理（避免并发打爆 BYOK 限流），onProgress 汇报进度；单章失败不中断整轮（记 error 跳过）。
// 返回 {results:[{chapterNo,title,polished,notes,changed,error?}], changed}。
export async function polishWholeBook({ apiKey, project, onProgress, signal, chapterNos = null, style, habits, forbidden, samples, setting }) {
  const proj = project || {}
  let chs = (Array.isArray(proj.chapters) ? proj.chapters : []).filter((c) => c && typeof c.content === 'string' && c.content.length)
  chs.sort((a, b) => (a.chapterNo || 0) - (b.chapterNo || 0))
  if (Array.isArray(chapterNos) && chapterNos.length) {
    const want = new Set(chapterNos.map(Number))
    chs = chs.filter((c) => want.has(Number(c.chapterNo)))
  }
  const results = []
  for (let i = 0; i < chs.length; i++) {
    const ch = chs[i]
    if (signal && signal.aborted) break
    if (onProgress) onProgress({ done: i, total: chs.length, chapterNo: ch.chapterNo, title: ch.title || '' })
    const prevCh = chs[i - 1]
    const nextCh = chs[i + 1]
    const messages = polishChapterMessages({
      text: ch.content,
      before: prevCh ? `${prevCh.title || ''}\n${String(prevCh.content || '').slice(-600)}` : '',
      after: nextCh ? `${nextCh.title || ''}\n${String(nextCh.content || '').slice(0, 300)}` : '',
      setting: setting || proj.world || '',
      style, habits, forbidden, samples,
    })
    try {
      const rep = await chatJSON({ apiKey, messages, temperature: 0.4, signal })
      const polished = String((rep && rep.polished_text) || '').trim()
      results.push({
        chapterNo: ch.chapterNo,
        title: ch.title || '',
        polished: polished || ch.content,
        notes: (rep && rep.notes) || '',
        changed: !!(polished && polished !== ch.content && (rep ? rep.changed !== false : true)),
      })
    } catch (e) {
      results.push({ chapterNo: ch.chapterNo, title: ch.title || '', polished: ch.content, notes: '', changed: false, error: String((e && e.message) || e) })
    }
  }
  if (onProgress) onProgress({ done: chs.length, total: chs.length, chapterNo: null, finished: true })
  return { results, changed: results.some((r) => r.changed) }
}
// 采用润色结果：把 results 里 changed 的章节正文替换为 polished；正文已变→清除陈旧的 refs/chunkEmbed 索引（下次归档/回填自动重建）。
export function applyPolishResults(project, results) {
  const proj = project || {}
  const chs = Array.isArray(proj.chapters) ? proj.chapters : []
  const byNo = new Map((Array.isArray(results) ? results : []).filter((r) => r && r.changed && r.polished).map((r) => [Number(r.chapterNo), r.polished]))
  if (!byNo.size) return proj
  return {
    ...proj,
    chapters: chs.map((c) => (byNo.has(Number(c.chapterNo)) ? { ...c, content: byNo.get(Number(c.chapterNo)), refs: undefined, chunkEmbed: undefined } : c)),
    updatedAt: Date.now(),
  }
}

// ==================== #4 写前场景推演（多智能体编排）====================
// 落笔前对同一个「待写场景前提」并行跑 4 个专家智能体（逻辑/角色/冲突/读者），再由综合者收敛成可执行报告。
// 纯 AI 编排（非确定性），独立于零-AI 门禁；只推演规划、不代写正文。单个 agent 失败降级标注（不阻塞其余），全失败由综合阶段兜底。
// 组装共享上下文：题材 + 世界观 + 滚动摘要 + 本章详纲（无则全书精简地图）+ 主要角色卡。
function sceneSimContext(proj, chapterNo) {
  const parts = []
  if (proj.genre) parts.push(`【题材】${proj.genre}`)
  if (proj.world) parts.push(`【世界观】${String(proj.world).slice(0, 600)}`)
  if (proj.rollingSummary) parts.push(`【前情滚动摘要】${String(proj.rollingSummary).slice(0, 800)}`)
  const no = Number(chapterNo) || 0
  const detail = no && proj.outlineDetail ? proj.outlineDetail[no] : ''
  if (detail) parts.push(`【本章详纲】${String(detail).slice(0, 700)}`)
  else if (proj.outline) parts.push(`【全书精简地图】${String(proj.outline).slice(0, 500)}`)
  const chars = ensureCharacterUids(Array.isArray(proj.characters) ? proj.characters : []).slice(0, 12)
  if (chars.length) parts.push('【主要角色】' + chars.map((c) => `${c.name}${c.identity ? '·' + c.identity : ''}${c.personality ? '（' + String(c.personality).slice(0, 30) + '）' : ''}`).join('；'))
  return parts.join('\n\n')
}

// 运行场景推演：并行 4 智能体 → 综合者收敛。onProgress({done,total,label}) 供面板进度条；signal 支持中断。
// 返回 {premise, chapterNo, agentOutputs:[{id,name,focus,icon,verdict,analysis,risks,suggestions,error}], synthesis}。
export async function runSceneSim({ apiKey, premise, project, chapterNo, signal, onProgress }) {
  const proj = project || {}
  const context = sceneSimContext(proj, chapterNo)
  const roster = ensureCharacterUids(Array.isArray(proj.characters) ? proj.characters : []).slice(0, 12)
  const total = SCENE_SIM_AGENTS.length + 1
  let done = 0
  const bump = (label) => { done += 1; if (onProgress) onProgress({ done, total, label }) }
  const settled = await Promise.allSettled(
    SCENE_SIM_AGENTS.map((a) =>
      chatJSON({ apiKey, messages: sceneSimAgentMessages({ agent: a.id, premise, context, characters: roster, chapterNo }), temperature: 0.5, signal })
        .then((r) => ({ a, r }))
        .finally(() => bump(a.name))
    )
  )
  const asArr = (x) => (Array.isArray(x) ? x.map((s) => String(s)).filter(Boolean) : [])
  const agentOutputs = settled.map((s, i) => {
    const a = SCENE_SIM_AGENTS[i]
    if (s.status === 'fulfilled' && s.value && s.value.r) {
      const r = s.value.r
      return { id: a.id, name: a.name, focus: a.focus, icon: a.icon, verdict: r.verdict || '需调整', analysis: String(r.analysis || ''), risks: asArr(r.risks), suggestions: asArr(r.suggestions), error: null }
    }
    const reason = s.status === 'rejected' ? s.reason : null
    return { id: a.id, name: a.name, focus: a.focus, icon: a.icon, verdict: '失败', analysis: '', risks: [], suggestions: [], error: (reason && reason.message) || '推演失败' }
  })
  const good = agentOutputs.filter((o) => !o.error)
  let synthesis = null
  if (good.length) {
    try {
      const r = await chatJSON({ apiKey, messages: sceneSimSynthesisMessages({ premise, context, agentOutputs: good, chapterNo }), temperature: 0.4, signal })
      synthesis = { feasibility: String((r && r.feasibility) || ''), key_risks: asArr(r && r.key_risks), recommendations: asArr(r && r.recommendations), beat_sequence: asArr(r && r.beat_sequence) }
    } catch (e) {
      synthesis = { error: (e && e.message) || '综合失败' }
    }
  } else {
    synthesis = { error: '所有智能体推演均失败，请检查 API Key 或稍后重试。' }
  }
  bump('综合')
  return { premise, chapterNo: chapterNo || null, agentOutputs, synthesis }
}

// ---------- 10. 抽章交叉审核：随机抽 2 个早期章 + 最近 3 章送审，专查跨窗口矛盾 ----------
// 与常规五章审核共用审核机会与落库协议（applyReview），只在输入组装上不同。
export function buildCrossReviewInput(project) {
  const chs = [...(project.chapters || [])].sort((a, b) => a.chapterNo - b.chapterNo)
  if (chs.length < 6) return null // 章节太少时没有"跨窗口"可言
  const recent = chs.slice(-3)
  const earliestRecent = recent[0].chapterNo
  // 候选池 = 最近窗口之前的章节（且至少写过摘要），均匀抽 2 章：一章靠前、一章靠中
  const pool = chs.filter((c) => c.chapterNo < earliestRecent - 1)
  if (!pool.length) return null
  const samples = [...new Set([pool[Math.floor(pool.length * 0.2)], pool[Math.floor(pool.length * 0.7)]])].filter(Boolean)
  const window = [...samples, ...recent].sort((a, b) => a.chapterNo - b.chapterNo)
  const startNo = window[0].chapterNo
  const endNo = window[window.length - 1].chapterNo
  const timeline = (project.events || [])
    .filter((e) => e.chapter >= startNo - 5 && e.chapter <= endNo)
    .slice(-150)
    .map((e) => `第${e.chapter}章${e.time ? `（${e.time}）` : ''}：${e.text}`)
    .join('\n')
  return {
    world: project.world,
    timeline,
    rollingSummary: project.rollingSummary,
    characters: project.characters,
    foreshadows: (project.foreshadows || []).filter((f) => f.status === '未回收' || f.status === '已提及'),
    beforeSummary: chs.filter((c) => c.chapterNo < startNo).slice(-6).map((c) => `第${c.chapterNo}章：${c.summary || ''}`).join('\n'),
    chapters: window,
    positions: window.map((c) => ({ chapterNo: c.chapterNo, position: '' })),
    truths: reviewTruths(project),
    cross: true,
    sampled: samples.map((c) => c.chapterNo),
  }
}

// ---------- 12. 成书导出增强：卷分隔 / TXT 与 Markdown 双格式（写得出来也要拿得出去） ----------
// 卷分隔按卷档案 startChapter 在对应章节前插入卷头；未建档卷则整本直出。
export function exportBookText(project, { format = 'txt', withVolumes = true } = {}) {
  const sorted = [...(project.chapters || [])].sort((a, b) => a.chapterNo - b.chapterNo)
  const vols = withVolumes ? [...(project.volumes || [])].sort((a, b) => a.startChapter - b.startChapter) : []
  const volFor = (no) => vols.find((v) => no === v.startChapter)
  const lines = []
  if (format === 'md') lines.push(`# ${project.name || '未命名'}`)
  let lastVolId = null
  for (const c of sorted) {
    const v = volFor(c.chapterNo)
    if (v && v.id !== lastVolId) {
      lastVolId = v.id
      lines.push('', format === 'md' ? `## 第${v.volumeNo}卷 ${v.name || ''}` : `═══════ 第${v.volumeNo}卷 ${v.name || ''} ═══════`)
    }
    const head = `第${c.chapterNo}章 ${(c.title || '').replace(/^第\s*[0-9〇零一二三四五六七八九十百两]+\s*章[\s:：]*/, '')}`.trim()
    lines.push('', format === 'md' ? `### ${head}` : head, '', c.content)
  }
  return lines.join('\n').replace(/^\n+/, '')
}

// ---------- 章节审核模块 ----------
// 审核机会：每写满 5 章解锁一次，一次性（执行审核即消耗）；未用时不阻塞写作，可累积
export function reviewOpportunity(project) {
  const written = (project.chapters || []).length
  const unlocked = Math.floor(written / REVIEW_WINDOW)
  const used = project.review?.usedCount || 0
  return {
    written,
    unlocked,
    available: written >= REVIEW_WINDOW && unlocked > used,
    toNext: written < REVIEW_WINDOW ? REVIEW_WINDOW - written : unlocked <= used ? REVIEW_WINDOW - (written % REVIEW_WINDOW || 0) : 0,
  }
}

// 组装审核输入：最近 5 章全文 + 严格约束上下文（世界观 / 时间线 / 人物状态 / 伏笔 / 窗口前剧情摘要）；
// 时间线只取审核窗口附近的事件（窗口前 10 章作衔接参照），百万字时不再全量注入撞爆上下文
export function buildReviewInput(project) {
  const chs = [...(project.chapters || [])].sort((a, b) => a.chapterNo - b.chapterNo)
  const window = chs.slice(-REVIEW_WINDOW)
  const before = chs.slice(0, -REVIEW_WINDOW)
  const startNo = window.length ? window[0].chapterNo : 1
  const endNo = window.length ? window[window.length - 1].chapterNo : startNo
  // 只注入「窗口前 10 章 ~ 窗口末章」区间内的事件，上下都有界，百万字时不再全量注入撞爆上下文
  const timeline = (project.events || [])
    .filter((e) => e.chapter >= startNo - 10 && e.chapter <= endNo)
    .slice(-150)
    .map((e) => `第${e.chapter}章：${e.text}`)
    .join('\n')
  return {
    world: project.world,
    timeline,
    rollingSummary: project.rollingSummary,
    characters: project.characters,
    foreshadows: (project.foreshadows || []).filter((f) => f.status === '未回收' || f.status === '已提及'),
    beforeSummary: before.slice(-8).map((c) => `第${c.chapterNo}章：${c.summary || ''}`).join('\n'),
    chapters: window,
    // 各章起承转合定位（供结构错位检查；旧细纲无标签时为空，审核自动跳过该项）
    positions: window.map((c) => ({ chapterNo: c.chapterNo, position: outlinePositionFor(project.outline, c.chapterNo) })),
    // 圣经真相对照表（有圣经才注入；只用于判断终极秘密是否被提前揭示）
    truths: reviewTruths(project),
  }
}

// 审核结果落库：消耗一次机会，建议绑定章号（过滤掉章号非法或缺修改提示词的条目）
export function applyReview(project, result, kind = 'window') {
  const next = { ...project }
  const chs = project.chapters || []
  next.review = {
    usedCount: (project.review?.usedCount || 0) + 1,
    current: {
      at: Date.now(),
      kind,
      windowEnd: chs.length ? chs[chs.length - 1].chapterNo : 0,
      pass: !!result.pass,
      analysis: result.analysis || '',
      suggestions: (Array.isArray(result.suggestions) ? result.suggestions : [])
        .filter((s) => Number.isFinite(Number(s.chapter_no)) && s.fix_prompt)
        .map((s) => ({ chapterNo: Number(s.chapter_no), problem: s.problem || '', fixPrompt: s.fix_prompt || '' })),
      fixed: [],
      dismissed: false,
    },
  }
  next.updatedAt = Date.now()
  return next
}

// 放弃本次审核建议：清空建议展示但不阻塞写作（安全阀）；保留历史记录供回看结论
export function dismissReview(project) {
  if (!project.review?.current) return project
  const next = { ...project }
  next.review = { ...project.review, current: { ...project.review.current, dismissed: true } }
  next.updatedAt = Date.now()
  return next
}

// 用重写结果替换已保存章节的正文（派生数据同步更新），并标记该章已修复；摘要/视角由 meta 提供（无则保留旧值）；
// 替换前把原稿整版快照存进 prev（只保最近一版），重写不满意时可一键恢复，永远不弄丢用户的字
export function replaceChapter(project, chapterNo, { title, text }, meta = {}) {
  const next = { ...project }
  next.chapters = (project.chapters || []).map((c) =>
    c.chapterNo === chapterNo
      ? {
          ...c,
          prev: { title: c.title, content: c.content, wordCount: c.wordCount, summary: c.summary, pov: c.pov },
          title: title || c.title,
          content: text,
          wordCount: countWords(text),
          summary: meta.summary !== undefined ? meta.summary : c.summary,
          pov: meta.pov !== undefined ? meta.pov : c.pov,
        }
      : c,
  )
  const cur = next.review?.current
  if (cur && !cur.fixed.includes(chapterNo)) {
    next.review = { ...next.review, current: { ...cur, fixed: [...cur.fixed, chapterNo] } }
  }
  next.updatedAt = Date.now()
  return next
}

// 恢复替换前的原稿：把 prev 快照回写正文与派生数据（问题明细一并清空，因为那是旧版本的校验结果）；无快照时不动
export function restoreChapter(project, chapterNo) {
  const next = { ...project }
  next.chapters = (project.chapters || []).map((c) =>
    c.chapterNo === chapterNo && c.prev
      ? {
          ...c,
          title: c.prev.title,
          content: c.prev.content,
          wordCount: c.prev.wordCount,
          summary: c.prev.summary,
          pov: c.prev.pov,
          issues: [],
          issueCount: 0,
          prev: undefined,
        }
      : c,
  )
  next.updatedAt = Date.now()
  return next
}

// ===== Round-3 新增：第二次自检 / 连续性漂移 / 多本融合 / 防原文 / 双层审计（纯函数，app 与探针同源、可单测）=====

// 修复1：残留重复封装——落库前对最终稿再扫一遍重复长短语，作为「第二次自检」的触发判定
export function residualRepeats(text) {
  return findRepeatedPhrases(text || '')
}

// 修复2：从项目提取「上一章遗留、本章必须修正」的连续性硬问题（只取 hard，soft 不阻断；按章号定位上一章）
export function consistencyCarryover(project, chapterNo) {
  const pending = (project && Array.isArray(project.pendingConsistency)) ? project.pendingConsistency : []
  const no = Number(chapterNo) || 0
  const out = []
  for (const p of pending) {
    if (!p || Number(p.chapterNo) !== no - 1) continue
    for (const it of (Array.isArray(p.issues) ? p.issues : [])) {
      if (it && it.severity === 'hard' && it.description) out.push(String(it.description))
    }
    if (p.drift) out.push('大纲偏离：' + String(p.drift))
    if (p.ledger) { const snap = ledgerToText({ items: p.ledger.items, numbers: p.ledger.numbers }); if (snap) out.push('上一章台账快照（道具/数字须与之连续，不得漂移）：' + snap.slice(0, 400)) }
  }
  return [...new Set(out)]
}

// Part2：把台账对象渲染成注入文本（道具/数字/约束三行）；供 deriveFactLedger 的 factSeed 与 consistencyCarryover 的上一章台账快照复用。
function ledgerToText(ledger) {
  if (!ledger || typeof ledger !== 'object') return ''
  const items = (Array.isArray(ledger.items) ? ledger.items : []).filter((it) => it && it.name)
  const numbers = (Array.isArray(ledger.numbers) ? ledger.numbers : []).filter((n) => n && n.key)
  const constraints = (Array.isArray(ledger.constraints) ? ledger.constraints : []).filter(Boolean)
  const rows = []
  if (items.length) rows.push('道具归属：' + items.map((it) => it.name + (it.owner ? '（' + it.owner + '）' : '') + (it.count != null && it.count !== '' ? '×' + it.count : '') + (it.note ? '[' + it.note + ']' : '')).join('；'))
  if (numbers.length) rows.push('关键数字：' + numbers.map((n) => n.key + '=' + n.value).join('；'))
  if (constraints.length) rows.push('设定约束：' + constraints.map((c) => '- ' + c).join(' '))
  return rows.join('\n')
}

// Part2（Step C）：从「本章出场人物的当前状态 status」与「世界观规则块 kind==='规则'」派生本章事实台账，
// 供 scenePlan（factSeed）/ 初稿 / 落库自检（factLedger）注入，治设定冲突（数字/道具漂移）。
// 全部派生自既有档案、不新造；status 以「；」分隔且带数字（STATE_UPDATE_SYSTEM 已约束），正则抓「标签+数字+量词」。
// 空 status / 空规则块 → 返回空台账（factSeed=''、ledger=null），下游跳过注入（等价旧行为、向后兼容）。
export function deriveFactLedger(project, chapterNo, participants, opts = {}) {
  const maxChars = opts && opts.maxChars != null ? opts.maxChars : 6000
  const proj = project || {}
  const chars = Array.isArray(proj.characters) ? proj.characters : []
  const only = Array.isArray(participants) && participants.length ? new Set(participants) : null
  const inScene = chars.filter((c) => c && c.name && (!only || only.has(c.name)))
  const ITEM_UNITS = ['支', '个', '瓶', '枚', '把', '颗', '粒', '片', '包', '袋', '盒', '条', '剂', '管', '台', '辆', '柄', '张', '份', '罐', '筒', '发', '束', '捆', '套', '件', '只', '匹', '头', '尾']
  const UNIT_ALT = '小时|分钟|毫升|回合|点|支|个|瓶|枚|把|颗|粒|片|包|袋|盒|条|剂|管|台|辆|柄|张|份|罐|筒|发|束|捆|套|件|只|匹|头|尾|天|秒|块|元|成|%|％|倍|米|人|两|斤|克|ml|次|年|月|周|里|位|名|阶|级|段|重|寸|尺|丈'
  const numRe = new RegExp('(\\d+(?:\\.\\d+)?)\\s*(' + UNIT_ALT + ')?', 'g')
  const labelRe = /[\u4e00-\u9fa5A-Za-z]+$/
  const items = []
  const numbers = []
  const seenItem = new Set()
  const seenNum = new Set()
  for (const c of inScene) {
    const status = typeof c.status === 'string' ? c.status.trim() : ''
    if (!status) continue
    for (const segRaw of status.split(/[；;]/)) {
      const seg = segRaw.trim()
      if (!seg) continue
      numRe.lastIndex = 0
      const toks = []
      let mm
      while ((mm = numRe.exec(seg)) !== null) {
        const label = (seg.slice(0, mm.index).trim().replace(/[：:，,、]+$/, '').match(labelRe) || [''])[0]
        toks.push({ num: mm[1], unit: mm[2] || '', val: (mm[1] + (mm[2] ? ' ' + mm[2] : '')).trim(), label, end: mm.index + mm[0].length })
      }
      if (!toks.length) continue
      for (const t of toks) {
        const key = (t.label || seg).slice(0, 20)
        const nk = key + '=' + t.val
        if (!seenNum.has(nk)) { seenNum.add(nk); numbers.push({ key, value: t.val }) }
      }
      const first = toks[0]
      if (first.unit && ITEM_UNITS.includes(first.unit) && first.label) {
        const ik = first.label + '|' + c.name
        if (!seenItem.has(ik)) {
          seenItem.add(ik)
          const note = seg.slice(first.end).replace(/^[，,、：:\s]+/, '').trim().slice(0, 30)
          items.push({ name: first.label.slice(0, 20), owner: c.name, count: first.val, note })
        }
      }
    }
  }
  const constraints = []
  for (const b of (Array.isArray(proj.worldBlocks) ? proj.worldBlocks : [])) {
    if (!b || b.kind !== '规则') continue
    const text = String(b.content || '').trim()
    if (text) constraints.push(((b.name ? '【' + b.name + '】' : '') + text).slice(0, 200))
  }
  const ledger = (items.length || numbers.length || constraints.length)
    ? { items: items.slice(0, 24), numbers: numbers.slice(0, 40), constraints: constraints.slice(0, 12) }
    : null
  let factSeed = ledger ? ledgerToText(ledger) : ''
  if (factSeed.length > maxChars) factSeed = factSeed.slice(0, maxChars) + '…'
  return { factSeed, ledger }
}

// 功能5：多本文风档案融合成一个混合文风——habits/forbidden 跨全体档案并集去重(共性规则)，profile/samples 择一(主导嗓音)。
// 主导嗓音优先：skin 池优先取 origin==='user' 子集（用户自带书主导基调）；无用户书时回退全体（预置档案里按 skinScore 择一）。
export function blendStyles(styleRecs, opts = {}) {
  const recs = (Array.isArray(styleRecs) ? styleRecs : []).filter((s) => s && (s.profile || (Array.isArray(s.habits) && s.habits.length)))
  if (!recs.length) return null
  if (recs.length === 1) return recs[0]
  // 骨架层（可组合的约束）：habits/forbidden 跨源并集去重——约束越多越严，合并让成文同时满足所有源的规则。预置与用户档案一律参与并集。
  const habits = [...new Set(recs.flatMap((s) => (Array.isArray(s.habits) ? s.habits : []).map((h) => String(h).trim()).filter(Boolean)))].slice(0, 8)
  const forbidden = [...new Set(recs.flatMap((s) => (Array.isArray(s.forbidden) ? s.forbidden : []).map((f) => String(f).trim()).filter(Boolean)))]
  // P2-2 皮肤层（不可组合的声音）：profile/samples 择一而非拼接——多源 few-shot 混杂会给模型冲突的嗓音信号，产出浑浊不一致的文风。
  // 主导嗓音选择：① opts.forceSkinBookId 显式指定（设定页绑定某书时该书主导）；② 否则优先 origin==='user' 子集（用户自带书主导预置基调）；③ 再否则全体（预置里择一）。
  // 池内选「皮肤最丰富」的源为主：profile 最长（权重×2）→ tie 取 samples 最多 → tie 取首个（确定性）。
  const skinScore = (s) => String(s.profile || '').length * 2 + (Array.isArray(s.samples) ? s.samples.filter((x) => typeof x === 'string' && x.trim()).length : 0)
  const forced = opts.forceSkinBookId ? recs.filter((s) => s.bookId === opts.forceSkinBookId) : []
  const userRecs = recs.filter((s) => s.origin === 'user')
  const skinPool = forced.length ? forced : (userRecs.length ? userRecs : recs)
  let skin = skinPool[0]
  for (let i = 1; i < skinPool.length; i++) if (skinScore(skinPool[i]) > skinScore(skin)) skin = skinPool[i]
  const profile = String(skin.profile || '')
  const samples = (Array.isArray(skin.samples) ? skin.samples.filter((x) => typeof x === 'string' && x.trim()) : []).slice(0, 3)
  // P1-1R metrics/thresholds 跟随主导 skin（与 profile/samples 同源，保证「嗓音」与「量化指纹」一致）：
  //  · skin 已存蒸馏指纹（用户书）→ 直接沿用其 metrics/thresholds/bandReliable；
  //  · skin 无指纹（预置档案）→ 用其 samples 兜底实时蒸馏（零 Token、确定性、随 samples 永不陈旧）；
  //  · 连 samples 都没有 → metrics=null，thresholds 回退保守默认（≈旧剑来口径），bandReliable=false。
  const skinBand = skin.metrics ? null : (samples.length ? distillStyleBand(samples.join('\n')) : null)
  const metrics = skin.metrics || (skinBand ? skinBand.metrics : null)
  const thresholds = skin.thresholds || (skinBand ? skinBand.thresholds : metricsToThresholds(metrics))
  const bandReliable = skin.metrics ? !!skin.bandReliable : (skinBand ? skinBand.reliable : false)
  return { bookId: 'blend:' + recs.map((s) => s.bookId).join('+'), origin: 'blend', profile, habits, samples, forbidden, metrics, thresholds, bandReliable, blended: true, skinFrom: skin.bookId || '来源', blendedFrom: recs.map((s) => s.bookId), updatedAt: Date.now() }
}

// 默认文风基调入口：把预置语料（PRESET_STYLES）与用户蒸馏档案在内存合成一个聚合基调，不落库。
// styleBookId==='' 时用此回退——habits/forbidden 全体并集，主导嗓音优先用户书（无则预置里 skinScore 最高者）。
export function resolveBaseStyle(userStyles) {
  return blendStyles([...PRESET_STYLES, ...(Array.isArray(userStyles) ? userStyles : [])])
}

// 设定页/写作端统一解析「当前生效的文风档案」——把散落的 libStyles.find(styleBookId) 收敛成一处，保证初稿/重写/试写/自动续写注入同一基调。
//  · styleBookId 命中某档案（预置或用户书）→ 该书主导 skin（profile/samples），PRESET + 用户档案进 habits/forbidden 并集；
//  · styleBookId==='' 或未命中 → 默认注入预置聚合基调（resolveBaseStyle：主导嗓音优先用户书）。
// libStyles 为页面内存中的全量档案（含 PRESET_STYLES 与用户蒸馏档案）。返回值恒为含 profile/habits/forbidden/samples 的对象。
export function resolveStyleRec(styleBookId, libStyles) {
  const all = (Array.isArray(libStyles) ? libStyles : []).filter((s) => s && s.bookId)
  const userStyles = all.filter((s) => s.origin === 'user')
  const boundRec = styleBookId ? all.find((s) => s.bookId === styleBookId) : null
  if (boundRec) {
    // 命中：该书强制主导 skin；habits/forbidden = 该书 + 全体 PRESET + 全体用户档案 的并集（按 bookId 去重）。
    const seen = new Set()
    const pool = [boundRec, ...PRESET_STYLES, ...userStyles].filter((s) => s && s.bookId && !seen.has(s.bookId) && seen.add(s.bookId))
    return blendStyles(pool, { forceSkinBookId: boundRec.bookId }) || boundRec
  }
  // 未绑定/未命中 → 默认预置聚合基调（主导嗓音优先用户书）
  return resolveBaseStyle(userStyles) || {}
}

// P2-2 动态选样：当文风范例池超过注入预算 maxN 时，按与本章上下文（细纲+场景）的相关度选最贴合的 maxN 个，让 few-shot 范例服务当前场景。
// 相关度用字符二元组 Dice（复用 bigramDice，纯前端零费用）；选中后升序排列（最相关放最后=离生成点最近，recency 锚定最强）。
// 保守降级（零回归）：池≤maxN 时原序全注入（identity）——当前蒸馏样本恒≤3，故对已校准的生成行为零改动；仅池>预算时动态选样才生效。
export function selectSamplesForContext(samples, contextText, maxN = 3) {
  const pool = (Array.isArray(samples) ? samples : []).filter((s) => typeof s === 'string' && s.trim())
  if (pool.length <= maxN) return pool
  const ctx = String(contextText || '').trim()
  if (!ctx) return pool.slice(0, maxN)
  const scored = pool.map((s, i) => ({ s, i, score: bigramDice(s, ctx) }))
  scored.sort((x, y) => (y.score - x.score) || (x.i - y.i))
  const top = scored.slice(0, maxN)
  top.sort((x, y) => (x.score - y.score) || (x.i - y.i))
  return top.map((x) => x.s)
}

// 功能6：防原文输出——正文与文风范例(samples)连续逐字重合≥minLen 视为泄漏（借鉴 ex-skill「存指纹非原文」）
export function verbatimLeakScan(text, samples, minLen = 30) {
  const t = String(text || '')
  const list = (Array.isArray(samples) ? samples : []).filter((s) => typeof s === 'string' && s.length >= minLen)
  const leaks = []
  for (const s of list) {
    const common = longestCommonSubstring(t, s)
    if (common && common.length >= minLen) leaks.push({ len: common.length, sample: common.slice(0, 50) })
  }
  return leaks
}

// 功能7：破折号计数（inkflow 代码层审计：每章≤max，超出视为 AI 味结构）
export function dashScan(text, max = 4) {
  const n = (String(text || '').match(/——/g) || []).length
  return { count: n, max, over: n > max }
}

// 功能7：代码层审计（零 Token）——聚合 AI味/重复/原文泄漏/破折号，pass=false 时触发 LLM 重写
// ---------- P0-2 分层硬门：三项客观穿帮检测（对话动词/真相泄漏/残留 run-on）----------
// 证据锚：audit_style.py 对 fenghuo(《剑来》) 把「人名+说」式对话动词列为硬 FAIL（剑来全书几乎为 0，用「道」体系）；
// 真相泄漏对应本项目「圣经真相隔离」（truths[].truth 永不进写作上下文，只露 clues）；run-on 对应 §1 门槛 #5（无标点长串=0）。
// 三项都是「客观可判定、低误报」的穿帮，故纳入 codeLayerAudit.pass（供 P1-2 离线脚本硬判）；
// live 生成路仍保持非阻塞（至多触发 1 次定向重写 + 告警），与 app 既有 try/catch 失败不阻塞 一致。

// 对话动词扫描：检「X说：/X地说：」式扁平归因（AI 高频 tell）。剑来用「道」体系，说道/问道/答道不算穿帮。
// severe=生成端容忍阈：剑来 shuo≈0，但 temp0.9 下 1~2 处视为噪声仅报告，≥severe(默认3) 才判穿帮 over=true。
export function dialogueVerbScan(text, opts = {}) {
  const t = String(text || '')
  const severe = opts.severe != null ? opts.severe : 3
  const shuoRe = /[\u4e00-\u9fa5]{1,3}地?说[：:，,]?\s*[\u201C"\u300C]/g
  const daoRe = /[\u4e00-\u9fa5]{0,4}道[：:，,]?\s*[\u201C"\u300C]/g
  const shuoSamples = t.match(shuoRe) || []
  const daoCount = (t.match(daoRe) || []).length
  return { shuoCount: shuoSamples.length, shuoSamples: [...new Set(shuoSamples)].slice(0, 8), daoCount, over: shuoSamples.length >= severe }
}

// 真相泄漏扫描：正文与「sealed 终极真相」连续逐字重合 ≥minLen 视为提前剧透（复用 longestCommonSubstring，与 verbatimLeakScan 同源）。
export function truthLeakScan(text, lockedTruths, minLen = 15) {
  const t = String(text || '')
  const list = (Array.isArray(lockedTruths) ? lockedTruths : []).map((s) => String(s || '')).filter((s) => s.length >= minLen)
  const leaks = []
  for (const truth of list) {
    const common = longestCommonSubstring(t, truth)
    if (common && common.length >= minLen) leaks.push({ len: common.length, truth: common.slice(0, 40) })
  }
  return leaks
}

// ---------- 细纲越界监管（改造前为零：truthLeakScan / codeLayerAudit / reviewTruths 只作用于章节正文与审核输入，从不扫细纲） ----------
// 纯函数、零 AI 调用，复用 longestCommonSubstring 的连续重合判定（与 truthLeakScan / verbatimLeakScan 同源口径）。
// 返回 { blocked, warnings }，每项 { kind, hit, evidence }：
//   · blocked —— 封存真相（终极真相 + 地图分层真相）连续重合 ≥15 字：这是「真相隔离」的红线，写作上下文永远拿不到，细纲也不得写进去 → 拒绝入库、报错给「重新生成」；
//   · warnings —— 未登场势力 / 未解锁地图层 / 抢收本卷禁回收伏笔 / 越界消耗后续章任务 / 提前引爆跨卷里程碑：
//     这些可能是合理的提前铺垫（传闻级提及），交作者判断 → UI 黄条列出命中项并提供「仍要采用」（与项目既有「只报警不阻断」风格一致）。
export function outlineLeakScan(text, ctx = {}) {
  const t = String(text || '')
  const blocked = []
  const warnings = []
  if (!t.trim()) return { blocked, warnings }
  const arr = (x) => (Array.isArray(x) ? x : [])
  // 命中证据：把命中串前后各 10 字带上，作者能直接看出是哪一句越界
  const around = (needle) => {
    const i = t.indexOf(needle)
    if (i < 0) return needle
    const from = Math.max(0, i - 10)
    const to = Math.min(t.length, i + needle.length + 10)
    return `${from > 0 ? '…' : ''}${t.slice(from, to)}${to < t.length ? '…' : ''}`
  }
  // 通用虚词过滤：6 字门槛下「他第一次意识到」这类叙事套话会误报，
  // 命中串若全由常见虚词与叙事常用字组成就跳过（只降噪声，不影响专名与动词短语命中）。
  const GENERIC_CHARS = '的一是了在不有人我他她它们这那就都而也还和与对到说从被把为着很更最只又再才已将要会能可且但如若因所此其之上下中前后里外来过地去时个们自己什么怎第一二三四五六七八九十'
  const isGeneric = (s) => [...s].every((ch) => GENERIC_CHARS.includes(ch))
  const fieldOf = (raw) => String(typeof raw === 'string' ? raw : (raw?.truth || raw?.content || raw?.task || raw?.name || '')).trim()

  // ① 封存真相（红线）：lockedTruths 可直接传 reviewTruths(project) 的 {kind, truth} 数组，也可传纯字符串数组
  for (const raw of arr(ctx.lockedTruths)) {
    const truth = fieldOf(raw)
    if (truth.length < 15) continue
    const common = longestCommonSubstring(t, truth)
    if (!common || common.length < 15) continue
    const kind = raw && typeof raw === 'object' && raw.kind ? `真相泄漏·${raw.kind}` : '终极真相泄漏'
    blocked.push({ kind, hit: common.slice(0, 30), evidence: `与封存真相连续重合 ${common.length} 字（${around(common.slice(0, 12))}）` })
  }
  // ② 未登场势力 / 未解锁地图层：专名短（圣经登记的 name），直接包含匹配
  const nameCheck = (list, kind) => {
    for (const raw of arr(list)) {
      const name = fieldOf(raw)
      if (name.length < 2 || name.length > 20) continue
      if (t.includes(name)) warnings.push({ kind, hit: name, evidence: around(name) })
    }
  }
  nameCheck(ctx.laterFactions, '未登场势力实质出场')
  nameCheck(ctx.laterMapLayers, '未解锁地图层')
  // ③ 长句类（伏笔内容 / 后续章任务 / 跨卷里程碑）：整句包含几乎不可能命中，改用连续重合阈值
  const phraseCheck = (list, kind, minLen) => {
    for (const raw of arr(list)) {
      const s = fieldOf(raw)
      if (s.length < minLen) continue
      const common = longestCommonSubstring(t, s)
      if (!common || common.length < minLen || isGeneric(common)) continue
      warnings.push({ kind, hit: common.slice(0, 30), evidence: `与「${s.slice(0, 24)}${s.length > 24 ? '…' : ''}」连续重合 ${common.length} 字（${around(common.slice(0, 10))}）` })
    }
  }
  phraseCheck(ctx.bannedForeshadows, '抢收本卷禁回收伏笔', 12)
  phraseCheck(ctx.laterTasks, '越界消耗后续章任务', 6)
  phraseCheck(ctx.laterMilestones, '提前引爆跨卷里程碑', 6)
  return { blocked, warnings }
}

// 主线里程碑句（本卷之后）：project.synopsis（成书时来自 Step2 全书梗概的 mainline）按句切，
// 取「章号锚点落在本卷结束之后」的句子。无章号锚点的句子一律不收：无法判定归属，
// 且「大结局形态」那类句子往往正好无锚点，收进来就是剧透到终局。
export function laterMilestonesFor(project, chapterNo, volEnd = Infinity) {
  const text = String(project?.synopsis || '')
  if (!text.trim() || !Number.isFinite(volEnd)) return []
  const out = []
  for (const sentRaw of text.split(/[。；;！!？?\n]/)) {
    const sent = sentRaw.trim()
    if (sent.length < 8) continue
    const re = /第\s*([0-9〇零一二三四五六七八九十百两]+)\s*章/g
    let m
    let later = false
    while ((m = re.exec(sent)) !== null) {
      const no = cnToNumber(m[1])
      if (Number.isFinite(no) && no > volEnd) { later = true; break }
    }
    if (later) out.push(sent.slice(0, 120))
  }
  return out
}

// 本卷相关主线切片（逐章详纲生成端用）：只给「章号锚点落在本卷区间内」的里程碑句，上限 maxChars。
// 全书梗概全文是主要剧透源（含大结局形态与后续卷里程碑），逐章细化时只喂本卷这一段，从源头堵剧透。
// 未建卷档案时降级为取开头 maxChars（开局状态不是剧透）；本卷无锚定里程碑时返回空串（详纲仍有本卷故事与卷战略可依）。
export function mainlineSliceFor(project, chapterNo, maxChars = 600) {
  const text = String(project?.synopsis || '')
  if (!text.trim()) return ''
  const vol = currentVolume(project, chapterNo)
  if (!vol) return text.length > maxChars ? text.slice(0, maxChars) + '…' : text
  const from = vol.startChapter || 1
  const to = vol.length ? from + vol.length - 1 : Infinity
  const keep = []
  for (const sentRaw of text.split(/[。；;！!？?\n]/)) {
    const sent = sentRaw.trim()
    if (!sent) continue
    const re = /第\s*([0-9〇零一二三四五六七八九十百两]+)\s*章/g
    let m
    let anchors = 0
    let inVol = false
    while ((m = re.exec(sent)) !== null) {
      const no = cnToNumber(m[1])
      if (!Number.isFinite(no)) continue
      anchors++
      if (no >= from && no <= to) inVol = true
    }
    if (anchors && !inVol) continue // 有锚点但全在本卷外 → 后续卷里程碑，不得注入
    if (!anchors) continue // 无锚点无法判定归属，一律不收
    keep.push(sent)
  }
  const out = keep.join('。')
  return out.length > maxChars ? out.slice(0, maxChars) + '…' : out
}

// 组装 outlineLeakScan 的比对基准（三处挂接点共用，避免每处各拼一遍导致口径漂移）：
//   · laterTasks：本章之后 taskWindow 章的骨架 task（只作为止步边界参照，越界消耗即报警）
//   · lockedTruths：reviewTruths 里揭示红线仍在本章之后的真相；已过红线的不再比对（终卷该揭示时不该拦）
//   · bannedForeshadows：本卷 forbiddenForeshadowIds 对应的伏笔内容（只许铺垫、不许抢收）
//   · laterFactions / laterMapLayers：圣经里 unlockVolume 大于本卷的势力与地图层（未到登场卷只能传闻级露出）
//   · laterMilestones：全书主线里章号锚点落在本卷之后的里程碑句
export function outlineLeakContextFor(project, chapterNo, opts = {}) {
  const proj = project || {}
  const taskWindow = opts.taskWindow != null ? opts.taskWindow : 10
  const vol = currentVolume(proj, chapterNo)
  const volEnd = vol ? (vol.length ? vol.startChapter + vol.length - 1 : Infinity) : Infinity
  const volNo = vol ? Number(vol.volumeNo) || 1 : 1
  const laterTasks = (Array.isArray(proj.chapterSkeleton) ? proj.chapterSkeleton : [])
    .filter((s) => s && Number(s.chapterNo) > chapterNo)
    .slice(0, taskWindow)
    .map((s) => String(s.task || '').trim())
    .filter(Boolean)
  const lockedTruths = reviewTruths(proj).filter((x) => !x.minResolveChapter || x.minResolveChapter > chapterNo)
  const bannedIds = new Set((vol && vol.forbiddenForeshadowIds) || [])
  const bannedForeshadows = (proj.foreshadows || []).filter((f) => f && f.content && bannedIds.has(f.id)).map((f) => String(f.content))
  const laterFactions = (proj.bible?.factions || []).filter((f) => f && f.name && Number(f.unlockVolume) > volNo).map((f) => String(f.name))
  const laterMapLayers = (proj.bible?.mapLayers || []).filter((m) => m && m.name && Number(m.unlockVolume) > volNo).map((m) => String(m.name))
  return { laterTasks, lockedTruths, bannedForeshadows, laterFactions, laterMapLayers, laterMilestones: laterMilestonesFor(proj, chapterNo, volEnd) }
}

// 残留 run-on 扫描：相邻标点/空白之间、归一化长度 ≥minLen 且完全无标点的连续串（§1 #5 口径，同 _style_metrics.mjs runOnSegments 定义）。
export function runOnResidualScan(text, minLen = 60) {
  const raw = String(text || '')
  const isBreak = (ch) => /[。！？；…，、：,.!?;:\s"'‘’“”「」『』()（）《》【】\u2014\-]/.test(ch)
  const segs = []
  let i = 0
  while (i < raw.length) {
    if (isBreak(raw[i])) { i++; continue }
    let j = i
    while (j < raw.length && !isBreak(raw[j])) j++
    const seg = raw.slice(i, j)
    if (normalizeForDedup(seg).length >= minLen) segs.push({ len: seg.length, text: seg })
    i = j
  }
  return { count: segs.length, maxLen: segs.length ? Math.max(...segs.map((s) => s.len)) : 0, segments: segs.slice(0, 5) }
}

// ---------- P1-1R 文风量化指纹蒸馏（stylometry）：每本书蒸馏自己的多维文体指纹，取代硬编码《剑来》统计区间 ----------
// 背景：旧 styleBandScan 把《剑来》全文统计区间写死（句长28-60、问号15-50/万字…），换一本书即误报，已移除；
//   但 dashScan(max=4)/dialogueVerbScan(severe=3)/runOnResidualScan(minLen=60) 的阈值仍是写死的「剑来口味」。
// 本组函数把「量化层」做成蒸馏增强：从任意书的采样蒸馏多维指纹分布 → 推导本书专属阈值 → Z-score 漂移门。
// 借鉴：文体计量学 Burrows' Delta（z-score 标准化，stylo/TextDescriptives）、Mosteller-Wallace 功能词指纹（《联邦党人文集》作者归属同源思路，中文用高频虚词）。
// 全部纯前端、零 Token、确定性；与 dashScan/dialogueVerbScan/runOnResidualScan 完全同口径。

// 中文高频虚词（功能词）——作者指纹里最稳定的维度（实词随题材变，虚词频率是个人习惯）
export const STYLE_FUNC_WORDS = ['的', '了', '着', '是', '在', '而', '却', '便', '都', '就', '也', '还', '把', '被', '让', '向', '从', '到']
// 参与指纹聚合的数值维度（computeStyleMetrics 的键子集，排除 chars 这类规模量）
export const STYLE_METRIC_KEYS = ['sentMean', 'sentStd', 'longPct', 'paraMedian', 'ultrashortPct', 'comma', 'exclaim', 'question', 'ellipsis', 'emdash', 'shuoRatio', 'daoRatio', 'runOnMax', 'funcWordRatio']
// 各维度中文名（供 UI 漂移面板展示，与 STYLE_METRIC_KEYS 一一对应，单一事实源）
export const STYLE_METRIC_LABELS = { sentMean: '平均句长', sentStd: '句长波动', longPct: '长句占比', paraMedian: '段落中位长', ultrashortPct: '超短段占比', comma: '逗号密度', exclaim: '叹号密度', question: '问号密度', ellipsis: '省略号密度', emdash: '破折号密度', shuoRatio: '「说」引导密度', daoRatio: '「道」引导密度', runOnMax: '最长无停顿串', funcWordRatio: '虚词占比' }

// 单份文本的多维文体计量（点值）。空/纯空白安全返回全零，绝不抛异常。
export function computeStyleMetrics(text) {
  const raw = String(text || '')
  const chars = raw.replace(/\s/g, '').length
  if (!chars) return { chars: 0, sentMean: 0, sentStd: 0, longPct: 0, paraMedian: 0, ultrashortPct: 0, comma: 0, exclaim: 0, question: 0, ellipsis: 0, emdash: 0, shuoRatio: 0, daoRatio: 0, runOnMax: 0, funcWordRatio: 0 }
  const perWan = (n) => +((n / chars) * 10000).toFixed(1)
  // 句：按 。！？… 切（同 runOnResidualScan/audit_style.py 口径，不含分号），剔过短/过长噪声
  const slens = raw.split(/[。！？…]+/).map((s) => s.replace(/\s/g, '')).filter((s) => s.length > 2 && s.length < 500).map((s) => s.length)
  const sentMean = slens.length ? +(slens.reduce((a, b) => a + b, 0) / slens.length).toFixed(1) : 0
  const sentStd = slens.length > 1 ? +Math.sqrt(slens.reduce((a, b) => a + (b - sentMean) * (b - sentMean), 0) / slens.length).toFixed(1) : 0
  const longPct = slens.length ? +((slens.filter((x) => x >= 40).length / slens.length) * 100).toFixed(1) : 0
  // 段：按行切，非空且 >1 字
  const paras = raw.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 1)
  const plens = paras.map((p) => p.length).sort((a, b) => a - b)
  const paraMedian = plens.length ? plens[Math.floor(plens.length / 2)] : 0
  const ultrashortPct = paras.length ? +((paras.filter((p) => p.length <= 15).length / paras.length) * 100).toFixed(1) : 0
  // 最长无标点连续串（run-on 强度）：同 runOnResidualScan 断句口径，单遍扫描（不用 spread，避免长文本大数组栈溢出）
  const isBreak = (ch) => /[。！？；…，、：,.!?;:\s"'‘’“”「」『』()（）《》【】\u2014\-]/.test(ch)
  let runOnMax = 0, run = 0
  for (const ch of raw) { if (isBreak(ch)) { if (run > runOnMax) runOnMax = run; run = 0 } else run++ }
  if (run > runOnMax) runOnMax = run
  // 对话动词：复用 dialogueVerbScan（「X说：」扁平归因）+「道」体系计数，归一化为每万字
  const dv = dialogueVerbScan(raw)
  const daoN = (raw.match(/[\u4e00-\u9fa5]{0,4}道[：:，,]?\s*[\u201C"\u300C]/g) || []).length
  // 功能词比率：虚词出现次数占总字数百分比
  const funcN = STYLE_FUNC_WORDS.reduce((a, w) => a + raw.split(w).length - 1, 0)
  return {
    chars, sentMean, sentStd, longPct, paraMedian, ultrashortPct,
    comma: perWan((raw.match(/[，、]/g) || []).length),
    exclaim: perWan((raw.match(/！/g) || []).length),
    question: perWan((raw.match(/？/g) || []).length),
    ellipsis: perWan((raw.match(/……/g) || []).length),
    emdash: perWan((raw.match(/——/g) || []).length),
    shuoRatio: perWan(dv.shuoCount), daoRatio: perWan(daoN),
    runOnMax, funcWordRatio: +((funcN / chars) * 100).toFixed(2),
  }
}

// 指纹 → 本书专属扫描阈值（取代写死的 4/3/60）。metrics 为空时逐项回退保守默认（≈旧剑来口径，零回归）。
export function metricsToThresholds(metrics) {
  const g = (k) => (metrics && metrics[k] && typeof metrics[k].mean === 'number' ? metrics[k].mean : null)
  const emdash = g('emdash'), shuo = g('shuoRatio'), runOn = g('runOnMax')
  // 破折号：每万字密度 → 每章（≈2000 字）容忍上限 ×1.5 冗余，下限 2（原著几乎不用则收紧）；无指纹回退 4
  const dashMax = emdash != null ? Math.max(2, Math.round((emdash / 10000) * 2000 * 1.5)) : 4
  // 对话动词「说」：原著密度高→放宽（通俗对话流），低→收紧到 3（剑来式「道」体系）；无指纹回退 3
  const dialogueSevere = shuo != null ? (shuo > 20 ? 8 : shuo > 5 ? 5 : 3) : 3
  // run-on 门槛：原著最长无标点串 ×1.3 + 10 冗余（长句多的书放宽、不误伤正当长句），下限 40（对齐 no-runon 规则「相邻标点≤40字」）；无指纹回退 60
  const runOnMinLen = runOn != null ? Math.max(40, Math.round(runOn * 1.3) + 10) : 60
  return { dashMax, dialogueSevere, runOnMinLen }
}

// 蒸馏增强入口：把采样切窗逐窗算指纹，聚合每维 {mean,std}（Burrows' Delta 需分布而非点值），并推导 thresholds。
// 返回 { reliable, windowCount, chars, metrics:{key:{mean,std}}, thresholds }。窗口不足（短文本）→ 整体点值、std=0、reliable=false。
export function distillStyleBand(sampleText, opts = {}) {
  const raw = String(sampleText || '')
  const winSize = opts.windowSize || 1200
  const minChars = opts.minChars != null ? opts.minChars : 400
  const totalChars = raw.replace(/\s/g, '').length
  if (!totalChars) return { reliable: false, windowCount: 0, chars: 0, metrics: {}, thresholds: metricsToThresholds(null) }
  // 按段落累积切窗（不切碎句子）
  const paras = raw.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 1)
  const windows = []
  let buf = ''
  for (const p of paras) {
    buf += (buf ? '\n' : '') + p
    if (buf.replace(/\s/g, '').length >= winSize) { windows.push(buf); buf = '' }
  }
  if (buf.replace(/\s/g, '').length >= minChars) windows.push(buf)
  // 窗口 ≥2 才有窗间方差；否则退化为整体单点（std=0，styleDriftScan 走相对偏差兜底）
  const perWin = windows.length >= 2 ? windows.map((w) => computeStyleMetrics(w)) : [computeStyleMetrics(raw)]
  const metrics = {}
  for (const k of STYLE_METRIC_KEYS) {
    const vals = perWin.map((m) => (typeof m[k] === 'number' ? m[k] : 0))
    const mean = +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)
    const std = vals.length > 1 ? +Math.sqrt(vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vals.length).toFixed(2) : 0
    metrics[k] = { mean, std }
  }
  const reliable = totalChars >= 1500 && windows.length >= 2
  return { reliable, windowCount: windows.length, chars: totalChars, metrics, thresholds: metricsToThresholds(metrics) }
}

// Z-score 文风漂移门：草稿指纹对本书档案指纹逐维算标准分 z=(v-mean)/std；|z|>k 判漂移。
// std≈0（单点指纹）时退化为相对偏差 |v-mean|/max(mean,1)>relTol。返回 { drifts, maxAbsZ, drifted, reliable, skipped }，只报警不阻断。
export function styleDriftScan(draft, band, opts = {}) {
  const k = opts.k != null ? opts.k : 2.5
  const relTol = opts.relTol != null ? opts.relTol : 0.6
  const stdFloor = opts.stdFloor != null ? opts.stdFloor : 1e-6
  const skip = { drifts: [], maxAbsZ: 0, drifted: false, reliable: false, skipped: true }
  if (!band || !band.metrics || !Object.keys(band.metrics).length) return skip
  const dm = computeStyleMetrics(draft)
  if (!dm.chars) return skip
  const drifts = []
  let maxAbsZ = 0
  for (const key of Object.keys(band.metrics)) {
    const ref = band.metrics[key]
    if (!ref || typeof ref.mean !== 'number') continue
    const v = typeof dm[key] === 'number' ? dm[key] : 0
    let z
    if (ref.std > stdFloor) z = (v - ref.mean) / ref.std
    else { const rel = Math.abs(v - ref.mean) / Math.max(Math.abs(ref.mean), 1); z = rel > relTol ? (v > ref.mean ? 1 : -1) * (k + rel) : 0 }
    const absZ = Math.abs(z)
    if (absZ > maxAbsZ) maxAbsZ = absZ
    if (absZ > k) drifts.push({ key, z: +z.toFixed(2), val: v, mean: ref.mean, std: +ref.std.toFixed(2) })
  }
  drifts.sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
  // band 可能是 distillStyleBand 原始输出（.reliable）或已入库/已解析的档案（.bandReliable），两者都兼容
  return { drifts, maxAbsZ: +maxAbsZ.toFixed(2), drifted: drifts.length > 0, reliable: !!(band.reliable != null ? band.reliable : band.bandReliable), skipped: false }
}

export function codeLayerAudit(text, samples, opts = {}) {
  // thresholds：从绑定文风档案蒸馏出的「本书专属阈值」；缺省则各扫描器回退写死默认（零回归）
  const th = (opts.thresholds && typeof opts.thresholds === 'object') ? opts.thresholds : {}
  const flavorThreshold = opts.flavorThreshold != null ? opts.flavorThreshold : 3
  const flavorHits = aiFlavorScan(text, opts.forbidden || [])
  const repeats = findRepeatedPhrases(text || '')
  const leaks = verbatimLeakScan(text, samples)
  const dash = dashScan(text, th.dashMax != null ? th.dashMax : 4)
  const flavorCount = flavorHits.reduce((a, h) => a + (h.count || 0), 0)
  // P0-2 分层硬门扩项：对话动词穿帮 / 真相泄漏 / 残留 run-on（客观低误报，纳入 pass 供离线脚本硬判；live 路仍非阻塞）
  const dialogueVerb = dialogueVerbScan(text, opts.dialogueVerb || (th.dialogueSevere != null ? { severe: th.dialogueSevere } : {}))
  const truthLeak = truthLeakScan(text, opts.lockedTruths || [], opts.truthMinLen != null ? opts.truthMinLen : 15)
  const runOn = runOnResidualScan(text, opts.runOnMinLen != null ? opts.runOnMinLen : (th.runOnMinLen != null ? th.runOnMinLen : 60))
  const pass = flavorCount < flavorThreshold && repeats.length === 0 && leaks.length === 0 && !dash.over &&
    !dialogueVerb.over && truthLeak.length === 0 && runOn.count === 0
  // ---------- 机制三：continuity-editor 式 5 类客观错误硬门控（verdict 由代码按 blocker 数量硬算，不由 LLM 裁量）----------
  // 加法式：以下检测器仅在 opts 显式提供对应上下文（characters/prevText/powerRules/paraMaxLen）时激活；
  // 不提供则 blockers/findings 为空、ok=true、verdict='pass'，且既有 pass 语义一字不改（gate.test.js 零回归）。
  const blockers = []
  const findings = []
  if (Array.isArray(opts.characters) && opts.characters.length) {
    // 类①连续性矛盾 / 类⑤物理不可能：死者/哑巴开口（机制一 uid 状态位）
    for (const b of speakerStateScan(text, opts.characters, opts.speaker || {}).blockers) blockers.push(b)
    // 类⑤物理不可能：伤势部位矛盾（机制二 facts/mutableInjuries）
    for (const b of injuryContradictionScan(text, { characters: opts.characters, facts: opts.facts, chapterNo: opts.chapterNo }).blockers) blockers.push(b)
  }
  if (Array.isArray(opts.powerRules) && opts.powerRules.length) {
    // 类②设定违背：金手指规则触发无后果（机制二 powerRules 受控字段）
    for (const b of powerRuleAudit(text, opts.powerRules).blockers) blockers.push(b)
  }
  if (typeof opts.prevText === 'string' && opts.prevText) {
    // 类①连续性矛盾：跨章 verbatim 复读（机制三，把 dedupeChapterTail 升级为跨章逐字比对）
    for (const b of crossChapterDupScan(text, opts.prevText, opts.crossChapter || {}).blockers) blockers.push(b)
  }
  if (opts.paraMaxLen != null) {
    // run-on 巨段（机制三，finding 非 blocker：强制提示分段，不阻断）
    for (const f of runOnParagraphScan(text, { maxLen: opts.paraMaxLen }).findings) findings.push(f)
  }
  const review = assembleReview({ blockers, findings })
  return {
    dashes: dash.count, dashOver: dash.over, flavorHits, flavorCount, repeats, leaks, dialogueVerb, truthLeak, runOn, pass,
    // 机制三新增（既有字段全保留）：ok/verdict 为连贯性硬门信号，与 pass（文风质量门）分属两套判据
    blockers, findings, ok: review.ok, verdict: review.verdict,
  }
}

// 机制三：连贯性硬门编排入口（供入库前预检）——用项目上下文（人物 uid 状态位 / facts / 上一章正文 / bible.powerRules）
// 跑 codeLayerAudit 的 5 类客观错误门控，返回 assembleReview 结果 {ok, verdict, blockers, findings}。
// UI/编排层在 applyReport 前调用：verdict==='fail' → 把 blockers 作为字段级 fix list 交 ChapterRewriter 定点重写，而非直接入库。
export function continuityGate(project, chapterNo, text, opts = {}) {
  const proj = project || {}
  const chars = ensureCharacterUids(proj.characters || [])
  const chapters = Array.isArray(proj.chapters) ? proj.chapters : []
  const no = Number(chapterNo) || 0
  const prev = chapters
    .filter((c) => c && Number(c.chapterNo) < no)
    .sort((a, b) => Number(b.chapterNo) - Number(a.chapterNo))[0]
  const powerRules = proj.bible && Array.isArray(proj.bible.powerRules) ? proj.bible.powerRules : []
  const audit = codeLayerAudit(text, [], {
    characters: chars,
    facts: Array.isArray(proj.facts) ? proj.facts : [],
    chapterNo: no,
    powerRules,
    prevText: prev && typeof prev.content === 'string' ? prev.content : '',
    paraMaxLen: opts.paraMaxLen != null ? opts.paraMaxLen : 1200,
    crossChapter: opts.crossChapter || {},
  })
  const blockers = [...audit.blockers]
  const findings = [...audit.findings]
  // P0 角色知识状态门：非知情人泄露秘密（加法式——project.bible.secrets 存在才激活，否则零回归）
  for (const b of knowerGate(text, { secrets: assembleSecrets(proj), characters: chars, chapterNo: no }).blockers) blockers.push(b)
  // P1 世界一致性门：缺席门（blocker）+ 时序门/外貌一致性（finding，只报警不阻断）
  const wg = worldGateAll(proj, no, text)
  for (const b of wg.blockers) blockers.push(b)
  for (const w of wg.warnings) findings.push({ severity: 'finding', ...w })
  // P0+ 角色声音门：台词串味 / 自称漂移（blocker）+ 仿拟语境降级（finding）——characters[].voice 登记了才激活，否则零回归
  const vg = voiceGate(text, { voices: assembleVoices(proj), characters: chars, chapterNo: no })
  for (const b of vg.blockers) blockers.push(b)
  for (const w of vg.warnings) findings.push({ severity: 'finding', ...w })
  // #3 平台合规叠加扫描：仅在 project.compliancePlatform 选定平台时激活（加法式，未选零回归）；市场规则 + 内容红线只报警不阻断
  if (proj.compliancePlatform) {
    for (const f of complianceScan(text, { platform: proj.compliancePlatform, chapterNo: no }).findings) findings.push({ ...f, severity: 'finding', kind: f.rule })
  }
  return assembleReview({ blockers, findings })
}

// ===== Round-4 新增（P0）：标点归一化 pass + 残留重复定向修复（纯函数，app 两路径与探针同源、可单测）=====

// P0-1 标点归一化：治「大段无标点 run-on」（§3.2 文风度根因）。
// 只处理病态片段——相邻标点/空白之间、归一化长度 ≥ minRunOn 且【完全无标点】的连续串，
// 在从句边界词（转折/因果/承接/时间副词等多字词）前补「，」，把一口气堆砌的长串切成可读小句。
// 保守护栏：①只碰无标点长串（已有任何标点的正常文本一字不改）；②切出的前后小句各 ≥ minClause 字才插；
// ③单片段插入 ≤ maxInserts；④幂等（插入后即含逗号，再跑不再命中）。绝不改字/改剧情，只增逗号。
export function normalizeRunOnPunctuation(text, opts = {}) {
  const minRunOn = opts.minRunOn ?? 40
  const minClause = opts.minClause ?? 6
  const maxInserts = opts.maxInserts ?? 8
  const raw = String(text || '')
  if (!raw.trim()) return { text: raw, inserted: 0, flagged: false }
  // 断点字符：任何标点/空白/引号/括号都算「已有断点」，只在完全无断点的超长串内插逗号
  const isBreak = (ch) => /[。！？；…，、：,.!?;:\s「」『』“”‘’（）()《》【】\u2014\-]/.test(ch)
  // 从句边界词（新小句常以这些多字词起头）；按长词优先排序，避免长词被短词截断；不含单字副词（就/才/而/却）以免误切
  const BOUNDARY = /(话音刚落|话音落下|接下来|紧接着|不多时|但是|然而|可是|不过|于是|所以|因此|因为|由于|如果|假如|虽然|尽管|然后|接着|随后|继而|同时|另外|此外|而且|并且|或者|以及|直到|直至|终于|渐渐|逐渐|慢慢|忽然|突然|这时|此时|此刻|说完|说罢|言罢|转而|随即|旋即|随之)/g
  let out = ''
  let inserted = 0
  let i = 0
  const n = raw.length
  while (i < n) {
    if (isBreak(raw[i])) { out += raw[i]; i++; continue }
    let j = i
    while (j < n && !isBreak(raw[j])) j++
    const seg = raw.slice(i, j)
    i = j
    if (normalizeForDedup(seg).length < minRunOn) { out += seg; continue }
    const marks = []
    BOUNDARY.lastIndex = 0
    let m
    while ((m = BOUNDARY.exec(seg)) !== null) {
      if (m.index > 0) marks.push(m.index)
      if (marks.length >= maxInserts * 4) break
    }
    if (!marks.length) { out += seg; continue }
    let built = ''
    let prev = 0
    let lastCut = 0
    let cnt = 0
    for (const pos of marks) {
      if (cnt >= maxInserts) break
      const beforeLen = normalizeForDedup(seg.slice(lastCut, pos)).length
      const afterLen = normalizeForDedup(seg.slice(pos)).length
      if (beforeLen < minClause || afterLen < minClause) continue
      built += seg.slice(prev, pos) + '，'
      prev = pos
      lastCut = pos
      cnt++
    }
    built += seg.slice(prev)
    out += built
    inserted += cnt
  }
  return { text: out, inserted, flagged: inserted > 0 }
}

// P0-2 残留重复定向修复：把「二次自检对长章返回整章 revisedText 被 0.7 地板拒绝」的两难（§3.1），
// 换成「只回传命中片段的最小改写」并确定性安全套用——不需整章重写，长章也能落地。
// fixes: [{ find, replace }]。护栏：①find 必须在文中逐字存在（取最后一次出现，保留最早那处）；
// ②replace 不得比 find 长太多（≤2×+10，防幻觉膨胀）；③replace 为空白=删除，仅当 find 归一化 ≥ minDelete 字才允许（防删碎）；
// ④每条最多套一次。只动命中片段，其余一字不改。
export function applyRepeatFixes(text, fixes, opts = {}) {
  const raw = String(text || '')
  const list = Array.isArray(fixes) ? fixes : []
  if (!raw.trim() || !list.length) return { text: raw, applied: 0, skipped: 0 }
  const minDelete = opts.minDelete ?? 8
  let out = raw
  let applied = 0
  let skipped = 0
  for (const f of list) {
    const find = String((f && f.find) || '')
    const replace = String((f && f.replace) || '')
    if (!find.trim()) { skipped++; continue }
    if (replace.length > find.length * 2 + 10) { skipped++; continue }
    if (!replace.trim() && normalizeForDedup(find).length < minDelete) { skipped++; continue }
    const idx = out.lastIndexOf(find)
    if (idx < 0) { skipped++; continue }
    out = out.slice(0, idx) + replace + out.slice(idx + find.length)
    applied++
  }
  return { text: out, applied, skipped }
}
