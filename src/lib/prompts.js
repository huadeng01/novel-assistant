// 全部提示词模板：文风分析、改写润色（固定 JSON 协议）、新手写作四步、续写

// ---------- 文风分析 ----------
// 只提炼作者的写作习惯；"去除 AI 味"是 AI 自身的固有行为（见 NO_AI_FLAVOR_RULE），
// 不需要也不应该从用户自己的文章里检查 AI 味词汇。
const STYLE_SYSTEM = `你是一位资深小说编辑，擅长把一位作者的写作风格拆成“可照着写”的具体指令。
你将收到某本小说的多段采样文本（已覆盖全书的开头、中间与结尾）。不要只做笼统概括，要提炼出【可量化、可执行、照着就能复刻笔触】的写作习惯，逐维度给出采样里的具体依据（引原句/原段为证）：
1. 句式与语法：平均句长偏长还是偏短、长短句搭配比例、是否多用短句收束、有无标志性句型（如独立成段的短促句）；
2. 叙事视角与人称：第几人称、贴视角还是全知、内心独白出现的频率与呈现方式；
3. 节奏与分段：段落平均长度、切换快慢、场景转换手法、留白与停顿的使用；
4. 对话风格：对话占比高不高、提示语用法（是否常省略“某某说”）、对话是否带动作/神态、口语化程度；
5. 描写取舍：环境/心理/动作三者比重，偏白描还是偏铺陈，感官调用偏好（视觉/听觉/触觉）；
6. 用词与修辞：词汇雅俗、比喻密度与取材方向、标点习惯（破折号/省略号/短句号的用法）。
另外从采样片段中挑出 3 段最能代表该作者笔触的原文段落原样留存（作为后续写作的模仿范例）。

严格按以下 JSON 格式输出，不要输出任何其他内容：
{"style_profile": "对作者写作习惯的完整描述，700~1000 字，逐维度展开、每个维度都给出采样中的具体依据与可执行的模仿要点（要具体到‘句长偏短、对话多省略提示语、段落多在3行内’这种可照做的程度，而非‘文笔优美’这类空话）", "habits": ["可执行模仿指令1（动宾结构，照着做即可，如‘动作戏用不超过15字的短句连缀，一段最多3句’）", "可执行模仿指令2", "可执行模仿指令3", "可执行模仿指令4", "可执行模仿指令5", "可执行模仿指令6", "可执行模仿指令7", "可执行模仿指令8"], "samples": ["从采样片段中原样摘录的典型段落1（150~300字）", "原样摘录的典型段落2", "原样摘录的典型段落3"]}
habits 必须是能直接指导落笔的模仿指令，不是抽象评价，且 8 条中至少 2 条必须是「节奏平衡」类硬指令（如「长短句错落：铺陈背景与心理可用 40~80 字的长句，但长句内部必须逗号密集；动作戏与对话用不超过 15 字的短句」「禁止为模仿而堆砌生僻字与文白夹杂——模仿笔触不等于牺牲叙事节奏与张力」）；【节奏平衡≠压句长】严禁写出「长句必须切碎为短句」「一律改用短句」这类反向指令——若原著均句长在 30 字以上，节奏平衡类 habit 必须写成「保留原著的长句节奏，长句内部用逗号/顿号切开小句」，否则蒸馏档案会把整本书推成一片短句（Round-5 浏览器冒烟实测：粘贴 233 字原著正文蒸馏，模型照抄旧示例产出「长句必须用逗号切碎为短句节奏」，与写作端【长句照写】直接冲突）；【标点约束】habits 中严禁出现任何「省略标点/不用逗号/长句不断开/无引号无标点混排」类指令；凡涉及长句铺陈、排比或罗列多项的习惯，必须同时写明「项与项之间用顿号或逗号分隔」——原著的长句是逗号密集的长句（实测约 6~8 个逗号/百字），不是无标点的长串；samples 必须是给定采样片段里逐字存在的原文，不得改写、拼接或自创，且仅供内化笔触——后续写作严禁照抄其原句、人物、专名或情节。`

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
2. 禁止形容词堆砌、"XX 的 XX"式空洞排比、每句都叠加修饰语（注意：此条禁的是抽象修饰语的空洞堆叠；凡按下方文风清单要求、以顿号或逗号分隔的【具象意象或动作罗列】——如「可搬山、倒海、降妖、镇魔」——属原著招牌笔法，不在禁止之列，应当照用）；
3. 用具体的动作、对话、细节和场景推进叙事，让读者自己感受情绪，而不是替读者总结感受；禁止用"他意识到/他明白了"式旁白直接陈述人物心理，用动作与对话呈现。`

// 文风习惯的标点护栏（确定性净化）：蒸馏出的 habits 会照抄原著的「长句铺陈/多项排比」习惯，
// 但若 habit 字面要求「超过 40 字的长句」「排比罗列五个以上同类意象并以感叹号结尾」，模型会直接产出
// 无标点长串（Round-4/5 实测：ch2 尾部「可搬山倒海降妖镇魔敕神摘星断江摧城开天！」即 habit 字面产物）。
// STYLE_SYSTEM 的标点约束只能管「新蒸馏」，已入库的存量文风档案仍带旧 habits，
// 故在注入端（styleBlockOf，所有成文路径的唯一入口）做一次确定性净化：
//   ① 显式要求省标点的 habit 整条剔除；② 字面要求「多项排比/罗列」却未写明分隔的 habit，就地补一句分隔要求。
// 【轻量级校准（Round-5 受控 A/B）】本函数只治「字面会产生零标点长串」的习惯（如「排比罗列五个以上同类意象并以感叹号结尾」），
// 不插手「长句铺陈/无引号对白」这类正当风格特征：实测仅把 frequency_penalty 归零就已达到人类级标点水位
// （逗号 6.68/百字 vs 原著 7.6、run-on 0、均句长 39.8 vs 40.2）；而旧版把「长句/连缀/无引号」也一并补上纪律后过度矫正：
// 均句长掉到 21.9（原著 40.2）、长句% 13.1（原著 38.6）、感叹号 15→1、独立判官 9→4/16——把作品推向了不像原著的方向。
// 不改写与标点无关的习惯，幂等（补过一次的 habit 因已含「顿号」不会重补）。
const HABIT_DROP_RE = /(不用标点|不加标点|省略标点|无标点|不要标点|省掉标点|不带标点|不需标点)/
const HABIT_PATCH_RE = /(排比|罗列|列举|一气呵成|连成一片|五个以上|四个以上|三个以上)/
const HABIT_PATCH_TAIL = '（项与项之间用顿号或逗号分隔，不得连成无分隔的字串）'
// ③（Fix10b）反向压句长的 habit 就地纠偏：蒸馏端旧示例会让模型产出「长句必须用逗号切碎为短句节奏」，
// 这类指令与写作端【长句照写】直接冲突，会把整本书推成一片短句（Round-5 实测：均句长 21.9~29.3，
// 低于原著区间 28.6~65.8）。同样在注入端（choke point）纠偏，存量档案也一并生效；幂等（已含「纠偏」的不重补）。
const HABIT_SHORTEN_RE = /(切碎为短句|切成短句|拆成短句|一律改用短句|全部改用短句|都用短句|改成一片短句)/
const HABIT_SHORTEN_TAIL = '（纠偏：此处「短句节奏」指长句内部用小句切开、逗号密集，不是把全书写成一片短句；铺陈背景与心理仍保留 40~80 字长句）'
export function sanitizeHabits(habits) {
  const list = Array.isArray(habits) ? habits.filter((h) => typeof h === 'string' && h.trim()) : []
  const out = []
  let removed = 0
  let patched = 0
  let shortened = 0
  for (const h of list) {
    if (HABIT_DROP_RE.test(h)) {
      removed++
      continue
    }
    if (HABIT_SHORTEN_RE.test(h) && !h.includes('纠偏')) {
      out.push(h + HABIT_SHORTEN_TAIL)
      shortened++
      continue
    }
    if (HABIT_PATCH_RE.test(h) && !h.includes('顿号')) {
      out.push(h + HABIT_PATCH_TAIL)
      patched++
      continue
    }
    out.push(h)
  }
  return { habits: out, removed, patched, shortened, flagged: removed > 0 || patched > 0 || shortened > 0 }
}

// 文风档案 + 用户自定义禁用词 + 反模板感规则 + 文风范例（原文样本），拼进成文类提示词（四者可独立生效）
// 范例是 few-shot 层：模仿效果显著强于纯描述；样本在文风分析时从原书留存。
function styleBlockOf({ style, habits, forbidden, rules, samples }) {
  let block = ''
  if (style) block += `\n\n【作者文风档案 — 这是本次写作的笔触标杆，必须逐条落实到字里行间】\n${style}\n落笔要求：主动模仿上述句式长短、对话密度与提示语用法、段落节奏、描写取舍与用词修辞，让成文的“笔触感”与档案一致；但内容、人物、情节必须完全原创，只学“怎么写”，不抄“写什么”。【度约束】模仿笔触不等于牺牲叙事节奏与张力：长短句必须错落，动作戏用短句，严禁为形似而堆砌长句、生僻字或文白夹杂导致节奏拖沓；宁可形似七分而节奏流畅，不要形似十分而神散。【标点纪律·硬要求】原著的长句之所以能读，靠的是逗号/顿号/分号把小句切开，而不是不用标点：【长句照写】原著均句长约 40 字、长句占比近四成，这是本书应有的节奏，不要为了“安全”而改写成一片短句；全章平均句长宜落在 30~45 字（原著 10 个窗口实测均值 41.9、区间 28.6~65.8），铺陈背景与心理时用 40~80 字的长句、动作与对话用不超过 12 字的短句，两者必须交错；但长句内部必须逗号密集（全篇约 6~8 处逗号/百字，原著实测水位），任何相邻标点之间不得超过 40 字；排比或罗列三个以上同类项时，项与项之间必须用顿号或逗号分隔（如「可搬山、倒海、降妖、镇魔」），严禁写成无分隔的字串；内心独白/心声同样适用本纪律，不得因为不用引号就连标点一并省掉。【对白引号·硬要求】凡角色开口说出的话（有声对白）必须用中文双引号“”完整包裹，严禁把说出口的话不加引号直接混进叙述；但角色没说出口的内心独白/心声沿用原著笔法，可以不用引号，以「某某心声问道」等引出或直接融入叙事段落——区分标准只有一个：说给别人听的必须加引号，只在心里想的可不加。本条只规范引号有无，绝不改变句长、逗号密度或任何其他文风特征（防止重蹈旧版把引号与长句纪律捆绑后的过度矫正）。【防原文】文风范例仅供内化笔触，严禁在正文照抄其原句、人物、专名或情节，连续 15 字以上与范例雷同即视为抄袭。`
  // habits 注入前过一道确定性标点净化：存量档案里的「长句不断/排比罗列」习惯是 run-on 的提示词级根因
  const safeHabits = sanitizeHabits(habits).habits
  if (safeHabits.length) block += `\n\n【可执行模仿清单 — 已把上述文风档案拆成“照着就能落笔”的具体动作，本章每一段都要逐条执行到位；这是文风模仿真正生效的关键，优先级高于你自身的默认写作习惯（但本清单与上方【标点纪律】冲突时，以标点纪律为准）】\n` + safeHabits.map((h, i) => `${i + 1}. ${h}`).join('\n')
  if (samples && samples.length) block += `\n\n【文风范例（few-shot：先内化其句长节奏、对话与描写的取舍、标点习惯，再用你自己的原创内容复刻同样的笔触；严禁照抄其内容、人物、专名与情节）】\n` + samples.map((s) => `【范例】${s}`).join('\n')
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
  // Fix8（Round-5）：本条原为「禁止三连排比」，与文风注入端直接矛盾：《剑来》蒸馏出的 habits 第7 条就是
  // 「善用排比、比喻、夸张等修辞，如‘可搬山，倒海’的排比，增强气势」，而本规则排在 habits 之后注入，
  // 模型会以后者为准→排比被一律压死。实测代价：独立判官给 styled-ch1 9/16，评语明确写「缺…排比气势」；
  // 且长句%(≥40字) 15.9~24.4 低于原著区间 18.1~55.3。本条真正要治的是 AI 腔的「空洞结构性三连」
  // （不是…而是… / 这是…这是…），而不是具象意象罗列这一文学手法，故按「禁形式、不禁手法」重写。
  { id: 'no-triad', name: '禁空洞三连排比（具象罗列可用）', text: '禁止空洞的结构性三连排比：如「不是…而是…」「这是…，这是…，这是…」，或三个结构相同的抽象短句连排造势、拿排比句充当情绪高潮。但具象意象的并列罗列属原著笔法，允许且应当使用——各项必须是具体动作或物件、以顿号或逗号分隔（如「可搬山、倒海、降妖、镇魔」），每章 2~3 处为宜，不得连篇堆叠。' },
  { id: 'no-explainer', name: '设定不自问自答', text: '世界观与设定通过人物行动、对话与后果自然呈现，禁止旁白自问自答式地讲解规则来历与原理。' },
  { id: 'vary-sentence', name: '句式长短错落', text: '段落内句式长短错落，禁止连续多个“他+动词”开头的主谓句；动作戏多用短句，抒情处可舒展。' },
  { id: 'no-runon', name: '禁大段无标点长句', text: '严禁大段无标点的长句（run-on）：一个句子若含多个动作或从句，必须在自然停顿处用逗号、分号断开；量化标准：任何相邻标点之间不得超过 40 字，全篇逗号密度约 6~8 处/百字（人类原著实测水位）；排比或罗列三个以上同类项时，项与项之间必须用顿号或逗号分隔（如「可搬山、倒海、降妖、镇魔」），严禁连成无分隔的字串；内心独白/心声同样适用。注意：本条禁的是「无标点」，不是「长句」——原著均句长约 40 字，该长就长，只要逗号跟得上；不得为避开本条而把全书写成一片短句。' },
  // Fix11（Round-5 #10）：runB 独立判官 styled 仅 8/16，H5(动作/施法步骤拆解)、H7(长篇大论后自嘲停顿)、H8(≥5意象排比+感叹号) 三条招牌动作全 0 分——habit 虽注入却整章未落地。本条在 habits 之后注入（recency 显著），把"每条习惯至少一处可指认字句证据"升为硬约束，并按类点名最易漏写的招牌动作；用"凡清单含同类习惯者"的条件式表述保持跨题材通用（不 hardcode 修真），且重申标点纪律与去 AI 味，避免抬分反伤已达标的 #3/#5/#6。
  // Fix11b（Round-5 #10 runC 复测精修，度量不动）：runC styledMean 未升反 A/B 回归（比喻过密）、H8 排比落内心戏暗示未回收伏笔被 draftSelfCheckMessages 检查项3 删、H3 改用心想丢失原著心声问道公式——故 (a) 补落点约束与总量节制、新增 (d) 内心独白式；H5 属 ch1 度量盲区（投宿章无动作戏），prompt 端保留 (b) 不强追绝对分。
  { id: 'habit-landing', name: '文风清单逐条落地（招牌动作不得整章缺失）', text: '上方【可执行模仿清单】里的每一条习惯，本章都必须找到至少一处明确可指认的字句证据，不得整章一条都不体现。尤其下列"招牌动作"类最易被整章漏写，凡清单中含同类习惯者务必各至少落地一次：(a) 排比造势——用顿号或逗号分隔、罗列五个以上具象同类意象或动作，以感叹号收束拉升气势（如「可搬山、倒海、降妖、镇魔、敕神！」），严禁连成无标点字串；排比须落在环境、气势或外部动作描写上，不得用于揭示或暗示未回收伏笔的答案（那会被落库前自检删去）；每章排比至多 1~2 处，且不得与密集明喻/暗喻叠加，保持原著白描克制；(b) 动作步骤拆解——动作、打斗或施法场面按时间顺序拆解，写出具体身体部位与兵器、法器或器物的交互轨迹，不得一笔带过；(c) 节奏停顿——凡本章任一人物连续≥60字的独白/训话/盘问/数落之后，必须由【该说话人自己】紧跟一句【可指认的出声自嘲台词】（是自己自嘲，不是嘲讽他人），再接一个【闭嘴/收束动作】（如收起笑意、摆手、敲一下桌沿）或一声叹息，形成节奏停顿；不得以『本章没有长篇大论』为由免写，只要有≥60字连续台词就触发；每章1~2处为限，防套路化。示例：『……不说了不说了，跟个半大孩子废什么话。』；(d) 内心独白式——凡清单含「心声/内心独白」类习惯者，用「某某心声问道」「心中默念」式引出，不得改写成「心想/心里念着」而丢失原著公式。落地时仍须遵守【标点纪律】与去 AI 味要求：具象、克制、服务叙事，绝不为凑数而堆砌。' },
]

// 写法引擎试写：用当前文风绑定与反模板规则写一段小片段，验证写法效果后再正式开写（只出正文，不带标题/解释）
export function styleTrialMessages({ synopsis, style, habits, forbidden, rules, samples }) {
  let sys = `你是一位职业小说作者。请根据本书设定写一段约 300 字的试写片段：自选一个有画面感的小场景（可以是一次对话、一段动作戏或一处氛围描写），直接输出正文，不要标题、不要任何解释。` +
    NO_AI_FLAVOR_RULE +
    styleBlockOf({ style, habits, forbidden, rules, samples })
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

export function versionMessages({ style, habits, forbidden, samples, text, index }) {
  const angle = VERSION_ANGLES[index] || VERSION_ANGLES[0]
  return [
    { role: 'system', content: versionSystem(angle) + NO_AI_FLAVOR_RULE + styleBlockOf({ style, habits, forbidden, samples }) },
    { role: 'user', content: `请按以上方向改写以下小说片段：\n\n${text}` },
  ]
}

// ---------- 全书润色终 pass（对标 show-me-the-story 的 final polish）----------
// 成书后逐章做一次「保持剧情/人物不变」的通顺化 + 去 AI 味 + 跨章连贯润色。
// 与四版改写（versionMessages，供选稿对比）不同：终 pass 只出一个「定稿润色版」，带前后章语境保证连贯，非破坏性（调用方预览后再决定是否采用）。
export function polishChapterMessages({ text, before, after, setting, style, habits, forbidden, samples }) {
  const sys = `你是一位资深小说编辑，为已成稿的长篇做「出版前终稿润色」。
