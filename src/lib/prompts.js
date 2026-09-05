// 全部提示词模板：文风分析、改写润色（固定 JSON 协议）、新手写作四步、续写

// ---------- 文风分析 ----------
// 只提炼作者的写作习惯；"去除 AI 味"是 AI 自身的固有行为（见 NO_AI_FLAVOR_RULE），
// 不需要也不应该从用户自己的文章里检查 AI 味词汇。
const STYLE_SYSTEM = `你是一位资深小说编辑，擅长拆解作者的写作风格。
你将收到某本小说的多段采样文本（已覆盖全书的开头、中间与结尾），请深入、详尽地提炼作者的写作习惯：
常用句式与语法特征、叙事视角与人称、叙事节奏与分段习惯、对话风格（含提示语用法）、环境与心理描写偏好、用词与口语化程度、修辞与标点习惯。
另外从采样片段中挑出 3 段最能代表该作者笔触的原文段落原样留存（作为后续写作的模仿范例）。

严格按以下 JSON 格式输出，不要输出任何其他内容：
{"style_profile": "对作者写作习惯的完整描述，600~800 字，逐维度展开并给出采样片段中的具体依据", "habits": ["习惯1", "习惯2", "习惯3", "习惯4", "习惯5", "习惯6", "习惯7", "习惯8"], "samples": ["从采样片段中原样摘录的典型段落1（150~300字）", "原样摘录的典型段落2", "原样摘录的典型段落3"]}
samples 必须是给定采样片段里逐字存在的原文，不得改写、拼接或自创。`

export function styleAnalyzeMessages(samples) {
  const body = samples.map((s, i) => `【片段${i + 1}】\n${s}`).join('\n\n')
  return [
    { role: 'system', content: STYLE_SYSTEM },
    { role: 'user', content: `以下是这本小说的采样片段，请提炼写作习惯：\n\n${body}` },
  ]
}

// ---------- 模块一：改写润色 ----------
// "去除 AI 味"是 AI 自身的固有写作规则，固定注入所有 AI 成文（改写、章节初稿），
// 不依赖也不检查用户自己的文章。
export const NO_AI_FLAVOR_RULE = `【去除 AI 味】请像一位真实的作者一样自然书写，严禁使用"AI 腔"套路表达：
1. 禁用"宛如、仿佛画卷、空气仿佛凝固、嘴角勾起一抹弧度、眸光微闪、眼神闪过一丝、嘴角扬起、不禁、不由、瞬间、犹如、恰似、如诗如画、意味深长、眼底闪过、眸中闪过、心中暗想、心中五味杂陈"等空洞修饰；
2. 禁止形容词堆砌、"XX 的 XX"式排比、每句都叠加修饰语；
3. 用具体的动作、对话、细节和场景推进叙事，让读者自己感受情绪，而不是替读者总结感受；禁止用"他意识到/他明白了"式旁白直接陈述人物心理，用动作与对话呈现。`

// 文风档案 + 用户自定义禁用词 + 反模板感规则 + 文风范例（原文样本），拼进成文类提示词（四者可独立生效）
// 范例是 few-shot 层：模仿效果显著强于纯描述；样本在文风分析时从原书留存。
function styleBlockOf({ style, forbidden, rules, samples }) {
  let block = ''
  if (style) block += `\n\n【作者文风档案，行文必须贴合】\n${style}`
  if (samples && samples.length) block += `\n\n【文风范例（只模仿其笔触、节奏与语感，严禁照抄内容与人物）】\n` + samples.map((s) => `【范例】${s}`).join('\n')
  if (forbidden && forbidden.length) block += `\n\n【自定义禁用词，严禁出现】\n${forbidden.join('、')}`
  if (rules && rules.length) block += `\n\n【反模板感规则（逐条对照执行，写出人味）】\n${rules.map((r, i) => `${i + 1}. ${r.text}`).join('\n')}`
  return block
}

// 反模板感规则预设（写法引擎 v1）：专门消除 AI 网文的套路化表达，可逐条开关；
// 与 NO_AI_FLAVOR_RULE 分工：后者禁词表，这里禁结构与节奏层面的模板行为。全部默认开启。
export const TEMPLATE_RULES = [
  { id: 'no-recap', name: '禁止章末总结', text: '禁止在章节结尾总结本章主题、升华情感或替读者归纳“这一章说明了什么”，落在具体动作、对话或悬念上直接收束。' },
  { id: 'no-dialogue-tag', name: '压缩对话提示语', text: '对话提示语以“某某说”或直接省略为主，禁止连续使用“他认真地说/她轻声说/他严肃地说”等带副词的提示语。' },
  { id: 'no-transition', name: '禁止过渡句', text: '场景转换直接切到新场景的第一句，禁止“与此同时/另一边/时间很快过去了/转眼就到了”式过渡。' },
  { id: 'no-triad', name: '禁止三连排比', text: '禁止连续三个结构相同的短句或短语排比造势；禁止用排比句表达情绪高潮。' },
  { id: 'no-explainer', name: '设定不自问自答', text: '世界观与设定通过人物行动、对话与后果自然呈现，禁止旁白自问自答式地讲解规则来历与原理。' },
  { id: 'vary-sentence', name: '句式长短错落', text: '段落内句式长短错落，禁止连续多个“他+动词”开头的主谓句；动作戏多用短句，抒情处可舒展。' },
]

// 写法引擎试写：用当前文风绑定与反模板规则写一段小片段，验证写法效果后再正式开写（只出正文，不带标题/解释）
export function styleTrialMessages({ synopsis, style, forbidden, rules, samples }) {
  let sys = `你是一位职业小说作者。请根据本书设定写一段约 300 字的试写片段：自选一个有画面感的小场景（可以是一次对话、一段动作戏或一处氛围描写），直接输出正文，不要标题、不要任何解释。` +
    NO_AI_FLAVOR_RULE +
    styleBlockOf({ style, forbidden, rules, samples })
  return [
    { role: 'system', content: sys },
    { role: 'user', content: `【本书设定】\n${synopsis || '（暂无设定，自由发挥一个奇幻/都市小场景）'}\n\n请试写。` },
  ]
}

// 四个版本各自独立的改写方向与温度：分开生成，从结构上保证四版不雷同
export const VERSION_ANGLES = [
  { title: '版本一：小修润色', temp: 0.3, desc: '保持原文结构与情节完全不变，只修正语病、冗余与生硬表达，让语句更通顺自然，改动幅度最小。' },
  { title: '版本二：节奏调整', temp: 0.6, desc: '通过调整句子长短、分段与语气轻重，优化叙事节奏，增强流畅度与阅读推进感，剧情与人物不变。' },
  { title: '版本三：氛围强化', temp: 0.7, desc: '在不改变剧情的前提下，强化环境、情绪与感官细节描写，增强画面感与感染力，比原稿更有氛围。' },
  { title: '版本四：大胆重写', temp: 0.9, desc: '彻底摆脱原文的句式与笔法，用一套完全不同的叙述方式重写同一段剧情，只保留事件与人物设定不变。' },
]

// 第一步：点评 + 判断是否需要修改（独立一次请求）
const REVIEW_SYSTEM = `你是一位资深小说编辑，负责点评用户提交的小说片段。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"need_revision": true 或 false, "review": "对原文的整体点评，包括优点与不足（200字以内）"}
【规则】
1. 如果原文已经写得很好，need_revision 置为 false。
2. 无论是否需要修改，都必须给出具体的 review 点评，避免空话套话。`

export function reviewMessages({ text }) {
  return [
    { role: 'system', content: REVIEW_SYSTEM },
    { role: 'user', content: `请点评以下小说片段：\n\n${text}` },
  ]
}

// 第二步：每个版本独立生成，各自带上明确且不同的改写方向
function versionSystem(angle) {
  return `你是一位资深小说编辑，负责把用户的小说片段改写为「${angle.title}」。
【改写方向】${angle.desc}
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"title": "${angle.title}", "revised_text": "完整的改写后文本", "suggestions": [{"point": "具体修改建议", "reason": "这样修改的原因"}]}
【规则】
1. 严格围绕上面的改写方向执行，让这一版与"小修润色"等版本明显不同，禁止照抄原文句子。
2. 保持原文的剧情走向与人物设定不变，只优化表达。
3. suggestions 至少给出 2 条。`
}

export function versionMessages({ style, forbidden, samples, text, index }) {
  const angle = VERSION_ANGLES[index] || VERSION_ANGLES[0]
  return [
    { role: 'system', content: versionSystem(angle) + NO_AI_FLAVOR_RULE + styleBlockOf({ style, forbidden, samples }) },
    { role: 'user', content: `请按以上方向改写以下小说片段：\n\n${text}` },
  ]
}

// ---------- 模块二：新手写作四步向导 ----------
export const GENRES = ['玄幻', '仙侠', '修真', '都市', '现实', '科幻', '末世', '奇幻', '悬疑', '推理', '恐怖', '言情', '古代言情', '历史', '武侠', '军事', '游戏', '无限流', '竞技', '轻小说']
export const TONES = ['轻松幽默', '热血燃向', '细腻治愈', '暗黑沉重', '悬疑烧脑']

// 开书导演模式：一句话灵感 → 3 个差异化开书方向候选（用户拍板后链式生成全套开书资产）
export function directorAnglesMessages({ idea }) {
  return [
    {
      role: 'system',
      content: `你是一位资深网文主编，负责把一句话灵感发展成可开书的方向。给出 3 个差异化的开书方向候选。
【规则】
1. 每个候选包含：title（书名候选，10 字以内）、pitch（核心卖点 80 字以内：题材切入点 + 核心冲突 + 读者期待）、genre（从玄幻/都市/言情/悬疑/科幻/历史/无限流中选一）、tone（从轻松幽默/热血燃向/细腻治愈/暗黑沉重/悬疑烧脑中选一）；
2. 三个候选的题材切入点或核心冲突必须明显不同，不得只是换皮；
3. 忠实于灵感种子，不要跑偏灵感的核心题材。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"angles": [{"title": "书名候选", "pitch": "核心卖点", "genre": "题材", "tone": "基调"}]}`,
    },
    { role: 'user', content: `一句话灵感：${idea}\n\n请给出 3 个开书方向候选。` },
  ]
}

// 开书导演模式：基于梗概与世界观生成核心人物班底（结构化，直接入人物活档案）
export function directorCastMessages({ synopsis, world }) {
  return [
    {
      role: 'system',
      content: `你是一位选角导演，负责为新书确定核心人物班底。
【规则】
1. 给出 4~8 个核心人物：主角必须排第一；其余覆盖对手位、盟友位、关键配角等叙事功能位；
2. 每人包含：name（姓名）、identity（身份一句话）、personality（性格两三个关键词）、description（50 字内：外形/背景/核心欲望）；
3. 人物之间要有功能性差异（动机冲突或互补），不要同质化；姓名避免大众化名。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"characters": [{"name": "...", "identity": "...", "personality": "...", "description": "..."}]}`,
    },
    { role: 'user', content: `故事梗概：\n${synopsis}\n\n世界观设定：\n${world}\n\n请给出核心人物班底。` },
  ]
}

export function synopsisMessages({ idea, genre, tone }) {
  return [
    {
      role: 'system',
      content:
        '你是一位网文主编。根据用户的一句话创意，扩写一份 500 字左右的故事梗概，包含：核心设定、主角动机、主线冲突、大致的结局走向。直接输出梗概正文，不要输出任何解释性文字。',
    },
    { role: 'user', content: `创意：${idea}\n题材：${genre}\n基调：${tone}` },
  ]
}

export function worldMessages({ synopsis }) {
  return [
    {
      role: 'system',
      content:
        '你是一位世界观架构师。基于故事梗概，生成世界观与人物设定卡，分为两部分：\n【世界观】约 200 字，交代故事发生的背景、规则与独特设定。\n【人物卡】3-5 个主要人物，每人包含：姓名、身份、性格、核心欲望、与主角的关系。\n直接输出设定内容，使用清晰的标题分段，不要输出解释性文字。',
    },
    { role: 'user', content: `故事梗概：\n${synopsis}` },
  ]
}

export function outlineMessages({ synopsis, world, count, volumeContext }) {
  return [
    {
      role: 'system',
      content: `你是一位小说大纲师。基于梗概与设定，生成前 ${count} 章的逐章细纲。每章包含四项：章节标题、本章事件、冲突点、章末钩子（让读者想继续看的悬念）。
【定位标签】每章章头行格式为「第N章【X】标题」，X 从 起/承/转/合/过渡 中选一个，标注本章在本卷弧线中的位置：起=铺垫开局，承=推进发展，转=冲突转向，合=阶段收束，过渡=场景衔接。${volumeContext ? '起承转合是卷级长弧线的节奏坐标，以给定的【卷弧线坐标】为准：严禁在少量章节内凑齐一整轮起承转合，处于「起/承」区间的章不得标「转/合」，「转」只出现在弧线给定的转向区间；' : '起承转合是相对长弧线的节奏，严禁每批章节都凑齐一轮；开篇应以起/承/过渡为主，转只出现在剧情真正需要处；'}标签必须与本章事件匹配（标了「转」的章必须有方向性变化）。
【节奏要求】章节事件密度要克制：每章只安排 1~2 个关键事件；伏笔要有充分发酵期，回收时机一般不早于埋设后 5 章，切忌抢收。直接输出细纲，不要输出解释性文字。`,
    },
    { role: 'user', content: `故事梗概：\n${synopsis}\n\n世界观与人物设定：\n${world}${volumeContext ? `\n\n【卷弧线坐标（定位标签必须与之对齐）】\n${volumeContext}` : ''}` },
  ]
}

