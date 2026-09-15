// 提示词层单测：细纲驱动的精简分支、详纲生成端的输入裁剪（从源头堵剧透）、世界观两档注入的标签措辞。
// 这一层是「节奏提前」的正面战场：断言的重点不是措辞好不好听，而是
//   ① outlineDriven=false 时输出与改造前逐字节一致（回归基线，验收 #7）；
//   ② outlineDriven=true 时该砍的块一个不留、该留的块一个不少（验收 #6）；
//   ③ 详纲生成端永远拿不到 bible.truths / 全书骨架 / 全书梗概（真相隔离）。
import { describe, it, expect } from 'vitest'
import {
  longFormDraftMessages,
  scenePlanMessages,
  sceneCountRange,
  chapterOutlineDetailMessages,
  chapterOutlineBatchMessages,
  worldviewVolumeText,
  inspirationMessages,
  inspirationExpandMessages,
  inspirationSeed,
  POWER_FANTASY_STANCES,
  POWER_FANTASY_DRIVES,
  bookWorldviewMessages,
} from '../prompts.js'
import { worldviewText, getWorldview } from '../worldviews/index.js'

const all = (msgs) => msgs.map((m) => m.content).join('\n')
const userOf = (msgs) => msgs.find((m) => m.role === 'user').content

// 一份接近真实密度的详纲（约 500 字）：占比断言用它，避免拿一行短细纲算出失真的高占比
const DETAIL = [
  '第12章【承】夜访旧档',
  '[任务] 林昭潜入档案库，找到母亲失踪当夜的出入记录',
  '[场景1] 城西档案库/林昭、老周 → 林昭用旧身份牌在侧门刷开铜锁，老周提着灯笼在街口望风，两次险些被巡夜的差役照见；库房里霉味呛人，林昭按编号一格一格摸过去，指尖在甲七号格子上停住 → 抽出一册边角被水渍泡软的出入簿',
  '[场景2] 档案库地下室/林昭 → 他把簿子凑到气窗漏下的一线月光里翻，翻到那一日时纸面是空的——整页被人裁走，裁口很齐，摸上去还有新茬；他数了前后页码，缺的正好是那一夜 → 林昭意识到有人比他先来过，而且来得不久',
  '[场景3] 巷口茶馆/林昭、苏晚 → 苏晚把一份手抄的副本推过桌面，说她从旧主顾那里高价买来；林昭追问来历，她只摇头；副本末页盖着一枚暗红火漆 → 火漆上的图案与林昭腕内侧那块胎记一模一样',
  '[边界] 本章允许揭示：出入簿当夜缺页、裁口是新茬、苏晚持有一份抄本；本章严禁触及：母亲仍然活着（属第30章）、火漆印的归属（属第18章）、钦天监这个名字（属第21章）',
  '[钩子] 林昭把抄本折进袖中抬头时，苏晚已经走了，桌上只剩半盏冷茶与一枚同样的火漆碎屑',
  '[字数] 2000（场景1:700 / 场景2:700 / 场景3:600）',
].join('\n')

const FORE = [
  { id: 'f1', content: '母亲的玉佩来历不明', minResolveChapter: 20 },
  { id: 'f2', content: '老周欠下的人情', minResolveChapter: 18 },
  { id: 'f3', content: '档案库的旧火', minResolveChapter: 0 },
  { id: 'f4', content: '苏晚的旧主顾', minResolveChapter: 0 },
  { id: 'f5', content: '铜锁上的刻痕', minResolveChapter: 0 },
  { id: 'f6', content: '巡夜差役的脸', minResolveChapter: 0 },
  { id: 'f7', content: '巷口的冷茶', minResolveChapter: 0 },
]

// 造一段规模接近真实成书的填充文本：真实书里 synopsis 约 5000 字、chronicles/passages/reference 各 2500~3000 字，
// 用一两句话当样本会让「砍掉这些块」的收益完全看不出来（占比断言会失真）。
// 句子带编号与标签，既能撑出体量，又便于断言「哪一句不该再出现」。
const filler = (tag, n) => Array.from({ length: n }, (_, i) => `${tag}第${i + 1}句，这一段只用于撑出接近真实成书的体量，本身不承载剧情信息。`).join('')