【任务】在【严格不改变剧情走向、人物设定、人物关系、结局】的前提下，逐句润色用户提交的这一章：
1. 修正语病、错别字、生硬翻译腔与冗余啰嗦；
2. 去除 AI 腔套路表达，让文字更像成熟作者的自然行文；
3. 优化句段节奏与衔接，但不得新增/删除情节，不得改动专名与设定；
4. 与【前文语境】保持连贯（称谓、时态、伏笔口径一致），不要重复前文已交代的背景。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"polished_text": "润色后的完整章节正文（保持原分段）", "notes": "本次润色的主要改动说明（120字以内）", "changed": true 或 false}
【规则】若原文已足够好，changed 置 false 且 polished_text 原样返回，不要为改而改。` + NO_AI_FLAVOR_RULE + styleBlockOf({ style, habits, forbidden, samples })
  const user = `【前文语境（仅供保持连贯，勿改写）】\n${before || '（本章为开篇，无前文）'}\n\n【后文提要（仅供口径一致，勿改写）】\n${after || '（无）'}\n\n【本书设定摘要】\n${setting || '（无）'}\n\n【待润色章节正文】\n${text}`
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
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
4. 不得引用后续卷里程碑：给定的【故事梗概】只是与本卷相关的主线切片，切片之外的后续卷走向对你不可见，一律视为尚未规划，不得凭猜测提前安排；本卷未解锁的地图层与未登场势力只能以传闻形式一笔带过，不得展开细节与实地场景；
5. 直接输出细纲正文，不要输出任何解释性文字。`,
    },
    {
      role: 'user',
      content: `【故事梗概】\n${synopsis || '（暂无）'}\n\n【当前进展（全书滚动摘要）】\n${rollingSummary || '（暂无）'}\n\n【现有故事线】\n${lines}${volumeStory ? `\n\n【所在卷的本卷故事（续纲围绕它展开，每卷是一个能独立讲完的故事）】\n${volumeStory}` : ''}${volumeContext ? `\n\n【卷弧线坐标（定位标签必须与之对齐）】\n${volumeContext}` : ''}\n\n【现有细纲结尾部分（紧接其后规划，编号从第 ${fromChapter} 章开始）】\n${outlineTail || '（暂无）'}`,
    },
  ]
}