// 细纲续写：已有细纲即将写完/已耗尽时，基于当前进展紧接规划下一批章节（保证百万字不断地图）
export function outlineExtendMessages({ fromChapter, count, synopsis, rollingSummary, storylines, outlineTail, volumeContext, volumeStory }) {
  const lines = (storylines || []).map((s) => `- ${s.name}（${s.type}）：${s.progress}`).join('\n') || '（暂无）'
  return [
    {
      role: 'system',
      content: `你是一位连载小说的细纲规划师。故事已写到当前进度，请紧接现有细纲规划第 ${fromChapter} 章到第 ${fromChapter + count - 1} 章的逐章细纲。
【规则】
1. 每章章头行格式为「第N章【X】标题」（从第 ${fromChapter} 章严格连续编号，不许重复已有章号），X 从 起/承/转/合/过渡 中选一个，标注本章在本卷弧线中的位置${volumeContext ? '（以给定的【卷弧线坐标】为准，处于起/承区间的章不得标转/合，转只出现在弧线给定的转向区间）' : '（起承转合是卷级长弧线的节奏，严禁每批都凑齐一轮）'}，标签须与本章事件匹配；每章 60~120 字，含：章节标题、本章事件、章末钩子；
2. 必须基于【当前进展】紧接发展，不得与已发生的既成事实矛盾，不得重复已写过的剧情；
3. 节奏克制：每章只安排 1~2 个关键事件；未回收的伏笔要继续发酵而不是急于收束；若处于一卷的中后段，应朝本卷故事的收尾推进，不得把同一件事无限拉长；
4. 直接输出细纲正文，不要输出任何解释性文字。`,
    },
    {
      role: 'user',
      content: `【故事梗概】\n${synopsis || '（暂无）'}\n\n【当前进展（全书滚动摘要）】\n${rollingSummary || '（暂无）'}\n\n【现有故事线】\n${lines}${volumeStory ? `\n\n【所在卷的本卷故事（续纲围绕它展开，每卷是一个能独立讲完的故事）】\n${volumeStory}` : ''}${volumeContext ? `\n\n【卷弧线坐标（定位标签必须与之对齐）】\n${volumeContext}` : ''}\n\n【现有细纲结尾部分（紧接其后规划，编号从第 ${fromChapter} 章开始）】\n${outlineTail || '（暂无）'}`,
    },
  ]
}

export function draftMessages({ synopsis, world, outline, chapter, style, forbidden, prevChapters, prevTail }) {
  let prevBlock = ''
  if (prevChapters && prevChapters.length) {
    prevBlock += `\n\n【前文各章摘要（新章必须自然衔接，禁止与既有情节矛盾或重复已经发生过的事）】\n`
    prevBlock += prevChapters.map((c) => `第${c.no}章：${c.summary || '（无摘要）'}`).join('\n')
  }
  return [
    {
      role: 'system',
      content:
        `你是一位职业小说作者。请根据章节细纲撰写第 ${chapter} 章的正文，要求：2000 字左右；多用具象描写与对话推进剧情，少用形容词堆砌；` +
        (prevTail
          ? '必须严格紧接上一章结尾的场景与时间点继续，人物位置、状态、情绪要承接上一章，不要重复或复述上一章内容；'
          : '') +
        `控制叙事节奏，本章只推进 1~2 个关键事件，不要压缩过程、跳过应展开的场景；细纲中尚未轮到回收的伏笔，本章只能铺垫渲染，绝不能提前揭示答案；章节结尾落在细纲给定的钩子上。直接输出正文，第一行为"第${chapter}章 章节标题"，不要输出解释性文字。` +
        NO_AI_FLAVOR_RULE +
        styleBlockOf({ style, forbidden }),
    },
    {
      role: 'user',
      content: `故事梗概：\n${synopsis}\n\n世界观与人物设定：\n${world}\n\n章节细纲：\n${outline}${prevBlock}${prevTail ? `\n\n【上一章正文结尾（请直接紧接其后继续写）】\n${prevTail}` : ''}\n\n请撰写第 ${chapter} 章正文。`,
    },
  ]
}

// ---------- 段级选中改写：在章节编辑器内选中一段文字，按指定模式改写后替换回原位 ----------
// 只输出改写后的段落本身（不带任何解释/标题），长度目标按模式区分；上下文（前后文）保证衔接不断裂。
export const SEGMENT_MODES = [
  { id: 'expand', name: '扩写', desc: '把选中段落扩写为约 1.8~2.5 倍篇幅：补足对话、动作、感官细节与过程，不新增剧情事件。' },
  { id: 'compress', name: '压缩', desc: '把选中段落压缩为约一半篇幅：保留关键事件与信息，删去冗余描写与重复。' },
  { id: 'polish', name: '润色', desc: '保持篇幅与剧情完全不变，只修正语病、生硬表达与节奏，让文字更自然。' },
  { id: 'rewrite', name: '改写', desc: '换一种叙述方式重写同一段剧情（换句式、换细节选择、换节奏），事件与人物不变。' },
]

export function segmentRewriteMessages({ mode, text, before, after, requirement, style, forbidden, rules, samples }) {
  const m = SEGMENT_MODES.find((x) => x.id === mode) || SEGMENT_MODES[2]
  return [
    {
      role: 'system',
      content:
        `你是一位职业小说作者，正在修订自己长篇中的一段文字。
【改写模式】${m.name}：${m.desc}
【规则】
1. 只输出改写后的段落正文，不要标题、引号、解释或"改写如下"等引导语；
2. 必须与给出的前文、后文无缝衔接（人称、场景、语气保持一致），不得改动选中段之外的剧情；
3. 严格遵守人物当前状态与既有设定，不得引入新人物或新事件。` +
        NO_AI_FLAVOR_RULE +
        styleBlockOf({ style, forbidden, rules, samples }),
    },
    {
      role: 'user',
      content: `【前文（不改写，仅供衔接）】\n${before || '（这是开头，无前文）'}\n\n【选中段落（按模式改写它）】\n${text}${requirement ? `\n\n【作者附加要求（最高优先级）】\n${requirement}` : ''}\n\n【后文（不改写，仅供衔接）】\n${after || '（这是结尾，无后文）'}`,
    },
  ]
}

// ---------- 剧情讨论面板：绑定本书上下文的自由对话（讨论剧情走向/人物动机/卡文破局） ----------
// 只讨论不代写：给选项、给推演、给利弊分析；拍板永远留给作者。
export function discussionSystem({ synopsis, rollingSummary, chapters, foreshadows, storylines, characters }) {
  const recent = (chapters || []).map((c) => `第${c.chapterNo}章：${c.summary || ''}`).filter((s) => s.length > 5).join('\n')
  const hooks = (foreshadows || []).map((f) => `- ${f.content}${f.minResolveChapter ? `（最早第${f.minResolveChapter}章可回收）` : ''}`).join('\n')
  const lines = (storylines || []).map((s) => `- ${s.name}（${s.type}）：${s.progress}`).join('\n')
  const cast = (characters || []).map((c) => `${c.name}${c.status ? `（${c.status}）` : ''}`).join('、')
  let ctx = ''
  if (synopsis) ctx += `\n\n【故事梗概】\n${String(synopsis).slice(0, 600)}`
  if (rollingSummary) ctx += `\n\n【全书滚动摘要（最新进度）】\n${String(rollingSummary).slice(0, 800)}`
  if (recent) ctx += `\n\n【最近章节摘要】\n${recent.slice(0, 2500)}`
  if (cast) ctx += `\n\n【人物名单与当前状态】\n${cast}`
  if (hooks) ctx += `\n\n【未回收伏笔（讨论时须尊重其保护期）】\n${hooks}`
  if (lines) ctx += `\n\n【现有故事线】\n${lines}`
  return `你是这部长篇小说的资深合著编辑，与作者自由讨论剧情。你熟悉本书的全部设定与最新进展（见下方档案）。
【讨论守则】
1. 所有建议必须与既有设定、人物状态、伏笔保护期兼容，不得与之矛盾；
2. 讨论剧情分支时给出 2~3 个选项，并推演各自后续 2~3 章的走向与代价，不替作者拍板；
3. 回答直接、具体、有观点，拒绝空话；涉及人物动机时从其性格与欲望出发推理；
4. 你只参与讨论，不主动代写正文；作者要求示例时可给少量示意句。
${ctx}`
}

// 根据章节内容自动起标题（长篇写作生成初稿后调用）
export function chapterTitleMessages({ text }) {
  return [
    {
      role: 'system',
      content:
        '你是一位小说编辑。请为给定章节内容起一个章节标题。要求：10 字以内，概括本章核心事件或悬念，不带"第X章"前缀，不加引号。\n【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：\n{"title": "章节标题"}',
    },
    { role: 'user', content: `章节内容：\n${(text || '').slice(0, 4000)}` },
  ]
}

// ---------- 小说采样 ----------
// 全文太长会超出上下文且浪费 token，按段切块后均匀采样，并强制包含首尾两块（覆盖开头与结尾）
export function sampleNovel(content, segments = 7, perLength = 2500) {
  const paras = content
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 20)
  const chunks = []
  let cur = ''
  for (const p of paras) {
    if (cur.length + p.length > perLength && cur) {
      chunks.push(cur)
      cur = ''
    }
    cur += (cur ? '\n' : '') + p
  }
  if (cur) chunks.push(cur)
  if (chunks.length <= segments) return chunks
  const idx = new Set([0, chunks.length - 1])
  const step = (chunks.length - 1) / (segments - 1)
  for (let i = 0; i < segments; i++) idx.add(Math.round(i * step))
  return [...idx].sort((a, b) => a - b).map((i) => chunks[i])
}

// ---------- 新手写作·圣经流程 ----------
// Step 1 圣经合理化修补：用户的初始提问含固定人设/固定背景/修补诉求，AI 先修补逻辑漏洞再产出圣经；
// 固定项严禁改动，真相类字段拆"真相/线索"双层（真相层永不进写作上下文，写作时只允许露线索）
const BIBLE_SYSTEM = `你是一位资深网文主编，擅长修补故事设定的逻辑漏洞并搭建小说圣经。
用户会给出初始设定，其中标明的固定项（人设/背景）严禁改动；其余设定你要逐一检查逻辑漏洞并给出合理化修补（每个"为什么"都要能回答）。
【规则】
1. world：合理化后的世界观，必须闭环解释设定中所有"为什么"（为什么必须这样做/为什么不能反抗/为什么不能离开），300~500 字；
2. power_rules：力量体系/世界运行的绝对规则，每条独立成条（永不改动），涉及生存规则/资源规则/禁忌红线的一律列入，2~6 条；
3. anchors：从用户固定项中抽取的人物锚点（只收录用户明确给出的人物，不新增），每人含 name/aliases（别称数组，可空）/identity（一句话定位）/secret（该人物的隐藏秘密，用户未给则推理一个与主线相关的，可留空）；
4. truths：四项终极真相，每项含 kind（照抄给定槽位名）/truth（完整真相，大结局才揭露）/clues（2~3 条前期可露出的"蛛丝马迹"线索，每条 30 字内，线索不得直接暴露真相）；真相必须与世界观、人物锚点自洽；
5. map_layers：世界地图分层，把故事世界从开局之地到大结局舞台切成 3~6 层递进区域，每层含 name（8字内）/summary（该层正式设定 50 字内）/unlock_volume（解锁卷号，递增，第 1 层填 1）/truth（该层要到大地图才揭露的深层秘密，可与终极真相呼应，无则留空）/rumor（30 字内的"远方传闻"：前期只允许以传闻形式流传的短引，不得直说真相）；地图层是主角走出开局、世界逐级变大的阶梯，禁止全部困在开局一城；
6. 修补说明 fixes：你修正了哪些逻辑漏洞、如何修的，逐条列出（供用户审阅）；
7. 字段完整性（硬要求）：fixes/world/power_rules/anchors/truths/map_layers 六个字段全部必须输出，缺一不可；power_rules 至少 2 条、map_layers 至少 3 层，严禁输出空数组或省略字段。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"fixes": ["修补说明1"], "world": "合理化世界观", "power_rules": ["规则1"], "anchors": [{"name": "姓名", "aliases": ["别称"], "identity": "一句话定位", "secret": "隐藏秘密"}], "truths": [{"kind": "槽位名", "truth": "完整真相", "clues": ["线索1"]}], "map_layers": [{"name": "区域名", "summary": "正式设定", "unlock_volume": 1, "truth": "深层秘密", "rumor": "前期传闻"}]}`

export function bibleRationalizeMessages({ brief, truthKinds }) {
  return [
    { role: 'system', content: BIBLE_SYSTEM },
    { role: 'user', content: `【四项终极真相的固定槽位名】\n${truthKinds.join('、')}\n\n【用户的初始提问（含固定项与修补诉求）】\n${brief}` },
  ]
}

// Step 1 分支：从导入的既有章节反推圣经草稿（只提取原文有依据的设定，真相层允许基于伏笔合理推演）
export function bibleFromImportMessages({ text, truthKinds }) {
  return [
    {
      role: 'system',
      content: `你是一位资深网文主编。给定一部小说的既有章节，请反推其小说圣经草稿。
【规则】
1. world 与 power_rules 只提取原文明确交代的设定（无依据则留空/空数组）；
2. anchors 只收录原文明确出场的人物，secret 填原文埋下的暗示（无则留空）；
3. truths 允许基于原文已埋的伏笔合理推演一个自洽的终极真相（这是创作建议不是原文事实，用户可改），每项含 kind/truth/clues，clues 优先引用原文已出现的细节；
4. map_layers：基于原文已出现的地点推演地图分层（开局之地为第 1 层，更高层可合理推演并标注解锁卷号），每层含 name/summary/unlock_volume/truth/rumor；
5. fixes 固定为空数组。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"fixes": [], "world": "世界观", "power_rules": ["规则1"], "anchors": [{"name": "姓名", "aliases": ["别称"], "identity": "一句话定位", "secret": "隐藏秘密"}], "truths": [{"kind": "槽位名", "truth": "真相", "clues": ["线索1"]}], "map_layers": [{"name": "区域名", "summary": "正式设定", "unlock_volume": 1, "truth": "深层秘密", "rumor": "前期传闻"}]}`,
    },
    { role: 'user', content: `【四项终极真相的固定槽位名】\n${truthKinds.join('、')}\n\n【既有章节正文】\n${text}` },
  ]
}

