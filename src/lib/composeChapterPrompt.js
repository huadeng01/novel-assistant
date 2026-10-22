import { LANG_RULE, sanitizeHabits } from './prompts.js'
import { isSectionHead, chapLineNo, normName } from './parseAssets.js'
import { stateToPromptLine, normalizeState, perVolOf, revealChapterOf } from './assets.js'
import { paraBandFor, avgParaLenFor } from './worldviews/index.js'
import { volNoOfCell, volOfChapter } from './longformPlan.js'

// 长篇工作台与新手向导共用的提示词构造器。全部是纯函数：输入数据、输出提示词字符串，不碰 React 与存储。

// 设定扩充：基于故事框架与已建档名册，批量补充次要人物/地点/道具/势力，让资产表更丰富。
export const expandPrompt = (book) => {
  const namesOf = (t) => ((book && book.assets) || []).filter((a) => a.type === t).map((a) => a.name).join('、') || '(无)'
  return [
    '你是设定扩充编辑。基于下面的故事框架与已建档名册，批量补充次要资产，让资产表更丰富。每行用｜分隔字段，通篇用｜分列行呈现。',
    LANG_RULE,
    '硬约束：控制方/所属地域/持有者/出处指向已有实体时，从下面名册里选准确名字，名册外的一律填"无主"或"未知"；新势力先进【次要势力】段建档再引用。',
    '【次要人物】至少8至20个，每行：姓名｜身份一句｜与主线关系一句｜高光事件一句｜透出卷',
    '【地点】至少10至30个，每行：地点名｜所属地域(须是名册地点或框架地域)｜功能一句｜控制方(须是名册势力/人物或"无主")｜透出卷',
    '【道具】至少5至15个，每行：道具名｜持有者(须是名册人物或"无主")｜功能一句｜出处(须是名册地点)｜透出卷',
    '【次要势力】3-8方，每行：势力名｜立场+资源｜与主角关系｜功能位｜透出卷',
    '只输出以上四段｜分列行。',
    '',
    '故事框架(创作简报)：',
    (book && book.brief) || '(无)',
    '',
    '已建档人物名册：',
    namesOf('person'),
    '',
    '已建档势力名册：',
    namesOf('faction'),
    '',
    '已建档地点名册：',
    namesOf('place'),
    '',
    '已建档道具名册：',
    namesOf('item'),
  ].join('\n')
}

// 关系网绑定：只在已建档名册的名字之间建关系边，名册外的名字不建边。
export const relationPrompt = (book) =>
  [
    '你是关系网编辑。下面名册是本书已建档的全部资产名字。关系边只建立在名册名字之间，名册外的名字留在名册之外。',
    '每行一条边：资产A名｜关系｜资产B名。关系用中文词：持有/位于/隶属/控制/受控于/出处/盟友/敌对/亲属/对手/关联/统领。',
    '产出人物间关系边(盟友/敌对/亲属/对手)至少10条，并补全明显缺失的人物-道具/人物-地点/势力-地点绑定边。',
    '只输出边行。',
    '',
    '资产名册：',
    ((book && book.assets) || []).map((a) => `${a.name}(${a.type})`).join('、'),
  ].join('\n')

// 原文分析：读一段原文，对照名册产出「已有资产更新」与「新资产」两组｜分列行，供落库预览。
export const analyzePrompt = (book, chapterNo, sourceText) =>
  [
    '你是设定分析编辑。读下面的原文片段，对照已建档资产名册，产出两类信息。每行用｜分隔，通篇用｜分列行呈现。',
    LANG_RULE,
    '【已有资产更新】原文里已建档资产的新信息或状态变化，每行：资产名(须用名册准确名字)｜更新内容一句｜新状态(活跃/死亡/毁坏/隐藏/升迁)',
    '【新资产】原文里出现但未建档的人物/地点/道具/势力，每行：类型(person/place/item/faction)｜名字｜描述一句｜透出章',
    '只输出以上两段｜分列行；某段没有内容时，段下写"无"。',
    '',
    `本章章号：${chapterNo}`,
    '',
    '已建档资产名册：',
    ((book && book.assets) || []).map((a) => `${a.name}(${a.type})`).join('、') || '(无)',
    '',
    '原文：',
    sourceText,
  ].join('\n')