export function draftMessages({ synopsis, world, outline, chapter, style, habits, forbidden, prevChapters, prevTail }) {
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
        styleBlockOf({ style, habits, forbidden }),
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

export function segmentRewriteMessages({ mode, text, before, after, requirement, style, habits, forbidden, rules, samples }) {
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
        styleBlockOf({ style, habits, forbidden, rules, samples }),
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
// level：注入的题材模板档位——'brief' 只有世界架构+力量体系+意象词库；'full' 八字段全量（开书圣经生成用）。
// full 档在 user 段标明各维度用途：八字段一起塞进来时，模型需要知道哪一维去对哪个输出字段
// （tropes/antiTropes → 避免开局撞车；factions/geography → unlock_volume 登场节奏与地图阶梯）。
export function bookWorldviewMessages({ template, brief, bible, volumeCount, level = 'brief' }) {
  const tplLabel =
    level === 'full'
      ? '【题材世界模板（参考，八字段全量；其中「高频套路清单/反套路切口」用于避免开局与常见套路撞车，「势力格局/地理与舞台分层」用于编排 unlock_volume 登场节奏与地图阶梯）】'
      : '【题材世界模板（参考）】'
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
      content: `${tplLabel}\n${template || '（暂无）'}\n\n【用户初始提问（含选定灵感）】\n${brief || '（无）'}\n\n【圣经·世界观】\n${bible?.world || '（暂无）'}\n\n【力量体系绝对规则】\n${(bible?.powerRules || []).join('\n') || '（暂无）'}\n\n全书共 ${volumeCount} 卷。请设计势力盘与冲突线。`,
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

// Step 5a 全书章名骨架：按卷分次生成，卷内再按 ≤ SKELETON_BATCH 章分批（根治一次性枚举上百章导致的复读/断号/思维链泄漏），
// 每章一行（章名 + 唯一剧情任务），仅作方向锚点，进卷时再细化为完整细纲；
// "每章只允许完成一个任务"在此源头确立，写章提示词另有硬约束兑现它；
// rangeStart/rangeEnd：本批章号区间（缺省=整卷）；prevTail：上一批/上一卷最后 3 章章行，供衔接对齐；actsText：本卷四幕的全局章号区间（有则供节奏对齐）
export function volumeSkeletonMessages({ bible, mainline, volume, volumeCount, prevTail = '', actsText = '', rangeStart, rangeEnd, usedTitles = [] }) {
  const volStart = volume.startChapter || 1
  const volLen = volume.length || 20
  const volEnd = volStart + volLen - 1
  const start = rangeStart ?? volStart
  const end = rangeEnd ?? volEnd
  const len = end - start + 1
  const isBatch = start !== volStart || end !== volEnd
  const isVolEndBatch = end >= volEnd
  const isLast = volume.volumeNo >= volumeCount && isVolEndBatch
  // A：把全书此前已定稿章名注入本批 prompt（去重上下文），从源头压制跨批/跨卷撞名；超长时列最近 UT_CAP 个 + 计数
  const UT_CAP = 1000
  const utList = (Array.isArray(usedTitles) ? usedTitles : []).map((t) => String(t).trim()).filter(Boolean)
  const utInject = utList.length > UT_CAP ? utList.slice(-UT_CAP) : utList
  const utNote = utList.length > UT_CAP ? `，共 ${utList.length} 个，此处列最近 ${UT_CAP} 个` : ''
  const usedTitlesText = utInject.length ? `【已用章名（全书此前各章已用${utNote}；本段章名严禁与下列任何一个重复或高度雷同）】\n${utInject.join('、')}\n\n` : ''
  return [
    {
      role: 'system',
      content: `你是一位小说大纲师。请为指定卷生成逐章骨架：每章一行，章名 + 本章唯一剧情任务。
【规则】
1. 章号严格从第 ${start} 章连续编到第 ${end} 章，共 ${len} 章，一章不少、一章不多、不得断号或跳号；${isBatch ? `本卷整体是第 ${volStart}~${volEnd} 章，本次只负责第 ${start}~${end} 章这一段，前后其余章由别的批次生成，不要越界多写、也不要重复上一段已给的章；` : ''}
2. 【围绕本卷故事拆章】本卷是一个能独立讲完的故事（见【本卷信息·本卷故事】）；每章任务是这件具体故事的一个环节：一个事件、一次交锋、一个新发现或一次关系变化；应不断引入为本卷故事服务的新事件与新配角，不得把同一个冲突反复拆成几十章的微小推进（拒绝单故事稀释）；每章只安排一个剧情任务，杜绝一章塞多件大事；
3. 只展开本卷内容：剧情不得越过本卷推进后续卷的里程碑${isLast ? '' : '，严禁提前触及大结局'}；${isVolEndBatch ? `本段最后一章（第 ${end} 章）必须落在本卷卷末悬念的爆发点上${isLast ? '（终卷：大结局在本卷收束，最后一章为结局余韵）' : ''}` : `本段最后一章（第 ${end} 章）收在一个自然的小节点上、把剧情顺势交给下一段即可，不要在本段提前引爆本卷卷末悬念`}；
4. 章名必须 2~8 字且与本章剧情具体相关：严禁单字章名、严禁空洞口号式章名（如“坚持”“希望”“责任”）、严禁用与剧情无关的填充章凑数；章名必须全书唯一——不得与【已用章名】中任何一个重复或高度雷同，本段各章章名彼此也不得重复；
5. 节奏克制，伏笔发酵期不得压缩；任务服务本卷故事的起承转合，与本卷主题、四幕区间对齐；
6. 与主线里程碑、圣经设定保持一致，不得提前安排终极真相揭示。
【输出格式】每章占一行，行格式固定为：第N章 章名｜任务：本章唯一要完成的一件事。
从第 ${start} 章起、到第 ${end} 章止，连续给出这 ${len} 行章行即可，无需开场白、结尾说明、思考过程或任何额外文字。`,
    },
    {
      role: 'user',
      content: `【本卷信息】\n第 ${volume.volumeNo} 卷《${volume.name || ''}》（本卷整体第 ${volStart}~${volEnd} 章；本次生成第 ${start}~${end} 章，共 ${len} 章）\n主题：${volume.theme || '（未定）'}；本卷故事（本章任务围绕它拆解）：${volume.arcStory || volume.conflict || '（未定）'}；主舞台：${volume.location || '（未定）'}；卷末悬念：${volume.endHook || '（未定）'}${actsText ? `\n四幕区间（全局章号）：${actsText}` : ''}${prevTail ? `\n\n【紧接上一段末尾（本段第 ${start} 章要从这里接住，不要重复这些章）】\n${prevTail}` : ''}\n\n${usedTitlesText}【全书主线（暗线，本卷只展开属于本卷故事的部分）】\n${(mainline || '').slice(0, 1500)}\n\n【圣经·世界观】\n${(bible?.world || '').slice(0, 800)}${(() => { const t = worldviewVolumeText(bible, volume.volumeNo, volumeCount); return t ? `\n\n${t}` : '' })()}\n\n请生成第 ${start}~${end} 章逐章骨架，每章任务都是本卷故事的具体环节。`,
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
2. 每章 120~200 字，含：本章事件（严格对应章骨架的唯一任务，不得擅自完成后续章节任务）、冲突点、章末钩子；这里产出的是「精简地图」，职责是全书/全卷走向与边界感知——写章前还会逐章细化成 500~700 字详纲，所以不必在此塞满过程细节，但必须把「本章推进到哪一步、停在哪个钩子上」写准；
3. 节奏克制：每章只推进章骨架给定的一件事；伏笔只铺垫不抢收；
4. 章号从第 1 章严格连续编号；直接输出细纲正文，不要输出任何解释性文字。`,
    },
    {
      role: 'user',
      content: `【第 1 卷章骨架（逐章任务，严格按它展开）】\n${skeleton || '（暂无）'}\n\n【本卷信息】\n主题：${volume?.theme || '（未定）'}；本卷故事（细纲围绕它展开）：${volume?.arcStory || volume?.conflict || '（未定）'}；卷末悬念：${volume?.endHook || '（未定）'}${arcText ? `\n\n【卷弧线坐标（定位标签必须与之对齐）】\n${arcText}` : ''}\n\n【圣经·世界观】\n${(bible?.world || '').slice(0, 1000)}${(() => { const t = worldviewVolumeText(bible, volume?.volumeNo || 1); return t ? `\n\n${t}` : '' })()}\n\n请生成第 1 卷完整细纲。`,
    },
  ]
}


// ---------- Step5.5 逐章详纲细化（A 方案：写第 N 章前按需细化，不是一次跑全书） ----------
// 为什么逐章而不是一次全书：一次跑几百章 × 600 字必然撞输出上限并整批退化；逐章每次只输出 500~700 字，
// 且生成时能拿到「上一章真实摘要 + 上一份详纲结尾」，衔接精度远高于批量。批量版见 chapterOutlineBatchMessages（备用入口，默认不走）。
//
// 【输入裁剪是这一步的关键——从源头堵剧透】
//   · 骨架只给本章任务 + 后 2 章任务标题（laterTasks 仅作「止步红线」参照，提示词明确不得写入本章）；不给全书骨架；
//   · bible 只经 worldviewVolumeText 取本卷已登场势力与活跃冲突（未登场的只有传闻级一句话），绝不注入 bible.truths（真相隔离）；
//   · 主线只给 mainlineSlice（本卷相关段落 ≤600 字），不给全书梗概全文（大结局形态与后续卷里程碑都在里面）。
//
// 场景数与写作端同源：取 sceneCountRange(chapterWords) 的区间上界，[字数] 行按 sceneWordBudget 的均分夹逼口径分配，
// 杜绝「详纲切 3 场景、写章要 5 场景」的错配（那种错配会把详纲的字数分配全部打乱，逐场景扩写的预算也就跟着错）。
const detailSceneCount = (chapterWords, sceneRange) => {
  const { range } = sceneCountRange(chapterWords)
  const nums = String(sceneRange || range).match(/\d+/g) || []
  // 取区间上界：场景越多每场景字数越少，越不容易为了填满篇幅去新造事件（节奏提前的直接诱因）
  return Math.max(1, nums.length ? Number(nums[nums.length - 1]) : 3)
}

// 每场景字数分配：与引擎层 sceneWordBudget 的「新开章」口径一致（剩余预算按剩余场景数均摊，再用均值的 0.5~1.5 倍夹住），
// 余数全部补给最后一个场景，保证各场景之和恰等于本章目标字数。
// prompts.js 是叶子模块、不得反向 import longform.js（会成环），故此处按同一口径本地实现。
const splitSceneWords = (total, n) => {
  const cw = Number(total) > 0 ? Number(total) : 2000
  const k = Math.max(1, Math.floor(Number(n) || 1))
  const even = cw / k
  const out = []
  let acc = 0
  for (let i = 0; i < k; i++) {
    if (i === k - 1) { out.push(Math.max(200, Math.round(cw - acc))); break }
    const w = Math.round(Math.min(even * 1.5, Math.max(even * 0.5, (cw - acc) / (k - i))))
    out.push(w)
    acc += w
  }
  return out
}

// 详纲行格式样例（方括号标签是解析契约：longform.parseDetailScenes 按 [场景N] 确定性切场景，标签文字与顺序都不得改）
const detailFormatSample = (chapterNo, title, position, budgets, total) => {
  const scenes = budgets.map((w, i) => `[场景${i + 1}] 地点/在场人物 → 发生什么 → 落点`).join('\n')
  return `第${chapterNo}章【${position || '承'}】${title || '章名'}
[任务] 一句话复述本章唯一任务
${scenes}
[边界] 本章允许揭示：…；本章严禁触及：…（属第${chapterNo + 1}章的…）
[钩子] 章末悬念（30~50 字）
[字数] ${total}（${budgets.map((w, i) => `场景${i + 1}:${w}`).join(' / ')}）`
}

// 详纲硬约束（逐章版与批量版共用，措辞必须一致，否则两条入口产出的详纲密度不同、写作端预算就对不上）
const detailRules = (sceneCount) => `1. 本章必须且只能完成【本章任务】这一件事。后面几章的任务标题只是「止步红线」：它们的内容一个都不得写进本章，哪怕只是一句预告、一次照面、提前交代结果也不行；
2. 场景数固定为 ${sceneCount} 个，与写作端的逐场景扩写一一对应；每个场景独占一行，格式「地点/在场人物 → 发生什么 → 落点」，三段之间必须用 → 分隔，每场景 100~150 字；
3. 相邻场景必须有可见的推进差：后一个场景不得重复前一个场景已经发生过的事，也不得把下一个场景的内容提前演掉；最后一个场景必须落在【钩子】上，严禁越过钩子继续推进；
4. 篇幅靠过程、对话与感官细节撑起来，不靠新增事件：每个场景都要写清谁做了什么动作、说了什么话、看到听到什么、心里转过什么念头，让写手照着就能写足对应字数；严禁用「随后」「不久」「经过一番」「众人」这类概述把过程跳过去；
5. [边界] 行必须写明本章允许揭示到什么程度、严禁触及什么，并把严禁项归属到具体后续章号；
6. 只使用给定设定里已经登场的人物、地点与势力；标注为「传闻」的势力与未解锁地图只能一笔带过，不得展开细节与实地场景；不得自行发明新的势力、地图层、能力阶位或重大设定；
7. 章头行必须原样使用给定章名与定位标签，格式「第N章【X】标题」，不得改写、不得增删字；
8. 直接输出详纲正文，禁止输出任何解释、前言、总结、编号说明或代码块标记。`

export function chapterOutlineDetailMessages({ chapterNo, chapterTitle = '', task = '', laterTasks = [], volume = null, arcText = '', bible = null, volumeNo = 1, totalVolumes = 0, mainlineSlice = '', prevSummary = '', prevDetailTail = '', chapterWords = 2000, sceneRange = '', sceneBudgets = null, position = '', povRule = '' }) {
  const sceneCount = detailSceneCount(chapterWords, sceneRange)
  // sceneBudgets 允许调用方直接用引擎层 sceneWordBudget 算好的分配覆盖（保证与写作端逐字节同源）；长度不匹配时回退本地均分
  const budgets = (Array.isArray(sceneBudgets) && sceneBudgets.length === sceneCount
    ? sceneBudgets.map((n) => Math.round(Number(n) || 0))
    : splitSceneWords(chapterWords, sceneCount))
  const total = budgets.reduce((a, b) => a + b, 0)
  const later = (Array.isArray(laterTasks) ? laterTasks : []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 2)
  const volNo = Number(volume?.volumeNo) || Number(volumeNo) || 1
  const volText = volume
    ? `第${volNo}卷《${volume.name || ''}》：主题 ${volume.theme || '（未定）'}；本卷故事 ${volume.arcStory || volume.conflict || '（未定）'}；卷末悬念（仅卷末章允许落在其上）${volume.endHook || '（未定）'}`
    : ''
  const wvText = bible ? worldviewVolumeText(bible, volNo, totalVolumes) : ''
  let ctx = ''
  if (task) ctx += `\n\n【本章任务（唯一硬约束，本章只完成这一件事）】\n${task}`
  ctx += `\n\n【后 2 章任务（止步红线：以下事件本章一律不得触及，只用于判断「该在哪里停笔」）】\n${later.length ? later.map((t, i) => `- 第${chapterNo + i + 1}章：${t}`).join('\n') : '（已是骨架末尾，本章自然收束即可）'}`
  if (volText) ctx += `\n\n【所在卷（详纲围绕本卷这件具体故事展开，不得漂移到跨卷主线）】\n${volText}`
  if (arcText) ctx += `\n\n【卷弧线坐标（定位标签必须与之对齐）】\n${arcText}`
  if (mainlineSlice) ctx += `\n\n【主线·本卷相关段落（只给这一段，其余主线对你不可见）】\n${mainlineSlice}`
  if (wvText) ctx += `\n\n【本卷世界盘（势力与冲突按登场卷号裁剪）】\n${wvText}`
  if (bible?.world) ctx += `\n\n【圣经·世界观（摘要）】\n${String(bible.world).slice(0, 800)}`
  if (prevSummary) ctx += `\n\n【上一章摘要（本章必须紧接其后，不得重复已发生的事）】\n${prevSummary}`
  if (prevDetailTail) ctx += `\n\n【上一份详纲结尾（衔接参照，本章不得复述其内容）】\n${prevDetailTail}`
  if (povRule) ctx += `\n\n【视角约束】${povRule}`
  return [
    {
      role: 'system',
      content: `你是一位职业小说作者，正在为长篇小说的第 ${chapterNo} 章撰写【详纲】。
详纲是本章写作时唯一的剧情依据：写手看不到全书骨架、看不到全书梗概、也看不到后续章节，只能照着详纲一字一句展开。所以详纲必须自带本章要写的全部过程——写手不需要猜，也不允许自行补剧情。
【硬约束】
${detailRules(sceneCount)}
9. 每章合计 500~700 字（${sceneCount} 个场景 × 100~150 字 + 任务/边界/钩子）。
【输出格式】每行以方括号标签开头，标签文字与顺序都不得改动（下游按标签确定性解析）：
${detailFormatSample(chapterNo, chapterTitle, position, budgets, total)}`,
    },
    {
      role: 'user',
      content: `请为第 ${chapterNo} 章撰写详纲。\n\n【章头行（原样使用，不得改写）】\n第${chapterNo}章【${position || '承'}】${chapterTitle || '（未定章名）'}\n\n【本章目标字数】${total} 字，切成 ${sceneCount} 个场景，各场景字数：${budgets.map((w, i) => `场景${i + 1} ${w} 字`).join('、')}${ctx}\n\n请输出第 ${chapterNo} 章详纲。`,
    },
  ]
}

// 批量版（B 方案备用入口，本次实现但默认不走）：一次细化 3~5 章，约 2000~3000 字输出。
// 与逐章版的差别：拿不到「每章写完后的真实摘要」，衔接只能靠批内自洽；优势是请求数少 3~5 倍。
// chapters: [{chapterNo, title, task}]；输入裁剪口径与逐章版完全一致（不给全书骨架、不给 truths、主线只给本卷切片）。
export function chapterOutlineBatchMessages({ chapters, volume = null, arcText = '', bible = null, volumeNo = 1, totalVolumes = 0, mainlineSlice = '', prevSummary = '', prevDetailTail = '', chapterWords = 2000, sceneRange = '', position = '' }) {
  const list = (Array.isArray(chapters) ? chapters : []).filter((c) => c && c.chapterNo)
  const sceneCount = detailSceneCount(chapterWords, sceneRange)
  const budgets = splitSceneWords(chapterWords, sceneCount)
  const total = budgets.reduce((a, b) => a + b, 0)
  const volNo = Number(volume?.volumeNo) || Number(volumeNo) || 1
  const wvText = bible ? worldviewVolumeText(bible, volNo, totalVolumes) : ''
  const taskText = list.map((c, i) => {
    const next = list.slice(i + 1, i + 3).map((x) => `第${x.chapterNo}章：${x.task || ''}`).filter(Boolean).join('；')
    return `第${c.chapterNo}章《${c.title || ''}》任务：${c.task || '（未给定）'}\n  └ 止步红线（后 2 章，不得提前写入）：${next || '（本批末尾，自然收束）'}`
  }).join('\n')
  let ctx = ''
  if (volume) ctx += `\n\n【所在卷】\n第${volNo}卷《${volume.name || ''}》：主题 ${volume.theme || '（未定）'}；本卷故事 ${volume.arcStory || volume.conflict || '（未定）'}；卷末悬念 ${volume.endHook || '（未定）'}`
  if (arcText) ctx += `\n\n【卷弧线坐标（各章定位标签必须与之对齐）】\n${arcText}`
  if (mainlineSlice) ctx += `\n\n【主线·本卷相关段落（只给这一段，其余主线对你不可见）】\n${mainlineSlice}`
  if (wvText) ctx += `\n\n【本卷世界盘（势力与冲突按登场卷号裁剪）】\n${wvText}`
  if (bible?.world) ctx += `\n\n【圣经·世界观（摘要）】\n${String(bible.world).slice(0, 800)}`
  if (prevSummary) ctx += `\n\n【上一章摘要（本批第 1 章必须紧接其后）】\n${prevSummary}`
  if (prevDetailTail) ctx += `\n\n【上一份详纲结尾（衔接参照，不得复述）】\n${prevDetailTail}`
  return [
    {
      role: 'system',
      content: `你是一位职业小说作者，正在为长篇小说的第 ${list[0]?.chapterNo || '?'} 章到第 ${list[list.length - 1]?.chapterNo || '?'} 章逐章撰写【详纲】。
详纲是各章写作时唯一的剧情依据：写手看不到全书骨架、看不到全书梗概、也看不到后续章节，只能照着详纲一字一句展开。所以每章详纲必须自带该章要写的全部过程。
【硬约束】
${detailRules(sceneCount)}
9. 每章合计 500~700 字（${sceneCount} 个场景 × 100~150 字 + 任务/边界/钩子）；各章之间必须首尾相接，前一章的【钩子】就是后一章的起点；
10. 逐章连续输出，章与章之间空一行，不得输出批次说明或总结。
【单章输出格式】每行以方括号标签开头，标签文字与顺序都不得改动（下游按标签确定性解析）：
${detailFormatSample(list[0]?.chapterNo || 1, list[0]?.title || '', position, budgets, total)}`,
    },
    {
      role: 'user',
      content: `请为下列 ${list.length} 章逐章撰写详纲。\n\n【各章章名与任务】\n${taskText}\n\n【每章目标字数】${total} 字，切成 ${sceneCount} 个场景，各场景字数：${budgets.map((w, i) => `场景${i + 1} ${w} 字`).join('、')}${ctx}\n\n请从第 ${list[0]?.chapterNo || '?'} 章开始连续输出。`,
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

export function continueMessages({ text, summary, world, characters, outline, timeline, style, habits, forbidden, instruction, index }) {
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
    { role: 'system', content: continueSystem(angle) + NO_AI_FLAVOR_RULE + styleBlockOf({ style, habits, forbidden }) },
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

export function followupMessages({ text, summary, world, characters, outline, timeline, style, habits, forbidden, index }) {
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
    { role: 'system', content: followupSystem(angle) + NO_AI_FLAVOR_RULE + styleBlockOf({ style, habits, forbidden }) },
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
4. pov 为本章的叙事视角人物（读者跟随谁的视角看故事），只输出一个姓名；如果是全知视角无固定人物，输出“全知”。
5. facts 为本章确立的【受控谓词事实】（供双时态事实库写时校验，治记忆二次消费/金手指漂移/伤势矛盾）：每条 {name, predicate, value, change_type}。
   - predicate 只能取以下 12 个受控谓词之一：identity(身份)/location(位置)/possession(持有)/goal(目标)/injury(伤势)/ability(能力)/status(状态)/secret(秘密)/reputation(声望)/oath(誓约)/debt(债务)/relationship(关系)；确需超出用 x-<中文短名> 扩展（如 x-恐惧）。
   - name 为主体名（人物/势力/物件，人物需与名单一致）；relationship 的 name 用「A|B」两端。
   - value 为一句话具体事实，必含关键数字/部位/归属（如“左臂齐肘而断”“余额 80 点”）。
   - change_type：new(新事实)/update(替换同主体同谓词旧值)/invalidate(仅失效不立新值)。
   - 若本章把某份记忆/物件作为代价消耗掉，额外输出一条 {name:主体, predicate:"x-consumed", value:被消耗的记忆签名, change_type:"new"}（同一签名不得二次输出）。
   - 只输出本章【明确发生】的事实，不臆测、不补齐未写明的字段；无事实则空数组。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"character_updates": [{"name": "人物姓名", "change": "状态变化描述"}], "new_characters": [{"name": "姓名", "identity": "身份", "personality": "性格"}], "events": [{"text": "事件描述", "time": "故事内时间或空字符串"}], "pov": "视角人物姓名", "facts": [{"name": "主体名", "predicate": "identity|location|possession|goal|injury|ability|status|secret|reputation|oath|debt|relationship|x-自定义|x-consumed", "value": "一句话具体事实", "change_type": "new|update|invalidate"}]}`

export function stateUpdateMessages({ characters, text }) {
  const roster = (characters || []).map((c) => c.name).filter(Boolean).join('、') || '（暂无）'
  return [
    { role: 'system', content: STATE_UPDATE_SYSTEM },
    { role: 'user', content: `人物名单：${roster}\n\n最新章节内容：\n${text}` },
  ]
}

// 机制二：facts 写时校验失败时的自修正重跑提示（仿 NarraCat writers.ts 返回字段级 errors+hint 让模型自修正）。
// 把上一轮 facts 的字段级 errors 原样逐条回传，要求只修正出错条目、保留其余合法事实，重提一次。
export function stateFactFixMessages({ characters, text, errors }) {
  const roster = (characters || []).map((c) => c.name).filter(Boolean).join('、') || '（暂无）'
  const errList = (Array.isArray(errors) ? errors : [])
    .map((e) => `- 字段 ${e.field}：期望 ${e.expected}，实际 ${e.actual}。修复：${e.hint}`)
    .join('\n') || '（无）'
  return [
    { role: 'system', content: STATE_UPDATE_SYSTEM },
    {
      role: 'user',
      content: `人物名单：${roster}\n\n最新章节内容：\n${text}\n\n【上一轮 facts 校验失败，请只修正下列出错条目后重新输出完整 JSON（保留其余合法事实，不要新增未发生的臆测事实）】\n${errList}`,
    },
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
7. 文本重复：同一句话/同一段落或大段内容在本章内重复出现（复读机事故，非有意的排比/回环修辞），以“文本重复”type 报告。
severity 分级：hard = 事实性硬矛盾或结构性缺陷（检查项 1/2/3/6/7 及实质性大纲偏离）；soft = 可辩论的节奏/密度/措辞张力类判断（检查项 5 及“略显模糊/存在张力”式问题）；拿不准时按 soft。
【误报护栏】只有与状态记录或前文既成事实【明确冲突、无法两读】的才能报 hard：措辞差异、近义表达、可两读的叙述（如“重新挎回背上”既可读作再次背上、也可读作此前曾背过）一律按 soft 或不报；人物同时拥有多个地点（如住处在草棚、藏物处在柴房）不得当作位置矛盾，只有把同一物件写在两个互斥地点时才算矛盾；不得因为正文选择比大纲更含蓄的写法（如剑未完全出鞘）就报 hard，这类属 soft 或写入 outline_drift。
没有问题时 issues 为空数组；每条简洁说明问题与依据，不要挑剔文风类小问题；被检章号已明确给出，禁止输出“若此章为第X章/若非第X章”式猜测性判断。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"issues": [{"type": "设定冲突|人物矛盾|伏笔矛盾|节奏过快|文本重复|其他", "severity": "hard|soft", "description": "问题描述"}], "outline_drift": "大纲偏离描述，没有则为空字符串"}`

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
// 逐场景扩写（multiScene）：每次只写一个场景，根治单次生成时后段压缩、过程概述的问题；
//   scenePlan 传当前场景，upcoming 传后续场景预告；withTitle 只在首段为 true（标题行由首段输出）。
// 篇幅预算（Round-5）：sceneWords = 本场景字数预算（由 sceneWordBudget 根据 chapterWords/场景数/已写字数自适应算出），
//   不传则退回 chapterWords/sceneCount 均分；旧版硬编码「600~900 / 2500」无视用户设定的每章字数，是字数膨胀的生成端根因之一。
// 细纲驱动（outlineDriven=true）：单章只依赖「本章详纲 + 世界规则块 + 出场人物卡 + 文风 + 前文尾部」，
//   砍掉 synopsis/longTerm/rollingSummary/prevChapterSummary/chronicles/passages/reference/storylines 与 world 全文——
//   这些块里装着全书走向与后续卷信息，是剧情漂移与提前揭示的主要来源；详纲已把本章该写什么写死，留着只会稀释它。
//   tail 由调用方从 2000 字压到 800 字，worldBlockText/volumeStrategy 由调用方走 rulesOnly/lean 档。
//   outlineDriven=false（默认）时上下文组装与改造前逐字节一致，可 A/B 对比。
export function longFormDraftMessages({ chapterNo, synopsis, world, worldBlockText, characters, participants, outline, longTerm, rollingSummary, prevChapterSummary, tail, foreshadows, passages, instruction, forbidden, storylines, povRule, scenePlan, chronicles, style, habits, rules, reference, volumeStrategy, chapterPosition, samples, multiScene, upcoming, withTitle = true, chapterTask, lastScene, consistencyCarryover = [], factLedger = null, chapterWords = 2000, sceneCount = 1, sceneWords = 0, outlineDriven = false }) {
  const inScene = Array.isArray(participants) && participants.length ? new Set(participants) : null
  const cardOf = (c) => `${c.name}${c.aliases ? `（又名：${c.aliases}）` : ''}：${[c.identity, c.personality, c.status ? `当前状态：${c.status}` : ''].filter(Boolean).join('，')}`
  const chars = (characters || []).filter((c) => !inScene || inScene.has(c.name)).map(cardOf).join('\n')
  const offScene = inScene ? (characters || []).filter((c) => !inScene.has(c.name)).map((c) => c.name).join('、') : ''
  // 伏笔提醒：细纲驱动模式下只留 ≤5 条——详纲的 [边界] 行已写死本章能揭示什么、严禁触及什么，
  // 整份未回收清单在这里只会稀释注意力、把本该写足的过程挤掉。优先保留保护期内的（碰了就是抢收，属硬约束），其余按原序补足。
  // outlineDriven=false 时输出与改造前逐字节一致：顺序不变、措辞不变、不限条数。
  const hookGuardOf = (f) => (f.minResolveChapter && chapterNo < f.minResolveChapter ? `保护期内，第 ${f.minResolveChapter} 章前禁止回收，只可铺垫渲染` : '已到回收窗口，可自然回收')
  const hookRows = (foreshadows || []).map((f) => ({ f, inGuard: !!(f.minResolveChapter && chapterNo < f.minResolveChapter) }))
  const hookKept = outlineDriven ? [...hookRows.filter((h) => h.inGuard), ...hookRows.filter((h) => !h.inGuard)].slice(0, 5) : hookRows
  const hooks = hookKept.map(({ f }) => `- ${f.content}（${hookGuardOf(f)}）`).join('\n')
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
  if (!outlineDriven && synopsis) ctx += `\n\n【故事梗概】\n${synopsis}`
  if (!outlineDriven && world && !worldBlockText) ctx += `\n\n【世界观设定】\n${world}`
  if (chars) ctx += `\n\n【本章出场人物（含当前状态，必须保持一致）】\n${chars}`
  if (offScene) ctx += `\n\n【本章不出场的人物】${offScene}——以上人物本章不应出场或被提及行动，除非剧情确有必要的例外。`
  if (worldBlockText) ctx += `\n\n【世界观设定（本章相关块，含永不省略的规则/禁忌块）】\n${worldBlockText}`
  ctx += factLedgerBlock(factLedger, '本章事实台账（道具归属/数字/设定约束，正文必须与之一致，不得漂移或新造）')
  const rule11 = (factLedger && ((Array.isArray(factLedger.numbers) && factLedger.numbers.length) || (Array.isArray(factLedger.items) && factLedger.items.length)))
    ? '11. 数字台账：金额/价格/余额/物品数量/承诺时长/倒计时/伤势数值等，一律以【本章事实台账】的 numbers/items 为准，台账未覆盖的再以人物当前状态与正文已出现的数字为准，落笔前先核对记录再写，严禁凭空捏造或漂移（如状态记余额 80，就不得写成耗尽八十点买价 480 的药；倒计时须逐秒连贯，不得跳变）；'
    : '11. 数字台账：金额/价格/余额/物品数量/承诺时长/倒计时/伤势数值等，一律以人物当前状态与正文已出现的数字为准，落笔前先核对记录再写，严禁凭空捏造或漂移（如状态记余额 80，就不得写成耗尽八十点买价 480 的药；倒计时须逐秒连贯，不得跳变）；'
  if (!outlineDriven && chronicles) ctx += `\n\n【人物编年史（各人物关键经历，写作不得与之矛盾）】\n${chronicles}`
  // 细纲驱动模式换标签：这块内容已经是 500~700 字详纲，标签必须跟着升级为「唯一剧情依据」，与规则 3 互相印证
  if (outline) ctx += `\n\n${outlineDriven ? '【本章详纲（本章唯一剧情依据：只写详纲给定场景的过程，详纲未写的事件一律不得出现）】' : '【本章细纲（只写本窗口内的剧情节点，后续章节的剧情节点一律留给后续章节，严禁提前写）】'}\n${outline}`
  if (volumeStrategy) ctx += `\n\n【本卷战略（本章属于本卷，写作须服务于它，卷末才允许落在卷级钩子上）】\n${volumeStrategy}`
  if (chapterPosition) ctx += `\n\n【本章结构定位：${chapterPosition}】本章叙事节奏须匹配该定位——起=铺垫开局蓄势，承=推进发展，转=制造方向性变化与冲突升级，合=阶段收束落钩，过渡=衔接换挡；不得写成与定位不符的节奏（如「转」章毫无转折、「承」章抢收结局）。`
  if (!outlineDriven && longTerm) ctx += `\n\n【长时记忆（全书重要事件沉淀，写较早章节时以此为准）】\n${longTerm}`
  if (!outlineDriven && rollingSummary) ctx += `\n\n【全书滚动摘要（近期剧情回顾）】\n${rollingSummary}`
  if (!outlineDriven && prevChapterSummary) ctx += `\n\n【上一章摘要】\n${prevChapterSummary}`
  if (hooks) ctx += `\n\n【未回收伏笔（可自然推进，不要擅自回收）】\n${hooks}`
  if (!outlineDriven && storylines && storylines.length) {
    ctx += `\n\n【现有故事线（写作须服务于其中，只推进不擅自完结）】\n` + storylines.map((s) => `- ${s.name}（${s.type}）：${s.progress}`).join('\n')
  }
  if (!outlineDriven && passageText) ctx += `\n\n【相关前文片段（检索所得，供细节与文风参考，禁止照抄）】\n${passageText}`
  if (!outlineDriven && reference) ctx += `\n\n【参考作品的叙事功能（结构层借鉴）】\n${reference}\n硬约束：严禁复用或谐音改写参考作品中的人物名/地名/设定名，只可借鉴其叙事功能与节奏模式；你笔下的人物与设定必须全部原创。`
  // 篇幅预算：显式给了 sceneWords 就用它（由 sceneWordBudget 根据已写字数自适应算出）；否则按 chapterWords/场景数均分。
  // 旧版硬编码「本段约 600~900 字 / 约 2500 字」：既无视用户设定的每章字数，也与场景数不匹配（3 场景×900=2700、
  // 而实测模型还会再超写 ~30%），是 §1 #9 字数膨胀（3487/3617 vs 2000）的生成端根因。
  const cwBudget = Number(chapterWords) > 0 ? Number(chapterWords) : 2000
  const nScenes = Math.max(1, Math.floor(Number(sceneCount) || 1))
  const perScene = Math.round(Number(sceneWords) > 0 ? Number(sceneWords) : cwBudget / nScenes)
  const scopeRule = multiScene
    ? `本段 ${Math.round(perScene * 0.85)}~${perScene} 字（全章共 ${cwBudget} 字、分 ${nScenes} 个场景写，本段只占其中一份；只写当前场景，写足对话与细节，写到上限就收束本段、把剩余过程留给后续场景，严禁为堆细节而超出上限）`
    : `全章 ${Math.round(cwBudget * 0.8)}~${Math.round(cwBudget * 1.2)} 字（目标 ${cwBudget} 字，超出两成即不合格）`
  // 规则 3 双档：细纲驱动模式下详纲是本章唯一剧情依据，措辞从「如有细纲，按细纲完成本章事件」（软性参照）
  // 升级为「详纲未写的一律不得出现」（硬约束）——这是把详纲从 0.4%~0.8% 的背景噪声抬成本章唯一事实源的关键一句。
  // outlineDriven=false 时 rule3Body 就是改造前的原文（含 ${chapterTask …} 活表达式），输出逐字节不变。
  const rule3Body = outlineDriven
    ? `本章详纲是唯一剧情依据：详纲未写的事件、人物、地点、设定与揭示一律不得出现（哪怕看起来顺势而为、哪怕前文已经铺垫到位）；必须先完整写到详纲最后一个场景的落点（该落点的过程与结果都要落地，不得把它挪给下一章），然后止步于此，严禁写出该落点之后的内容（包括下一章的开头与后续章的揭秘），章末钩子落在详纲【钩子】行给定的悬念上；最后一段必须收在悬念上（未解的问题、迫近的威胁或反转的预兆），严禁平铺直叙收尾；详纲 [边界] 行标注的「严禁触及」项，本章一个字都不得涉及；${chapterTask ? '本章只允许完成【本章核心任务】中的这一个任务，禁止顺手完成后续章节的任务；' : ''}`
    : `如有细纲，按细纲完成本章事件，章末落在钩子上；本章必须先完整写到本章细纲/核心任务的最后一个剧情节点（该节点的过程与结果都要落地，不得把它挪给下一章），然后止步于该节点，严禁写出该节点之后的内容（包括下一章的开头与后续章的揭秘），章末钩子落在本章最后节点的悬念上；最后一段必须收在悬念上（未解的问题、迫近的威胁或反转的预兆），严禁平铺直叙收尾；${chapterTask ? '本章只允许完成【本章核心任务】中的这一个任务，禁止顺手完成后续章节的任务；' : ''}`
  // 规则 13（只在细纲驱动模式出现）：正向内容约束，这是治本的一条。
  // 现有防提前的负向约束已经很密（窗口=1、规则3 止步、规则7 揭示层级、规则10 自检、末场景强制收束、draftSelfCheckMessages、truncateAfterAnchor），
  // 缺的是「字数不够时该往哪儿加」的正向出口——模型没东西可写就只能推进新剧情，于是节奏提前。
  const rule13 = outlineDriven
    ? '\n13. 篇幅只能靠详纲给定场景的过程、对话与感官细节写足，严禁靠新增剧情事件填字数：写到某个场景发现字数不够时，只能加深该场景已经写到的动作、对话、环境与心理层（补一个具体的感官细节、多一轮有信息量的对话、把一个动作拆成可见的步骤、把一句心理活动落成具体的犹豫与选择），不得引入新事件、新人物、新地点、新设定或新的冲突升级。'
    : ''
  return [
    {
      role: 'system',
      content:
        `你是一位职业小说作者，正在撰写一部长篇连载小说的第 ${chapterNo} 章。
【规则】
1. 篇幅${scopeRule}；严格紧接前文尾部继续，严禁重复或复述前文内容${multiScene ? '（前文尾部中已出现的句子与段落，本段一个字都不得再现，直接从新的动作/画面开始）' : ''}；
2. 必须与世界观、人物当前状态、既有剧情保持一致；不要凭空捏造新的重要人物与设定；细纲中的核心道具/地点/组织必须使用细纲原名，严禁改名或改换形态（如细纲写“罗盘”就不得写成“金属片”）；人物言行必须符合其身份定位与当前状态，严禁表现超出定位的能力、知识或镇定（如需铺垫只能以模糊、不受控的细节一闪而过）；人物内心独白与词汇须匹配其成长环境与认知水平，严禁出现超越背景的术语或凭空顿悟（认知飞跃必须由正文已写的感官证据一步步推出）；
3. ${rule3Body}
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
10. 落笔前止步自检：本场景写完后先自查——是否已越过本章细纲/核心任务的最后一个剧情节点？若有任何超出部分一律不写，收在本节点上的悬念处即停；严禁为填满篇幅而新增本章大纲未列的关键剧情事件（如新的惩罚机制/抑制协议触发、新能力觉醒、新人物登场、提前演绎后续章节节点），篇幅不足时只能加深当前节点的感官细节、对话与心理，不得推进新事件；章末不得以静态的环境描写或被动观望收尾（如"窗外安静下来""它在等待"），必须落在未解的问题、迫近的威胁或反转的预兆上；
${rule11}
12. 严禁文本重复：同一句话、同一段落或高度相似的描写不得在本章内重复出现；同一个比喻、意象、动作刻画、口头禅或心理独白，全章只允许出现一次——即使换了措辞或句式，只要内核相同（反复用同一个比喻去写同一件事、反复刻画同一个动作细节、反复念叨同一句师门教诲或口头禅、反复描写同一处景物）也算严重重复；跨场景需要呼应时，必须换用全新的、不同的意象与表达，严禁把前文已经用过的比喻或描写改几个字再写一遍。${rule13}` +
        NO_AI_FLAVOR_RULE +
        styleBlockOf({ style, habits, forbidden, rules, samples }),
    },
    { role: 'user', content: `前文尾部（请紧接其后续写）：\n\n${tail}${ctx}${carryoverBlock(consistencyCarryover, '上一章遗留的连续性硬问题（本章必须修正或避免重犯）')}${lastScene ? '\n\n【末场景强制收束】这是本章最后一个场景：写完本场景即全文结束，必须落在本章最后节点的悬念上立即收尾，严禁再写任何超出本场景的内容，尤其严禁触发任何属于后续章节的关键事件（新的惩罚机制/抑制协议、新能力觉醒、新人物登场等本章大纲未列的节点）。落笔前完成止步自检（规则10）：若已越过本章最后节点，删去超出部分，收在节点的悬念上。' : ''}\n\n请撰写第 ${chapterNo} 章正文。` },
  ]
}

// 场景清单（两段式写作第一步）：先让 AI 规划本章场景，用户确认后再扩写正文，根治"进程太快/跳过应展开的场景"
// 同时让 AI 圈定本章出场人物（participants），供初稿按需注入人物档案，而不是全书人物全量进上下文；
// 场景数随每章目标字数自适应（短章少场景，防事件过载），未给字数时默认 3~5。
const scenePlanSystem = (range, min) => `你是一位职业小说作者，正在为下一章规划场景清单。
【规则】
1. 必须输出 ${range} 个场景，场景依次衔接，每个场景推进一小步剧情或情感变化，合起来完成本章应写的内容；少于 ${min} 个视为不合格——剧情再简单也要拆成递进的过程场景（铺垫→推进→落钩），不得一步带过；场景数不够时只能把本章大纲已有节点拆得更细、加深其过程/对话/心理，严禁为凑数新增本章大纲之外的关键剧情事件（如新的惩罚机制、新能力觉醒、新协议触发、新人物登场）；
2. 每个场景用一句话描述（30 字以内）：在哪里、谁参与、发生什么、落在什么钩子上；细纲中的核心道具/地点必须用原名；此外为每个场景标注 enter（入场状态/起点节拍）、exit（落点状态/钩子）、advance（本场景【独占】推进的一小步）三段边界职责；相邻场景的 advance 必须互斥——后一场景严禁重复或提前演绎前一场景 advance 的内容，也不得把下一场景的 advance 提前写进本场景（治场景重叠复读）；
3. 必须紧接上一章结尾，遵守伏笔保护期与故事线约束；保护期内的伏笔只能铺垫，不得安排揭示；
4. 控制节奏：不要把多个重大事件塞进一章，留出对话与细节展开的空间；场景清单的终点必须精确停在【本章对应细纲】的最后一个剧情节点上——最后一个场景就落在该节点的悬念上，严禁规划该节点之后的任何发展（哪怕只是一步），即使你觉得剧情顺势该往下走也必须留给下一章；
5. participants 列出本章实际出场的全部人物姓名，必须与给定人物名单中的姓名完全一致，不得自造姓名；不出场的人物不要列入；
6. locations 列出本章场景涉及的地点、势力与组织名称（来自既有设定的用原名，新出现的用简短名称）；
7. proposals：仅当本章存在影响后续剧情走向的重大分支（重要人物去留、阵营抉择、关键秘密是否揭示等）时才给出，最多 1 条，需要作者拍板；普通剧情推进一律自行按细纲与故事线决定，不要给提案；没有任何分支时 proposals 必须是空数组。
8. factLedger（本章事实台账）：{items:[{name,owner,count,note}], numbers:[{key,value}], constraints:[设定禁忌/规则硬约束]}，只能【派生自既有设定与人物当前状态】、严禁新造道具/数字/设定（治设定冲突）；若已给【本章事实台账草稿】就据其细化，未给的字段留空数组；
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容（scenes 必须为 ${range} 项）：
{"scenes": [{"title": "场景标题（6字以内）", "summary": "这个场景发生什么（30字以内）", "enter": "入场状态/起点节拍（20字以内）", "exit": "落点状态/钩子（20字以内）", "advance": "本场景独占推进的一小步（20字以内，不得与相邻场景重叠）"}], "participants": ["出场人物姓名"], "locations": ["地点/势力"], "factLedger": {"items": [{"name": "道具名", "owner": "归属人物", "count": "数量", "note": "备注"}], "numbers": [{"key": "数字项", "value": "值"}], "constraints": ["设定禁忌/规则硬约束"]}, "proposals": [{"question": "需要作者拍板的剧情分支（40字以内）", "options": ["方向A（20字以内）", "方向B（20字以内）"]}]}`
// 场景数区间（随每章目标字数自适应）：约每场景 900 字，短章少场景防事件过载，未给字数时默认 3~5 个下限。
// 导出供调用方在「模型只回 1 个场景」时重问使用，措辞必须与本函数一致：
// 旧版重问文案硬写「不满足 3~5 个的下限」，与按 2000 字算出的 2~3 相冲，会把场景数硬推高、间接放大整章字数。
export function sceneCountRange(chapterWords) {
  const hint = Number(chapterWords) > 0 ? Math.min(5, Math.max(2, Math.round(Number(chapterWords) / 900))) : 0
  const range = hint ? (hint >= 5 ? '5' : `${hint}~${hint + 1}`) : '3~5'
  return { hint, range, min: hint || 3 }
}
export function scenePlanMessages({ chapterNo, synopsis, outline, rollingSummary, prevChapterSummary, storylines, foreshadows, povRule, instruction, characters, chapterPosition, chapterTask, chapterWords, volumeStory, factSeed, outlineDriven = false }) {
  const roster = (characters || []).map((c) => c.name).filter(Boolean).join('、') || '（暂无）'
  const hooks = (foreshadows || [])
    .map((f) => {
      const guard = f.minResolveChapter && chapterNo < f.minResolveChapter ? `保护期内，第 ${f.minResolveChapter} 章前禁止回收` : '可自然回收'
      return `- ${f.content}（${guard}）`
    })
    .join('\n')
  // 细纲驱动降级路径（详纲非结构化 / 旧书只有精简细纲，parseDetailScenes 解析不出场景时才走到这里）：
  // 同样砍掉全书梗概、全书滚动摘要与故事线——它们装着后续卷走向，是场景规划越界的主要来源；本章该规划什么由详纲给足。
  // outlineDriven=false 时输出与改造前逐字节一致。
  let ctx = ''
  if (!outlineDriven && synopsis) ctx += `\n\n【故事梗概】\n${synopsis}`
  if (outline) ctx += `\n\n${outlineDriven ? '【本章详纲（场景清单只能切分详纲已给定的过程，严禁新增详纲之外的事件）】' : '【本章对应细纲】'}\n${outline}`
  if (!outlineDriven && rollingSummary) ctx += `\n\n【全书滚动摘要】\n${rollingSummary}`
  if (prevChapterSummary) ctx += `\n\n【上一章摘要（本章须紧接其后）】\n${prevChapterSummary}`
  if (hooks) ctx += `\n\n【未回收伏笔】\n${hooks}`
  if (!outlineDriven && storylines && storylines.length) {
    ctx += `\n\n【现有故事线（只推进不擅自完结）】\n` + storylines.map((s) => `- ${s.name}（${s.type}）：${s.progress}`).join('\n')
  }
  if (instruction) ctx += `\n\n【用户指定的本章方向（必须遵循）】\n${instruction}`
  if (chapterTask) ctx += `\n\n【本章核心任务（场景清单只服务于这一个任务，不得把后续章节的任务提前安排进场景）】\n${chapterTask}`
  if (volumeStory) ctx += `\n\n【所在卷的本卷故事（场景应服务本卷这件具体故事，不得漂移到跨卷主线或提前写后续卷的事）】\n${volumeStory}`
  if (chapterPosition) ctx += `\n\n【本章结构定位：${chapterPosition}】场景规划须匹配该定位的节奏（起=铺垫蓄势，承=推进发展，转=方向性变化，合=阶段收束，过渡=衔接换挡）`
  if (povRule) ctx += `\n\n【视角约束】${povRule}`
  if (factSeed) ctx += `\n\n【本章事实台账草稿（据此细化 enter/exit/advance 与 factLedger，不得新造道具/数字/设定）】\n${factSeed}`
  const { hint, range, min } = sceneCountRange(chapterWords)
  return [
    { role: 'system', content: scenePlanSystem(range, min) },
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
5. cognitive_frame：作者的「认知框架」——不是写什么（辞藻/皮肤），也不是怎么结构（技法），而是作者如何思考世界；这是生成表层文风与结构的底层引擎，迁移它才能让新作「像这位作者一样思考」而非仅「像他一样遣词」。5 个子维度，每个 30 字以内，只谈可迁移的思维习惯、不引用原文：{causality: 因果观（事件如何链接：强因果闭环/性格决定论/命运偶然/规则驱动）, values: 价值序列（叙事奖励什么、惩罚什么，如情义>算计、尊严>苟活）, attention: 注意力分配（叙述者目光停留在哪：心理内省/外部动作/世情百态/环境氛围）, conflict: 冲突观（冲突主源：人性内部/外部势力/体制规则/命运无常）, worldview: 世界观基调（冷峻写实/温情悲悯/荒诞反讽/理想主义）}。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"work_function": "...", "character_functions": [{"slot": "...", "relation": "...", "arc": "..."}], "pacing_patterns": ["..."], "techniques": ["..."], "cognitive_frame": {"causality": "...", "values": "...", "attention": "...", "conflict": "...", "worldview": "..."}}`

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
export function chapterRewriteMessages({ chapterNo, title, content, fixPrompt, world, prevSummary, nextSummary, forbidden, style, habits, rules, samples, characters }) {
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
        styleBlockOf({ style, habits, forbidden, rules, samples }),
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

// tropes：worldviewTropeBlock(getWorldview(genre)) 的输出（【该题材高频套路…】+【可用的反套路切口…】），可为空串。
// 有内容时规则 3 从「模型自己在心里列 2~3 种套路」升级为「照单规避 + 5 个选题分别落在给定切口上」，
// 把反套路从自由发挥变成可核对的硬约束；为空（旧两字段数据 / 自定义题材未填）时逐字降级回原措辞。
export function inspirationMessages(genre, worldview, seed, tropes) {
  const seedBlock = seed
    ? `\n【本批发散骰（随机约束，必须遵守）】\n${seed}\n5 个选题都必须落在这些约束的交集内：每个选题以其中至少一个约束为核心展开，且 5 个选题分别侧重不同的约束组合，不得全部挤在同一个约束上。\n`
    : ''
  const tropeBlock = tropes ? `\n${tropes}\n` : ''
  const rule3 = tropes
    ? '3. 反套路（照单规避，硬约束）：上面已给出该题材的高频套路清单，清单里的套路一个都不得出现，换皮改名也不行；5 个选题必须分别落在「可用的反套路切口」的不同方向上，不得有两个选题共用同一个切口；'
    : '3. 反套路：先在心里列出该题材最高频、你最先想到的 2~3 种开局（如废柴退婚流、重生复仇流、系统签到流），然后主动规避它们——这批选题不得出现这些套路，哪怕换皮也不行；'
  return [
    {
      role: 'system',
      content: `你是一位脑洞极大的资深网文策划。下面给出「${genre}」题材的世界模板，它只是该题材常见套路的一份参考模板，不是定死的设定：你可以借用、改造、混搭、反转甚至完全抛弃它另起炉灶，不需要忠于模板，更不得把模板里的措辞当成硬约束。
【世界模板（参考用，权重低）】
${worldview}${tropeBlock}${seedBlock}
构思 5 个彼此差异足够大的长篇小说开局选题，要求：
1. 纯题材：只依赖题材自身套路/反套路，不含现实热梗与热点话题；除题材本身为都市/现实外，不得移植职场KPI、公司制度、AI绩效等现代社会元素；
2. 脑洞要大 = 发散性思维，而非黑暗/反转/致郁：每个选题都要有一个让人眼前一亮、意料之外又情理之中的核心创意点，方向不限——新颖的世界规则、独特的成长路径、别致的主角设定、巧妙的核心关系皆可；既可以是颠覆性的设定，也可以是靠主角自身努力、经受重重考验一步步成长的那种扎实而真挚的故事。唯一标准是不落俗套、有新鲜感，严禁把"脑洞大"窄化成必须黑深残或必须反转；5 个选题的核心创意点要落在不同方向，拒绝安全平庸、循规蹈矩的点子；
${rule3}
4. 5 个选题的世界观框架、主角身份、核心冲突、金手指/钩子互不重复，不得只是换个名字的同一套路；
5. 每个选题写清三件事：① 固定人设（主角姓名 + 身份 + 1~2 个核心关系）；② 固定背景（一句话世界观/设定，由你自由设计，不必照搬模板）；③ 想让 AI 修补的逻辑漏洞或合理化诉求：2~3 个"为什么"。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"ideas":[{"title":"选题名（12 字内）","brief":"完整初始提问文本"}]}
brief 必须按此模板写成一段话：
我想写一部…的小说。主角…，…
固定人设：…；固定背景：…。
请帮我把故事合理化：为什么…、为什么…`,
    },
    { role: 'user', content: `题材：${genre}。世界模板仅供参考可自由突破${tropes ? '；但高频套路清单是硬约束，一条都不得出现' : ''}${seed ? `；本批发散骰约束：${seed}` : ''}。请给出 5 个脑洞足够大、世界观彼此差异明显、主动规避该题材高频套路的纯题材选题。` },
  ]
}

// 落库前预检（初稿生成后、存档前的一次校订调用）：对照状态记录检查数字台账/生死连续/收束点/严重文本重复，发现问题最小修订；
// 把事后审校前移，硬矛盾在入库前就被修掉。repeatedPhrases=系统确定性扫出的重复长短语（代码检测、模型修复）；
// 越界另回 endAnchor（应保留的最后一句）供 truncateAfterAnchor 确定性截断兜底。
export function draftSelfCheckMessages({ chapterNo, text, characters, scenePlan, outline, repeatedPhrases = [], consistencyCarryover = [], factLedger = null }) {
  const chars = (characters || []).map((c) => `${c.name}${c.status ? `（当前状态：${c.status}）` : ''}`).join('\n') || '（暂无）'
  const check1 = (factLedger && ((Array.isArray(factLedger.numbers) && factLedger.numbers.length) || (Array.isArray(factLedger.items) && factLedger.items.length)))
    ? '1. 数字台账：金额/价格/余额/物品数量/承诺时长/倒计时/伤势数值等，是否与【本章事实台账】的 numbers/items 及【人物当前状态】、本章前文一致，不得漂移或跳变；'
    : '1. 数字台账：金额/价格/余额/物品数量/承诺时长/倒计时/伤势数值等，是否与【人物当前状态】及本章前文自洽，不得漂移或跳变；'
  const repeatHint = (Array.isArray(repeatedPhrases) && repeatedPhrases.length)
    ? `\n\n【系统已确定性检测到的重复长短语（字面高度雷同，已去标点；务必逐条处理：改写靠后出现的、或直接删除，只保留最必要的一处，不得原样保留任何一条）】\n${repeatedPhrases.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
    : ''
  return [
    {
      role: 'system',
      content: `你是一位小说校订编辑，负责对刚写好的章节做落库前预检与修订。
【检查项】
${check1}
2. 生死与状态连续（含空间位置）：人物生死、伤势、位置、随身物品的佩戴方式等不得与状态记录或本章前文跳变或自相矛盾（典型硬伤：剑/物品明明背在背上，却写“隔着胸前的麻布戳中剑”这类胸前背后位置错乱；或前文写背在背上、后文又写成已解下持在手中），这类矛盾必须改到前后一致；
3. 收束点与越界（节奏提前，重点）：章末是否越过【收束点】最后一个剧情节点，或演绎了本章大纲未列的后续关键事件——包括但不限于：新能力觉醒/身体异变（如青筋暴突、器物吸血苏醒、经脉异动、力量不受控）、新人物登场、提前揭示或暗示未回收伏笔的答案、把后续章节才该发生的冲突提前爆发。一旦越过，必须【直接删去越界的全部句子】，让全章恰好收束在【收束点】最后节点的悬念上（这是允许的截断，不算破坏篇幅，宁可短也绝不越界）；并在 endAnchor 字段【逐字摘录】删减后全章应保留的最后一句原文（供系统确定性截断兜底）；此外逐场景核对：本场景是否写到了它 advance（独占推进的一小步）之外的、属于下一场景的节拍——一旦与相邻场景重叠复读，删去越界的重复节拍，让每个场景只保留自己 enter→advance→exit 那一段；
4. 严重文本重复（重点）：不仅指同一句话/同一段落原样重复，也包括【同一意象、同一比喻、同一母题、同一口头禅/签名式短语在整章不同位置反复重铸】（哪怕字面略有改动、分散在多段）。【系统已检测到的重复长短语】必须逐条处理；此外自行排查母题级滥用（如某个比喻意象/某类匠人、器物、动物比喻全章出现 3 次以上），只保留最必要的 1~2 处，其余改写为完全不同的表达或删除。
5. 收束点欠账（未落地，与检查项 3 相反的毛病，重点）：正文是否【根本没写到】【收束点】要求的那个最后节点（典型：大纲要求“首次拔出半截剑对峙”，正文却只隔着布推出半寸、关键动作始终未真正发生；或要求两人当面对峙，正文却只写到其中一人到场）。一旦欠账，必须在章末【最小补写】该节点的落地过程与结果（只补这一个节点，不得附带任何其它新剧情、不得越到下一章），使全章恰好收束在该节点的悬念上；并在 problems 里写明补写了什么。
【修订原则】最小修订：只改有问题的句子/段落，其余保持原样；不得新增任何剧情（【唯一例外】检查项 5 的收束点欠账，允许在章末最小补写该节点的落地）；第一行保留章节标题行；revisedText 必须是修订后的【完整】章节正文。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"ok": true或false, "problems": ["问题简述（无问题为空数组）"], "endAnchor": "仅当检出收束点越界时填：删减后全章应保留的最后一句原文（逐字摘录）；无越界填空字符串", "revisedText": "修订后完整章节正文（ok 为 true 时填空字符串）"}`,
    },
    {
      role: 'user',
      content: `【人物名单与当前状态】\n${chars}\n\n【本章收束点（场景清单/细纲最后节点）】\n${scenePlan || outline || '（暂无）'}${factLedgerBlock(factLedger, '本章事实台账（核对数字/道具/设定约束是否与之一致）')}${repeatHint}${carryoverBlock(consistencyCarryover, '上一章遗留的连续性硬问题（本章必须修正或避免重犯，并在自检时逐条核查）')}\n\n【第 ${chapterNo} 章正文】\n${text}`,
    },
  ]
}

// Part2：把「本章事实台账」拼成注入块（function 声明提升，供 longFormDraft/draftSelfCheck 调用）；空台账返回空串（等价旧行为、向后兼容）
function factLedgerBlock(factLedger, title) {
  if (!factLedger || typeof factLedger !== 'object') return ''
  const items = (Array.isArray(factLedger.items) ? factLedger.items : []).filter((it) => it && it.name)
  const numbers = (Array.isArray(factLedger.numbers) ? factLedger.numbers : []).filter((n) => n && n.key)
  const constraints = (Array.isArray(factLedger.constraints) ? factLedger.constraints : []).filter(Boolean)
  if (!items.length && !numbers.length && !constraints.length) return ''
  const rows = []
  if (items.length) rows.push('· 道具归属：' + items.map((it) => it.name + (it.owner ? '（' + it.owner + '）' : '') + (it.count != null && it.count !== '' ? '×' + it.count : '') + (it.note ? '[' + it.note + ']' : '')).join('；'))
  if (numbers.length) rows.push('· 关键数字：' + numbers.map((n) => n.key + '=' + n.value).join('；'))
  if (constraints.length) rows.push('· 设定约束：' + constraints.map((c) => '- ' + c).join(' '))
  return '\n\n【' + title + '】\n' + rows.join('\n')
}

// 修复2：把「上一章遗留连续性硬问题」拼成注入块（function 声明提升，供前面的 draftSelfCheck/longFormDraft 调用）
function carryoverBlock(consistencyCarryover, title) {
  if (!Array.isArray(consistencyCarryover) || !consistencyCarryover.length) return ''
  return '\n\n【' + title + '】\n' + consistencyCarryover.map((c, i) => (i + 1) + '. ' + c).join('\n')
}

// 功能7：去AI味重写（LLM 层）——只改命中处，保持文风/剧情/字数基本不变
export function aiFlavorRewriteMessages({ text, hits }) {
  const hitList = (Array.isArray(hits) ? hits : []).map((h, i) => (i + 1) + '. [' + (h.type || 'AI味') + '] 「' + h.word + '」（出现' + (h.count || 0) + '次）').join('\n')
  return [
    { role: 'system', content: '你是一位小说文字编辑，负责消除正文里的「AI腔」。只修改下面列出的命中表达及其所在句子，其余一字不改；保持原有文风笔触、剧情、人物与字数基本不变；用具体的动作、对话、细节替换空洞修饰，不得新增剧情。\n【需消除的AI味命中】\n' + hitList },
    { role: 'user', content: '请重写以下正文，仅消除上述AI味命中：\n\n' + text },
  ]
}

// 修复（Round-4 P0-2）：残留重复定向改写——只回传命中片段的最小改写，避开长章整章 revisedText 被 0.7 字数地板拒绝的两难（§3.1）。
// repeats 为代码检出的重复长短语（已归一化去标点，仅作定位提示）；要求模型据此在正文中定位，
// 输出「逐字精确摘自正文」的 find 与最小改写的 replace，交由 applyRepeatFixes 确定性安全套用（find 不逐字命中即跳过）。
export function residualRepeatFixMessages({ text, repeats }) {
  const list = (Array.isArray(repeats) ? repeats : []).map((p, i) => (i + 1) + '. 「' + String(p) + '」').join('\n')
  return [
    {
      role: 'system',
      content:
        '你是小说文字编辑，任务是消除正文中「重复/复读」的片段，只做最小改写，绝不改动剧情、人物与其余文字。\n' +
        '【已检出的重复长短语】（系统按去标点归一化提取，仅用于帮你定位；正文里的真实字面可能带标点、略有出入）\n' +
        (list || '（无）') + '\n' +
        '【改写要求】\n' +
        '1. 对上述每一处重复，在正文中找到它实际出现的所有位置，保留最早/最主要的一处不动，把其余重复出现的那一处改写成【完全不同的表达】（换意象、换句式、换用词），或删除该冗余片段；\n' +
        '2. find 字段必须【逐字精确摘自正文】——含标点、语气词，一字不差，且要能定位到你想改的那一处（可带足够上下文，避免匹配到不该改的位置）；\n' +
        '3. replace 是改写后的片段，长度与 find 相当或更短，不得大幅膨胀、不得新增剧情；若该处应整段删除，replace 填空字符串；\n' +
        '4. 只处理确有重复的片段，没有把握宁可不改（少输出，也不要输出匹配不到正文的 find）。\n' +
        '【输出协议】严格按以下 JSON 输出，不要输出任何其它内容：\n' +
        '{"fixes":[{"find":"逐字精确摘自正文、需要被替换的原片段","replace":"改写后的片段（删除则填空字符串）"}]}',
    },
    { role: 'user', content: '请对以下正文定位并最小改写上述重复片段，按协议输出 fixes：\n\n' + text },
  ]
}
// 榜单洞察（榜单页底部「AI 故事偏向分析」）：读入某平台当前榜单的公开元数据（书名/题材/一句话简介/状态/字数），
// 产出 ① 整榜故事偏向综述（题材分布、共性爽点/情感取向、读者风向）② 逐本的故事偏向 + 故事梗概提炼。
// 合规红线：只基于给定元数据分析与提炼，严禁联网、严禁杜撰元数据里没有的具体情节/人名/地名/设定；
// 「故事梗概」是对简介(intro)的忠实提炼与合理扩写，不得编造原著没有的关键转折。
export function rankInsightMessages({ platformName, listName, books }) {
  const rows = (Array.isArray(books) ? books : [])
    .map((b, i) => `${i + 1}. 《${b.title || '无书名'}》${b.author ? ' / ' + b.author : ''}${b.category ? ' / 题材：' + b.category : ''}${b.extra && b.extra.status ? ' / ' + b.extra.status : ''}${b.extra && b.extra.wordCount ? ' / ' + b.extra.wordCount : ''}\n   简介：${b.intro || '（无）'}`)
    .join('\n')
  return [
    {
      role: 'system',
      content: `你是一位资深网文主编兼榜单分析师。下面给出「${platformName}${listName ? '·' + listName : ''}」的公开榜单元数据（书名、题材、一句话简介、连载状态、字数）。请仅依据这些元数据，分析这一批上榜小说的【故事偏向】，并为每一本提炼【故事梗概】。
【要求】
1. 只依据给定元数据分析与提炼，严禁编造元数据里没有的具体情节、人名、地名或设定；故事梗概是对简介的忠实提炼与合理扩写，不得杜撰原著没有的关键转折或结局。
2. overview：先给整榜综述——题材分布（哪些题材扎堆、大致各占几本）、共性元素（高频的爽点/设定/情感取向，如“重生复仇”“随身空间”“萌宝助攻”“战神归来”等）、以及这批书反映出的读者风向与情绪偏好，150~250 字。
3. genres：按题材归类统计，每项给出题材名(genre)、该题材在本榜的上榜本数(count，数字)、以及一句话点评该题材在本榜的整体取向(note)。
4. books：逐本给出——title（书名，须与输入逐字一致，便于前端对应）；orientation（故事偏向：一句话点明它的题材定位 + 核心吸引力/爽点或情感看点，20~40 字）；synopsis（故事梗概：在简介基础上提炼成 2~3 句、说清主角处境与核心冲突/看点，50~90 字，忠实不杜撰）。books 的数量与顺序必须与输入榜单保持一致。
【输出协议】严格按以下 JSON 格式输出，不要输出任何其他内容：
{"overview":"整榜故事偏向综述","genres":[{"genre":"题材名","count":该题材本数,"note":"该题材在本榜的取向点评"}],"books":[{"title":"书名（与输入逐字一致）","orientation":"故事偏向一句话","synopsis":"故事梗概2~3句"}]}`,
    },
    { role: 'user', content: `以下是「${platformName}${listName ? '·' + listName : ''}」的榜单元数据，请按要求分析整榜故事偏向、并逐本提炼故事偏向与梗概：\n\n${rows}` },
  ]
}

// ==================== #4 写前场景推演（多智能体）====================
// 对标 novel-distiller「MiroFish 场景推演：落笔前先推演场景逻辑自洽性」、novel-studio「多智能体世界推演」。
// 命门：AI 直接写场景常「能写但经不起推敲」——因果断裂、角色 OOC、冲突平淡、读者无感。
// 与其写完再改，不如【落笔前】让多个专家智能体从不同维度并行推演同一个场景前提，再由综合者收敛成可执行建议。
// 每个 agent 只负责一个维度（逻辑/角色/冲突/读者），互不干扰（并行），综合者做裁判 + 编排 beat 序列。
// 纯 AI（非确定性），故独立于零-AI 门禁；只做推演规划，绝不代写正文、绝不替作者拍板。

export const SCENE_SIM_AGENTS = [
  { id: 'logic', name: '逻辑推演者', focus: '因果自洽', icon: 'search' },
  { id: 'character', name: '角色动机推演者', focus: '角色不崩', icon: 'chat' },
  { id: 'conflict', name: '冲突升级推演者', focus: '张力升级', icon: 'flame' },
  { id: 'reader', name: '读者体验推演者', focus: '留人钩子', icon: 'sparkle' },
]

const SCENE_SIM_FOCUS = {
  logic: '你只负责【因果逻辑】维度：这个场景前提与前文因果链是否自洽？角色为何此刻在此、信息差是否合理、时间线与既定设定有无冲突、有没有「为了剧情强行让角色做不合理的事」。只挑逻辑漏洞，不谈文笔。',
  character: '你只负责【角色动机】维度：逐个出场角色推演——他/她带着什么目标进入这个场景、会怎么想怎么做、是否符合其既定性格与利益、会不会 OOC（说出/做出不符合人设的事）、角色之间的目标冲突点在哪。只谈角色，不谈逻辑硬伤。',
  conflict: '你只负责【冲突升级】维度：这个场景的核心冲突/张力是什么、够不够、如何升级（加阻碍/抬代价/造两难/反转）、怎样避免平铺直叙或流水账、场景结束时局势应比开场更紧张。只谈冲突节奏，不谈人设细节。',
  reader: '你只负责【读者体验】维度：读者读到这里的情绪曲线如何、钩子在哪、节奏是否拖沓或信息过载、读者此刻期待什么、什么会打动或劝退他们、章末该留什么悬念。站在追更读者视角，不谈创作技法术语。',
}

export function sceneSimAgentMessages({ agent, premise, context, characters, chapterNo }) {
  const focus = SCENE_SIM_FOCUS[agent] || SCENE_SIM_FOCUS.logic
  const roster = (characters || []).map((c) => `${c.name}${c.identity ? '（' + c.identity + '）' : ''}`).filter(Boolean).join('、') || '（未指定）'
  const sys = `你是一位长篇小说创作团队里的专家智能体，正在【落笔之前】对一个待写场景做推演。\n${focus}\n【规则】\n1. 只做推演与建议，绝不代写正文、绝不替作者拍板改剧情；\n2. 严格基于给定设定与前情，不编造未提供的关键设定；\n3. 结论要具体、可执行，落到「这个场景里谁该怎么做/该埋什么/该避免什么」，忌空泛套话。\n【输出协议】严格按以下 JSON 输出，不要输出任何其他内容：\n{"verdict":"可行|需调整|有风险","analysis":"本维度推演分析（120~200字）","risks":["该维度的具体风险点"],"suggestions":["该维度可执行的写作建议"]}` + NO_AI_FLAVOR_RULE
  const user = `【待推演场景前提】\n${premise}\n\n【涉及角色】\n${roster}\n\n【设定与前情】\n${context || '（无额外上下文）'}${chapterNo ? `\n\n【拟定章号】第 ${chapterNo} 章` : ''}\n\n请只从你负责的维度推演这个场景，按输出协议给出结论。`
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ]
}

export function sceneSimSynthesisMessages({ premise, context, agentOutputs, chapterNo }) {
  const parts = (agentOutputs || [])
    .map((o) => `【${o.name}·${o.focus}】结论：${o.verdict}\n分析：${o.analysis}\n风险：${(o.risks || []).join('；')}\n建议：${(o.suggestions || []).join('；')}`)
    .join('\n\n')
  const sys = `你是长篇小说创作团队的【总编/综合者】。四位专家智能体已分别从逻辑、角色、冲突、读者四个维度推演了同一个待写场景，现在由你收敛成一份可执行的场景推演报告。\n【规则】\n1. 综合各维度，指出最关键的风险与最值得采纳的建议（去重、排优先级），不要简单罗列；\n2. 若维度之间有矛盾（如「角色动机」与「冲突升级」打架），你要做裁判给出取舍理由；\n3. 给出一版推荐的场景 beat 序列（3~6 步，从开场到章末钩子），让作者照着就能写；\n4. 只做推演与规划，绝不代写正文。\n【输出协议】严格按以下 JSON 输出，不要输出任何其他内容：\n{"feasibility":"总体可行性判断（80~140字）","key_risks":["按优先级排序的关键风险"],"recommendations":["去重后排优先级的可执行建议"],"beat_sequence":["推荐场景beat：每步一句话"]}` + NO_AI_FLAVOR_RULE
  const user = `【待写场景前提】\n${premise}\n\n【设定与前情】\n${context || '（无）'}${chapterNo ? `\n\n【拟定章号】第 ${chapterNo} 章` : ''}\n\n【四位专家的推演结论】\n${parts}\n\n请综合收敛，按输出协议给出场景推演报告。`
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ]
}