// 开书自动步骤：圣经推导完成后立即生成本书完整世界观（势力/冲突）——选定灵感后才成型，题材模板仅作参考。
// 防透支机制：每个势力带 unlockVolume（登场时机）与 rumor（登场前的模糊传闻，不含实情），每条冲突带 start/end 卷区间；
// 规划层（全书梗概/分卷）看完整清单负责编排登场节奏，逐卷写作层只见"已到时机"的细节（worldviewPlanText / worldviewVolumeText）。
export function bookWorldviewMessages({ template, brief, bible, volumeCount }) {
  return [
    {
      role: 'system',
      content: `你是一位资深网文主编，请为这本书设计完整世界观的势力盘与冲突线（世界架构与力量体系已由圣经确定，不要重复输出）。
【规则】
1. factions：4~8 个主要势力（宗门/集团/阵营/组织，不必全是敌对），每个含 name（8 字内）/desc（定位、立场、与主角初始关系，80 字内）/unlock_volume（登场卷号 1~${volumeCount}：主角与该势力发生实质交集的最早卷）/rumor（登场前流传的模糊传闻，30 字内，不得暴露其真实现状、规模、位置与目的，只能以"听说…"口吻营造氛围）；
2. conflicts：3~5 条贯穿全书的主要冲突线（势力对抗/道统之争/资源战争等，不是某一卷的具体事件），每条含 name/desc（80 字内）/start_volume/end_volume（发酵与收尾卷号）；
3. 登场时机必须铺满全书：unlock_volume 不得全挤在前两卷，至少一半势力在中后期登场，为地图扩张与升级流留出阶梯；冲突线的 start_volume 也应错开；
4. 严格基于圣经世界观与用户初始诉求自洽，不得与之矛盾；不得提前安排四项终极真相的揭示（终局底牌属于真相层，不在本清单）；
5. 题材世界模板仅供参考：与圣经/初始诉求一致时可吸收其格局，冲突时一律以圣经为准。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"factions": [{"name": "势力名", "desc": "定位与立场", "rumor": "登场前传闻", "unlock_volume": 2}], "conflicts": [{"name": "冲突线名", "desc": "冲突内涵", "start_volume": 1, "end_volume": 4}]}`,
    },
    {
      role: 'user',
      content: `【题材世界模板（参考）】\n${template || '（暂无）'}\n\n【用户初始提问（含选定灵感）】\n${brief || '（无）'}\n\n【圣经·世界观】\n${bible?.world || '（暂无）'}\n\n【力量体系绝对规则】\n${(bible?.powerRules || []).join('\n') || '（暂无）'}\n\n全书共 ${volumeCount} 卷。请设计势力盘与冲突线。`,
    },
  ]
}

// 规划层注入（全书梗概/分卷/全书骨架）：完整势力与冲突清单含登场时机，AI 负责编排节奏，未到时机的势力不得提前实质登场
export function worldviewPlanText(bible) {
  const f = (bible?.factions || []).filter((x) => x?.name).map((x) => `- ${x.name}（第${x.unlockVolume || 1}卷登场；此前只允许传闻：${x.rumor || '无'}）：${x.desc || ''}`).join('\n') || '（暂无）'
  const c = (bible?.conflicts || []).filter((x) => x?.name).map((x) => `- ${x.name}（第${x.startVolume || 1}~${x.endVolume || '?'}卷）：${x.desc || ''}`).join('\n') || '（暂无）'
  return `【世界势力盘（含登场卷；未到登场卷的势力不得实质出场，只能以传闻形式提及）】\n${f}\n\n【主要冲突线（含阶段；不得把后期冲突提前引爆）】\n${c}`
}

// 逐卷写作层注入（卷骨架/卷细纲）：已到登场时机的势力给详情，未到时机只给一句模糊传闻（rumor 不含实情）；
// 冲突线只在所处阶段内可见，未开始的完全不注入——AI 看不到细节就不可能提前透支（同地图分层 truth/rumor 隔离机制）
export function worldviewVolumeText(bible, volumeNo, totalVolumes) {
  const v = Number(volumeNo) || 1
  const ready = []
  const rumors = []
  for (const x of bible?.factions || []) {
    if (!x?.name) continue
    if ((x.unlockVolume || 1) <= v) ready.push(`- ${x.name}：${x.desc || ''}`)
    else if (x.rumor) rumors.push(`- ${x.rumor}`)
  }
  const active = (bible?.conflicts || [])
    .filter((x) => x?.name && (x.startVolume || 1) <= v && v <= (x.endVolume || totalVolumes || 99))
    .map((x) => `- ${x.name}：${x.desc || ''}`)
  if (!ready.length && !rumors.length && !active.length) return ''
  const parts = []
  if (ready.length) parts.push(`【已登场势力（可展开描写）】\n${ready.join('\n')}`)
  if (active.length) parts.push(`【本卷所处阶段的冲突线】\n${active.join('\n')}`)
  if (rumors.length) parts.push(`【未登场势力的民间传闻（只可原样带过，禁止展开、禁止让主角接触其详情）】\n${rumors.join('\n')}`)
  return parts.join('\n\n')
}

// Step 2 全书梗概 5000 字：主线里程碑式全景大纲 + 副线 + 四层伏笔（每条带回收卷规划，根治"只有短埋点"）
export function fullSynopsisMessages({ bible, brief, totalWords, volumeCount, chapterWords }) {
  const anchors = (bible?.anchors || []).map((a) => a.name).join('、') || '（暂无）'
  const clues = (bible?.truths || []).flatMap((t) => (t.clues || []).map((c) => `- ${t.kind}的线索：${c}`)).join('\n') || '（暂无）'
  const mapText = (bible?.mapLayers || []).filter((m) => m?.name).map((m, i) => `第${i + 1}层 ${m.name}（第${m.unlockVolume}卷解锁）：${m.summary || ''}`).join('\n') || '（暂无）'
  const totalChapters = Math.max(1, Math.round(totalWords / chapterWords))
  return [
    {
      role: 'system',
      content: `你是一位资深网文主编，请基于小说圣经撰写全书全景大纲（约 5000 字），从第 1 章一直规划到大结局。
【规则】
1. 全书规划体量约 ${totalWords} 字、共 ${volumeCount} 卷、约 ${totalChapters} 章（每章约 ${chapterWords} 字）；
2. mainline：全书唯一主线，写成里程碑链：开局状态 → 3~5 个重大里程碑（每个标注大致章号锚点）→ 大结局形态，800~1200 字；里程碑必须体现地图分层的逐级扩张（主角走出开局之地、世界逐级变大），禁止全程困在同一区域；
3. subplots：0~3 条全程贯穿的副线，每条含 name（6 字内）/theme/起点卷/终点卷（1~${volumeCount}）；
4. foreshadows：四层伏笔登记，总量 8~14 条，每层至少 1 条：
   - 短（10~20 章回收）：日常爽点、小冲突、小反转；
   - 中（50~80 章回收）：卷中反转、配角秘密、区域真相；
   - 长（150~250 章回收）：主角身世、金手指第一层秘密、幕后黑手线索；
   - 终极（终卷回收）：圣经四项终极真相对应的全书最大秘密，全程只露蛛丝马迹；
   每条含 content（伏笔内容）/tier/related_chars（相关人物）/planned_volume（计划回收卷号，终极层填 ${volumeCount}）/hints（2~3 个线索露出时机：{chapter: 大致章号, clue: 露什么蛛丝马迹}，长/终极层必填）；
5. 伏笔必须与圣经终极真相和主线里程碑呼应，回收节奏错开，不得扎堆；
6. 严格基于圣经设定，不得与之矛盾；不得提前揭示真相层内容；
7. 里程碑与伏笔须遵守世界势力盘的登场卷号：未到登场卷的势力只能以传闻形式露出，冲突线不得提前引爆，由你负责把它们编排到合适的里程碑上。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"mainline": "主线里程碑链全文", "subplots": [{"name": "副线名", "theme": "主题", "start_volume": 1, "end_volume": 2}], "foreshadows": [{"content": "伏笔内容", "tier": "短|中|长|终极", "related_chars": ["人物"], "planned_volume": 3, "hints": [{"chapter": 30, "clue": "露出什么"}]}]}`,
    },
    {
      role: 'user',
      content: `【小说圣经·世界观】\n${bible?.world || '（暂无）'}\n\n【力量体系绝对规则】\n${(bible?.powerRules || []).join('\n') || '（暂无）'}\n\n【人物锚点】\n${anchors}\n\n【世界地图分层（主线里程碑须沿此阶梯扩张）】\n${mapText}\n\n${worldviewPlanText(bible)}\n\n【圣经已埋线索（长线伏笔须围绕它们展开）】\n${clues}\n\n【用户初始诉求】\n${brief || '（无）'}\n\n请撰写全书全景大纲。`,
    },
  ]
}

// Step 3 卷结构：按给定节奏切卷（不均分），每卷卷名/主题/核心冲突/收获/主舞台/解锁地图层/卷末大悬念（对齐圣经与主线里程碑）；并逐卷生成情感走向（贴合本卷故事走向，卷间不重复）
export function volumesPlanMessages({ bible, mainline, volumeCount, lengths, roles, genre = '', tone = '' }) {
  const mapText = (bible?.mapLayers || []).filter((m) => m?.name).map((m, i) => `第${i + 1}层 ${m.name}（第${m.unlockVolume}卷解锁）`).join('；') || '（暂无）'
  const rhythmText = (lengths || []).map((n, i) => `第${i + 1}卷约${n}章（${(roles || [])[i] || '腹地'}）`).join('、')
  return [
    {
      role: 'system',
      content: `你是一位资深网文主编，请把全书主线切分为 ${volumeCount} 卷，按用户给定的节奏分配篇幅（不均分）。本书题材为「${genre || '未定'}」，基调为「${tone || '未定'}」。
【最重要的结构原则：每卷 = 一个能独立讲完的故事】
长篇不是把一件事拆成 ${volumeCount} 份慢慢磨，而是 ${volumeCount} 个各自完整的故事，由同一条主线暗线串联。每卷必须有一个本卷限定的具体事件（arc_story）：新的对手/新的局面/明确目标，在本卷内起-承-转-合完整解决，卷末只留钩子与长线收获交给下一卷。读者读完单卷应获得一个完整故事的满足感。
【规则】
1. 每卷含：name（卷名 8 字内）/theme（本卷核心主题一句话）/conflict（本卷核心冲突）/arc_story（本卷故事：100~150 字，写清本卷那件具体的事——谁与谁、因为什么、争什么、在本卷内如何一步步升级并收尾；必须是可单独讲完的具体事件，不是“推进主线”“提升实力”这类抽象描述）/gain（主角本卷收获：能力/关系/信息/地位）/location（本卷主舞台：具体地名，随卷递进不得全程困在一地）/unlock_layer（本卷解锁的地图层号，随卷递增，至少每 2 卷推进 1 层）/strategy（本卷战略 100 字内：要达成什么、主线推进到哪、卷末落在什么钩子上）/end_hook（卷末大悬念，留给下一卷）/emotion（本卷情感走向：4~5 个情感节拍用→连接，如“压抑→憋屈→爆发→短暂喘息”；必须根据本卷自己的故事走向（主题/冲突/战略）设计，不得所有卷套用同一条；各卷不得重复）；
2. 【故事弧互不重复】各卷的 arc_story 事件类型与对手必须明显不同，在“大比/探秘/追查/守卫/战争/交易/逃亡/守城…”等模式中轮换；严禁多卷重复同一类事件或同一对手反复登场；每卷登场的新人物/新势力为该卷故事服务，主线人物只作暗线穿插；
3. 【主线作暗线】全书主线不是每卷正面推进的对象，而是被各卷故事“顺带”推动的暗线：每卷解决本卷事件的同时，只让主线里程碑前进一步（得到一条关键信息/一个必要物品/一位盟友）；
4. 卷与卷之间递进：本卷故事的规模与难度逐卷升级、舞台扩大、主角能力与处境阶梯式变化；每卷 end_hook 是下一卷故事的开局动力；换地图的卷应携带 1~2 名旧人物同行，不得丢线；
5. 短卷（开卷/收割卷）要短而密：钩子密集、快入局或快回收；长卷（腹地卷）承载地图深耕与中长伏笔发酵；
6. 必须与主线里程碑、地图分层对齐，不得与圣经设定矛盾；不得提前安排终极真相的揭示；情感走向须符合题材与基调的气质（如暗黑基调不得出现圆满收尾节拍）；
7. 第 ${volumeCount} 卷为终卷：arc_story 可为各卷暗线与主线总爆发的收束故事，end_hook 填大结局的余韵而非悬念；
8. 世界势力盘与冲突线是硬约束：每个势力应在其登场卷成为该卷 arc_story/conflict 的主角之一，未到登场卷只能以传闻带过；各卷主打的冲突线应按其 start_volume/end_volume 阶段轮换，不得每卷都打同一条冲突线，不得提前引爆后期冲突。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"volumes": [{"volume_no": 1, "name": "卷名", "theme": "主题", "conflict": "核心冲突", "arc_story": "本卷具体故事", "gain": "本卷收获", "location": "主舞台", "unlock_layer": 1, "strategy": "本卷战略", "end_hook": "卷末大悬念", "emotion": "情感走向"}]}`,
    },
    { role: 'user', content: `【圣经·世界观】\n${bible?.world || '（暂无）'}\n\n【全书主线（作为暗线，由各卷故事顺带推动）】\n${mainline || '（暂无）'}\n\n【世界地图分层】\n${mapText}\n\n${worldviewPlanText(bible)}\n\n【分卷节奏（篇幅已定，严格按此安排内容密度）】\n${rhythmText}\n\n请切分 ${volumeCount} 卷，每卷设计一个能独立讲完、互不重复的具体故事（arc_story）。` },
  ]
}