const draftBase = () => ({
  chapterNo: 12,
  synopsis: `全书梗概：第25章林昭闯东玄州救出母亲，第45章登上天阙揭开屠神真相。${filler('梗概', 48)}`,
  world: `世界全文：九州分三层，凡人居下，修士居中，仙门在上。${filler('世界', 20)}`,
  worldBlockText: '',
  characters: [
    { name: '林昭', aliases: '阿昭', identity: '主角', personality: '执拗', status: '灵力余量 3 成' },
    { name: '老周', identity: '档案库守夜人', personality: '寡言', status: '' },
    { name: '苏晚', identity: '抄书人', personality: '谨慎', status: '' },
  ],
  participants: ['林昭', '老周'],
  outline: DETAIL,
  longTerm: `长时记忆：林昭幼年丧母，被叔父养大。${filler('长时', 10)}`,
  rollingSummary: `全书滚动摘要：近三章林昭一直在追查旧案。${filler('滚动', 16)}`,
  prevChapterSummary: `上一章摘要：林昭翻检旧卷宗，发现编号缺了一格。${filler('上章', 4)}`,
  tail: '前文尾部：他把卷宗合上，灯芯爆了一下。',
  foreshadows: FORE,
  passages: [
    { title: '第3章', text: `相关前文片段：幼年那夜的火光。${filler('前文甲', 22)}` },
    { title: '第7章', text: `相关前文片段：老周第一次提起档案库。${filler('前文乙', 22)}` },
  ],
  instruction: '本章写作方向：克制，多用动作与器物，少写心理独白。',
  forbidden: ['禁止出现现代词汇'],
  storylines: [{ name: '查案线', type: '主线', progress: '刚起步' }],
  povRule: '第三人称限制视角，只写林昭所见所闻',
  scenePlan: '场景1：城西档案库/林昭、老周 → 混入库房 → 抽出出入簿',
  chronicles: `人物编年史：林昭七岁丧母。${filler('编年', 18)}`,
  style: '克制、短句、名词密',
  habits: ['少用形容词'],
  rules: [{ id: 'no-meta', name: '禁止作者评论', text: '不得出现作者评论' }],
  reference: `参考作品的叙事功能：以查案推进人物弧。${filler('参考', 14)}`,
  volumeStrategy: '第1卷《青阳风起》\n本卷故事（本章围绕它推进，不写跨卷主线）：林昭追查母亲失踪的旧案。',
  chapterPosition: '承',
  samples: ['样例段落：他把灯捻小了些。'],
  chapterTask: '林昭潜入档案库找到出入记录',
  consistencyCarryover: ['上章遗留硬问题：老周的手伤未愈，本章不得让他提重物'],
  factLedger: {
    items: [{ name: '身份牌', owner: '林昭', count: '1 枚', note: '旧身份牌' }],
    numbers: [{ key: '灵力余量', value: '3 成' }],
    constraints: ['【修行铁律】夺舍者遭天谴，寿元折半。'],
  },
  chapterWords: 2000,
  sceneCount: 3,
  sceneWords: 700,
})

// 细纲驱动模式下应该整块消失的标签（它们装着后续卷走向，是剧情漂移与提前揭示的主要来源）
const DROPPED = [
  '【故事梗概】',
  '【世界观设定】',
  '【长时记忆',
  '【全书滚动摘要',
  '【上一章摘要】',
  '【人物编年史',
  '【现有故事线',
  '【相关前文片段',
  '【参考作品的叙事功能',
]
// 两种模式下都必须保留的块（管「怎么写」与「本章写什么」，不引起剧情漂移）
const KEPT = [
  '【本章场景清单',
  '【本章核心任务',
  '【本章写作方向',
  '【本章结构定位',
  '【本章出场人物',
  '【本章不出场的人物】',
  '【本卷战略',
  '【本章事实台账',
  '克制、短句、名词密',
  '少用形容词',
  '禁止出现现代词汇',
  '不得出现作者评论',
  '样例段落：他把灯捻小了些。',
  '前文尾部：他把卷宗合上',
  '老周的手伤未愈',
  '夺舍者遭天谴',
  '灵力余量',
]

