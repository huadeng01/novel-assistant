// 全部提示词模板：文风分析、改写润色（固定 JSON 协议）、新手写作四步、续写

// ---------- 文风分析 ----------
// 只提炼作者的写作习惯；"去除 AI 味"是 AI 自身的固有行为（见 NO_AI_FLAVOR_RULE），
// 不需要也不应该从用户自己的文章里检查 AI 味词汇。
const STYLE_SYSTEM = `你是一位资深小说编辑，擅长拆解作者的写作风格。
你将收到某本小说的多段采样文本，请提炼作者的写作习惯：常用句式、叙事视角与节奏、对话风格、描写偏好、用词特点。

严格按以下 JSON 格式输出，不要输出任何其他内容：
{"style_profile": "对作者写作习惯的完整描述（300字以内）", "habits": ["习惯1", "习惯2", "习惯3"]}`

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
1. 禁用"宛如、仿佛画卷、空气仿佛凝固、嘴角勾起一抹弧度、眸光微闪、眼神闪过一丝、嘴角扬起、不禁、不由、瞬间、犹如、恰似、如诗如画、意味深长"等空洞修饰；
2. 禁止形容词堆砌、"XX 的 XX"式排比、每句都叠加修饰语；
3. 用具体的动作、对话、细节和场景推进叙事，让读者自己感受情绪，而不是替读者总结感受。`

// 文风档案 + 用户自定义禁用词，拼进成文类提示词
function styleBlockOf({ style, forbidden }) {
  if (!style) return ''
  let block = `\n\n【作者文风档案，行文必须贴合】\n${style}`
  if (forbidden && forbidden.length) block += `\n\n【自定义禁用词，严禁出现】\n${forbidden.join('、')}`
  return block
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

export function versionMessages({ style, forbidden, text, index }) {
  const angle = VERSION_ANGLES[index] || VERSION_ANGLES[0]
  return [
    { role: 'system', content: versionSystem(angle) + NO_AI_FLAVOR_RULE + styleBlockOf({ style, forbidden }) },
    { role: 'user', content: `请按以上方向改写以下小说片段：\n\n${text}` },
  ]
}

// ---------- 模块二：新手写作四步向导 ----------
export const GENRES = ['玄幻', '都市', '言情', '悬疑', '科幻', '历史', '无限流']
export const TONES = ['轻松幽默', '热血燃向', '细腻治愈', '暗黑沉重', '悬疑烧脑']

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

export function outlineMessages({ synopsis, world, count }) {
  return [
    {
      role: 'system',
      content: `你是一位小说大纲师。基于梗概与设定，生成前 ${count} 章的逐章细纲。每章包含四项：章节标题、本章事件、冲突点、章末钩子（让读者想继续看的悬念）。直接输出细纲，不要输出解释性文字。`,
    },
    { role: 'user', content: `故事梗概：\n${synopsis}\n\n世界观与人物设定：\n${world}` },
  ]
}

export function draftMessages({ synopsis, world, outline, chapter, style, forbidden }) {
  return [
    {
      role: 'system',
      content:
        `你是一位职业小说作者。请根据章节细纲撰写第 ${chapter} 章的正文，要求：2000 字左右；多用具象描写与对话推进剧情，少用形容词堆砌；章节结尾落在细纲给定的钩子上。直接输出正文，第一行为"第${chapter}章 章节标题"，不要输出解释性文字。` +
        NO_AI_FLAVOR_RULE +
        styleBlockOf({ style, forbidden }),
    },
    { role: 'user', content: `故事梗概：\n${synopsis}\n\n世界观与人物设定：\n${world}\n\n章节细纲：\n${outline}\n\n请撰写第 ${chapter} 章正文。` },
  ]
}

// ---------- 小说采样 ----------
// 全文太长会超出上下文且浪费 token，按段切块后均匀采样
export function sampleNovel(content, segments = 5, perLength = 2000) {
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
  const step = chunks.length / segments
  return Array.from({ length: segments }, (_, i) => chunks[Math.floor(i * step)])
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
  const angle = CONTINUE_ANGLES[index] || CONTINUE_ANGLES[0][0]
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