// Step 4 卷内四幕：按卷的叙事角色给不同比例参考（ratioGuide 由调用方从引擎层 ACT_RATIO_GUIDE 传入），禁止每卷同构均分（根治四幕模板化）
export function actsPlanMessages({ volume, mainline, role = '腹地', ratioGuide = '起幕约20%，发展幕约40%，冲突幕约25%，高潮落幕约15%' }) {
  return [
    {
      role: 'system',
      content: `你是一位资深网文主编，请把一卷拆成四幕结构：起幕→发展幕→冲突幕→高潮落幕。
【规则】
1. 给定本卷计划章数 L（卷内坐标从 1 到 L），把 1~L 切成四段连续不重叠的章节区间；
2. 本卷叙事角色为「${role}」，比例参考：${ratioGuide}；该比例只是参考，可根据本卷剧情合理偏离，但严禁与其他卷使用相同的均分比例（每卷四幕形状必须不同）；
3. 每幕含 goal（本幕要完成什么，40 字内）；四幕目标依次递进，合起来完成本卷战略；
4. 输出格式：act 名固定为"起幕/发展幕/冲突幕/高潮落幕"。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"acts": [{"act": "起幕", "start": 1, "end": 5, "goal": "本幕目标"}]}`,
    },
    { role: 'user', content: `【本卷信息】\n第 ${volume.volumeNo} 卷《${volume.name || ''}》：计划 ${volume.length || 20} 章（叙事角色：${role}）\n主题：${volume.theme || '（未定）'}\n核心冲突：${volume.conflict || '（未定）'}\n主舞台：${volume.location || '（未定）'}\n战略：${volume.strategy || '（未定）'}\n卷末悬念：${volume.endHook || '（未定）'}\n\n【全书主线（供对齐）】\n${(mainline || '').slice(0, 1500)}\n\n请拆出四幕结构。` },
  ]
}

// Step 5a 全书章名骨架：按卷分次生成（每次只负责一卷的章数区间，避免单次请求输出上千章导致模型压缩完剧情后用填充内容凑数），
// 每章一行（章名 + 唯一剧情任务），仅作方向锚点，进卷时再细化为完整细纲；
// "每章只允许完成一个任务"在此源头确立，写章提示词另有硬约束兑现它；
// prevTail：上一卷最后 3 章的章行，供衔接对齐；actsText：本卷四幕的全局章号区间（有则供节奏对齐）
export function volumeSkeletonMessages({ bible, mainline, volume, volumeCount, prevTail = '', actsText = '' }) {
  const start = volume.startChapter || 1
  const len = volume.length || 20
  const end = start + len - 1
  const isLast = volume.volumeNo >= volumeCount
  return [
    {
      role: 'system',
      content: `你是一位小说大纲师。请为指定卷生成逐章骨架：每章一行，章名 + 本章唯一剧情任务。
【规则】
1. 章号严格从第 ${start} 章连续编到第 ${end} 章，共 ${len} 章，一章不少、一章不多；
2. 【围绕本卷故事拆章】本卷是一个能独立讲完的故事（见【本卷信息·本卷故事】）；每章任务是这件具体故事的一个环节：一个事件、一次交锋、一个新发现或一次关系变化；应不断引入为本卷故事服务的新事件与新配角，不得把同一个冲突反复拆成几十章的微小推进（拒绝单故事稀释）；每章只安排一个剧情任务，杜绝一章塞多件大事；
3. 只展开本卷内容：剧情不得越过本卷推进后续卷的里程碑${isLast ? '' : '，严禁提前触及大结局'}；最后一章必须落在本卷卷末悬念的爆发点上${isLast ? '（终卷：大结局在本卷收束，最后一章为结局余韵）' : ''}；
4. 章名必须 2~8 字且与本章剧情具体相关：严禁单字章名、严禁空洞口号式章名（如“坚持”“希望”“责任”）、严禁用与剧情无关的填充章凑数；
5. 节奏克制，伏笔发酵期不得压缩；任务服务本卷故事的起承转合，与本卷主题、四幕区间对齐；
6. 与主线里程碑、圣经设定保持一致，不得提前安排终极真相揭示。
【输出协议】直接连续输出全部 ${len} 行章行，每章一行："第N章 章名｜任务：本章唯一要完成的一件事"。禁止输出任何解释、注释、前言、总结或"注："类文字。`,
    },
    {
      role: 'user',
      content: `【本卷信息】\n第 ${volume.volumeNo} 卷《${volume.name || ''}》（第 ${start}~${end} 章，共 ${len} 章）\n主题：${volume.theme || '（未定）'}；本卷故事（本章任务围绕它拆解）：${volume.arcStory || volume.conflict || '（未定）'}；主舞台：${volume.location || '（未定）'}；卷末悬念：${volume.endHook || '（未定）'}${actsText ? `\n四幕区间（全局章号）：${actsText}` : ''}${prevTail ? `\n\n【上一卷末尾（本卷开头需从这里接住）】\n${prevTail}` : ''}\n\n【全书主线（暗线，本卷只展开属于本卷故事的部分）】\n${(mainline || '').slice(0, 1500)}\n\n【圣经·世界观】\n${(bible?.world || '').slice(0, 800)}${(() => { const t = worldviewVolumeText(bible, volume.volumeNo, volumeCount); return t ? `\n\n${t}` : '' })()}\n\n请生成第 ${start}~${end} 章逐章骨架，每章任务都是本卷故事的具体环节。`,
    },
  ]
}

// Step 5a 兼容旧入口：全书一次性骨架（仅在无卷结构时降级使用；有卷结构时向导改用 volumeSkeletonMessages 分卷生成）
export function chapterSkeletonMessages({ bible, mainline, volumes, volumeLength }) {
  const volText = (volumes || []).map((v) => `第${v.volumeNo}卷《${v.name || ''}》（约${v.length || volumeLength}章）：${v.theme || ''}；本卷故事：${v.arcStory || v.conflict || ''}；主舞台：${v.location || '未定'}；卷末悬念：${v.endHook || ''}`).join('\n')
  const total = (volumes || []).reduce((n, v) => n + (v.length || volumeLength), 0) || (volumes || []).length * volumeLength
  return [
    {
      role: 'system',
      content: `你是一位小说大纲师。请为全书生成逐章骨架：每章一行，章名 + 本章唯一剧情任务。
【规则】
1. 共约 ${total} 章，编号从第 1 章连续到第 ${total} 章，不得断号；每章格式一行："第N章 章名｜任务：本章唯一要完成的一件事"；
2. 【围绕本卷故事拆章】每章任务是所在卷那件具体故事（arc_story）的一个具体环节：一个事件、一次交锋、一个新发现或一次关系变化；应不断引入为本卷故事服务的新事件与新配角，不得把同一个冲突反复拆成几百章的微小推进（拒绝单故事稀释）；杜绝一章塞多件大事；
3. 任务必须服务本卷故事的起承转合，并落在卷末悬念的铺垫上；节奏克制，伏笔发酵期不得压缩；
4. 章名必须 2~8 字且与剧情具体相关：严禁单字章名、口号式章名与与剧情无关的填充章；
5. 与主线里程碑、圣经设定保持一致，不得提前安排终极真相揭示。
【输出协议】直接连续输出全部章行，禁止输出任何解释、注释、前言、总结或"注："类文字。`,
    },
    { role: 'user', content: `【卷结构】\n${volText || '（暂无）'}\n\n【全书主线】\n${(mainline || '').slice(0, 2000)}\n\n【圣经·世界观】\n${(bible?.world || '').slice(0, 1000)}\n\n${worldviewPlanText(bible)}\n\n请生成全书逐章骨架。` },
  ]
}

// Step 5b 第 1 卷完整细纲：基于章骨架展开，格式兼容现有细纲解析（第N章【定位】标题 + 事件/冲突/钩子）
export function volumeOutlineMessages({ skeleton, volume, bible, chapterCount, arcText }) {
  return [
    {
      role: 'system',
      content: `你是一位小说大纲师。请把第 1 卷的章骨架展开为完整细纲，覆盖第 1 章到第 ${chapterCount} 章。
【规则】
1. 每章章头行格式为「第N章【X】标题」，X 从 起/承/转/合/过渡 中选一，标注本章在本卷弧线中的位置${arcText ? `（以给定的【卷弧线坐标】为准）` : ''}；标签须与本章事件匹配；
2. 每章 60~120 字，含：本章事件（严格对应章骨架的唯一任务，不得擅自完成后续章节任务）、冲突点、章末钩子；
3. 节奏克制：每章只推进章骨架给定的一件事；伏笔只铺垫不抢收；
4. 章号从第 1 章严格连续编号；直接输出细纲正文，不要输出任何解释性文字。`,
    },
    {
      role: 'user',
      content: `【第 1 卷章骨架（逐章任务，严格按它展开）】\n${skeleton || '（暂无）'}\n\n【本卷信息】\n主题：${volume?.theme || '（未定）'}；本卷故事（细纲围绕它展开）：${volume?.arcStory || volume?.conflict || '（未定）'}；卷末悬念：${volume?.endHook || '（未定）'}${arcText ? `\n\n【卷弧线坐标（定位标签必须与之对齐）】\n${arcText}` : ''}\n\n【圣经·世界观】\n${(bible?.world || '').slice(0, 1000)}${(() => { const t = worldviewVolumeText(bible, volume?.volumeNo || 1); return t ? `\n\n${t}` : '' })()}\n\n请生成第 1 卷完整细纲。`,
    },
  ]
}

// ---------- 模块三：续写 ----------

// 分析现有文章：严格只提取原文明确出现的内容，未提及则留空，绝对禁止捏造
const ANALYZE_SYSTEM = `你是一位严谨的小说内容分析师。任务是从用户提供的小说原文中，提取已经明确写出的信息。

【绝对规则——违反即失败】
1. 只提取原文中明确出现、有字面依据的内容。
2. 原文未提及的信息，对应字段必须返回空字符串或空数组，绝对不要推测、补全、演绎或捏造。
3. 禁止出现原文中未出现的人物姓名、地点、组织、情节、设定或关系。
4. 人物卡只收录原文中明确出场或被明确提及姓名的人物；只写原文有依据的特征。
5. 故事大纲和故事线只梳理原文已经写到的情节，不预测后续、不补充未发生的事。
6. 如果某类信息原文完全没有涉及，宁可留空，也不要用"可能""大概""似乎"等推测性内容填充。

【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容、解释或代码块标记：
{
  "world_setting": "原文明确交代的世界观/时代背景/规则设定（没有则为空字符串）",
  "characters": [
    {"name": "人物姓名", "identity": "身份/职业（原文有依据才写）", "personality": "性格特征（原文有依据才写）", "description": "原文中关于该人物的其他关键信息"}
  ],
  "outline": "原文已经写到的故事大纲/情节脉络（没有则为空字符串）",
  "timeline": [
    {"stage": "阶段名称（用开篇/发展/转折/高潮/当前等描述性阶段，不要用真实时间）", "summary": "该阶段原文已经发生的关键情节"}
  ]
}`

export function analyzeMessages({ text }) {
  return [
    { role: 'system', content: ANALYZE_SYSTEM },
    { role: 'user', content: `请分析以下小说原文，严格只提取原文中明确出现的信息，未提及的留空：\n\n${text}` },
  ]
}

// 四个续写版本：不预设具体剧情方向，只通过不同的叙述要求与温度保证四版内容各异
// 具体续写方向由用户在对话框中输入指令决定
export const CONTINUE_ANGLES = [
  { title: '版本一', temp: 0.5, desc: '紧接原文自然续写，保持原有叙事节奏、视角和文风，平稳推进剧情。' },
  { title: '版本二', temp: 0.6, desc: '换一种句式结构和叙事节奏续写，同样的剧情走向但表达方式明显不同，更紧凑或更舒展。' },
  { title: '版本三', temp: 0.7, desc: '更注重细节、氛围和感官描写，用更细腻的笔触续写同一段剧情，让场景更有画面感。' },
  { title: '版本四', temp: 0.9, desc: '更大胆地发挥，探索剧情可能的不同处理方式，确保与其他三个版本在叙述和走向上有明显区别。' },
]

function continueSystem(angle) {
  return `你是一位职业小说作者。请根据用户提供的原文与设定，以「${angle.title}」的要求续写接下来的内容。
【本版本要求】${angle.desc}
【规则】
1. 严格紧接原文结尾的最后一个场景/时间点开始续写，不要重复、复述或回顾原文内容。
2. 保持原文的叙事视角、人称和文风。
3. 只使用用户提供的世界观、人物卡和大纲中出现的设定与人物；如用户未提供，则只基于原文已出现的人物和设定，不要凭空捏造新人物或新世界观。
4. 四个版本内容必须各不相同，本版本要在叙述方式、节奏或细节处理上与其他版本拉开差异。
5. 续写长度约 1500 字。
6. 直接输出续写正文，不要输出任何解释性文字、标题、前缀或"以下是续写"等引导语。`
}

// 前文摘要：原文过长时，先给前文做摘要，再拼上尾部原文发给续写
const SUMMARIZE_SYSTEM = `你是一位小说编辑。请为以下小说前文写一份简洁摘要，用于给续写AI提供上下文。
摘要必须包含：
1. 主要人物及其关系
2. 核心世界观/设定
3. 已发生的关键情节
4. 当前故事进展到哪里（结尾处的状态）
要求：300字以内，客观陈述原文已有内容，不要添加原文没有的信息，不要预测后续发展。

【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"summary": "摘要正文"}`