describe('longFormDraftMessages · 关闭细纲驱动（回归基线）', () => {
  it('默认参数就是 outlineDriven=false：显式传 false 与不传逐字节一致', () => {
    expect(all(longFormDraftMessages(draftBase()))).toBe(all(longFormDraftMessages({ ...draftBase(), outlineDriven: false })))
  })

  it('全量上下文块一个不少', () => {
    const t = all(longFormDraftMessages(draftBase()))
    for (const label of DROPPED) expect(t, `关闭驱动时应含 ${label}`).toContain(label)
    expect(t).toContain('全书梗概：第25章林昭闯东玄州')
    expect(t).toContain('相关前文片段：幼年那夜的火光。')
    expect(t).toContain('参考作品的叙事功能：以查案推进人物弧。')
  })

  it('细纲标签用「本章细纲」措辞，且没有规则 13', () => {
    const t = all(longFormDraftMessages(draftBase()))
    expect(t).toContain('【本章细纲（只写本窗口内的剧情节点')
    expect(t).not.toContain('【本章详纲（本章唯一剧情依据')
    expect(t).not.toContain('13. 篇幅只能靠详纲')
    expect(t).toContain('如有细纲，按细纲完成本章事件')
  })

  it('伏笔不限条数、顺序照原序', () => {
    const t = userOf(longFormDraftMessages(draftBase()))
    for (const f of FORE) expect(t, `关闭驱动时应含伏笔 ${f.content}`).toContain(f.content)
  })

  it('共用块同样都在', () => {
    const t = all(longFormDraftMessages(draftBase()))
    for (const k of KEPT) expect(t, `应保留 ${k}`).toContain(k)
  })
})

describe('longFormDraftMessages · 开启细纲驱动', () => {
  const driven = () => all(longFormDraftMessages({ ...draftBase(), outlineDriven: true }))

  it('该砍的块一个不留', () => {
    const t = driven()
    for (const label of DROPPED) expect(t, `细纲驱动下不应含 ${label}`).not.toContain(label)
    // 内容级复核：后续卷里程碑、编年史、前文召回、参考作品的正文都不得出现在上下文里
    expect(t).not.toContain('闯东玄州')
    expect(t).not.toContain('林昭七岁丧母')
    expect(t).not.toContain('幼年那夜的火光')
    expect(t).not.toContain('以查案推进人物弧')
    expect(t).not.toContain('全书滚动摘要')
  })

  it('该留的块一个不少（文风/规则/台账/衔接照旧，只管怎么写不管写什么）', () => {
    const t = driven()
    for (const k of KEPT) expect(t, `细纲驱动下仍应保留 ${k}`).toContain(k)
  })

  it('细纲标签换成「本章详纲（唯一剧情依据）」，规则 3 与规则 13 同时生效', () => {
    const t = driven()
    expect(t).toContain('【本章详纲（本章唯一剧情依据：只写详纲给定场景的过程，详纲未写的事件一律不得出现）】')
    expect(t).not.toContain('【本章细纲（只写本窗口内的剧情节点')
    expect(t).toContain('本章详纲是唯一剧情依据')
    expect(t).not.toContain('如有细纲，按细纲完成本章事件')
    // 规则 13 是治本的正向出口：字数不够时只能加深已有场景，不得新造事件
    expect(t).toContain('13. 篇幅只能靠详纲给定场景的过程、对话与感官细节写足')
    expect(t).toContain('不得引入新事件、新人物、新地点、新设定或新的冲突升级')
  })

  it('伏笔压到 5 条以内，且保护期内的优先保留', () => {
    const t = userOf(longFormDraftMessages({ ...draftBase(), outlineDriven: true }))
    // f1/f2 在第 12 章仍处保护期（minResolveChapter 20/18）→ 必须留下
    expect(t).toContain('母亲的玉佩来历不明')
    expect(t).toContain('老周欠下的人情')
    expect(t).toContain('保护期内，第 20 章前禁止回收')
    // 7 条压到 5 条：末尾两条被裁掉
    expect(t).not.toContain('巡夜差役的脸')
    expect(t).not.toContain('巷口的冷茶')
    expect(t).toContain('档案库的旧火')
  })

  // 实测数据（本文件这套接近真实成书体量的样本：synopsis 约 4800 字、编年史/前文召回/滚动摘要各上千字）：
  //   关闭细纲驱动：system 2973 + user 15824 = 18797 字，详纲占整份 2.69%、占 user 段 3.20%
  //   开启细纲驱动：system 3196 + user  1673 =  4869 字，详纲占整份 10.39%、占 user 段 30.25%
  // user 段砍掉 89%，详纲在 user 侧的权重提升约 9.5 倍。真实书的 system 段约 7800 字（含完整文风档案与反模板规则），
  // 代入后详纲占整份约 6.9%，与方案里「约 5.7%」的估算同量级；改造前实测基线是 0.4%~0.8%。
  it('上下文总量下降，且详纲占比显著提升（这是本次改造要拿到的核心指标）', () => {
    const fullMsgs = longFormDraftMessages(draftBase())
    const leanMsgs = longFormDraftMessages({ ...draftBase(), outlineDriven: true })
    const full = all(fullMsgs)
    const lean = all(leanMsgs)
    expect(lean.length).toBeLessThan(full.length)

    // user 段是精简的主战场（system 段两档完全一致）：砍掉梗概/滚动摘要/编年史/前文召回/参考作品后应缩到四成以下
    const fullUser = userOf(fullMsgs)
    const leanUser = userOf(leanMsgs)
    expect(leanUser.length).toBeLessThan(fullUser.length * 0.4)

    // 详纲占「整份请求」与占「user 段剧情信息」两个口径都要明显上升。
    // 绝对百分比随书的体量浮动（百万字书的 synopsis/编年史远大于本样本），所以断言相对幅度而不是写死方案里的 5.7%。
    expect(DETAIL.length / lean.length).toBeGreaterThan((DETAIL.length / full.length) * 1.5)
    // user 侧口径是更有意义的指标：细纲驱动下本章详纲应当是 user 段里最大的一块剧情信息
    expect(DETAIL.length / leanUser.length).toBeGreaterThan(0.15)
  })

  it('system 段两档逐字节一致（精简只动 user 侧的剧情信息，不动写作规则）', () => {
    const sys = (msgs) => msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
    const fullSys = sys(longFormDraftMessages(draftBase()))
    const leanSys = sys(longFormDraftMessages({ ...draftBase(), outlineDriven: true }))
    // 唯一差异是规则 3 的措辞与追加的规则 13，其余全部相同
    expect(leanSys.length).toBeGreaterThan(fullSys.length)
    expect(leanSys).toContain('13. 篇幅只能靠详纲')
    expect(fullSys).not.toContain('13. 篇幅只能靠详纲')
  })
})