// 续排下一卷时遵守的排章纪律，第 7/8 步与长篇页续排共用同一份，避免多处漂移
const NEXT_VOL_RULES = [
  '回溯锚：本章首次透出的资产，其透出卷早于或等于本卷；透出卷晚于本卷的资产以传闻出现，或留到其透出卷再登场。',
  '资产登场以资产表标明的透出卷为准，只排入透出卷早于或等于本卷的资产；不为凑数提前拉后面才透出的资产登场。',
  '每章任务各有分工；按事件密度排章；每章都推进主线、塑造人物、兑现爽点其中之一，只列有实际内容的章。',
]

// 从大纲里抽出指定卷的两段内容：【分卷结构表】的本卷行 + 【每卷事件节点】的本卷节点，作为续排的粗粒度依据。
// 段头判定走 parseAssets 的 isSectionHead 单一出处，兼容 AI 写「## 分卷结构表」这类不带【】的标题；
// 遇到任意其它段标题就关闭当前区块（通用标题检测，与具名段匹配语义不同，不用空段名写法）。
const outlineNodesOfVol = (outline, vol) => {
  const keep = []
  let inStruct = false
  let inNodes = false
  for (const raw of String(outline || '').split('\n')) {
    const l = raw.trim()
    if (isSectionHead(l, '分卷结构表')) { inStruct = true; inNodes = false; continue }
    if (isSectionHead(l, '每卷事件节点')) { inNodes = true; inStruct = false; continue }
    if (l.startsWith('【') || /^#{1,3} /.test(l)) { inStruct = false; inNodes = false; continue }
    if (!l) continue
    // 卷号列先归一再比对，兼容「第2卷｜…」「卷二｜…」「2｜…」等写法
    if (inStruct && volNoOfCell(l.split(/[｜|]/)[0]) === vol) keep.push(l)
    if (inNodes) {
      const dot = l.search(/[.．]/) // 事件节点行形如「卷序.节点序｜…」，取首个点前的卷序归一比对
      if (dot > 0 && volNoOfCell(l.slice(0, dot)) === vol) keep.push(l)
    }
  }
  return keep.join('\n')
}

// 卷章表的末 3 章，续排时用来承接结尾钩子与人物处境
const volumesTail3 = (volumes) =>
  String(volumes || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => chapLineNo(l) > 0) // 与详纲/续排卷号同一章号口径，「第N章」格式的书末 3 章不再恒空
    .slice(-3)
    .join('\n')

// 续排下一卷章表：从起始章起排指定卷，依据是本卷大纲节点 + 已建档资产清单 + 前卷末 3 章，并产出资产章号回填清单
export const nextVolumePrompt = (book, nextVol, startChapter) => {
  const perVol = perVolOf(book) // 每卷章数走 assets.js 单一出处，与图谱/资产库同源
  const assetList =
    ((book && book.assets) || []).map((a) => `${a.name}(${a.type})｜透出章${revealChapterOf(a, perVol) || '—'}`).join('\n') || '(无)'
  return [
    `你是分卷结构编辑。第1至${startChapter - 1}章已排定（卷一至卷${nextVol - 1}）。现在排第${nextVol}卷：从第${startChapter}章起至本卷末，并产出资产章号回填清单。`,
    LANG_RULE,
    `【第${nextVol}卷章节】逐章列出第${startChapter}章至本卷末章，每章一行：章号｜章名｜本章故事梗概(150至250字，讲完本章从开场到结尾钩子的完整故事；含对峙或谈判的章写清一轮来回台词谁对谁说了什么；梗概内一律用逗号句号，把｜分隔符留给字段之间)｜本章视角人物(写人物名)｜本章首次透出的资产(人物/地点/势力名)｜情绪节拍(主情绪+强度1-5+主爽点类型+触发事件)｜出场人物(用准确名字，逗号分隔)｜结尾钩子+类型。`,
    '【资产章号回填】把本卷新登场资产的透出卷/传闻卷细化为透出章/传闻章，每行：资产名｜透出章｜传闻章，本卷登场的资产一条不漏。',
    ...NEXT_VOL_RULES,
    '',
    `第${nextVol}卷大纲（分卷结构表本卷行 + 本卷事件节点）：`,
    outlineNodesOfVol(book && book.outline, nextVol) || '(大纲未找到本卷节点，按主线自由推进)',
    '',
    '已建档资产清单（名字｜类型｜透出章）：',
    assetList,
    '',
    '前卷末3章（承接结尾钩子与人物处境）：',
    volumesTail3(book && book.volumes) || '(无)',
  ].join('\n')
}

// 组装「写第 N 章正文」的完整提示词。输入全为数据（书、章节列表、章号、章纲行、资产三桶、本章摘要、目标字数、每卷章数），
// 输出一个字符串。内部依次做：上章末尾前情切段 → 本章节拍点名资产 → 名字容错匹配 → 资产现况行 →
// 传闻资产过滤 → 本场调度（地点/在场/人物位置）→ 段长带宽 → 章纲剥内部记号 → 伏笔筛选 → 文风档案与写作纪律拼装。
export const composeChapterPrompt = ({ book, chapters, chapterNo, chapterPlan, buckets, prevSummary, targetWords, perVol }) => {
  if (!book) return ''
  const prev = chapters.find((c) => c.no === chapterNo - 1)
  // 前情从段落边界切，避免半句开头误导衔接
  const tailCut = prev ? String(prev.text || '').slice(-800) : ''
  const prevTail = tailCut && tailCut.indexOf('\n') > 0 ? tailCut.slice(tailCut.indexOf('\n') + 1) : tailCut
  const beat = (book.beats || []).find((b) => b.chapter_no === chapterNo)
  // 章纲点名制：只注入本章章纲点名的资产，避免整卷资产堆进单章提示词；
  // 无章纲行时回退扫章纲原文；其余已透出资产仍属可用桶（防提前透出检查不变），只是不注入。
  const beatNames = beat
    ? [
        ...String(beat.reveal_assets || '').split(/[,，、/]/).map((s) => s.trim()).filter(Boolean),
        ...(beat.cast || []),
        ...(beat.pov ? [beat.pov] : []),
      ]
    : []
  // 名字匹配容错：去空格/书名号后双向包含即命中，避免 AI 在点名列表里加增饰或换分隔符就一个都匹配不上。
  // 归一函数用 parseAssets 的单一出处，与资产查名/重名分组同口径。
  const beatNamesNorm = beatNames.map(normName).filter(Boolean)
  const planText = String(chapterPlan || '')
  const matchBeat = (a) => {
    const an = normName(a.name)
    return !!an && beatNamesNorm.some((bn) => bn === an || bn.includes(an) || an.includes(bn))
  }
  let injectedAllow = buckets.allow.filter((a) => matchBeat(a) || (!beat && planText.includes(a.name)))
  // 有节拍但一个都没匹配上（名字漂移）时，退回「章纲原文出现资产名」判据，避免本章零资产可用只能凭空编
  if (!injectedAllow.length) injectedAllow = buckets.allow.filter((a) => a.name && planText.includes(a.name))
  // 详情截到 80 字内的最后一个完整字段边界，避免截出半截括号
  const cutDetail = (s) => {
    const t = String(s || '').slice(0, 80)
    if (String(s || '').length <= 80) return t
    const i = t.lastIndexOf('｜')
    return (i > 40 ? t.slice(0, i) : t) + '…'
  }
  // 本章点名资产在详情后拼一行口语化「现况」；只注入点名资产，传闻/未透出不注入（防剧透）。
  // 现况行只输出有值的维度、不出现字段名或英文枚举，空状态不拼。
  const allowText = injectedAllow
    .map((a) => {
      const base = `${a.name}(${a.type})：${cutDetail(a.detail)}`
      const st = stateToPromptLine(a)
      return st ? `${base}\n  ${st}` : base
    })
    .join('\n')
  // 传闻资产只注入本章章纲里实际出现的，避免整卷传闻名单堆进单章诱导加戏
  const injectedRumor = buckets.rumor.filter((a) => String(chapterPlan || '').includes(a.name))
  const rumorText = injectedRumor.map((a) => `${a.name}(仅传闻)`).join('\n')
  // 整章调度块：本章地点/在场人物/上一章末尾在场者，防人物瞬移与凭空出场
  const stagePlaces = injectedAllow.filter((a) => a.type === 'place').map((a) => a.name)
  const stageCast = [...new Set(injectedAllow.filter((a) => a.type === 'person' || a.type === 'group').map((a) => a.name))]
  const prevPresent = prevTail ? (book.assets || []).filter((a) => (a.type === 'person' || a.type === 'group') && prevTail.includes(a.name)).map((a) => a.name) : []
  // 人物现位置取自结构化状态里的地点字段，把「跨章连续：人物位置沿用」落到数据上。
  // 只查上一章在场的人物，避免对全表逐个归一。
  const assetByName = new Map((book.assets || []).map((a) => [a.name, a]))
  // 位置行只补「上一章在场、但点名资产现况行没覆盖」的人物——点名资产的现况行已渲染过位置，再渲染就是同一事实写两遍。
  const allowNames = new Set(injectedAllow.map((a) => a.name))
  const personLocs = [...new Set(prevPresent)]
    .filter((nm) => !allowNames.has(nm))
    .map((nm) => {
      const a = assetByName.get(nm)
      if (!a) return ''
      const st = a.state && a.state.v === 2 ? a.state : normalizeState(a.state)
      const pl = st.place
      if (!pl || !pl.ref) return ''
      // 只注入确定位置；移动中/失踪/推定的位置不写「在X」，宁缺勿错
      const tag = pl.tag || ''
      if (pl.inferred || (tag !== 'at' && tag !== '')) return ''
      return `${nm}在${pl.ref}`
    })
    .filter(Boolean)
  // 段长带宽来自世界观档单一出处：先按题材/绑定文风指纹推真实目标段长，再换算成上下沿带宽；
  // 无真值时自动回落默认档。
  const band = paraBandFor(avgParaLenFor(book))
  const planClean = String(chapterPlan || '')
    .replace(/｜\s*P\d+(?:\s*,\s*P\d+)*\s*(?=｜)/g, '')
    .replace(/\+(\d)\+/g, '，强度$1，')
  // 伏笔筛选两组：活跃伏笔 = 已埋设（埋设章≤本章）且回收卷未到或正在本卷；本卷应回收 = 回收卷等于当前卷。
  // 埋设章优先用回填的精确章号，否则按埋设卷换算；回收只有卷级信息，故「应回收」按当前卷判定。
  const fsList = (book && book.foreshadows) || []
  const curVol = volOfChapter(book && book.volumes, chapterNo, perVol) // 按卷章表实际卷定义定位，不用除法反推（各卷章数不等时错卷）
  const plantChOf = (f) => (f.plant_ch > 0 ? f.plant_ch : f.plant_volume > 0 ? (f.plant_volume - 1) * perVol + 1 : 0)
  const fsLine = (f) => `- ${f.title || '(无名)'}：${String(f.desc || '').slice(0, 60)}`
  const activeFs = fsList.filter((f) => {
    // 已回收/已撤稿的伏笔不再当活跃伏笔注入，否则回收后还提示「勿提前泄底」自相矛盾
    if (f.state === 'resolved' || f.state === 'superseded') return false
    const pc = plantChOf(f)
    const planted = pc > 0 ? pc <= chapterNo : f.plant_volume > 0 && f.plant_volume <= curVol
    const notPaid = f.payoff_volume > 0 ? curVol <= f.payoff_volume : true
    return planted && notPaid
  })
  const dueFs = activeFs.filter((f) => f.payoff_volume > 0 && curVol > 0 && f.payoff_volume === curVol)
  const dueLines = dueFs.slice(0, 5).map(fsLine)
  const activeLines = activeFs
    .filter((f) => !dueFs.includes(f))
    .slice(0, 8)
    .map(fsLine)
  const foreshadowBlock =
    dueLines.length || activeLines.length
      ? [
          '伏笔衔接：',
          dueLines.length ? `本卷应回收的伏笔(时机合适就在本章兑现，别拖过本卷)：\n${dueLines.join('\n')}` : '',
          activeLines.length ? `仍在埋设/延续中的活跃伏笔(可呼应、可加深，勿提前泄底)：\n${activeLines.join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      : ''
  return [
    `你是本书的执笔写手。写第${chapterNo}章正文。`,
    LANG_RULE,
    '本章章纲：',
    planClean || '(卷章表里没找到本章行，按主线自由推进一小步)',
    '本章点名资产：',
    allowText || '(无)',
    '本章仅传闻资产：',
    rumorText || '(无)',
    '上一章末尾(前情)：',
    prevTail || '(首章无)',
    '本场调度：',
    `本章地点：${stagePlaces.join('、') || '(章纲场景内)'}`,
    `本章在场人物：${stageCast.join('、') || '(无)'}`,
    `上一章末尾在场：${prevPresent.join('、') || '(首章无)'}`,
    `人物当前位置(据资产状态，跨章沿用、勿瞬移)：${personLocs.join('、') || '(未记录)'}`,
    '本章摘要：',
    prevSummary || '(无)',
    '本章节拍：',
    beat ? `主情绪与爽点：${beat.mood_raw || ''}｜视角人物 ${beat.pov || ''}` : '(无)',
    ...(foreshadowBlock ? [foreshadowBlock] : []),
    '文风档案：',
    // 档案是 AI 产物，可能自带否定句；注入前把「禁绝…」换成正向陈述
    String(book.styleProfile || '').replace(/禁绝[^。；\n]*说法/g, '叙述与对白的说法一律长在本书世界观里') || '(无)',
    '文风习惯(照着这几条落笔)：',
    sanitizeHabits(book.styleHabits || []).habits.slice(0, 3).join('\n') || '(无)',
    '文风范例(真书摘录：学句长、分段、对话与描写的度；范例的单句段密度高于本书目标，只学句长不学断段；范例里的人物地名情节器物留在范例内；范例里的比喻密度是原书特例，正文一个场景至多一个)：',
    (book.styleSamples || []).slice(0, 2).join('\n---\n') || '(无)',
    '',
    '写作纪律：只写章纲与可用资产支撑的内容；素材不足以支撑目标字数时写短、写实；设定/人物/场景一律取自素材；只写已透出的资产；章纲台词事件展开成的来回对话属章纲支撑范围。',
    '呈现方式：世界观与设定通过人物行动、对话与后果带出；叙述者讲课式的整段设定说明整段删除。',
    '跨章连续：上一章已写的人物位置、生死、去向本章沿用；改写须有当章动作支撑；章纲没写的冲突留到下一章。',
    '场景描写：环境与感官描写只作当下的一两句即时反应，一段写完即回到人物行动。',
    `目标字数：${targetWords}字。`,
    '',
    '落笔上限：单句独立成段尽量少用，能合并进邻段就合并，一个场景至多一个比喻；单句成段每章至多五处，只留给点睛收束。',
    `段落节奏：每段写到约${band.minPara}~${band.maxPara}字再断行（本书目标段长约${band.target}字${band.defaulted ? '，未配题材档、用默认档' : ''}）；既不通篇单句成段，也不整屏不断行。`,
    // 对话要求由代码判断：章纲含对峙/谈判词，或章纲里出现两个以上已建档人物名（不依赖章表出场列，旧书该列可能是编号）
    /对峙|谈判|叫阵|质问|讨价|劝降|审问/.test(String(chapterPlan || '')) ||
    ((book.assets || []).filter((a) => (a.type === 'person' || a.type === 'group') && String(chapterPlan || '').includes(a.name)).length >= 2)
      ? '对话：本章含对峙或多人在场场景，把章纲里的台词事件展开成来回对话，轮数按章纲台词事件自然展开、至少一轮一问一答，带潜台词与分寸。'
      : '对话：本章为独角戏或单人行动场景，对话可缺省，用动作与感官推进。',
    '输出前自查：数一遍单句成段与比喻，单句成段超过五处把多余的合并进邻段，比喻超过场景数删到每场景一个；再数来回对话，该有对话的场景补齐。',
    '直接输出本章正文，输出内容只有正文本身。',
  ].join('\n')
}