export function summarizeMessages({ text }) {
  return [
    { role: 'system', content: SUMMARIZE_SYSTEM },
    { role: 'user', content: `请为以下小说前文写摘要：\n\n${text}` },
  ]
}

export function continueMessages({ text, summary, world, characters, outline, timeline, style, forbidden, instruction, index }) {
  const angle = CONTINUE_ANGLES[index] || CONTINUE_ANGLES[0]
  let ctx = ''
  if (instruction) ctx += `\n\n【用户续写指令（最高优先级，必须遵循）】\n${instruction}`
  if (summary) ctx += `\n\n【前文摘要（原文较长，仅提供摘要作为上下文）】\n${summary}`
  if (world) ctx += `\n\n【世界观设定（用户提供，可作为续写依据）】\n${world}`
  if (characters) ctx += `\n\n【人物卡（用户提供，可作为续写依据）】\n${characters}`
  if (outline) ctx += `\n\n【故事大纲（用户提供，可作为续写依据）】\n${outline}`
  if (timeline && timeline.length) {
    ctx += `\n\n【已有故事线（原文已写到的情节，续写紧接其后）】\n`
    ctx += timeline.map((t, i) => `${i + 1}. ${t.stage}：${t.summary}`).join('\n')
  }
  return [
    { role: 'system', content: continueSystem(angle) + NO_AI_FLAVOR_RULE + styleBlockOf({ style, forbidden }) },
    { role: 'user', content: `以下是小说原文（请紧接结尾续写）：\n\n${text}${ctx}\n\n请以「${angle.title}」的要求续写。` },
  ]
}

// ---------- 后续版本：AI 自动探索 4 种不同剧情走向 ----------
// 与"自定义续写"的区别：自定义续写由用户指定方向，4 个版本只是叙述方式不同；
// 后续版本由 AI 自动探索 4 种本质不同的剧情走向，用户不需要输入指令。
export const FOLLOWUP_ANGLES = [
  { title: '后续一：顺势发展', temp: 0.5, desc: '按现有剧情逻辑和人物性格自然推进，让故事顺着当前势头平稳发展，不引入意外变数，展现故事最可能的走向。' },
  { title: '后续二：意外变故', temp: 0.7, desc: '引入一个突如其来的意外事件或变数，打破当前局面，让故事走向发生明显偏转，制造新的冲突和张力。' },
  { title: '后续三：人物抉择', temp: 0.6, desc: '聚焦某个关键人物面临的艰难抉择，通过人物的选择和行动推动剧情发展，深入展现人物内心冲突和成长。' },
  { title: '后续四：伏笔回收', temp: 0.8, desc: '回收前文埋下的伏笔或暗示，揭示之前隐藏的信息、人物关系或真相，让读者有恍然大悟之感，同时推动剧情进入新阶段。' },
]

function followupSystem(angle) {
  return `你是一位职业小说作者。请根据用户提供的原文，探索「${angle.title}」这一剧情走向，续写接下来的内容。
【本版本剧情走向】${angle.desc}
【规则】
1. 严格紧接原文结尾的最后一个场景/时间点开始续写，不要重复、复述或回顾原文内容。
2. 保持原文的世界观、人物性格、叙事视角和文风一致。
3. 本版本必须在剧情走向、事件发展或人物命运上与其他三个版本有本质区别，不能只是叙述方式或措辞不同。
4. 只使用原文中已出现的人物和设定，不要凭空捏造新人物或全新世界观；可以基于已有伏笔和人物关系合理发展。
5. 续写长度约 1500 字。
6. 直接输出续写正文，不要输出任何解释性文字、标题、前缀或"以下是续写"等引导语。`
}

export function followupMessages({ text, summary, world, characters, outline, timeline, style, forbidden, index }) {
  const angle = FOLLOWUP_ANGLES[index] || FOLLOWUP_ANGLES[0]
  let ctx = ''
  if (summary) ctx += `\n\n【前文摘要（原文较长，仅提供摘要作为上下文）】\n${summary}`
  if (world) ctx += `\n\n【世界观设定】\n${world}`
  if (characters) ctx += `\n\n【人物卡】\n${characters}`
  if (outline) ctx += `\n\n【故事大纲】\n${outline}`
  if (timeline && timeline.length) {
    ctx += `\n\n【已有故事线】\n`
    ctx += timeline.map((t, i) => `${i + 1}. ${t.stage}：${t.summary}`).join('\n')
  }
  return [
    { role: 'system', content: followupSystem(angle) + NO_AI_FLAVOR_RULE + styleBlockOf({ style, forbidden }) },
    { role: 'user', content: `以下是小说原文（请紧接结尾续写）：\n\n${text}${ctx}\n\n请以「${angle.title}」的剧情走向续写。` },
  ]
}

// ---------- 全局诊断看板 ----------
// 对已有文本做一次"体检"：梳理故事线与节奏、评估伏笔健康度，供各 tab 的看板复用
const DIAGNOSE_SYSTEM = `你是一位资深小说编辑，负责对给定的小说内容进行全局诊断。
请输出以下内容：
1. storylines：梳理现有故事线（主线 + 各支线），每条用一句话概括当前进展与悬而未决的问题；
2. pace_issues：节奏问题诊断，重点关注：进程过快（关键转折缺乏铺垫）、伏笔收得太早（缺少发酵期）、事件密度过高（一章塞太多大事）；没有则为空数组；
3. foreshadows：识别已埋下但尚未回收的伏笔/悬念，并给出建议回收时机（距当前还需几章发酵）；
4. suggestions：不超过 5 条最重要的写作建议，针对具体问题，不要空话。
客观基于给定内容分析，不要推测内容之外的情节。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"storylines": [{"name": "故事线名称", "progress": "当前进展与未决问题"}], "pace_issues": ["问题描述"], "foreshadows": [{"content": "伏笔内容", "suggestion": "建议回收时机与方式"}], "suggestions": ["建议1"]}`

export function diagnoseMessages({ text, context }) {
  return [
    { role: 'system', content: DIAGNOSE_SYSTEM },
    { role: 'user', content: `${context ? `【背景设定（供参考）】
${context}

` : ''}【待诊断内容】
${text}` },
  ]
}

// 完整故事时间线：把各章摘要串成细粒度的事件级时间线（新手写作第 5 步使用）
const TIMELINE_SYSTEM = `你是一位小说剧情档案师。请根据给定的各章内容摘要，梳理出整个故事的完整时间线。
要求：
1. 尽量细：按章节顺序逐个展开，每章列出实际发生的关键事件（每条 30 字以内），不要笼统概括；
2. 标注事件的因果关系与前后呼应（哪些事件为后文埋了钩子、哪些是前文钩子的回应）；
3. 最后用 2~3 句话总结当前故事停在哪里、接下来悬而未决的问题是什么；
4. 只基于给定摘要梳理，不编造未发生的情节。
直接输出时间线文本，用清晰的分层格式，不要输出 JSON。`

export function timelineMessages({ chapterSummaries }) {
  const body = (chapterSummaries || [])
    .map((c) => `第${c.no}章：${c.summary || '（无摘要）'}`)
    .join('\n')
  return [
    { role: 'system', content: TIMELINE_SYSTEM },
    { role: 'user', content: `以下是各章内容摘要，请梳理完整时间线：\n\n${body}` },
  ]
}

const FORESHADOW_PLAN_SYSTEM = `你是一位小说节奏策划师。给定当前章节号与未回收伏笔清单，请为每条伏笔规划回收节奏。
【规则】
1. 伏笔需要充分发酵：回收时机一般不早于埋设后 5~15 章（主线伏笔可以更长），切忌刚埋就收；
2. 为每条伏笔给出 min_resolve_chapter（最早允许回收的章节号，整数）与一句节奏建议；
3. 如果伏笔埋设太久、再不回收会让读者遗忘，可以适当提前，但仍需保留至少 3 章发酵期；
4. 不要遗漏任何一条伏笔，不要改变伏笔内容。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"plans": [{"id": "伏笔id", "min_resolve_chapter": 最早回收章号, "advice": "节奏建议"}]}`

export function foreshadowPlanMessages({ currentChapter, active }) {
  const list = (active || [])
    .map((f) => `[id:${f.id}] 第${f.plantedChapter}章埋设：${f.content}（${f.importance}）`)
    .join('\n')
  return [
    { role: 'system', content: FORESHADOW_PLAN_SYSTEM },
    { role: 'user', content: `当前已写到第 ${currentChapter} 章。未回收伏笔：\n${list || '（暂无）'}` },
  ]
}

// 卷级长时记忆：每 20 章把章节摘要链压缩成一段不可变的"卷志"，防止早期剧情被滚动摘要遗忘
const VOLUME_MEMORY_SYSTEM = `你是一位小说档案师。请把给定的一卷章节摘要压缩成一段"卷志"，作为全书的长期记忆永久保存。
要求：
1. 500 字以内，保留本卷的关键事件、重要人物及其状态变化、埋下与回收的伏笔、重要地点与物品；
2. 客观陈述，不评价、不预测；对后续写作仍有约束力的既成事实（人物死亡、誓言、恩怨、身份秘密等）必须保留；
3. 直接输出卷志正文。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"memory": "卷志正文"}`

export function volumeMemoryMessages({ chapters }) {
  const body = (chapters || [])
    .map((c) => `第${c.chapterNo}章 ${c.title}：${c.summary || '（无摘要）'}`)
    .join('\n')
  return [
    { role: 'system', content: VOLUME_MEMORY_SYSTEM },
    { role: 'user', content: `以下是本卷各章摘要，请压缩成卷志：\n\n${body}` },
  ]
}

// ---------- 长篇一致性系统 ----------
// 章节摘要：每章独立压缩成摘要，形成持久化的章节摘要链（供滚动摘要与回看）
const CHAPTER_SUMMARY_SYSTEM = `你是一位小说编辑。请把给定章节内容浓缩成一份章节摘要。
要求：150 字以内，客观罗列本章的关键事件、重要人物行动与章末状态；保留关键数字（金额/价格/余额、物品数量、承诺时长、期限）；不添加原文没有的内容，不预测后续。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"summary": "章节摘要正文"}`

export function chapterSummaryMessages({ text }) {
  return [
    { role: 'system', content: CHAPTER_SUMMARY_SYSTEM },
    { role: 'user', content: `请为以下章节写摘要：\n\n${text}` },
  ]
}

// 滚动摘要：把旧的全书摘要与最新章节摘要合并，维护唯一一份全书进度摘要，随写作滚动更新
const ROLLING_SUMMARY_SYSTEM = `你是一位小说编辑，负责维护一部长篇小说的「滚动摘要」。
请把旧的全书摘要与最新章节摘要合并成一份更新后的全书摘要：
1. 保留旧摘要中的主要人物、核心设定与主线脉络；
2. 并入最新章节的关键事件，并更新人物的最新状态；关键数字（余额、重要物品数量与时长）必须保留，不得在压缩中丢失；
3. 删去对后续写作不再重要的琐碎细节；
4. 总长度控制在 400 字以内，客观陈述，不预测后续。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"summary": "更新后的全书摘要"}`

export function rollingSummaryMessages({ prevSummary, chapterSummary }) {
  return [
    { role: 'system', content: ROLLING_SUMMARY_SYSTEM },
    { role: 'user', content: `旧的全书摘要：\n${prevSummary || '（无，这是开篇章节）'}\n\n最新章节摘要：\n${chapterSummary}` },
  ]
}

// 章后状态回写：从章节内容提取人物状态变化、新人物、时间线事件与叙事视角，更新活档案
const STATE_UPDATE_SYSTEM = `你是一位小说档案管理员。根据最新章节内容，输出人物状态变化与本章时间线事件。
【规则】
1. 只输出本章中明确发生变化的状态（位置、伤势、物品获得/失去、关系变化、生死、能力成长等），无变化的人物不要出现在结果中；状态描述必须带关键数字（余额、物品数量、时长、价格等，以原文为准，如“余额 80 点；临期抑制剂 1 支，约维持 12 小时”）。
2. name 必须与给定名单中的某个姓名完全一致，不要自造既有人物姓名；本章新出场的重要人物放入 new_characters。
3. events 为本章关键事件，按先后顺序；每条 text 30 字以内；time 填该事件在故事内的时间描述（如"当日深夜""三日后""闭关两年后"），原文没有明确时间线索则填空字符串；没有事件则空数组。
4. pov 为本章的叙事视角人物（读者跟随谁的视角看故事），只输出一个姓名；如果是全知视角无固定人物，输出"全知"。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"character_updates": [{"name": "人物姓名", "change": "状态变化描述"}], "new_characters": [{"name": "姓名", "identity": "身份", "personality": "性格"}], "events": [{"text": "事件描述", "time": "故事内时间或空字符串"}], "pov": "视角人物姓名"}`

export function stateUpdateMessages({ characters, text }) {
  const roster = (characters || []).map((c) => c.name).filter(Boolean).join('、') || '（暂无）'
  return [
    { role: 'system', content: STATE_UPDATE_SYSTEM },
    { role: 'user', content: `人物名单：${roster}\n\n最新章节内容：\n${text}` },
  ]
}

// 故事线回写：章后检测本章推进了哪些故事线、是否新开了支线，持久化到项目档案
const STORYLINE_SYSTEM = `你是一位小说故事线管理员。根据最新章节内容与现有故事线清单，输出故事线的最新进展。
【规则】
1. 对每条被本章推进的故事线，输出其名称与最新进展（一句话，含悬而未决的问题）；未被本章触及的故事线不要输出。
2. 本章新开启的故事线（新的支线冲突、新的人物目标线）也要输出，type 取 "主线" 或 "支线"。
3. 名称必须简短（6 字以内）且稳定：已有故事线必须原样沿用清单中的名称，不要改名。
4. 客观基于章节内容，不预测后续。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"storylines": [{"name": "故事线名称", "type": "主线|支线", "progress": "最新进展与未决问题"}]}`