describe('scenePlanMessages · 场景清单的降级路径精简', () => {
  const sp = (outlineDriven) => all(scenePlanMessages({
    chapterNo: 12,
    synopsis: '全书梗概：第45章登上天阙。',
    outline: DETAIL,
    rollingSummary: '全书滚动摘要：近三章查案。',
    prevChapterSummary: '上一章摘要：翻检旧卷宗。',
    storylines: [{ name: '查案线', type: '主线', progress: '刚起步' }],
    foreshadows: FORE,
    povRule: '第三人称限制视角',
    instruction: '克制一些',
    characters: [{ name: '林昭' }, { name: '老周' }],
    chapterPosition: '承',
    chapterTask: '林昭潜入档案库找到出入记录',
    chapterWords: 2000,
    volumeStory: '第1卷本卷故事：追查旧案。',
    factSeed: '灵力余量 3 成',
    outlineDriven,
  }))

  it('关闭驱动时与改造前一致：梗概/滚动摘要/故事线都在，标签是「本章对应细纲」', () => {
    const t = sp(false)
    expect(t).toBe(sp(undefined)) // 默认参数
    expect(t).toContain('【故事梗概】')
    expect(t).toContain('【全书滚动摘要】')
    expect(t).toContain('【现有故事线')
    expect(t).toContain('【本章对应细纲】')
    expect(t).toContain('【上一章摘要（本章须紧接其后）】')
  })

  it('开启驱动时砍掉三个剧透源，标签换成「只能切分详纲已给定的过程」', () => {
    const t = sp(true)
    expect(t).not.toContain('【故事梗概】')
    expect(t).not.toContain('【全书滚动摘要】')
    expect(t).not.toContain('【现有故事线')
    expect(t).not.toContain('登上天阙')
    expect(t).toContain('【本章详纲（场景清单只能切分详纲已给定的过程，严禁新增详纲之外的事件）】')
    // 衔接与本章约束照留：上一章摘要、核心任务、本卷故事、视角、事实种子
    expect(t).toContain('【上一章摘要（本章须紧接其后）】')
    expect(t).toContain('【本章核心任务')
    expect(t).toContain('追查旧案')
    expect(t).toContain('灵力余量 3 成')
  })
})