export function storylineUpdateMessages({ storylines, text }) {
  const list = (storylines || []).map((s) => `- ${s.name}（${s.type}）：${s.progress}`).join('\n') || '（暂无已登记故事线）'
  return [
    { role: 'system', content: STORYLINE_SYSTEM },
    { role: 'user', content: `现有故事线：\n${list}\n\n最新章节内容：\n${text}` },
  ]
}

// 检索词扩展：把本章写作方向扩展成一组检索关键词，用于从已写章节中召回相关前文片段（无需 embedding 服务的语义检索近似）
const SEARCH_EXPAND_SYSTEM = `你是一位检索助手。把用户的"本章写作方向"扩展成一组检索关键词，用于从已有章节中召回相关前文片段。
【规则】输出 6~12 个关键词：人物名（含别名）、地点、物品、组织、事件名词；只输出与写作方向相关或设定中出现过的词，不要解释。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"keywords": ["词1", "词2"]}`

export function searchExpandMessages({ instruction, characters, world }) {
  const roster = (characters || [])
    .map((c) => [c.name, ...(c.aliases || [])].filter(Boolean).join('（又名：') + ((c.aliases || []).length ? '）' : ''))
    .join('、')
  return [
    { role: 'system', content: SEARCH_EXPAND_SYSTEM },
    { role: 'user', content: `本章写作方向：${instruction || '（未指定，按当前剧情自然推进）'}\n\n人物名单：${roster || '（暂无）'}\n\n世界观设定（节选）：${(world || '').slice(0, 1500) || '（暂无）'}` },
  ]
}

// 伏笔账本：检测本章新埋的伏笔，以及对既有未回收伏笔的回收/提及（保守判定）
const FORESHADOW_SYSTEM = `你是一位小说伏笔管理员，负责根据最新章节维护伏笔账本。
【规则】
1. new_foreshadows：本章新埋下、需要后文回收的暗示、悬念、未解之谜或承诺；没有则空数组。importance 取 "主线" 或 "支线"。
2. resolved：本章被明确揭示或回收的伏笔的 id。
3. mentioned：本章被提及或推进、但尚未回收的伏笔的 id。
4. 保守判定：拿不准时宁可标 mentioned 也不要标 resolved，不要错标、多标。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"new_foreshadows": [{"content": "伏笔内容描述", "related_chars": ["相关人物"], "importance": "主线"}], "resolved": ["伏笔id"], "mentioned": ["伏笔id"]}`

export function foreshadowMessages({ active, text }) {
  const list = (active || []).map((f) => `[id:${f.id}] ${f.content}`).join('\n') || '（暂无未回收伏笔）'
  return [
    { role: 'system', content: FORESHADOW_SYSTEM },
    { role: 'user', content: `当前未回收伏笔：\n${list}\n\n最新章节内容：\n${text}` },
  ]
}

// 一致性校验：独立质检 agent，对照设定、人物状态、伏笔与大纲检查指定章（含大纲偏离检测）
const CONSISTENCY_SYSTEM = `你是一位严格的小说一致性审校员，检查指定章号的章节是否违背给定设定。
检查项（发现问题时才报告，type 用问题名而非检查项名）：
1. 设定冲突：与世界观规则或前文既成事实矛盾；
2. 人物矛盾：人物性格、能力、状态与记录矛盾（如死人复活、伤势瞬愈、性格突变）；
3. 伏笔矛盾：与未回收伏笔矛盾或擅自提前揭示答案（遵循【本章写作方向】的揭示不算矛盾）；
4. 大纲偏离：本章内容与大纲中“本章应写的剧情节点”不符（写了属于其他章的内容、跳过本章关键节点）；内容与本章大纲相符、或遵循作者指定的【本章写作方向】/【场景清单收束点】即为合格，不算偏离；如有，在 outline_drift 中描述；
5. 节奏过快：一章内塞入过多关键事件、跳过本应展开的过程，或过早回收伏笔（尤其是仍在保护期内的伏笔）；
6. 数字/持有物矛盾：金额、价格、余额、物品数量、承诺时长、伤势等与人物当前状态记录或既定设定冲突（如状态记余额 80、药价 480，正文却写“耗尽八十点买来的药”），以“设定冲突”type 报告。
severity 分级：hard = 事实性硬矛盾（检查项 1/2/3/6 及实质性大纲偏离）；soft = 可辩论的节奏/密度/措辞张力类判断（检查项 5 及“略显模糊/存在张力”式问题）；拿不准时按 soft。
没有问题时 issues 为空数组；每条简洁说明问题与依据，不要挑剔文风类小问题；被检章号已明确给出，禁止输出“若此章为第X章/若非第X章”式猜测性判断。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"issues": [{"type": "设定冲突|人物矛盾|伏笔矛盾|节奏过快|其他", "severity": "hard|soft", "description": "问题描述"}], "outline_drift": "大纲偏离描述，没有则为空字符串"}`

export function consistencyCheckMessages({ world, characters, outline, foreshadows, text, chapterNo, instruction = '', scenePlan = '' }) {
  const chars = (characters || []).map((c) => `${c.name}${c.status ? `（当前状态：${c.status}）` : ''}`).join('\n') || '（暂无）'
  const hooks = (foreshadows || []).map((f) => `- ${f.content}`).join('\n') || '（暂无）'
  return [
    { role: 'system', content: CONSISTENCY_SYSTEM },
    {
      role: 'user',
      content: `【被检章节】第 ${chapterNo || '?'} 章\n\n【世界观设定】\n${world || '（暂无）'}\n\n【人物名单与当前状态】\n${chars}\n\n【本章对应大纲窗口】\n${outline || '（暂无）'}${instruction ? `\n\n【本章写作方向（作者指定，最高优先级；遵循它的揭示与推进不算偏离/提前揭示）】\n${instruction}` : ''}${scenePlan ? `\n\n【场景清单收束点（作者确认；章末落在最后一个场景的钩子上即视为合格收束，其后的少量余韵描写不算偏离）】\n${scenePlan}` : ''}\n\n【未回收伏笔】\n${hooks}\n\n【第 ${chapterNo || '?'} 章正文】\n${text}`,
    },
  ]
}

// 长篇章节初稿：上下文由「大纲 + 长时记忆 + 滚动摘要 + 前章摘要 + 前文尾部 + 伏笔提醒（含保护期）+ 检索片段」组装，而不是全量原文
// participants：本章出场人物名单（场景清单阶段确定）；给了就只注入这些人的完整档案，其余人物一行带过并禁止出场，省上下文防串场；为空则全量注入（旧行为）
// 逐场景扩写（multiScene）：每次只写一个场景（600~900 字），根治单次生成 2500 字时后段压缩、过程概述的问题；
//   scenePlan 传当前场景，upcoming 传后续场景预告；withTitle 只在首段为 true（标题行由首段输出）。
export function longFormDraftMessages({ chapterNo, synopsis, world, worldBlockText, characters, participants, outline, longTerm, rollingSummary, prevChapterSummary, tail, foreshadows, passages, instruction, forbidden, storylines, povRule, scenePlan, chronicles, style, rules, reference, volumeStrategy, chapterPosition, samples, multiScene, upcoming, withTitle = true, chapterTask, lastScene }) {
  const inScene = Array.isArray(participants) && participants.length ? new Set(participants) : null
  const cardOf = (c) => `${c.name}${c.aliases ? `（又名：${c.aliases}）` : ''}：${[c.identity, c.personality, c.status ? `当前状态：${c.status}` : ''].filter(Boolean).join('，')}`
  const chars = (characters || []).filter((c) => !inScene || inScene.has(c.name)).map(cardOf).join('\n')
  const offScene = inScene ? (characters || []).filter((c) => !inScene.has(c.name)).map((c) => c.name).join('、') : ''
  const hooks = (foreshadows || [])
    .map((f) => {
      const guard = f.minResolveChapter && chapterNo < f.minResolveChapter ? `保护期内，第 ${f.minResolveChapter} 章前禁止回收，只可铺垫渲染` : '已到回收窗口，可自然回收'
      return `- ${f.content}（${guard}）`
    })
    .join('\n')
  const passageText = (passages || []).map((p) => `【出自：${p.title}】\n${p.text}`).join('\n\n')
  let ctx = ''
  if (scenePlan) {
    ctx += multiScene
      ? `\n\n【当前场景（本段只写这一个场景，对话、动作与过程写足，不得推进到后续场景）】\n${scenePlan}`
      : `\n\n【本章场景清单（用户已确认，逐场景展开写作，不要跳过或合并场景，每个场景写足过程）】\n${scenePlan}`
  }
  if (multiScene && upcoming) ctx += `\n\n【后续场景预告（本段不写，仅保持方向一致，段末自然落到下一场景的入口）】\n${upcoming}`
  if (chapterTask) ctx += `\n\n【本章核心任务（只允许完成这一个任务，禁止顺手推进后续章节的任务）】\n${chapterTask}`
  if (instruction) ctx += `\n\n【本章写作方向（最高优先级，必须遵循）】\n${instruction}`
  if (synopsis) ctx += `\n\n【故事梗概】\n${synopsis}`
  if (world && !worldBlockText) ctx += `\n\n【世界观设定】\n${world}`
  if (chars) ctx += `\n\n【本章出场人物（含当前状态，必须保持一致）】\n${chars}`
  if (offScene) ctx += `\n\n【本章不出场的人物】${offScene}——以上人物本章不应出场或被提及行动，除非剧情确有必要的例外。`
  if (worldBlockText) ctx += `\n\n【世界观设定（本章相关块，含永不省略的规则/禁忌块）】\n${worldBlockText}`
  if (chronicles) ctx += `\n\n【人物编年史（各人物关键经历，写作不得与之矛盾）】\n${chronicles}`
  if (outline) ctx += `\n\n【本章细纲（只写本窗口内的剧情节点，后续章节的剧情节点一律留给后续章节，严禁提前写）】\n${outline}`
  if (volumeStrategy) ctx += `\n\n【本卷战略（本章属于本卷，写作须服务于它，卷末才允许落在卷级钩子上）】\n${volumeStrategy}`
  if (chapterPosition) ctx += `\n\n【本章结构定位：${chapterPosition}】本章叙事节奏须匹配该定位——起=铺垫开局蓄势，承=推进发展，转=制造方向性变化与冲突升级，合=阶段收束落钩，过渡=衔接换挡；不得写成与定位不符的节奏（如「转」章毫无转折、「承」章抢收结局）。`
  if (longTerm) ctx += `\n\n【长时记忆（全书重要事件沉淀，写较早章节时以此为准）】\n${longTerm}`
  if (rollingSummary) ctx += `\n\n【全书滚动摘要（近期剧情回顾）】\n${rollingSummary}`
  if (prevChapterSummary) ctx += `\n\n【上一章摘要】\n${prevChapterSummary}`
  if (hooks) ctx += `\n\n【未回收伏笔（可自然推进，不要擅自回收）】\n${hooks}`
  if (storylines && storylines.length) {
    ctx += `\n\n【现有故事线（写作须服务于其中，只推进不擅自完结）】\n` + storylines.map((s) => `- ${s.name}（${s.type}）：${s.progress}`).join('\n')
  }
  if (passageText) ctx += `\n\n【相关前文片段（检索所得，供细节与文风参考，禁止照抄）】\n${passageText}`
  if (reference) ctx += `\n\n【参考作品的叙事功能（结构层借鉴）】\n${reference}\n硬约束：严禁复用或谐音改写参考作品中的人物名/地名/设定名，只可借鉴其叙事功能与节奏模式；你笔下的人物与设定必须全部原创。`
  return [
    {
      role: 'system',
      content:
        `你是一位职业小说作者，正在撰写一部长篇连载小说的第 ${chapterNo} 章。
【规则】
1. 篇幅${multiScene ? '本段约 600~900 字（只写当前场景，写足对话与细节）' : '约 2500 字'}；严格紧接前文尾部继续，严禁重复或复述前文内容${multiScene ? '（前文尾部中已出现的句子与段落，本段一个字都不得再现，直接从新的动作/画面开始）' : ''}；
2. 必须与世界观、人物当前状态、既有剧情保持一致；不要凭空捏造新的重要人物与设定；细纲中的核心道具/地点/组织必须使用细纲原名，严禁改名或改换形态（如细纲写“罗盘”就不得写成“金属片”）；人物言行必须符合其身份定位与当前状态，严禁表现超出定位的能力、知识或镇定（如需铺垫只能以模糊、不受控的细节一闪而过）；人物内心独白与词汇须匹配其成长环境与认知水平，严禁出现超越背景的术语或凭空顿悟（认知飞跃必须由正文已写的感官证据一步步推出）；
3. 如有细纲，按细纲完成本章事件，章末落在钩子上；本章必须先完整写到本章细纲/核心任务的最后一个剧情节点（该节点的过程与结果都要落地，不得把它挪给下一章），然后止步于该节点，严禁写出该节点之后的内容（包括下一章的开头与后续章的揭秘），章末钩子落在本章最后节点的悬念上；最后一段必须收在悬念上（未解的问题、迫近的威胁或反转的预兆），严禁平铺直叙收尾；${chapterTask ? '本章只允许完成【本章核心任务】中的这一个任务，禁止顺手完成后续章节的任务；' : ''}
4. ${
          withTitle
            ? '第一行先输出本章标题（10 字以内，概括本章核心事件或悬念，不带"第X章"前缀、不加引号），第二行起输出正文；除此之外不要输出任何解释性文字；'
            : '直接输出正文，不要输出标题与任何解释性文字；'
        }
5. 控制叙事节奏：${multiScene ? '只写当前场景，不压缩过程、不跳过应展开的对话与动作；' : '本章只推进 1~2 个关键事件，不要压缩过程、跳过应展开的内容；'}严格遵守伏笔保护期，保护期内的伏笔只能铺垫渲染，绝不能回收或揭示答案。
6. 叙事视角：以主角线为主；${povRule || '如需使用非主角视角，连续不得超过 3~5 章，篇幅也应明显短于主角线。'}
7. 信息揭示层级：本章只允许揭示本章细纲钩子所允许层级的信息——属于后续章节的揭秘点（具体代码/编号、身份确认、NPC 明示真相、实质性异象等）本章只能以模糊暗示呈现（欲言又止的眼神、说不出口的半句话、一闪而过的异常细节），严禁通过对话、道具或异象实质性揭示；
8. 生理与物理状态连续：人物伤势/病情/体温/位置等状态必须与前文尾部及人物当前状态记录保持连续，短时间内不得出现违背常识的跳变（如高烧滚烫数分钟内变为尸体般冰冷）；
9. 反应义务：视角人物亲眼目睹的物理异常、超自然景象或迫在眉睫的危险，必须给出相应的心理与行动反应（震惊、合理化、戒备或准备对策），决策须匹配当前危机的紧迫程度，不得视而不见、无动于衷；
10. 落笔前止步自检：本场景写完后先自查——是否已越过本章细纲/核心任务的最后一个剧情节点？若有任何超出部分一律不写，收在本节点上的悬念处即停；章末不得以静态的环境描写或被动观望收尾（如"窗外安静下来""它在等待"），必须落在未解的问题、迫近的威胁或反转的预兆上；
11. 数字台账：金额/价格/余额/物品数量/承诺时长/倒计时/伤势数值等，一律以人物当前状态与正文已出现的数字为准，落笔前先核对记录再写，严禁凭空捏造或漂移（如状态记余额 80，就不得写成耗尽八十点买价 480 的药；倒计时须逐秒连贯，不得跳变）；
12. 严禁严重文本重复：同一句话、同一段落或高度相似的描写（含同一比喻、同一动作刻画）不得在本章内重复出现，跨场景呼应同一意象时换措辞，只保留最完整的一处。` +
        NO_AI_FLAVOR_RULE +
        styleBlockOf({ style, forbidden, rules, samples }),
    },
    { role: 'user', content: `前文尾部（请紧接其后续写）：\n\n${tail}${ctx}${lastScene ? '\n\n【末场景强制收束】这是本章最后一个场景：写完本场景即全文结束，必须落在本章最后节点的悬念上立即收尾，严禁再写任何超出本场景的内容。落笔前完成止步自检（规则10）：若已越过本章最后节点，删去超出部分，收在节点的悬念上。' : ''}\n\n请撰写第 ${chapterNo} 章正文。` },
  ]
}

// 场景清单（两段式写作第一步）：先让 AI 规划本章场景，用户确认后再扩写正文，根治"进程太快/跳过应展开的场景"
// 同时让 AI 圈定本章出场人物（participants），供初稿按需注入人物档案，而不是全书人物全量进上下文；
// 场景数随每章目标字数自适应（短章少场景，防事件过载），未给字数时默认 3~5。
const scenePlanSystem = (range, min) => `你是一位职业小说作者，正在为下一章规划场景清单。
【规则】
1. 必须输出 ${range} 个场景，场景依次衔接，每个场景推进一小步剧情或情感变化，合起来完成本章应写的内容；少于 ${min} 个视为不合格——剧情再简单也要拆成递进的过程场景（铺垫→推进→落钩），不得一步带过；
2. 每个场景用一句话描述（30 字以内）：在哪里、谁参与、发生什么、落在什么钩子上；细纲中的核心道具/地点必须用原名；
3. 必须紧接上一章结尾，遵守伏笔保护期与故事线约束；保护期内的伏笔只能铺垫，不得安排揭示；
4. 控制节奏：不要把多个重大事件塞进一章，留出对话与细节展开的空间；场景清单的终点必须精确停在【本章对应细纲】的最后一个剧情节点上——最后一个场景就落在该节点的悬念上，严禁规划该节点之后的任何发展（哪怕只是一步），即使你觉得剧情顺势该往下走也必须留给下一章；
5. participants 列出本章实际出场的全部人物姓名，必须与给定人物名单中的姓名完全一致，不得自造姓名；不出场的人物不要列入；
6. locations 列出本章场景涉及的地点、势力与组织名称（来自既有设定的用原名，新出现的用简短名称）；
7. proposals：仅当本章存在影响后续剧情走向的重大分支（重要人物去留、阵营抉择、关键秘密是否揭示等）时才给出，最多 1 条，需要作者拍板；普通剧情推进一律自行按细纲与故事线决定，不要给提案；没有任何分支时 proposals 必须是空数组。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容（scenes 必须为 ${range} 项）：
{"scenes": [{"title": "场景标题（6字以内）", "summary": "这个场景发生什么（30字以内）"}], "participants": ["出场人物姓名"], "locations": ["地点/势力"], "proposals": [{"question": "需要作者拍板的剧情分支（40字以内）", "options": ["方向A（20字以内）", "方向B（20字以内）"]}]}`
// 场景数随每章目标字数自适应：约每场景 900 字，短章少场景防事件过载，未给字数时默认 3~5 个下限
export function scenePlanMessages({ chapterNo, synopsis, outline, rollingSummary, prevChapterSummary, storylines, foreshadows, povRule, instruction, characters, chapterPosition, chapterTask, chapterWords, volumeStory }) {
  const roster = (characters || []).map((c) => c.name).filter(Boolean).join('、') || '（暂无）'
  const hooks = (foreshadows || [])
    .map((f) => {
      const guard = f.minResolveChapter && chapterNo < f.minResolveChapter ? `保护期内，第 ${f.minResolveChapter} 章前禁止回收` : '可自然回收'
      return `- ${f.content}（${guard}）`
    })
    .join('\n')
  let ctx = ''
  if (synopsis) ctx += `\n\n【故事梗概】\n${synopsis}`
  if (outline) ctx += `\n\n【本章对应细纲】\n${outline}`
  if (rollingSummary) ctx += `\n\n【全书滚动摘要】\n${rollingSummary}`
  if (prevChapterSummary) ctx += `\n\n【上一章摘要（本章须紧接其后）】\n${prevChapterSummary}`
  if (hooks) ctx += `\n\n【未回收伏笔】\n${hooks}`
  if (storylines && storylines.length) {
    ctx += `\n\n【现有故事线（只推进不擅自完结）】\n` + storylines.map((s) => `- ${s.name}（${s.type}）：${s.progress}`).join('\n')
  }
  if (instruction) ctx += `\n\n【用户指定的本章方向（必须遵循）】\n${instruction}`
  if (chapterTask) ctx += `\n\n【本章核心任务（场景清单只服务于这一个任务，不得把后续章节的任务提前安排进场景）】\n${chapterTask}`
  if (volumeStory) ctx += `\n\n【所在卷的本卷故事（场景应服务本卷这件具体故事，不得漂移到跨卷主线或提前写后续卷的事）】\n${volumeStory}`
  if (chapterPosition) ctx += `\n\n【本章结构定位：${chapterPosition}】场景规划须匹配该定位的节奏（起=铺垫蓄势，承=推进发展，转=方向性变化，合=阶段收束，过渡=衔接换挡）`
  if (povRule) ctx += `\n\n【视角约束】${povRule}`
  const hint = chapterWords ? Math.min(5, Math.max(2, Math.round(chapterWords / 900))) : 0
  const range = hint ? (hint >= 5 ? '5' : `${hint}~${hint + 1}`) : '3~5'
  return [
    { role: 'system', content: scenePlanSystem(range, hint || 3) },
    { role: 'user', content: `请为长篇小说的第 ${chapterNo} 章规划场景清单。${ctx}\n\n【人物名单（participants 只能从中选取）】\n${roster}` },
  ]
}

// 卷战略规划：每卷第一章开写前规划本卷的目标与节奏（基于梗概/细纲/滚动摘要），写作时注入本章上下文。
const VOLUME_PLAN_SYSTEM = `你是一位资深小说编辑，正在为一部长篇连载规划新的一卷。
【核心原则：新的一卷 = 一个能独立讲完的新故事】不要把上一个故事无限延长；本卷应有一个本卷限定的具体事件（arc_story）：新的对手/新的局面/明确目标，在本卷内完整解决，卷末只留钩子。
【规则】
1. title：卷名，8 字以内，概括本卷核心事件或主题；
2. arc_story：本卷故事 100~150 字，写清本卷那件具体的事（谁与谁、因为什么、争什么、在本卷内如何一步步升级并收尾），事件类型与对手应与前面各卷明显不同，不得重复已写过的同类事件或同一对手；
3. strategy：本卷战略 200 字以内，包含：本卷要达成什么目标、主线（暗线）推进到哪一步、卷末落在什么钩子上；
4. arc：本卷起承转合结构，带章节范围（章号用卷内坐标，从本卷第 1 章算起），如「铺垫(第1-5章)→发展(第6-12章)→高潮(第13-17章)→收束(第18-20章)」；
5. emotion：本卷情感走向，如「压抑→憋屈→爆发→短暂喘息」；
6. 必须与既有细纲和滚动摘要衔接，不要提出与设定冲突的方向。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"title": "卷名", "arc_story": "本卷具体故事", "strategy": "本卷战略", "arc": "起承转合结构（带章节范围）", "emotion": "情感走向"}`

export function volumePlanMessages({ volumeNo, synopsis, outline, rollingSummary, storylines, prevVolumes }) {
  let ctx = ''
  if (synopsis) ctx += `\n\n【故事梗概】\n${synopsis}`
  if (outline) ctx += `\n\n【本卷对应细纲（开头部分）】\n${outline}`
  if (rollingSummary) ctx += `\n\n【全书滚动摘要（截至上一卷末）】\n${rollingSummary}`
  if (prevVolumes) ctx += `\n\n【前面各卷已讲过的故事（本卷事件类型与对手必须与之不同，不得重复）】\n${prevVolumes}`
  if (storylines && storylines.length) ctx += `\n\n【现有故事线】\n` + storylines.map((s) => `- ${s.name}（${s.type}）：${s.progress}`).join('\n')
  return [
    { role: 'system', content: VOLUME_PLAN_SYSTEM },
    { role: 'user', content: `请为这部长篇的第 ${volumeNo} 卷规划卷名与卷战略。${ctx}` },
  ]
}

// 世界观拆块（世界手册结构化）：把整段自由文本世界观拆成结构化块；规则/禁忌类单独成块（写作时永不省略）
const WORLD_SPLIT_SYSTEM = `你是一位资深小说编辑，负责把整段世界观设定拆成结构化的世界手册块。
【规则】
1. 每个块是一个独立主题：一个地点、一个势力/组织、一条力量体系规则、一组禁忌或一类核心设定；
2. kind 只有两种：涉及世界运行规则、力量体系限制、禁忌红线的一律为"规则"（写作时永不省略），其余为"设定"；
3. 块内容保持原文信息完整，不要概括丢信息；每块 300 字以内，过长就拆成两块；
4. aliases 给该块的常用别称/简称（逗号分隔，可留空）。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"blocks": [{"name": "块名（8字以内）", "aliases": "别称1,别称2", "kind": "规则或设定", "content": "该块的完整设定内容"}]}`

export function worldSplitMessages({ world }) {
  return [
    { role: 'system', content: WORLD_SPLIT_SYSTEM },
    { role: 'user', content: `请把以下世界观设定拆成结构化块：\n\n${world}` },
  ]
}

// 拆书工作台：把参考小说拆成可学习的叙事功能资产（全局可召回、书级可绑定）。
// 防照搬核心：产出只保留功能位/关系模式/弧线/节奏模式等结构信息，
// 强制 AI 不得输出原作任何专名（人名/地名/功法/组织），看不到的东西抄不走。
const BOOK_ANALYZE_SYSTEM = `你是一位资深写作教练，负责把一部参考小说拆解成可供其他作者结构学习的「叙事功能」资产。
【核心原则：防照搬，最高优先级】
绝对禁止输出原文中的任何专有名词：人名、地名、功法名、组织名、书名、绰号一律不得出现；
所有专名必须替换成功能性描述（如"导师型角色""主角的初始据点""核心成长体系"）。
【分析维度】
1. work_function：200 字以内，概括这部作品为读者提供了什么叙事体验（爽点类型、情感钩子、成长母题）；
2. character_functions：核心人物的叙事功能位 4~8 条：{slot: 功能位（如导师型/对手型/丑角位/镜像型）, relation: 与主角的关系模式, arc: 成长或结局走向}；
3. pacing_patterns：爽点推进模式 3~6 条，每条是可复用的节奏套路（如"压抑→反转→当众验效"）；
4. techniques：值得借鉴的写法 3~5 条，只谈结构与技法，不引用原文语句。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"work_function": "...", "character_functions": [{"slot": "...", "relation": "...", "arc": "..."}], "pacing_patterns": ["..."], "techniques": ["..."]}`

export function bookAnalyzeMessages(samples) {
  const body = samples.map((s, i) => `【片段${i + 1}】\n${s}`).join('\n\n')
  return [
    { role: 'system', content: BOOK_ANALYZE_SYSTEM },
    { role: 'user', content: `以下是这部参考小说的采样片段（覆盖全书开头、中间与结尾），请拆解：\n\n${body}` },
  ]
}