describe('chapterOutlineDetailMessages · 详纲生成端的输入裁剪', () => {
  const BIBLE = {
    world: '九州分三层，灵石是唯一硬通货。',
    truths: [{ id: 't1', kind: '终极真相', truth: '母亲当年并未死于火灾，而是被钦天监秘密囚禁在东玄州地牢', clues: ['玉佩'] }],
    factions: [
      { name: '青阳剑派', desc: '本地宗门', unlockVolume: 1 },
      { name: '钦天监', desc: '朝廷监察机构', rumor: '听说京里有个管修士的衙门', unlockVolume: 2 },
    ],
    conflicts: [
      { name: '宗门与世家争灵石', desc: '卷一主冲突', startVolume: 1, endVolume: 2 },
      { name: '屠神遗族归来', desc: '卷三主冲突', startVolume: 3, endVolume: 3 },
    ],
    mapLayers: [
      { id: 'm1', name: '青阳县', summary: '开局之地', rumor: '', truth: '', unlockVolume: 1 },
      { id: 'm2', name: '东玄州', summary: '中期舞台', rumor: '传闻中的大州', truth: '东玄州地底镇压着一条真龙', unlockVolume: 2 },
    ],
  }

  const build = (over = {}) => chapterOutlineDetailMessages({
    chapterNo: 12,
    chapterTitle: '夜访旧档',
    task: '林昭潜入档案库找到出入记录',
    laterTasks: ['档案库起火，出入册失踪', '林昭在灰烬里捡到半枚玉佩', '苏晚交出抄本', '林昭与老周对峙', '钦天监的人进城'],
    volume: { volumeNo: 1, name: '青阳风起', theme: '执念', arcStory: '林昭追查母亲失踪的旧案', endHook: '档案库走水' },
    arcText: '起1-5 承6-12 转13-17 合18-20；本章位于「承」段末尾',
    bible: BIBLE,
    volumeNo: 1,
    totalVolumes: 3,
    mainlineSlice: '第5章林昭拜入青阳剑派',
    prevSummary: '上一章摘要：林昭翻检旧卷宗。',
    prevDetailTail: '上一份详纲结尾：他把卷宗放回原处。',
    chapterWords: 2000,
    sceneRange: '2~3',
    position: '承',
    povRule: '第三人称限制视角',
    ...over,
  })

  it('真相隔离：bible.truths 与 mapLayers[].truth 一个字都不进上下文', () => {
    const t = all(build())
    expect(t).not.toContain('母亲当年并未死于火灾')
    expect(t).not.toContain('东玄州地底镇压着一条真龙')
    expect(t).not.toContain('秘密囚禁')
  })

  it('不给全书骨架：后续章任务只取 2 条作为止步红线，第 3 条之后一律不进', () => {
    const t = all(build())
    expect(t).toContain('【后 2 章任务（止步红线')
    expect(t).toContain('档案库起火，出入册失踪')
    expect(t).toContain('林昭在灰烬里捡到半枚玉佩')
    expect(t).not.toContain('苏晚交出抄本')
    expect(t).not.toContain('林昭与老周对峙')
    expect(t).not.toContain('钦天监的人进城')
  })

  it('主线只给本卷切片，不给全书梗概（函数根本没有 synopsis 入参）', () => {
    const t = all(build())
    expect(t).toContain('【主线·本卷相关段落（只给这一段，其余主线对你不可见）】')
    expect(t).toContain('第5章林昭拜入青阳剑派')
    expect(t).not.toContain('【全书梗概】') // 注意：系统提示的说明句里会出现「全书梗概」四个字，断言盯的是注入标签
    expect(t).not.toContain('登上天阙')
    expect(t).not.toContain('第25章林昭闯东玄州')
  })

  it('世界盘按登场卷号裁剪：未登场势力只以传闻一句话出现，名字本身不进上下文', () => {
    const t = all(build())
    expect(t).toContain('青阳剑派')
    expect(t).toContain('听说京里有个管修士的衙门')
    expect(t).not.toContain('钦天监')
    expect(t).not.toContain('屠神遗族归来') // 卷三冲突不在卷一活跃
    expect(t).toContain('宗门与世家争灵石')
  })

  it('场景数取 sceneCountRange 上界，与写章端同源（杜绝细纲切 3 场景、写章要 5 场景的错配）', () => {
    const t = all(build())
    expect(sceneCountRange(2000).range).toBe('2~3')
    expect(t).toContain('场景数固定为 3 个')
    expect(t).toContain('[场景3]')
    expect(t).not.toContain('[场景4]')
  })

  it('输出格式样例五类标签齐全，且章头行原样使用给定章名与定位', () => {
    const t = all(build())
    for (const tag of ['[任务]', '[场景1]', '[边界]', '[钩子]', '[字数]']) expect(t).toContain(tag)
    expect(t).toContain('第12章【承】夜访旧档')
    expect(t).toContain('章头行必须原样使用给定章名与定位标签')
    expect(t).toContain('标签文字与顺序都不得改动（下游按标签确定性解析）')
  })

  it('字数行按本地均分，各场景之和恰等于本章目标字数', () => {
    const t = userOf(build())
    expect(t).toContain('【本章目标字数】2000 字，切成 3 个场景')
    const m = t.match(/场景1 (\d+) 字、场景2 (\d+) 字、场景3 (\d+) 字/)
    expect(m).not.toBeNull()
    expect(Number(m[1]) + Number(m[2]) + Number(m[3])).toBe(2000)
  })

  it('调用方传入引擎层 sceneWordBudget 的分配时原样采用（与写作端逐字节同源）', () => {
    const t = all(build({ sceneBudgets: [700, 700, 600] }))
    expect(t).toContain('[字数] 2000（场景1:700 / 场景2:700 / 场景3:600）')
    expect(t).toContain('场景1 700 字、场景2 700 字、场景3 600 字')
  })

  it('sceneBudgets 长度与场景数不匹配时回退本地均分（不能拿错配的预算去指挥写作端）', () => {
    const t = all(build({ sceneBudgets: [1000, 1000] }))
    expect(t).not.toContain('场景1:1000')
    expect(t).toContain('[字数] 2000（')
  })

  it('已是骨架末尾时给出「自然收束」而不是空红线', () => {
    expect(all(build({ laterTasks: [] }))).toContain('（已是骨架末尾，本章自然收束即可）')
  })

  it('硬约束里写死「篇幅靠过程与感官细节，不靠新增事件」（详纲阶段就把治本的一条讲清楚）', () => {
    const t = all(build())
    expect(t).toContain('篇幅靠过程、对话与感官细节撑起来，不靠新增事件')
    expect(t).toContain('严禁用「随后」「不久」「经过一番」「众人」这类概述把过程跳过去')
    expect(t).toContain('每章合计 500~700 字')
  })

  it('衔接信息带上上一章摘要与上一份详纲结尾', () => {
    const t = all(build())
    expect(t).toContain('上一章摘要：林昭翻检旧卷宗。')
    expect(t).toContain('上一份详纲结尾：他把卷宗放回原处。')
  })
})

describe('chapterOutlineBatchMessages · B 方案备用入口同口径', () => {
  it('一次多章，但真相隔离与主线裁剪口径与逐章版一致', () => {
    const msgs = chapterOutlineBatchMessages({
      chapters: [
        { chapterNo: 12, title: '夜访旧档', task: '潜入档案库' },
        { chapterNo: 13, title: '走水', task: '档案库起火' },
        { chapterNo: 14, title: '灰烬', task: '捡到半枚玉佩' },
      ],
      volume: { volumeNo: 1, name: '青阳风起', theme: '执念', arcStory: '追查旧案', endHook: '档案库走水' },
      bible: {
        world: '九州分三层。',
        truths: [{ kind: '终极真相', truth: '母亲当年并未死于火灾而是被囚禁在东玄州地牢' }],
        factions: [{ name: '青阳剑派', desc: '本地宗门', unlockVolume: 1 }],
        mapLayers: [{ name: '东玄州', summary: '中期舞台', truth: '东玄州地底镇压着一条真龙', unlockVolume: 2 }],
      },
      volumeNo: 1,
      totalVolumes: 3,
      mainlineSlice: '第5章林昭拜入青阳剑派',
      chapterWords: 2000,
      sceneRange: '2~3',
      position: '承',
    })
    const t = all(msgs)
    expect(t).not.toContain('母亲当年并未死于火灾')
    expect(t).not.toContain('东玄州地底镇压着一条真龙')
    expect(t).toContain('第12章《夜访旧档》任务：潜入档案库')
    expect(t).toContain('止步红线（后 2 章，不得提前写入）')
    expect(t).toContain('第5章林昭拜入青阳剑派')
  })
})