// ---------- 章节审核模块（GLM 审核 + DeepSeek 重写） ----------
// 五章连贯性审核：只查硬性连贯问题，明确禁止挑刺（文风/用词/修辞/节奏等主观问题一律不算问题）
const CHAPTER_REVIEW_SYSTEM = `你是一位资深小说编辑，负责对最近若干章做一次「剧情连贯性审核」。
【审核范围（只查这些，其余一律不管）】
1. 设定冲突：违背世界观规则或前文既成事实；
2. 时间线矛盾：事件先后、时间跨度与给定时间线冲突；
3. 人物矛盾：人物状态、能力、性格前后不一致（如死人复活、伤势瞬愈、立场突变无铺垫）；
4. 剧情断裂：相邻章节之间情节接不上、场景或目标无故跳变；
5. 伏笔误处理：未回收的伏笔被提前揭示，或已回收的伏笔被当作未发生；
6. 结构错位：若给定各章的起承转合定位，检查章节实际内容是否与之明显背离（如定位「转」的章通篇没有任何方向性变化或冲突升级、定位「合」的章既不收束阶段冲突也不落钩子）；只查明显背离，定位缺失时跳过此项。
【严格禁止的挑刺行为】
- 不得指出文风、用词、修辞、对话风格、节奏快慢、篇幅长短等主观问题（结构错位指内容与既定定位的客观背离，不属于此列）；
- 不得建议"可以写得更好"式的优化项；只有硬性的逻辑/事实矛盾才算问题；
- 没有硬性矛盾时必须判定通过，不要为了凑建议而编造问题。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"pass": true或false, "analysis": "300字以内的整体连贯性分析（客观陈述这五章讲了什么、衔接是否顺畅）", "suggestions": [{"chapter_no": 章号数字, "problem": "该章存在的硬性矛盾（含依据）", "fix_prompt": "300~500字的修改提示词：写明该章需要修正什么、必须保持与前后文哪些内容一致、重写时的注意事项"}]}
没有问题时 suggestions 为空数组且 pass 为 true。`

export function chapterReviewMessages({ world, timeline, rollingSummary, characters, foreshadows, beforeSummary, chapters, positions, truths }) {
  const chars = (characters || []).map((c) => `${c.name}${c.status ? `（当前状态：${c.status}）` : ''}`).join('\n') || '（暂无）'
  const hooks = (foreshadows || []).map((f) => `- ${f.content}`).join('\n') || '（暂无）'
  const posText = (positions || []).filter((p) => p.position).map((p) => `第${p.chapterNo}章：${p.position}`).join('，')
  const body = (chapters || []).map((c) => `【第 ${c.chapterNo} 章 ${c.title || ''}】\n${c.content}`).join('\n\n')
  // 圣经真相层仅供审核对照（判断终极秘密是否被提前揭示），该上下文只走审核请求，不进写作提示词（真相隔离）
  const truthText = (truths || []).map((t) => `- ${t.kind}：${t.truth}${t.minResolveChapter ? `（第 ${t.minResolveChapter} 章前严禁揭示）` : ''}`).join('\n')
  return [
    {
      role: 'system',
      content: CHAPTER_REVIEW_SYSTEM + (truthText
        ? '\n【附加检查项：终极秘密提前揭示】\n7. 若给定【圣经真相对照表】，检查章节是否提前揭示或过度暴露了其中的真相（把真相直接写出、人物不该知道却知道了、暗示过于直白等同揭示）；发现时在 suggestions 中报告，fix_prompt 要求改为只留蛛丝马迹。'
        : ''),
    },
    {
      role: 'user',
      content: `【世界观设定（严禁违背）】\n${world || '（暂无）'}\n\n【全书事件时间线（严禁时间矛盾）】\n${timeline || '（暂无）'}\n\n【人物当前状态】\n${chars}\n\n【未回收伏笔】\n${hooks}\n\n【审核窗口之前的剧情摘要（须与之衔接）】\n${beforeSummary || '（这是开篇章节，无前文）'}\n\n【全书滚动摘要】\n${rollingSummary || '（暂无）'}\n\n【各章结构定位（起承转合）】\n${posText || '（细纲未标注定位，跳过结构错位检查）'}${truthText ? `\n\n【圣经真相对照表（仅用于判断是否提前揭示，不得当作应写内容）】\n${truthText}` : ''}\n\n【待审核章节全文】\n${body}`,
    },
  ]
}

// 单章定向重写：只改审核建议指出的问题，其余内容尽量保持原样（由 DeepSeek 执行，复用书风规则）
export function chapterRewriteMessages({ chapterNo, title, content, fixPrompt, world, prevSummary, nextSummary, forbidden, style, rules, samples, characters }) {
  const chars = (characters || []).map((c) => `${c.name}${c.status ? `（当前状态：${c.status}）` : ''}`).join('\n') || '（暂无）'
  return [
    {
      role: 'system',
      content:
        `你是一位职业小说作者，正在修订长篇连载小说的第 ${chapterNo} 章。
【规则】
1. 严格按照【修改指令】重写本章：指令列出的每一个问题都必须逐一修掉（缺失的剧情节点必须补写到位，与状态档矛盾的描写必须以状态档为准纠正），重写后不得残留指令中列出的任何问题；其余情节、对话、场景尽量保持原样，不要大改无关内容；
2. 重写后必须与【上一章摘要】自然衔接，也不能破坏【下一章摘要】所依赖的既成事实；
3. 必须与世界观设定保持一致；人物状态与关键数字（余额、物品数量、时长、价格）必须以【人物当前状态】为准，不得自相矛盾；
4. 篇幅与原章相当；第一行输出章节标题（沿用「${title || '原标题'}」或按修改后内容微调，不带"第X章"前缀、不加引号），第二行起输出完整正文；除此之外不要输出任何解释性文字。` +
        NO_AI_FLAVOR_RULE +
        styleBlockOf({ style, forbidden, rules, samples }),
    },
    {
      role: 'user',
      content: `【修改指令】\n${fixPrompt}\n\n【上一章摘要（重写后须紧接其后）】\n${prevSummary || '（这是第一章，无前文）'}\n\n【下一章摘要（重写不得破坏的后续既成事实）】\n${nextSummary || '（这是最新章节，无后文）'}\n\n【人物名单与当前状态（含关键数字，重写不得违背）】\n${chars}\n\n【世界观设定】\n${world || '（暂无）'}\n\n【本章原文】\n${content}\n\n请输出修订后的完整章节。`,
    },
  ]
}


// 灵感选题（向导页「灵感」按钮）：为所选题材生成 5 个开局选题，每个选题按"写清三件事"的初始提问格式输出。
// 灵感选题生成：5 个纯题材选题（不联网搜热梗）；题材世界模板仅作低权重参考（不定死世界），
// 用户选定灵感后由开书流程生成该书完整世界观。
// 发散骰：高温采样只增加用词噪声、不增加概念多样性——模型对题材有强先验，相同提示词每批都会收敛到
// 概率最高的那几个套路（「换一批」只是重采样同一分布）。所以每批随机抽 2~3 个正交约束轴注入提示词，
// 把随机性从「措辞层」提升到「概念层」，跨批选题才真正拉开差异。
// 各轴选项刻意保持方向中性：创意内核轴的「颠覆性反转」只是众多方向之一，与成长/情感/命运等正向方向平级，
// 避免把「脑洞大」窄化成黑暗反转流（脑洞大 = 发散、不落俗套，不等于必须黑深残）。
// 叙事基调轴覆盖明亮→中性→悬疑→暗黑的完整光谱（20 项均衡分布），黑暗只是少数平级选项，不再主导气质。
const IDEA_DICE = [
  { axis: '主角起点', options: ['被本阵营通缉的叛徒', '刚被顶替身份/功绩的无名者', '负责善后的底层清理工', '记忆被篡改的实验体', '敌方安插多年的暗子', '上一代传奇的失败继承者', '规则漏洞的意外受益人'] },
  { axis: '创意内核', options: ['新颖的成长/考验体系（靠自身努力一步步成长）', '独特的世界运行规则', '别致的主角起点/身份', '巧妙的核心人物关系', '温暖真挚的情感内核', '宏大的命运/时代命题', '颠覆性的反转设定'] },
  { axis: '叙事基调', options: ['热血燃向', '励志昂扬', '轻松诙谐', '沙雕欢脱', '温馨治愈', '甜蜜浪漫', '平静日常', '市井烟火', '细腻文艺', '写实冷峻', '慢热沉稳', '宏大史诗', '悬疑烧脑', '紧张刺激', '神秘诡谲', '阴郁权谋', '冷硬残酷', '悲情苍凉', '荒诞怪谈', '黑色幽默'] },
  { axis: '结构花样', options: ['倒计时开局（限期解决否则大祸）', '倒叙开局（先亮结局再回溯）', '双主角对立视角', '循环/重复的一天', '开局即巅峰后坠落', '群像多线收束', '任务清单驱动'] },
]
// 每批随机抽 2~3 个轴、每轴随机取一个选项，拼成「本批发散骰」约束串
export function inspirationSeed() {
  const axes = [...IDEA_DICE].sort(() => Math.random() - 0.5).slice(0, 2 + Math.floor(Math.random() * 2))
  return axes.map((a) => `${a.axis}=${a.options[Math.floor(Math.random() * a.options.length)]}`).join('；')
}

export function inspirationMessages(genre, worldview, seed) {
  const seedBlock = seed
    ? `\n【本批发散骰（随机约束，必须遵守）】\n${seed}\n5 个选题都必须落在这些约束的交集内：每个选题以其中至少一个约束为核心展开，且 5 个选题分别侧重不同的约束组合，不得全部挤在同一个约束上。\n`
    : ''
  return [
    {
      role: 'system',
      content: `你是一位脑洞极大的资深网文策划。下面给出「${genre}」题材的世界模板，它只是该题材常见套路的一份参考模板，不是定死的设定：你可以借用、改造、混搭、反转甚至完全抛弃它另起炉灶，不需要忠于模板，更不得把模板里的措辞当成硬约束。
【世界模板（参考用，权重低）】
${worldview}${seedBlock}
构思 5 个彼此差异足够大的长篇小说开局选题，要求：
1. 纯题材：只依赖题材自身套路/反套路，不含现实热梗与热点话题；除题材本身为都市/现实外，不得移植职场KPI、公司制度、AI绩效等现代社会元素；
2. 脑洞要大 = 发散性思维，而非黑暗/反转/致郁：每个选题都要有一个让人眼前一亮、意料之外又情理之中的核心创意点，方向不限——新颖的世界规则、独特的成长路径、别致的主角设定、巧妙的核心关系皆可；既可以是颠覆性的设定，也可以是靠主角自身努力、经受重重考验一步步成长的那种扎实而真挚的故事。唯一标准是不落俗套、有新鲜感，严禁把"脑洞大"窄化成必须黑深残或必须反转；5 个选题的核心创意点要落在不同方向，拒绝安全平庸、循规蹈矩的点子；
3. 反套路：先在心里列出该题材最高频、你最先想到的 2~3 种开局（如废柴退婚流、重生复仇流、系统签到流），然后主动规避它们——这批选题不得出现这些套路，哪怕换皮也不行；
4. 5 个选题的世界观框架、主角身份、核心冲突、金手指/钩子互不重复，不得只是换个名字的同一套路；
5. 每个选题写清三件事：① 固定人设（主角姓名 + 身份 + 1~2 个核心关系）；② 固定背景（一句话世界观/设定，由你自由设计，不必照搬模板）；③ 想让 AI 修补的逻辑漏洞或合理化诉求：2~3 个"为什么"。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"ideas":[{"title":"选题名（12 字内）","brief":"完整初始提问文本"}]}
brief 必须按此模板写成一段话：
我想写一部…的小说。主角…，…
固定人设：…；固定背景：…。
请帮我把故事合理化：为什么…、为什么…`,
    },
    { role: 'user', content: `题材：${genre}。世界模板仅供参考可自由突破${seed ? `；本批发散骰约束：${seed}` : ''}。请给出 5 个脑洞足够大、世界观彼此差异明显、主动规避该题材高频套路的纯题材选题。` },
  ]
}

// 落库前预检（初稿生成后、存档前的一次校订调用）：对照状态记录检查数字台账/生死连续/收束点/严重文本重复，发现问题最小修订；
// 把事后审校前移，硬矛盾在入库前就被修掉，而不是等章后校验标红。
export function draftSelfCheckMessages({ chapterNo, text, characters, scenePlan, outline }) {
  const chars = (characters || []).map((c) => `${c.name}${c.status ? `（当前状态：${c.status}）` : ''}`).join('\n') || '（暂无）'
  return [
    {
      role: 'system',
      content: `你是一位小说校订编辑，负责对刚写好的章节做落库前预检与最小修订。
【检查项】
1. 数字台账：金额/价格/余额/物品数量/承诺时长/倒计时/伤势数值等，是否与【人物当前状态】及本章前文自洽，不得漂移或跳变；
2. 生死与状态连续：人物生死、伤势、位置等不得与状态记录或本章前文跳变（如记录已死亡却写存活体征）；
3. 收束点：章末是否越过【收束点】最后一个剧情节点（越过则删去超出部分，收在节点悬念上）；
4. 严重文本重复：同一句话/同一段落或高度相似的描写（含同一比喻、同一动作刻画）是否在本章内重复出现，重复则改写或删并，只保留最完整的一处。
【修订原则】最小修订：只改有问题的句子/段落，其余保持原样；篇幅相当；不得新增剧情；第一行保留章节标题行。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"ok": true或false, "problems": ["问题简述（无问题为空数组）"], "revisedText": "修订后完整章节正文（ok 为 true 时填空字符串）"}`,
    },
    {
      role: 'user',
      content: `【人物名单与当前状态】\n${chars}\n\n【本章收束点（场景清单/细纲最后节点）】\n${scenePlan || outline || '（暂无）'}\n\n【第 ${chapterNo} 章正文】\n${text}`,
    },
  ]
}