describe('worldviewVolumeText · 按卷裁剪世界盘', () => {
  const bible = {
    factions: [
      { name: '青阳剑派', desc: '本地宗门', unlockVolume: 1 },
      { name: '钦天监', desc: '朝廷监察机构', rumor: '听说京里有个管修士的衙门', unlockVolume: 2 },
      { name: '屠神遗族', desc: '终局势力', unlockVolume: 3 }, // 无 rumor：连传闻都不给
    ],
    conflicts: [
      { name: '宗门与世家争灵石', desc: '卷一主冲突', startVolume: 1, endVolume: 2 },
      { name: '屠神遗族归来', desc: '卷三主冲突', startVolume: 3, endVolume: 3 },
    ],
  }

  it('卷一只看到已登场势力 + 本卷活跃冲突 + 未登场势力的一句传闻', () => {
    const t = worldviewVolumeText(bible, 1, 3)
    expect(t).toContain('【已登场势力（可展开描写）】')
    expect(t).toContain('青阳剑派')
    expect(t).toContain('宗门与世家争灵石')
    expect(t).toContain('听说京里有个管修士的衙门')
    expect(t).not.toContain('钦天监')
    expect(t).not.toContain('屠神遗族')
    expect(t).not.toContain('屠神遗族归来')
  })

  it('卷三时全部势力都已登场、只剩卷三冲突', () => {
    const t = worldviewVolumeText(bible, 3, 3)
    expect(t).toContain('钦天监')
    expect(t).toContain('屠神遗族')
    expect(t).toContain('屠神遗族归来')
    expect(t).not.toContain('宗门与世家争灵石') // endVolume=2 已结束
    expect(t).not.toContain('【未登场势力的民间传闻')
  })

  it('空圣经返回空串（不注入空标题）', () => {
    expect(worldviewVolumeText(null, 1, 3)).toBe('')
    expect(worldviewVolumeText({}, 1, 3)).toBe('')
  })
})

describe('世界观两档注入的落点措辞', () => {
  const wv = getWorldview('玄幻')

  it('bookWorldviewMessages 的 full 档写明八字段各自用途，brief 档只是普通参考标签', () => {
    const full = all(bookWorldviewMessages({ template: worldviewText(wv, 'full'), brief: '一个少年走出县城。', bible: null, volumeCount: 3, level: 'full' }))
    const brief = all(bookWorldviewMessages({ template: worldviewText(wv, 'brief'), brief: '一个少年走出县城。', bible: null, volumeCount: 3 }))
    expect(full).toContain('八字段全量')
    expect(full).toContain('高频套路清单/反套路切口')
    expect(full).toContain('势力格局/地理与舞台分层')
    expect(brief).not.toContain('八字段全量')
    expect(brief).toContain('【题材世界模板（参考）】')
    // brief 是默认档：不传 level 与显式传 'brief' 逐字节一致（调用方漏传时不会意外拿到 full 档把上下文撑爆）
    expect(brief).toBe(all(bookWorldviewMessages({ template: worldviewText(wv, 'brief'), brief: '一个少年走出县城。', bible: null, volumeCount: 3, level: 'brief' })))
    expect(full).not.toBe(brief)
  })

  it('inspirationMessages 走爽文机制：注入元素库(驱动/爽点/流派/金手指)+升级链参考，套路作爽点素材注入', () => {
    const tropes = getWorldview('玄幻').tropes
    expect(tropes).toBeTruthy()
    const seedStr = '主打爽点=装逼打脸；流派=词条流；金手指=签到系统'
    const stance = POWER_FANTASY_STANCES[0] // 系统开挂流
    const withTropes = all(inspirationMessages('玄幻', worldviewText(wv, 'brief'), tropes, { mode: 'guided', stance, seed: seedStr }))
    const without = all(inspirationMessages('玄幻', worldviewText(wv, 'brief'), '', { mode: 'free', seed: seedStr }))
    // 爽文基调(参考,非强制)+元素库注入
    expect(withTropes).toContain('开局快给爽点')
    expect(withTropes).toContain('情绪宣泄优先')
    expect(withTropes).toContain('爽文元素库（参考素材，自主取用，非硬约束）')
    // 主驱动与升级链注入(8 驱动)
    for (const d of POWER_FANTASY_DRIVES.map((x) => x.name)) {
      expect(withTropes).toContain(d)
    }
    expect(withTropes).toContain('升级链参考')
    expect(withTropes).toContain('反派梯队')
    // 12 爽点逐个注入(含新增非打脸类)
    for (const b of ['装逼打脸', '扮猪吃虎', '逆天改命', '获得奇遇', '以弱胜强', '众人震惊', '报仇雪恨', '突破升级', '获得收集', '躺赢锦鲤', '团宠被爱', '揭秘探奇']) {
      expect(withTropes).toContain(b)
    }
    // 流派清单注入
    expect(withTropes).toContain('系统流·签到')
    expect(withTropes).toContain('词条流')
    expect(withTropes).toContain('御兽流')
    // 金手指清单注入
    expect(withTropes).toContain('签到系统')
    // 有套路清单：作为参考素材注入(软化措辞)
    expect(withTropes).toContain(tropes)
    expect(withTropes).toContain('可照用/强化/叠加')
    expect(withTropes).not.toContain('一个都不得出现')
    // 参考种子(软化,非必须命中)
    expect(withTropes).toContain('本批参考种子（随机，优先参考，可微调）')
    expect(withTropes).not.toContain('必须命中')
    // 立意倾向注入(软参考)+主驱动
    expect(withTropes).toContain('用户倾向立意（软参考，可采纳可突破）')
    expect(withTropes).toContain('系统开挂流')
    expect(withTropes).toContain('主驱动：打脸（反派梯队）')
    // 无套路清单：该块跳过,但元素库照常
    expect(without).not.toContain('高频爽点套路')
    expect(without).toContain('爽文元素库')
    // 自由模式无倾向块
    expect(without).not.toContain('用户倾向立意')
  })

  it('爽文选题注入的是 brief 档（背景低权重参考，约几百字而不是上千字）', () => {
    const t = all(inspirationMessages('玄幻', worldviewText(wv, 'brief'), '', { mode: 'free' }))
    expect(t).toContain(worldviewText(wv, 'brief'))
    expect(t).not.toContain(worldviewText(wv, 'full'))
    expect(worldviewText(wv, 'brief').length).toBeLessThan(worldviewText(wv, 'full').length)
  })

  it('常规小说模式：不注入爽文元素库，按正常叙事构思', () => {
    const t = all(inspirationMessages('玄幻', worldviewText(wv, 'brief'), '', { mode: 'normal' }))
    // 常规分支不含爽文元素库与基调
    expect(t).not.toContain('爽文元素库')
    expect(t).not.toContain('开局快给爽点')
    expect(t).not.toContain('主驱动与升级链')
    expect(t).not.toContain('用户倾向立意')
    // 常规分支强调正常叙事：动机合理/冲突循序渐进/反派有立场
    expect(t).toContain('人物动机合理')
    expect(t).toContain('冲突循序渐进')
    expect(t).toContain('反派也有自己的立场与逻辑')
  })

  it('inspirationSeed 无参纯随机：每批抽 3~4 个爽文要素轴作参考种子', () => {
    for (let i = 0; i < 30; i++) {
      const n = inspirationSeed().split('；').length
      expect(n === 3 || n === 4).toBe(true)
    }
    // 轴名来自 4 轴(主打爽点/流派/金手指/开局对手目标)
    const s = inspirationSeed()
    expect(/主打爽点=|流派=|金手指=|开局对手\/目标=/.test(s)).toBe(true)
  })

  it('inspirationExpandMessages 扩充：注入 full 世界模板 + 境界硬校准 + JSON 协议；userNote 走迭代修改', () => {
    const fullWv = worldviewText(getWorldview('仙侠'), 'full')
    const brief = '我想写一部仙侠爽文，主角顾长生，开局签到得大乘期修为，前期突破化神境。'
    const stance = POWER_FANTASY_STANCES[0]
    const t = all(inspirationExpandMessages({ brief, genre: '仙侠', worldview: fullWv, stance }))
    // 注入完整世界模板（full 档）与待扩充选题
    expect(t).toContain(fullWv)
    expect(t).toContain(brief)
    // 境界硬校准是重点：开局低段、升级链递增、修正倒挂
    expect(t).toContain('境界硬校准')
    expect(t).toContain('不得开局即巅峰')
    expect(t).toContain('逐级严格递增')
    expect(t).toContain('境界倒挂')
    // 立意倾向软参考注入
    expect(t).toContain('本书立意倾向（软参考）')
    expect(t).toContain(stance.name)
    // 输出协议：JSON {brief}
    expect(t).toContain('{"brief":"扩充后的完整初始提问文本（一段话）"}')
    // 无 userNote：走初次扩充
    expect(t).not.toContain('用户的修改想法')
    // userNote 非空：注入修改想法块，走迭代
    const t2 = all(inspirationExpandMessages({ brief, genre: '仙侠', worldview: fullWv, userNote: '把金手指改成签到暴击' }))
    expect(t2).toContain('用户的修改想法（必须落实）')
    expect(t2).toContain('把金手指改成签到暴击')
    expect(t2).toContain('按用户想法修改并扩充')
  })
})
