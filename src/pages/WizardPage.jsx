import { useEffect, useMemo, useRef, useState } from 'react'
import PromptEditorModal from '../components/PromptEditorModal.jsx'
import { PRESET_STYLES } from '../corpus/presetStyles.js'
import { put, getById, del, getAll } from '../lib/db.js'
import { parseBookAssets, parseAssetTable, backfillChapterNos, digestLines, isSectionHead, chapLineNo } from '../lib/parseAssets.js'
import { normalizeAsset, ASSET_TYPE_LABEL } from '../lib/assets.js' // #6：重新保存成书的非破坏性资产合并用(统一 links 去重 + state.place→located_in upsert)；B30：ASSET_TYPE_LABEL 供第9步缺类型提示复用（不再内联一份 type→中文映射）
import * as worldviews from '../lib/worldviews/index.js' // #6：题材档 chapterWords 单一出处(namespace 探测，B 导出 GENRE_STYLE_TABLE/chapterWordsFor 后自动生效)
import { sampleNovel, styleAnalyzeMessages, LANG_RULE } from '../lib/prompts.js' // WZ-4：移除 sanitizeHabits(净化统一在消费端 LongFormPage 做，建书侧不再净化)
import { distillStyleBand } from '../lib/longform.js'
import { readDocumentFile, READ_ACCEPT } from '../lib/docio.js'
import ClarifyModal from '../components/ClarifyModal.jsx'

// 新手写作：自顶向下搭建故事框架，共 9 步。每一步的提示词都经 PromptEditorModal 暴露给用户编辑、确认后才发送。
// 方案C：资产库管实体(assets)，情绪节拍(beats)与伏笔(foreshadows)分离落库；落库前用 parseBookAssets 把｜分列文本解析进三表。
// 数量带(宁多)：至少N至M，真书校准(完美世界势力核心20-25/地点25-30)；质量锚=每个资产写清前三卷不可替代的剧情作用。
// 章号断点修法A：第4-6步时序一律用【卷序】，章号在第8步排章后经【资产章号回填】细化。
// 提示词纪律：一律正向陈述；正向锚"只写上游出现过的或为其直接补全的"；字段缺省时写—。

const inspirePrompt = (targetWords, clarifyText) =>
  [
    '你是网文选题编辑。把下面的一句话灵感扩写成创作简报，每项一行，停留在概念层(讲什么/凭什么吸引/往哪走)。',
    LANG_RULE,
    '1. 题材与基调：类型/流派+情绪基调+一个对标作品或细分赛道，一句话。',
    `2. 目标体量：总字数${targetWords}字；卷数至少6至8+每卷大致章数，一句话。`,
    '3. 设定支点：区别于现实的核心设定及其规则，一句话；力量来源或升级方式涉及多个耦合设定时分条写清，至少1条至3条。',
    '4. 主角：身份+核心欲望+金手指类型，一句话。',
    '5. 核心冲突：一句话。',
    '6. 成长曲线：主角从起点到终局的能力/地位跨度，一句话。',
    '7. 主线：阶段数与建议卷数相当(至少6至8个)，每阶段写明格局变化(新增敌手层级+活动尺度扩大+本阶段揭示的真相)。',
    '8. 终局：主角最终成为/得到什么，一句话。',
    '',
    '用户补全答案(已确认的逻辑，直接采用；只写这些答案出现过的或为其直接补全的)：',
    clarifyText || '(无)',
    '',
    '一句话灵感：',
  ].join('\n')

const clarifyPrompt = (inspiration) =>
  [
    '你是故事结构编辑。读下面的一句话灵感，按逻辑顺序找出其中的逻辑缺口(①世界构成或地理没定 ②力量或能力体系没定 ③势力或社会格局没定 ④世界前史或背景事件没定 ⑤机制没定义 ⑥因果没讲清 ⑦动机没给足 ⑧关系没说明 ⑨对抗力量没定义 ⑩边界或限制没定义 ⑪信息差没定 ⑫时序或跨度没排 ⑬收束没闭环)，产出至少3个至10个补全问题帮用户补全逻辑；优先问序号靠前的缺口(世界观基础先定，才能推后续人物与情节)。',
    '每个问题给3个候选答案(每个一句话，方向明显不同)，供用户选择；用户也可自己写。',
    '问题必须是补全整体逻辑、让后续生成有据可依的关键缺口(如：A为什么能影响B？主角的X从哪来？Y的机制是什么？)；问题限定在灵感已提及要素之间的缺口，提问只用灵感里出现过的要素(灵感没提的新要素，如穿越者的现代知识金手指，留在提问之外)。',
    '只输出一个结构表：[{"question":"...","options":[{"label":"...","description":"..."},{"label":"...","description":"..."},{"label":"...","description":"..."}]}]',
    '',
    '一句话灵感：',
    inspiration,
  ].join('\n')

const STYLE_PROMPT_HEAD = [
  '你是文风编辑。基于"参考文风""题材"和"补充要求"，产出本书专用的六维度文风档案。',
  LANG_RULE,
  '六个小标题：【句式与语法】【叙事视角与人称】【节奏与分段】【对话风格】【描写取舍】【用词与修辞】。',
  '每维0-2句可执行描述，写"怎么做"；无把握的维度写一句该题材的基线做法。',
  '提炼笔法并适配题材基线；参考文风未覆盖的维度按题材与补充要求写。',
  '只输出六个小标题及其内容。',
  '',
  '参考文风：',
].join('\n')

// A10（用户拍板：圣经步骤不注入文风档案）：删掉原 styleProfile 死参数与其注释掉的注入块，签名收敛为只接收真正用到的 brief
const biblePrompt = (brief) =>
  [
    '你是世界观架构师。为百万字长篇构建世界观圣经。只写恒定状态(规则/等级/势力/地点/真相)，事件与时序留给下游。',
    LANG_RULE,
    '每条用陈述句给定名称/数值/因果；只写上游材料(简报)出现过的或为其直接补全的。',
    '质量锚：每个势力/地点/真相都写清它在前三卷承担哪个不可替代的剧情作用(删掉它哪个场景写不下去)；支撑不足该条写"—"；每个势力各有独立立场、每个地点都有人物前往的理由、每个等级都有各自的战力标尺。',
    '主角的现代背景只作性格与视角底色；能力、道具、机制的来源一律取自世界观内部。机构、能力、器物、机制、地点的命名和描述一律用本书世界观内部的说法，把现代职场、财务、互联网词汇换成世界观内的对应说法。',
    '时序一律用【卷序】(第几卷)；具体章号在第8步排章后回填。',
    '',
    '【世界与规则】宏观面貌与物理/社会运行规则，3-8句，每句一个独立规则。',
    '【核心设定机制】核心设定(金手指/灾变/异能体系)的运作规则与限制，5-10句。',
    '【力量体系】至少6个至15个大等级，每级一行：等级名｜能力质变｜突破条件｜战力标尺｜大致达成卷序；把全书要用到的等级体系一次交代明白，从最低到最高逐级列全。',
    '【势力】至少8方至20方，每方一行：势力名｜立场+资源｜与主角初始关系(敌/中立/庇护/利用)｜功能位(前三卷推动哪条冲突)｜知情人｜透出卷｜传闻卷(缺省写—)。',
    '【地点】至少12个至30个，按层级分组(世界框架/域级/场景级/势力驻地)，每地一行：地点名｜层级：X / 区域：Y｜功能 / 控制方：Z｜透出卷｜传闻卷（"层级："与"区域："与"控制方："三个前缀逐字保留，区域写它所属的更大地区名）。圣经只收恒定地点，副本流/无限流的一次性场景留到卷章步。',
    '【终极真相】至少3条至5条分阶段揭示的真相，每条一行：真相｜揭示卷序｜知情人。',
    '',
    '创作简报：',
    brief || '（空）',
  ].join('\n')

const charPrompt = (brief, bible) =>
  [
    '你是人物设计编辑。基于简报/圣经，设计本书的【常驻人物】与【群像】。本步只定义贯穿多卷的人物；各卷对立角色在第6步分卷结构表里按卷定义。时序用【卷序】，章号在第8步排章后回填。',
    LANG_RULE,
    '每个人物一行(字段顺序固定，该字段缺省时写—)：姓名｜身份｜核心欲望(脱离主角也成立)｜能力/战力定位(境界或段位+相对主角位置)｜与主角关系及张力(关系+利益冲突点)｜性格弧光(从X信念→到Y信念+触发事件；外部驱动型主角写—)｜秘密/底牌(1条+预计揭示卷)｜识别符(口头禅或标志动作，择一)｜语气示例(直接写2句可照抄进正文的台词，体现用词/句长/称呼)｜外貌锚点(10至20字)｜高光事件(具体动作+具体后果)｜高光卷序(与第7步节拍对应)｜贯穿卷范围｜首次透出卷｜传闻卷｜知情人｜退场方式(死/离/转化/留；死/离/转化各自给触发条件)。',
    '配角群像(群像=配角每一位都有独立高光)：长期配角之外再补2至4位次要配角，每行：配角名｜身份一句｜高光事件(具体动作+具体后果)｜高光卷序｜透出卷。',
    '硬约束：语气示例可直接照抄、不同人物用词层级肉眼可辨；主角与配角至少2处能力互补、1处能力冲突；配角之间至少3条独立于主角的关系线。',
    '每个人物的欲望在其与主角无关时也成立。某项无法从上游推出时该项写—，整个人物照常保留。',
    '',
    '配额：主角1人；长期配角至少6人至10人，覆盖功能位(战斗队友/情报技术/导师/情感线/势力接口/后勤调剂)每个功能位1至2人；圣经每个势力至少1名代表，缺省时写—。',
    '',
    '创作简报：',
    brief || '（空）',
    '',
    '世界观圣经：',
    bible || '（空）',
  ].join('\n')

// 独立资产表：一次生成完整、分层、带透出卷的资产（主角/配角/普通角色/地点/势力/道具），
// 替代"从圣经/人物顺带解析"导致的资产单薄；每行尾部统一三列「透出卷｜传闻卷｜知情人」，由 parseAssetTable 解析。
const assetTablePrompt = (brief, bible, characters) =>
  [
    '你是资产表编辑。基于简报/圣经/人物，产出本书完整的资产表，供正文写作时按章透出调用。分六段，每段每行一个资产，字段用｜分隔。',
    LANG_RULE,
    '所有段的每一行，最后三列固定是：透出卷｜传闻卷｜知情人（没有就填—）。透出卷写该资产正式登场的卷序，传闻卷写它只以传闻露出的卷序，具体章号在排章后回填。透出卷与传闻卷这两列只写阿拉伯数字卷序（如 1、3、12），知情人列写人名。',
    '【主角】1人，每行：姓名｜身份｜能力/战力定位｜核心欲望｜性格弧光｜高光事件｜透出卷｜传闻卷｜知情人。',
    '【配角】至少6人至12人（贯穿多卷的主要配角），每行：姓名｜身份｜能力/战力定位｜与主角关系及张力｜核心欲望｜高光事件｜透出卷｜传闻卷｜知情人。',
    '【普通角色】至少10个至30个（各卷陆续登场的次要角色、对手、功能性人物），每行：姓名｜身份｜与主角关系｜在剧情里的功能作用｜透出卷｜传闻卷｜知情人。',
    '【地点】至少15个至40个，每行：地点名｜层级｜区域｜功能｜控制方(须是名册势力/人物或"无主")｜透出卷｜传闻卷｜知情人。',
    '【势力】至少8方至20方，每行：势力名｜立场+资源｜与主角初始关系｜功能位｜透出卷｜传闻卷｜知情人。',
    '【道具】至少8个至20个，每行：道具名｜持有者｜功能｜出处｜透出卷｜传闻卷｜知情人。',
    '硬约束：名字取自圣经/人物/简报，不新造与上游冲突的实体；控制方/持有者/出处指向本表已有的资产名，没有就填"无主"；每个资产都写清它在剧情里不可替代的作用；数量宁多勿少，让每一章都有足够的已透出资产可写。',
    '只输出以上六段的｜分列行。',
    '',
    '创作简报：',
    brief || '（空）',
    '',
    '世界观圣经：',
    bible || '（空）',
    '',
    '人物：',
    characters || '（空）',
  ].join('\n')

const outlinePrompt = (brief, bible, characters) =>
  [
    '你是故事结构编辑。基于简报/圣经/人物，产出全书结构大纲。只写结构层，场景对白留给正文。时序用【卷序】。主线在简报基础上产出增量。',
    LANG_RULE,
    '【分卷结构表】每卷一行：卷序｜地图推进｜主角战力阶位(标本卷突破点)｜主要对手与势力格局变化。',
    '【关键转折】每卷至少2至3个(全书至少12至18个)，每个一句：所在卷+发生什么+改变了什么。',
    '【每卷事件节点】每卷至少8至15个，按时间序每节点一行：卷序.节点序｜事件(谁在何地做了什么，一句讲清)｜涉及人物｜涉及地点或势力｜承接(上一节点的后果如何引发本节点)｜后果(本节点造成什么变化或埋下什么新钩子)。节点因果相连、逐级推进；【关键转折】的每个转折都落在某个节点上；只写上游出现过的或为其直接补全的。',
    '【情绪曲线】按"蓄力—爆发—回落"循环编排，每卷标：主情绪基调｜蓄力段:释放段章数配比至少2至4比1｜卷末大爆点(爽点类型+强度)｜卷末新钩子。强度4至5的章在每卷里占少数(每4章里1章上下)、彼此隔开排布；高潮后接1章强度1至2的回落章。',
    '  · 每个情绪节点标出本章主爽点类型与触发事件。',
    '【伏笔】至少3条至6条(全书8至12条)，每条一行：伏笔名｜埋什么｜埋设卷｜回收卷｜重要度(主线级/支线级/局部级)｜传闻卷。发酵期由重要度决定(主线级至少40章、支线级至少15章、局部级至少5章)；每条伏笔都写出确定的回收卷。',
    '【悬念账本】全书一张：钩子编号｜埋设卷｜内容｜预计回收卷｜回收方式｜状态(未回收/已回收)。每卷末留待回收的钩子控制在5条以内。',
    '【终局】一句话。',
    '只写走向与节点；只写上游出现过的或为其直接补全的。',
    '',
    '创作简报：',
    brief || '（空）',
    '',
    '世界观圣经：',
    bible || '（空）',
    '',
    '人物：',
    characters || '（空）',
  ].join('\n')

// 第7/8步共用的排章纪律（单一出处，避免两处漂移）
const VOLUME_RULES = [
  '回溯锚：本章首次透出的资产，其透出卷早于或等于本卷；透出卷晚于本卷的资产以传闻出现，或留到其透出卷再登场。',
  '资产登场以资产表标明的透出卷为准，只排入透出卷早于或等于本卷的资产；不为凑数提前拉后面才透出的资产登场。',
  '每章任务各有分工；按事件密度排章；每章都推进主线、塑造人物、兑现爽点其中之一，只列有实际内容的章。',
]

const volumePrompt = (volumeLine, bibleDigest, charsDigest, outlineDigest) =>
  [
    '你是分卷结构编辑。基于体量/精简清单/大纲摘要，产出第1卷章节框架；分卷沿用大纲里的【分卷结构表】，本步只排章、不重复产分卷。',
    LANG_RULE,
    '【第1卷章节·前段】逐章列出第1至20章，每章一行：章号｜章名｜本章故事梗概(约200字，讲完本章从开场到结尾钩子的完整故事：在哪个场景/谁做了什么/遇到什么冲突/如何转折/怎么收尾；含对峙或谈判的章，梗概里写清一轮来回台词谁对谁说了什么；梗概内一律用逗号句号，把｜分隔符留给字段之间)｜本章视角人物(写人物名)｜本章首次透出的资产(人物/地点/势力名，含本章主角与在场人物)｜情绪节拍(主情绪+强度1-5+主爽点类型+触发事件)｜出场人物(用人物名册里的准确名字，逗号分隔)｜结尾钩子+类型。',
    ...VOLUME_RULES,
    '',
    '目标体量：',
    volumeLine || '（空）',
    '',
    '势力/地点/等级清单(精简)：',
    bibleDigest || '（空）',
    '',
    '人物清单(精简)：',
    charsDigest || '（空）',
    '',
    '故事大纲摘要(分卷表+事件节点+情绪曲线)：',
    outlineDigest || '（空）',
  ].join('\n')

// 第8步：续排第21章起 + 资产章号回填（独立一步，避免与长章表挤在同一次输出里被截断）
const volumePrompt2 = (volumesTail, bibleDigest, charsDigest, foreshadowLines) =>
  [
    '你是分卷结构编辑。第1卷前20章已排定(见下)。续排第21章起至本卷末，并产出资产章号回填清单。',
    LANG_RULE,
    '【第1卷章节·后段】逐章列出第21章至本卷末章，每章一行：章号｜章名｜本章故事梗概(150至250字，讲完本章从开场到结尾钩子的完整故事；含对峙或谈判的章，梗概里写清一轮来回台词谁对谁说了什么；梗概内一律用逗号句号，把｜分隔符留给字段之间)｜本章视角人物(写人物名)｜本章首次透出的资产(人物/地点/势力名，含本章主角与在场人物)｜情绪节拍(主情绪+强度1-5+主爽点类型+触发事件)｜出场人物(用人物名册里的准确名字，逗号分隔)｜结尾钩子+类型。',
    '【资产章号回填】把圣经/人物/伏笔各资产的"透出卷/传闻卷"细化为"透出章(伏笔写埋设章)/传闻章"，每行：资产名｜透出章｜传闻章，逐行整齐列出，每个资产与每条伏笔一行不漏；章号按前段加后段章表的事件顺序推定。',
    ...VOLUME_RULES,
    '',
    '势力/地点/等级清单(精简)：',
    bibleDigest || '（空）',
    '',
    '人物清单(精简)：',
    charsDigest || '（空）',
    '',
    '伏笔清单(回填埋设章的依据)：',
    foreshadowLines || '（空）',
    '',
    '前段末3章(续排时承接其结尾钩子与人物处境；前段已排到第20章)：',
    volumesTail || '（空）',
  ].join('\n')

// 上游精简：只取｜分列行的前 keep 个字段，避免全文堆叠稀释第7步指令。
// keep 需覆盖到"透出卷/传闻卷/知情人/退场方式"列(圣经势力第7列、人物知情人第16列、退场方式第17列)，否则第7/8步的回溯锚、知情人节与人物退场安排无从核对(M36)。
// digestLines 复用 parseAssets 导出的兼容版（兼容半角竖线与 markdown 表头；M35 起保留段标题行并滤掉 markdown 分隔行/表头行）。
// 大纲摘要：只取排章真消费的段（分卷表/转折/事件节点/情绪曲线）；伏笔与悬念账本已落库成表，整段不再注入
const outlineDigest = (text) => {
  const keep = []
  let on = false
  for (const raw of String(text || '').split('\n')) {
    const l = raw.trim()
    if (!l) continue
    // 段头判定统一走 parseAssets 的 isSectionHead(单一出处)：剥 #/【】/[]/** 装饰后匹配段名，兼容 AI 写 '## 分卷结构表'/'**分卷结构表**'(不带【】)——原 includes('分卷结构表') 只在已是标题行时判、且不认加粗/[]形态
    if (isSectionHead(l, '分卷结构表') || isSectionHead(l, '关键转折') || isSectionHead(l, '每卷事件节点') || isSectionHead(l, '情绪曲线')) {
      on = true
      keep.push(l)
      continue
    }
    // 其它标题行 → 关闭当前段(通用标题判定，非具名段匹配；与 LongFormPage outlineNodesOfVol 同处理，不用 isSectionHead(l,'') 空段名惯用法)
    if (/^#{1,3} /.test(l) || l.startsWith('【')) {
      on = false
      continue
    }
    if (on) keep.push(l)
  }
  return keep.join('\n')
}
// 伏笔段单独抽出，作第8步回填埋设章的依据
const foreshadowLinesOf = (text) => {
  const keep = []
  let on = false
  for (const raw of String(text || '').split('\n')) {
    const l = raw.trim()
    if (!l) continue
    // 段头判定统一走 isSectionHead(单一出处)：兼容 '【伏笔】'/'## 伏笔'/'**伏笔**'；其双门(无竖线+有标题装饰)天然防"散文里出现伏笔二字"被误判为段头(比 A12 的 includes('伏笔') 更严更准)
    if (isSectionHead(l, '伏笔')) {
      on = true
      keep.push(l)
      continue
    }
    if (/^#{1,3} /.test(l) || l.startsWith('【')) {
      on = false
      continue
    }
    if (on) keep.push(l)
  }
  return keep.join('\n')
}
// 章行→章号 chapLineNo 已下沉 parseAssets.js 单一出处（第五轮），本页 import 复用（原与 LongFormPage 的第二份本地副本已删）——两页同源、不再漂移。
//   #5(已知边界·入注防复审重复标记)：下沉版认裸中文数字行(「三｜…」→3)、全角数字→0、中文数字>99→0；volumesTail 取末3章时若卷章表混入这类行可能取偏。项目自产格式恒为阿拉伯章号，生成路径不受影响，仅手写/AI 漂移表可能踩。parseAssets 在 B 区、不在本页改。

// 前段章表只取末3章给第8步承接钩子，整份20章不再重复注入
const volumesTail = (text) =>
  String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => chapLineNo(l) > 0) // M2：与 LongFormPage 同口径——原 /^\d+[｜|]/ 不认「第N章」、不容忍数字后空格，「第N章」格式的书第8步承接上下文恒空
    .slice(-3)
    .join('\n')

// 第7步体量行提取：宽松匹配简报里以序号 2 开头的行(允许 **2. / 2、/ 二. 等任意非数字前缀)；
// 匹配不到时用目标总字数除以每章字数兜底算出全书章数，保证 volumePrompt 始终有体量锚。
const PER_CHAPTER_WORDS = 2500
// #6：兜底"每章字数"优先取题材档 chapterWords(GENRE_STYLE_TABLE：仙侠10000/玄幻3200/言情2000…，跨度2000-10000)，而非硬编码 2500——
// 否则仙侠(章均约1万字)会被按2500估成约4倍章数、第7步排章的体量锚失真。
// L7：worldviews 现已导出 chapterWordsFor(题材章字数单一出处)——下方探测恒命中、取真值(不再回落 2500)。namespace 探测写法保留为防御：
//   万一将来该访问器被重命名/移除，则回落 GENRE_STYLE_TABLE→PER_CHAPTER_WORDS，不阻断、也不在本页硬编码第二份题材表。
const genreChapterWords = (genreNote) => {
  const g = String(genreNote || '').trim()
  if (!g) return PER_CHAPTER_WORDS
  if (typeof worldviews.chapterWordsFor === 'function') {
    const n = Number(worldviews.chapterWordsFor({ genre: g }))
    if (Number.isFinite(n) && n > 0) return n
  }
  const table = worldviews.GENRE_STYLE_TABLE
  if (table) {
    const key = Object.prototype.hasOwnProperty.call(table, g) ? g : Object.keys(table).find((k) => g.includes(k))
    const cw = key ? Number(table[key] && table[key].chapterWords) : 0
    if (Number.isFinite(cw) && cw > 0) return cw
  }
  return PER_CHAPTER_WORDS
}
const resolveVolumeLine = (brief, targetWords, genreNote) => {
  const hit = String(brief || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^\D*2\s*[.、．:：]/.test(l))
  if (hit) return hit
  const tw = Number(targetWords) || 1000000
  const perCh = genreChapterWords(genreNote)
  const chapters = Math.max(1, Math.round(tw / perCh))
  return `目标总字数${tw}字；按每章约${perCh}字估算（据题材档），全书约${chapters}章。`
}

// 补全问答与文风蒸馏的回复是结构表文本，采纳时从中解析出问题列表/文风字段；解析失败提示用户重发。
const parseJsonReply = (text) => {
  const raw = String(text || '').trim()
  if (!raw) return null
  const unfenced = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try {
    return JSON.parse(unfenced)
  } catch {
    /* 落到下面的截取分支 */
  }
  const arr = unfenced.match(/\[[\s\S]*\]/)
  const obj = unfenced.match(/\{[\s\S]*\}/)
  for (const m of [arr, obj]) {
    if (m) {
      try {
        return JSON.parse(m[0])
      } catch {
        /* 继续尝试下一种 */
      }
    }
  }
  return null
}

// M-10：三表解析(资产/节拍/伏笔)——资产以独立「资产表」为准(更完整、分层、带透出卷)，资产表为空时回落圣经/人物解析；
// 再把卷章表的「资产章号回填」写回资产/伏笔(否则第8步回填成果全丢)。previewCounts(防抖计数)与 saveBook(落库即时算)共用同一函数，保证"所见即所存"。
// #5：资产表"全有或全无"→截断补足+告警。assetTablePrompt 要求六段(主角/配角/普通角色→person、地点、势力、道具)；AI 输出被 token 上限截断
// (如只到【地点】)时，原 `fromTable.length ? fromTable : fromBook.assets` 因 fromTable 非空而全用它、把圣经/人物能推出的势力/道具全丢，
// 用户只在第9步看到一个数字无从察觉。这里检测缺失类型、用 fromBook 同类型且未重名的补足，并回传告警标志供 UI 明示。
const TABLE_EXPECTED_TYPES = ['person', 'place', 'faction', 'item']
const computeParsed = ({ assetTable, bible, characters, outline, volumes, volumes2 }) => {
  const vols = `${volumes}\n${volumes2}`
  const fromBook = parseBookAssets({ bible, characters, outline, volumes: vols })
  const fromTable = parseAssetTable(assetTable)
  let assets = fromTable.length ? fromTable : fromBook.assets
  let supplemented = 0
  let missingTypes = []
  if (fromTable.length) {
    const have = new Set(fromTable.map((a) => a.type))
    missingTypes = TABLE_EXPECTED_TYPES.filter((t) => !have.has(t))
    if (missingTypes.length) {
      const names = new Set(fromTable.map((a) => a.name))
      const fill = (fromBook.assets || []).filter((a) => missingTypes.includes(a.type) && !names.has(a.name))
      assets = [...fromTable, ...fill]
      supplemented = fill.length
    }
  }
  backfillChapterNos(assets, fromBook.foreshadows, vols)
  return { assets, beats: fromBook.beats, foreshadows: fromBook.foreshadows, assetTableIncomplete: fromTable.length > 0 && missingTypes.length > 0, missingTypes, supplemented }
}

// #6：重新保存成书的非破坏性资产合并——wizard 重解析的表派生字段(type/tier/detail/reveal_volume/rumor_volume/knowers/aliases/ch_reveal/ch_rumor/holder)更新，
// 但保留长篇页写的 state(结算)/手改与 state.place 派生的 links/新增资产/id/createdAt。过 normalizeAsset 统一去重 links、由 state.place 重新 upsert located_in 边。
// detail 直接取 wizard 的(覆盖，不追加)→ 反复重新保存不会累积重复 detail。
const mergeAssetsForResave = (parsedAssets, savedAssets) => {
  const savedByName = new Map((savedAssets || []).map((a) => [a.name, a]))
  const parsedNames = new Set()
  const merged = (parsedAssets || []).map((pa) => {
    parsedNames.add(pa.name)
    const sa = savedByName.get(pa.name)
    if (!sa) return pa // wizard 表里新增的资产，直接用
    return normalizeAsset(
      {
        ...pa,
        id: sa.id, // 保留原 id，否则指向它的 links 全断
        state: sa.state, // 保留长篇页结算写的状态
        createdAt: sa.createdAt,
        links: [...(sa.links || []), ...(pa.links || [])], // 手改/状态派生边 ∪ 表内绑定边，normalizeAsset 去重
      },
      { idPrefix: 'lf' }
    )
  })
  const savedOnly = (savedAssets || []).filter((a) => !parsedNames.has(a.name)) // 长篇页新增、wizard 表里没有的资产：保留不丢
  return [...merged, ...savedOnly]
}

// #6：伏笔合并按 title 保留长篇页结算写的生命周期(state/lastAdvancedChapter/payoff_hint)，wizard 只更新 desc/埋设回收卷等表派生字段
const mergeForeshadowsForResave = (parsedFs, savedFs) => {
  const savedByTitle = new Map((savedFs || []).map((f) => [f.title, f]))
  return (parsedFs || []).map((pf) => {
    const sf = savedByTitle.get(pf.title)
    return sf ? { ...pf, state: sf.state || pf.state, lastAdvancedChapter: sf.lastAdvancedChapter, payoff_hint: sf.payoff_hint || pf.payoff_hint } : pf
  })
}

const box = 'w-full resize-y rounded-lg border border-stone-300 bg-stone-50 p-3 text-sm leading-relaxed focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-200'
const line =
  'w-full rounded-lg border border-stone-300 bg-stone-50 px-3 py-2 text-sm focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-200'
const label = 'mb-1 block text-xs font-medium text-stone-500'
const genBtn =
  'rounded-lg bg-red-700 px-4 py-1.5 text-sm text-onaccent hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-red-700'
const hint = 'mt-2 text-xs text-stone-400'

// 草稿持久化：纯前端项目，刷新不丢未落库内容（落库的书在 IndexedDB books store）
const DRAFT_KEY = 'na_wizard_draft'
// 必修2/C39：草稿初值改「惰性读取」。原为模块级 const（只在页面首次加载求值一次），clearDraft 清了 LS/IDB/内存后
//   该 const 仍持旧快照；切页签真卸载再回来时 useState(DRAFT.*) 会把已清空的内容复活、保存副作用再写回 LS/IDB，"不可撤销"其实可逆。
//   改成组件挂载时读一次 LS（下方组件内 `const [DRAFT] = useState(() => readDraft())`）；clearDraft 已 removeItem → 重挂载读到空、不复活。
//   只读 LS：原文样本 styleSourceText 不在 LS 轻载荷里，仍由下面的 IDB restore 副作用异步载入，M-1 loadedIdbSourceRef null 哨兵不受影响。
function readDraft() {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null') || {}
  } catch {
    return {}
  }
}

// H-新1：草稿写盘抽成函数，供 400ms 防抖与「卸载 / pagehide」flush 共用（与 ContinuePage/RevisePage/LongFormPage 同构）。
//   localStorage 放不含原文样本的轻载荷(超配额不中断数据库落盘)；IndexedDB 放全量。IDB 写失败置 draftSaveError 明示(M38)，不静默。
function writeWizardDraft(payload, setErr) {
  const { styleSourceText: _omit, ...lightPayload } = payload
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(lightPayload))
  } catch {
    /* 小容量存储超配额时跳过，数据库那份仍在 */
  }
  return put('drafts', { id: DRAFT_KEY, updatedAt: Date.now(), ...payload })
    .then(() => setErr(''))
    .catch(() =>
      setErr('草稿未能保存到浏览器数据库（可能存储空间不足）；请尽快「落库成书」或到「我的」页导出备份，否则刷新后未落库内容可能丢失。')
    )
}

// 第一档④修：clarifyQuestions 归一抽成模块级 helper，供 adoptClarify(写侧) 与两处回读(localStorage 初值 / IDB restore)共用——
//   ClarifyModal 直接渲染 q.question / o.label / o.description，修复前落库的毒丸(字段是对象/数组)刷新即回灌、渲染抛「Objects are not valid as React child」持续崩、只能清空逃生。
//   过滤无效项 + 逐字段 typeof 归一(对象归空、不显 [object Object])；读回旧毒丸也归一成安全空串。写侧/读回侧共用一份，防口径漂移。
function sanitizeClarifyQuestions(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.questions) ? raw.questions : []
  return list
    .filter((q) => q && q.question && Array.isArray(q.options) && q.options.length >= 2)
    .slice(0, 10)
    .map((q) => ({
      ...q,
      question: typeof q.question === 'string' ? q.question : '',
      options: q.options.map((o) =>
        o && typeof o === 'object'
          ? { ...o, label: typeof o.label === 'string' ? o.label : '', description: typeof o.description === 'string' ? o.description : '' }
          : { label: typeof o === 'string' ? o : '', description: '' },
      ),
    }))
}

export default function WizardPage({ onOpenLongForm }) {
  // 必修2：草稿初值惰性读取——挂载时读一次 LS（非每渲染），clearDraft 后重挂载读到空、不复活（见 readDraft 注释）
  const [DRAFT] = useState(() => readDraft())
  const [inspiration, setInspiration] = useState(DRAFT.inspiration || '')
  const [targetWords, setTargetWords] = useState(DRAFT.targetWords || '1000000')
  const [brief, setBrief] = useState(DRAFT.brief || '')
  const [inspireOpen, setInspireOpen] = useState(false)

  const [clarifyQuestions, setClarifyQuestions] = useState(() => sanitizeClarifyQuestions(DRAFT.clarifyQuestions)) // 第一档④：localStorage 草稿回读也归一，防旧毒丸
  const [clarifyOpen, setClarifyOpen] = useState(false)
  const [clarifyAnswers, setClarifyAnswers] = useState(DRAFT.clarifyAnswers || null)
  const [clarifyPromptOpen, setClarifyPromptOpen] = useState(false)
  const [clarifyErr, setClarifyErr] = useState('')

  const [stylePreset, setStylePreset] = useState(DRAFT.stylePreset || '')
  const [genreNote, setGenreNote] = useState(DRAFT.genreNote || '')
  const [styleNote, setStyleNote] = useState(DRAFT.styleNote || '')
  const [styleProfile, setStyleProfile] = useState(DRAFT.styleProfile || '')
  const [styleOpen, setStyleOpen] = useState(false)
  const [styleSourceText, setStyleSourceText] = useState('')
  const [styleHabits, setStyleHabits] = useState(DRAFT.styleHabits || []) // WZ-1：初值从 DRAFT 读，与 styleProfile 一致，避免"localStorage 存了却首屏闪空/IndexedDB 载入失败时永远空"
  const [styleSamples, setStyleSamples] = useState(DRAFT.styleSamples || [])
  const [styleMetrics, setStyleMetrics] = useState(DRAFT.styleMetrics || null)
  const [styleReliable, setStyleReliable] = useState(!!DRAFT.styleReliable) // WZ-2：蒸馏指纹是否可靠(样本量足够)，与 styleMetrics 一起持久化；徽标据此区分"含14维指纹"与"样本过短仅供参考"
  // 第2项(avgParaLenFor 半生效)：指纹来源 'distill'(原文蒸馏)|'preset'(预设真值语料)|''；徽标据此措辞，避免选预设存了 metrics 后误报"已蒸馏"
  const [styleMetricsFrom, setStyleMetricsFrom] = useState(DRAFT.styleMetricsFrom || '')
  const [distillPromptOpen, setDistillPromptOpen] = useState(false)
  const [distillSystem, setDistillSystem] = useState('')
  const [distillUserPrompt, setDistillUserPrompt] = useState('')
  const [distillSamples, setDistillSamples] = useState([])
  const [distillErr, setDistillErr] = useState('')

  const [bible, setBible] = useState(DRAFT.bible || '')
  const [bibleOpen, setBibleOpen] = useState(false)
  const [characters, setCharacters] = useState(DRAFT.characters || '')
  const [charsOpen, setCharsOpen] = useState(false)
  const [assetTable, setAssetTable] = useState(DRAFT.assetTable || '')
  const [assetTableOpen, setAssetTableOpen] = useState(false)
  const [outline, setOutline] = useState(DRAFT.outline || '')
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [volumes, setVolumes] = useState(DRAFT.volumes || '')
  const [volumesOpen, setVolumesOpen] = useState(false)
  const [volumes2, setVolumes2] = useState(DRAFT.volumes2 || '')
  const [volumes2Open, setVolumes2Open] = useState(false)

  const [savedBook, setSavedBook] = useState(null)
  const [saveErr, setSaveErr] = useState('')
  const [saving, setSaving] = useState(false) // #3：落库进行中标志，禁用按钮防双击建出两本不同 id 的重复书
  const [draftSaveError, setDraftSaveError] = useState('') // M38：草稿写 IndexedDB 失败时置位，界面明示"未能保存"，不再无保证地承诺"刷新不丢"
  const loadedRef = useRef(false) // M37：首次草稿载入完成前，保存副作用不写盘，避免用挂载初值(空 styleSourceText)覆盖 IndexedDB 里已存的原文样本
  const skipSaveRef = useRef(false) // #8：clearDraft 后跳过一次保存副作用，否则 del('drafts') 会被 400ms 后的 put 抵消、drafts 重现空记录
  const userTouchedRef = useRef(false) // #9：用户是否已在首屏真实输入——IndexedDB 慢载入完成时若已输入则不覆盖(防冷启动/大 value 慢载入冲掉用户输入)
  const clearedRef = useRef(false) // item3（第十轮）：clearDraft 置真——IDB 载入 .then 与 restoreSavedBook 据此丢弃「清空后才到达」的异步回填。
  //   竞态：点「清空」时 window.confirm 阻塞事件循环，getById('drafts') 常在此间 resolve；clearDraft 同步跑完后其 .then 才执行，
  //   会把 21 字段全量回填 + 无条件 restoreSavedBook → 已清空草稿与 savedBook 复活、第9步重现「重新保存成书」、点下去用空内容覆盖已落库书(正是 H3 要防)。
  //   四重防复活(skipSaveRef/draftRef=null/loadedIdbSourceRef=''/del)只覆盖**写侧**，此哨兵补上**读侧**（清空后到达的回填一律丢弃）。
  const draftRef = useRef(null) // H-新1：随时持有最新草稿载荷，供「卸载 / pagehide」flush 补写防抖窗口内的最后编辑（与另三页同构）
  const loadedIdbSourceRef = useRef(null) // M-1(方案b)：IDB 载入的原文样本兜底值。null=尚未载入/未被用户接管；''=用户已接管原文框(onChange/导入/清空置此)；非空串=IDB 原文。冷启动竞态下 state 为空且未被接管时用它兜底，防空值覆盖 IDB 整本原文。
  const [draftLoaded, setDraftLoaded] = useState(false) // #5：草稿载入完成标志——载入前不显第2步 hint，避免 styleSourceText(不在 localStorage、异步从 IDB 载)导致 hint 从"请选预设"闪变成"已粘贴原文"

  const hasBrief = !!brief.trim()
  const hasBible = !!bible.trim()
  const hasChars = !!characters.trim()
  const hasOutline = !!outline.trim()
  const styleEmpty = !stylePreset && !styleNote.trim() && !genreNote.trim()

  const preset = PRESET_STYLES.find((s) => s.bookName === stylePreset)
  const styleInitialPrompt =
    STYLE_PROMPT_HEAD +
    (preset?.profile || '（无预设）') +
    '\n\n题材：\n' +
    (genreNote || '（无）') +
    '\n\n补充要求：\n' +
    (styleNote || '（无）')

  useEffect(() => {
    // M37：首次载入完成前不写草稿，否则挂载初值(空 styleSourceText)会覆盖 IndexedDB 里已存的整本原文样本。
    // L3(已知窄缺口·刻意不兜底)：故 draftRef 在载入完成前不赋值 →「载入完成前就输入并刷新」这段输入不会被 flush 兜住。
    //   不提前 flush 是有意为之：pre-load 载荷的 styleSourceText 还没从 IDB 载入(为空)，此时 flush 会用空原文覆盖 IDB 里的好草稿=比缺口更严重的数据损坏。
    //   窗口很窄(仅「IDB 载入完成前输入 + 立刻刷新」)，且 userTouchedRef 保证载入完成后不覆盖用户已输入内容——权衡取「宁可不兜这段，也不冒覆盖原文的险」。
    if (!loadedRef.current) return
    // #8：clearDraft 刚 del 掉草稿，这次由清空触发的保存要跳过，否则 400ms 后又 put 回一条空草稿(del 被抵消)
    if (skipSaveRef.current) {
      skipSaveRef.current = false
      draftRef.current = null // H-新1：清空后不要把旧载荷留给 flush，否则 pagehide/卸载会把已清空的草稿复活
      return
    }
    // M-1(方案b)：styleSourceText 为空时用 IDB 载入的兜底值——冷启动竞态(用户先敲字→userTouched→.then 跳过 restore)下 state.styleSourceText 停在空，
    //   直接保存会用空值覆盖 IDB 里已存的整本原文样本(永久丢，localStorage 轻载荷不含它、无备份)。用户一旦编辑原文框即把 ref 置 ''(接管)，此兜底自动让位。末尾 ||'' 兜住 ref 仍为 null 的载入失败边角。
    const payload = { inspiration, targetWords, brief, clarifyQuestions, clarifyAnswers, stylePreset, genreNote, styleNote, styleProfile, styleHabits, styleSamples, styleSourceText: styleSourceText || loadedIdbSourceRef.current || '', styleMetrics, styleReliable, styleMetricsFrom, bible, characters, assetTable, outline, volumes, volumes2, savedBookId: savedBook?.id || '' }
    draftRef.current = payload // H-新1：同步持有最新载荷——防抖 400ms 未到期时，卸载/pagehide 的 flush 也能补写最后编辑
    const t = setTimeout(() => writeWizardDraft(payload, setDraftSaveError), 400)
    return () => clearTimeout(t)
  }, [inspiration, targetWords, brief, clarifyQuestions, clarifyAnswers, stylePreset, genreNote, styleNote, styleProfile, styleHabits, styleSamples, styleSourceText, styleMetrics, styleReliable, styleMetricsFrom, bible, characters, assetTable, outline, volumes, volumes2, savedBook])
  // H-新1：卸载(切页签——App 条件渲染真卸载本页) 与 pagehide(刷新/F5/关标签——不走 React cleanup) 各 flush 一次，兜住 400ms 防抖窗口内的最后编辑。
  //   最坏场景：采纳 AI 回复(圣经/资产表/卷章)后 400ms 内切页/刷新 → 整段丢。与 ContinuePage/RevisePage/LongFormPage 的「pagehide + 卸载 flush」同构，WizardPage 是仅剩未修的一页。
  //   best-effort：pagehide 期间 IndexedDB 不保证落盘，但 localStorage(轻载荷)是同步写、多数赶得上。空 deps → 监听只挂一次。
  useEffect(() => {
    const flush = () => {
      if (draftRef.current) writeWizardDraft(draftRef.current, setDraftSaveError)
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush() // 卸载(切页签)时立即补写
    }
  }, [])

  // 落库前先算一次三表计数，让用户核对后再落库（item 25）
  // M-10：previewCounts 原先对 6 个大 textarea 每次按键都全量重跑 parseBookAssets+parseAssetTable+backfillChapterNos(含 O(n²) buildLinks)，输入卡顿。
  // 改用 400ms 防抖快照算计数(仅供第9步 UI 核对)；落库时 saveBook 用当前值即时重算，不吃防抖滞后值，保证落库=用户最后编辑。
  const [debouncedSrc, setDebouncedSrc] = useState({ assetTable, bible, characters, outline, volumes, volumes2 })
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSrc({ assetTable, bible, characters, outline, volumes, volumes2 }), 400)
    return () => clearTimeout(t)
  }, [assetTable, bible, characters, outline, volumes, volumes2])
  const previewCounts = useMemo(() => computeParsed(debouncedSrc), [debouncedSrc])

  // M34：第7/8步弹窗的 initialPrompt 原先内联重算 digestLines/outlineDigest/foreshadowLinesOf/volumesTail
  // （对圣经与人物全文各扫多次），大文本下每次按键都重算、弹窗关闭时也照算。改 useMemo 缓存，两个弹窗共享 digestLines 结果，只在上游文本变化时重算。
  const bibleDigest = useMemo(() => digestLines(bible, 7), [bible])
  const charsDigest = useMemo(() => digestLines(characters, 17), [characters]) // M36：keep 17 覆盖到第17列"退场方式"(死/离/转化/留+各自触发条件)，否则第7/8步排章不知人物何时以何种方式退场，可能给已死/已离场人物排后续戏份与对白
  const volumeInitialPrompt = useMemo(
    () => volumePrompt(resolveVolumeLine(brief, targetWords, genreNote), bibleDigest, charsDigest, outlineDigest(outline)),
    [brief, targetWords, genreNote, bibleDigest, charsDigest, outline]
  )
  const volume2InitialPrompt = useMemo(
    () => volumePrompt2(volumesTail(volumes), bibleDigest, charsDigest, foreshadowLinesOf(outline)),
    [volumes, bibleDigest, charsDigest, outline]
  )

  // #9：捕获用户首次真实输入(input 事件冒泡到 window；程序化 setState 改 value 不触发 input，故只会被真人输入置位)，供慢载入 .then 判断是否覆盖首屏
  useEffect(() => {
    const mark = () => {
      userTouchedRef.current = true
    }
    window.addEventListener('input', mark, { once: true })
    return () => window.removeEventListener('input', mark)
  }, [])

  // IndexedDB 草稿覆盖 localStorage 首屏值（IndexedDB 为准，容量大）
  useEffect(() => {
    let alive = true
    // L3：savedBook 恢复兜底——IDB 草稿优先，IDB 无草稿/读失败时用 localStorage 草稿(DRAFT)的 savedBookId 再试，防 IDB 故障时刷新后第9步重复建书(H3 本意)
    const restoreSavedBook = (id) => {
      if (!id) return
      getById('books', id)
        .then((b) => {
          if (alive && !clearedRef.current && b) setSavedBook(b) // item3：清空后到达的 savedBook 回填丢弃，防第9步「重新保存成书」复活覆盖已落库书
        })
        .catch(() => {})
    }
    getById('drafts', DRAFT_KEY)
      .then((d) => {
        if (!alive || clearedRef.current) return // item3：清空后到达的草稿回填一律丢弃（防 21 字段复活）；正常载入(clearedRef=false)不受影响
        // M-1(方案b)：记下 IDB 的原文样本兜底值——冷启动竞态下(用户先敲字→跳过下面的 restore)state.styleSourceText 停在空，保存时用它兜底(见持久化 payload)，避免空值覆盖 IDB 整本原文。
        // L⑤：仅在 ref 仍为 null(=用户尚未接管原文框)时回填。若用户在 getById resolve 前已编辑/清空过原文框(onChange/导入已把 ref 置 '')，则不回填——否则会用 IDB 旧值盖掉用户的清空、下次保存复活原文。
        //   (不用全局 userTouchedRef 判定：那只反映"碰过任意字段"，用户敲的是灵感框而非原文框时仍须回填原文，故用原文框专属的 null 哨兵。)
        if (loadedIdbSourceRef.current === null) loadedIdbSourceRef.current = (d && d.styleSourceText) || ''
        // #9：用户在慢载入完成前已真实输入(冷启动/大 value 慢) → 不用草稿覆盖首屏各字段，避免 21 个 setState 冲掉用户已输入；仅未交互时回填
        if (d && !userTouchedRef.current) {
          setInspiration(d.inspiration || '')
          setTargetWords(d.targetWords || '1000000')
          setBrief(d.brief || '')
          setClarifyQuestions(sanitizeClarifyQuestions(d.clarifyQuestions)) // 第一档④：IDB 草稿回读也归一，防旧毒丸刷新回灌崩
          setClarifyAnswers(d.clarifyAnswers || null)
          setStylePreset(d.stylePreset || '')
          setGenreNote(d.genreNote || '')
          setStyleNote(d.styleNote || '')
          setStyleProfile(d.styleProfile || '')
          setStyleHabits(d.styleHabits || [])
          setStyleSamples(d.styleSamples || [])
          setStyleSourceText(d.styleSourceText || '')
          setStyleMetrics(d.styleMetrics || null)
          setStyleReliable(!!d.styleReliable)
          setStyleMetricsFrom(d.styleMetricsFrom || '')
          setBible(d.bible || '')
          setCharacters(d.characters || '')
          setAssetTable(d.assetTable || '')
          setOutline(d.outline || '')
          setVolumes(d.volumes || '')
          setVolumes2(d.volumes2 || '')
        }
        // H3+L3：savedBook 恢复不碰输入字段，userTouched 与否都执行——IDB 草稿 savedBookId 优先，缺则用 localStorage 草稿 DRAFT.savedBookId 兜底
        restoreSavedBook((d && d.savedBookId) || DRAFT.savedBookId)
      })
      .catch(() => {
        // L3：IDB 草稿读取失败，用 localStorage 草稿的 savedBookId 兜底恢复 savedBook
        restoreSavedBook(DRAFT.savedBookId)
      })
      .finally(() => {
        if (alive) {
          loadedRef.current = true // M37：载入流程结束(无论有无草稿/成败)后才放行保存副作用
          setDraftLoaded(true) // #5：载入结束后才显第2步 hint(此时 styleSourceText 已定，hint 文案不再闪变)
        }
      })
    return () => {
      alive = false
    }
  }, [])

  // 真蒸馏链路（对齐 novel-local stylistAgent.distillOne）：sampleNovel切样本 → 文风分析提示词经弹窗给用户看/改 → 发送后回复解析 → distillStyleBand(零Token 14维量化)。
  // WZ-4：habits 存原始值、不在此净化；净化统一放到消费端(LongFormPage 注入成文提示词前)做一次，避免双重净化。
  const openDistill = () => {
    setDistillErr('')
    const smp = sampleNovel(styleSourceText)
    if (!smp || !smp.length) {
      setDistillErr('原文太短，切不出样本；请粘贴更长的原文再蒸馏。')
      return
    }
    const msgs = styleAnalyzeMessages(smp)
    setDistillSamples(smp)
    setDistillSystem(msgs[0] && msgs[0].content ? msgs[0].content : '')
    setDistillUserPrompt(msgs[1] && msgs[1].content ? msgs[1].content : '')
    setDistillPromptOpen(true)
  }

  const adoptDistill = (reply) => {
    const res = parseJsonReply(reply)
    if (!res || typeof res !== 'object') {
      setDistillErr('回复解析不出文风结构表，请在弹窗里调整提示词后点「重发」，或复制回复手动核对。')
      return
    }
    const band = distillStyleBand(distillSamples.join('\n'))
    setStyleProfile(String(res.style_profile || ''))
    // WZ-4：落库存原始 habits，不在建书侧净化——净化统一在消费端(LongFormPage composePrompt 注入成文提示词前 sanitizeHabits)做一次。
    // 原"落库净化+消费端再净化"是双重净化；且预设/书库路径本就不过建书侧净化，口径不一。统一消费端单次净化覆盖所有来源。
    // 必修6同型横扫（防御性）：habits/samples 归一成字符串数组（与 useLibrary analyze 同口径）——当前无 JSX 渲染点（仅落草稿/书 + 注入提示词），
    //   但模型返对象元素时会污染提示词（"[object Object]"）；原 `res.habits||[]` 不归一、`filter(Boolean)` 会放过对象，故按 typeof 过滤。
    setStyleHabits(Array.isArray(res.habits) ? res.habits.map((h) => (typeof h === 'string' ? h.trim() : '')).filter(Boolean) : [])
    setStyleSamples(Array.isArray(res.samples) ? res.samples.filter((s) => typeof s === 'string' && s.trim()).slice(0, 3) : [])
    setStyleMetrics(band.metrics || null)
    setStyleReliable(!!band.reliable) // WZ-2：记录指纹是否可靠(样本量足够)，徽标据此区分"含14维指纹"与"样本过短仅供参考"
    setStyleMetricsFrom('distill') // 第2项：标记指纹来自原文蒸馏(徽标显示"已蒸馏…")
    // #4：蒸馏产出已取代预设的 samples/habits/metrics/profile，清空预设下拉(→"自定义")，否则徽标显"已蒸馏"而下拉仍显《某书》自相矛盾
    setStylePreset('')
    setDistillErr('')
    setDistillPromptOpen(false)
  }

  const styleFileRef = useRef(null)
  const onStyleFile = async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    try {
      const text = await readDocumentFile(file)
      // 必修4同型横扫（第十一轮）：导入覆盖前脏检查——当前原文样本非空且与将导入内容不同时先 confirm，避免静默覆盖已粘贴/导入的原文样本（无恢复入口）
      if (String(styleSourceText || '').trim() && String(styleSourceText) !== String(text) && !window.confirm('导入会替换当前的原文样本（当前未另存的内容将丢失）。确定导入吗？')) return
      loadedIdbSourceRef.current = '' // M-1：导入原文=用户接管该字段，清掉 IDB 兜底值(此后以导入内容为准)
      setStyleSourceText(text)
      setDistillErr('')
    } catch (err) {
      setDistillErr(err && err.message ? err.message : String(err))
    }
  }

  const clearDraft = () => {
    // H3：清空草稿不可逆(丢弃所有未落库内容)，加二次确认防误点
    if (!window.confirm('确定清空本页草稿吗？所有未落库的内容（简报/圣经/人物/资产表/大纲/卷章/文风）都会被清除，此操作不可撤销。已落库成书的书不受影响。')) return
    // M10：localStorage.removeItem 包 try/catch(同文件 DRAFT 读取与草稿写入两处都包了，唯独这里没)——存储不可用(隐私模式/配额满)时
    //   裸调会立即抛错，导致后面的 del('drafts')/skipSaveRef/21 个 setState 全不执行、点「清空」UI 毫无反应。清除失败不应阻断内存态清空。
    try {
      localStorage.removeItem(DRAFT_KEY)
    } catch {
      /* localStorage 不可用：跳过持久层清除，仍继续清 IndexedDB 草稿与内存态 */
    }
    del('drafts', DRAFT_KEY).catch(() => {})
    // #8：下面一批 setState 会触发保存副作用，先置跳过标志，让紧跟的那次保存在 400ms 后被跳过——否则刚 del 掉的草稿又被 put 回一条空记录
    skipSaveRef.current = true
    clearedRef.current = true // item3：置读侧哨兵——若 getById('drafts') 的 .then 在 confirm 阻塞期间才 resolve（竞态），它据此丢弃回填、不复活已清空的草稿与 savedBook
    draftRef.current = null // H-新1：立即清掉待 flush 载荷，防 pagehide/卸载 flush 把刚清空的草稿复活(与 skipSaveRef 分支双保险)
    setDraftSaveError('') // M38：用户主动清空后，之前的"未能保存"警告不再适用
    setInspiration('')
    setTargetWords('1000000')
    setBrief('')
    setClarifyQuestions([])
    setClarifyAnswers(null)
    setStylePreset('')
    setGenreNote('')
    setStyleNote('')
    setStyleProfile('')
    setStyleHabits([])
    setStyleSamples([])
    loadedIdbSourceRef.current = '' // M-1：清空草稿后别再拿 IDB 兜底值把原文复活(与 skipSaveRef/draftRef=null 同批清)
    setStyleSourceText('')
    setStyleMetrics(null)
    setStyleReliable(false)
    setStyleMetricsFrom('')
    setBible('')
    setCharacters('')
    setAssetTable('')
    setOutline('')
    setVolumes('')
    setVolumes2('')
    // H3：一并重置 savedBook/saveErr——否则清空后第9步仍显示"重新保存成书"，点下去会用旧 savedBook.id 把空内容覆盖写回，两次点击摧毁一本已落库书
    setSavedBook(null)
    setSaveErr('')
  }

  const clarifyText = clarifyAnswers
    ? clarifyAnswers
        .map((a, i) => {
          const q = clarifyQuestions[i]
          if (!q) return ''
          // L26：选项的 description 承载"方向说明"(clarifyPrompt 要求每个候选方向明显不同)，只取 label 会丢掉用户选中方向的实质内容，AI 只看短标签可能理解成另一个方向
          const opt = a.option >= 0 && q.options ? q.options[a.option] : null
          const sel = opt ? (opt.description ? `${opt.label}（${opt.description}）` : opt.label) : ''
          const val = (a.free || '').trim() || sel
          return val ? `${q.question} → ${val}` : ''
        })
        .filter(Boolean)
        .join('\n')
    : ''

  const genClarify = () => {
    // WZ-9：重新生成会在采纳新回复时清空已答(adoptClarify→setClarifyAnswers(null))。已答>0 时先确认，避免用户白填。
    const answered = Array.isArray(clarifyAnswers) ? clarifyAnswers.filter((a) => a.option >= 0 || (a.free || '').trim()).length : 0
    if (answered > 0 && !window.confirm(`重新生成补全问题会丢弃已作答的 ${answered} 题，确定继续？`)) return
    setClarifyErr('')
    setClarifyPromptOpen(true)
  }

  const adoptClarify = (reply) => {
    const data = parseJsonReply(reply)
    // 必修6同型横扫 + 第一档④：归一抽到模块级 sanitizeClarifyQuestions，写侧(此处)与读回侧(localStorage 初值 / IDB restore)共用同一份——防毒丸且防两侧口径漂移。
    const valid = sanitizeClarifyQuestions(data)
    if (!valid.length) {
      setClarifyErr('回复解析不出有效的问题列表，请在弹窗里调整提示词后点「重发」。')
      return
    }
    setClarifyQuestions(valid)
    setClarifyAnswers(null)
    setClarifyErr('')
    setClarifyPromptOpen(false)
    setClarifyOpen(true)
  }

  const saveBook = async () => {
    // #2+#6：重新保存成书(已有 savedBook)——#6 已改成非破坏性合并(保留长篇页 state/手改 links/新增资产/伏笔进度/图谱布局/章节)，
    // 但资产表派生字段/节拍/卷章仍以当前新手写作文本为准，故保留二次确认、明示"更新什么 vs 保留什么"，不再静默。
    if (savedBook) {
      const ok = window.confirm(
        `《${savedBook.title || savedBook.name || '本书'}》已落库。重新保存会：\n` +
          `· 更新(以当前新手写作文本为准)：资产的表派生字段(详情/分层/透出卷/精确章号…)、节拍、卷章\n` +
          `· 保留(长篇页成果不丢)：资产状态 / 手改关系边 / 新增资产、伏笔进度、图谱布局、已写章节\n` +
          `注意：长篇页「续排下一卷」追加的卷章若没同步回第 7/8 步，会被这里的卷章覆盖。\n\n确定重新保存？`
      )
      if (!ok) return
    }
    // #3(M)：落库 async，双击会跑两次生成两个不同 id 建出重复书；setSaving 放在首个 await(getAll) 之前才能真正挡住第二次点击
    if (saving) return
    setSaving(true)
    // M-10：落库用当前值即时重算(不吃 previewCounts 的 400ms 防抖滞后值)，保证写进书里的三表=用户最后编辑的内容
    const parsed = computeParsed({ assetTable, bible, characters, outline, volumes, volumes2 })
    const date = new Date().toISOString().slice(0, 10)
    const existing = await getAll('books').catch(() => [])
    const seq = (existing || []).filter((b) => String(b.name || b.title || '').startsWith(date)).length + 1
    const bookTitle = `${date}（${seq}）`
    // 书名优先取简报第一行(前20字，去掉行首序号)，简报为空时回落到日期序号；日期序号始终存进 name 字段
    const briefFirstLine =
      String(brief || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)[0] || ''
    const titleFromBrief = briefFirstLine.replace(/^\d+\s*[.、．:：]\s*/, '').replace(/^[\u4e00-\u9fa5]{2,8}：/, '').slice(0, 20)
    const book = {
      // M40：已落库过则复用原 id/name/createdAt/章节做更新，不再每次新建(否则"重新保存成书"会在书库堆出内容近似的重复书)
      id: savedBook?.id || `bk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title: titleFromBrief || bookTitle,
      name: savedBook?.name || bookTitle,
      targetWords: Number(targetWords) || 1000000,
      inspiration,
      brief,
      genreNote,
      // 第2项(avgParaLenFor 半生效)：把题材写进 book.genre(与 genreNote 同源)，让 avgParaLenFor 的 GENRE_STYLE_TABLE[b.genre] 能命中真实段长档；
      // genreNote 是自由文本时精确匹配可能落空，B 本轮给 avgParaLenFor 加 genreNote 模糊兜底后两边都能命中。
      genre: genreNote,
      styleProfile,
      styleHabits,
      styleSamples,
      styleMetrics, // M39：蒸馏的 14 维量化指纹一并落库，不再丢弃(否则"已蒸馏：含14维量化指纹"徽标是虚假承诺)
      styleReliable, // WZ-2：指纹可靠标记一并落库，与 styleMetrics 平行存档(供重新打开时徽标正确区分)
      styleNote, // M39：补充要求也留存
      bible,
      characters,
      assetTable,
      outline,
      volumes: `${volumes}\n${volumes2}`,
      // #6：重新保存(savedBook 存在)时非破坏性合并——保留长篇页写的资产 state/手改 links/新增资产 + 伏笔生命周期；首次落库直接用 parsed
      assets: savedBook ? mergeAssetsForResave(parsed.assets, savedBook.assets) : parsed.assets,
      beats: parsed.beats,
      foreshadows: savedBook ? mergeForeshadowsForResave(parsed.foreshadows, savedBook.foreshadows) : parsed.foreshadows,
      // 卷一实际章数（建书只排卷一，此时节拍最大章号即卷一末章）；长篇页卷号→章号换算用它，续排后不随之膨胀(H5/H6)
      volOneChapters: parsed.beats.reduce((m, b) => Math.max(m, b.chapter_no || 0), 0),
      chapters: savedBook?.chapters || [], // M40：重新保存时保留已写章节，不清空
      graphPos: savedBook?.graphPos, // #2：图谱布局是长篇页数据、wizard 无重算来源；原 book 对象漏了它 → 重新保存后长篇页手动布局消失，这里保留
      wordCount: savedBook?.wordCount || 0,
      createdAt: savedBook?.createdAt || Date.now(),
    }
    try {
      await put('books', book)
      // 记住刚建的书，长篇页首屏优先打开它
      try {
        localStorage.setItem('na_open_book', book.id)
      } catch {
        /* 隐私模式/配额不足，忽略 */
      }
      setSavedBook(book)
      setSaveErr('')
    } catch (e) {
      // M40：落库失败不静默——不显示"已成书"并给出原因，避免用户以为没成功反复点、堆出更多重复书
      // 必修7（第十一轮）：**仅首次落库失败**（原本无 savedBook）才置 null；「重新保存成书」失败时**保留旧 savedBook**——旧书仍在库、id 不能丢，
      //   否则下次「重新保存」会走 :766 生成新 id 建出重复书（正是 M40 要防的），且草稿 savedBookId(:502 附近) 变空、第9步不再显示「重新保存成书」。
      if (!savedBook) setSavedBook(null)
      setSaveErr('落库失败：' + (e && e.message ? e.message : String(e)) + '（可能存储空间不足）' + (savedBook ? '；原书未改动、仍在书库，可重试。' : ''))
    } finally {
      setSaving(false) // #3：无论成败都解禁「落库成书」按钮
    }
  }

  // 门禁：每步的提示词吃哪些上游，就校验哪些上游；缺料时按钮禁用并显示"缺XX"（item 18）
  const charsMissing = [!hasBrief && '简报', !hasBible && '圣经'].filter(Boolean)
  const assetTableMissing = [!hasBrief && '简报', !hasBible && '圣经', !hasChars && '人物'].filter(Boolean)
  const outlineMissing = [!hasBrief && '简报', !hasBible && '圣经', !hasChars && '人物'].filter(Boolean)
  const volumesMissing = [!hasBrief && '简报', !hasBible && '圣经', !hasChars && '人物', !hasOutline && '大纲'].filter(Boolean)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">新手写作 · 搭建故事框架</h2>
        <p className="mt-1 text-sm text-stone-500">
          自顶向下把整个故事搭好；每一步的提示词都会弹窗给你看、给你改，确认后才发给 AI。上游产物自动带入下游；任何一步可随时回来重生成或手改。资产带「知情人/透出卷/传闻卷」；排章分两步（前20章 + 后段并回填章号，防超长截断）；落库前先算好资产/节拍/伏笔三表计数供你核对，确认后再写进书里。
        </p>
        <button onClick={clearDraft} className="text-xs text-stone-400 underline hover:text-stone-600">
          清空本页草稿（内容会自动存到浏览器本地）
        </button>
        {draftSaveError && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{draftSaveError}</p>}
      </div>

      <section className="rounded-xl border border-stone-200 bg-paper p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="font-semibold">第 1 步 · 灵感扩写</h3>
          <div className="flex gap-2">
            <button onClick={genClarify} disabled={!inspiration.trim()} className={genBtn}>
              {clarifyAnswers ? '重新生成补全问题' : '生成补全问题'}
            </button>
            <button onClick={() => setInspireOpen(true)} disabled={!inspiration.trim()} className={genBtn}>
              {brief ? '重新扩充灵感' : '扩充灵感'}
            </button>
          </div>
        </div>
        <label className={label}>一句话灵感</label>
        <input
          value={inspiration}
          onChange={(e) => setInspiration(e.target.value)}
          placeholder="例：末日迷雾降临，少年觉醒异能，从校园成长到域主。"
          className={`${line} mb-3`}
        />
        <label className={label}>目标总字数（下游数量锚，由你定）</label>
        <input value={targetWords} onChange={(e) => setTargetWords(e.target.value.replace(/[^0-9]/g, ''))} className={`${line} mb-3`} />
        {!inspiration.trim() && <p className={hint}>先填一句话灵感，再点扩充。</p>}
        {(clarifyAnswers || clarifyErr) && (
          <div className="mb-3 flex flex-wrap items-center gap-3">
            {clarifyAnswers && (
              <span className="text-xs text-stone-500">
                已补全 {clarifyAnswers.filter((a) => a.option >= 0 || (a.free || '').trim()).length} 题，将带入扩充灵感
              </span>
            )}
            {clarifyErr && <span className="text-xs text-red-400">{clarifyErr}</span>}
          </div>
        )}
        <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={9} placeholder="创作简报(brief,含目标体量/设定支点/成长曲线)会填到这里，可直接手改。" className={box} />
      </section>

      <section className="rounded-xl border border-stone-200 bg-paper p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">第 2 步 · 文风 + 题材</h3>
          <button onClick={() => setStyleOpen(true)} disabled={styleEmpty} className={genBtn}>
            {styleProfile ? '重新生成文风' : '生成文风档案'}
          </button>
        </div>
        <label className={label}>参考文风（可选预设）</label>
        <select
          value={stylePreset}
          onChange={(e) => {
            const next = e.target.value
            // M41：切换预设会覆盖已蒸馏的文风范例(samples)/写作习惯(habits)/指纹(metrics)；仅当当前指纹来自「原文蒸馏」时才二次确认(预设→预设直接替换，不误报"蒸馏")
            if (styleMetrics && styleMetricsFrom === 'distill') {
              const ok = window.confirm('当前已从原文蒸馏出文风（含 14 维量化指纹）。切换预设会替换「文风范例」「写作习惯」，并用该预设的真实语料指纹替换当前蒸馏指纹。确定继续吗？')
              if (!ok) return
            }
            setStylePreset(next)
            const p = PRESET_STYLES.find((s) => s.bookName === next)
            if (p) {
              setStyleSamples(p.samples || [])
              setStyleHabits(p.habits || [])
            } else {
              setStyleSamples([])
              setStyleHabits([])
            }
            // 第2项(avgParaLenFor 半生效)：选预设不再清空 styleMetrics，而是存该预设的真实语料 metrics(含 paraMedian)——
            // 让 avgParaLenFor 的 styleMetrics.paraMedian 路径命中，段长用预设真值(如剑来 39.78)而非默认档30；来源标 'preset'，徽标不误报"已蒸馏"。
            if (p && p.metrics) {
              setStyleMetrics(p.metrics)
              setStyleReliable(true) // 预设 metrics 是真书语料标定值(可靠)
              setStyleMetricsFrom('preset')
            } else {
              setStyleMetrics(null)
              setStyleReliable(false)
              setStyleMetricsFrom('')
            }
          }}
          className={`${line} mb-3`}
        >
          <option value="">自定义（不用预设）</option>
          {PRESET_STYLES.map((s) => (
            <option key={s.bookName} value={s.bookName}>
              {s.bookName}
            </option>
          ))}
        </select>
        <label className={label}>题材 / 类型（可选）</label>
        <input value={genreNote} onChange={(e) => setGenreNote(e.target.value)} placeholder="例：末世异能升级流、悬疑修仙。" className={`${line} mb-3`} />
        <label className={label}>补充要求（可选）</label>
        <input value={styleNote} onChange={(e) => setStyleNote(e.target.value)} placeholder="例：对话要多、句子偏短、少用比喻。" className={`${line} mb-3`} />
        {/* L10：已粘贴/导入原文样本时给准确引导——"生成文风档案"走预设/题材/补充要求(不消费原文)，故按钮仍禁用，但提示改指向"从原文蒸馏文风"，不再让用户误以为必须先随便填个题材 */}
        {/* #5：draftLoaded 前不显此 hint——styleSourceText 不在 localStorage、异步从 IDB 载入，否则首帧按空原文显"请选预设"、载入后翻成"已粘贴原文"(闪变) */}
        {draftLoaded && styleEmpty && (
          <p className={hint}>
            {styleSourceText.trim()
              ? '已粘贴原文样本：可直接点「从原文蒸馏文风」；或选预设 / 填题材 / 补充要求之一后再用「生成文风档案」。'
              : '请至少选预设、填题材或补充要求之一——零输入生成的文风会污染全书笔触。'}
          </p>
        )}
        <label className={label}>原文样本（粘贴或导入小说原文，用于真蒸馏）</label>
        <input ref={styleFileRef} type="file" accept={READ_ACCEPT} className="hidden" onChange={onStyleFile} />
        <textarea
          value={styleSourceText}
          onChange={(e) => {
            loadedIdbSourceRef.current = '' // M-1：用户接管原文框，清掉 IDB 兜底值——此后以用户输入为准(含用户主动清空，不被兜底复活)
            setStyleSourceText(e.target.value)
          }}
          rows={5}
          placeholder="粘贴你想模仿的小说原文（建议3000字以上），点「从原文蒸馏文风」。"
          className={`${box} mb-3`}
        />
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <button
            onClick={() => styleFileRef.current && styleFileRef.current.click()}
            className="rounded-lg border border-stone-300 bg-stone-50 px-4 py-1.5 text-sm text-stone-700 hover:border-stone-400 hover:bg-stone-100"
          >
            导入原文文件
          </button>
          <button onClick={openDistill} disabled={!styleSourceText.trim()} className={genBtn}>
            从原文蒸馏文风
          </button>
          {/* 第2项：徽标按指纹来源措辞——蒸馏才说"已蒸馏"，预设说"预设真值"，避免选预设存了 metrics 后误报"已蒸馏" */}
          {styleMetrics && styleMetricsFrom === 'distill' && (
            <span className="text-xs text-stone-500">
              {styleReliable ? '已蒸馏：含14维量化指纹' : '已蒸馏：样本过短，指纹仅供参考'}
            </span>
          )}
          {styleMetrics && styleMetricsFrom === 'preset' && (
            <span className="text-xs text-stone-500">已载入预设《{stylePreset}》的真实语料指纹（段长按该书标定）</span>
          )}
          {distillErr && <span className="text-xs text-red-400">{distillErr}</span>}
        </div>
        <label className={label}>文风档案（生成或蒸馏后可手改）</label>
        <textarea value={styleProfile} onChange={(e) => setStyleProfile(e.target.value)} rows={8} placeholder="六维度文风档案会填到这里。" className={box} />
      </section>

      <section className="rounded-xl border border-stone-200 bg-paper p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">第 3 步 · 世界观圣经</h3>
          <button onClick={() => setBibleOpen(true)} disabled={!hasBrief} className={genBtn}>
            {bible ? '重新生成圣经' : '生成圣经'}
          </button>
        </div>
        {!hasBrief && <p className={hint}>请先完成第 1 步（brief），世界观基于简报展开。</p>}
        <textarea value={bible} onChange={(e) => setBible(e.target.value)} rows={12} placeholder="世界/机制/力量(≥6级含战力标尺)/势力(≥8方含功能位)/地点(≥12个按层级)/真相(≥3条)会填到这里；时序用卷序。" className={box} />
      </section>

      <section className="rounded-xl border border-stone-200 bg-paper p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">第 4 步 · 常驻人物 + 群像</h3>
          <button onClick={() => setCharsOpen(true)} disabled={charsMissing.length > 0} className={genBtn}>
            {characters ? '重新生成人物' : '生成人物'}
          </button>
        </div>
        {charsMissing.length > 0 && <p className={hint}>本步提示词要吃简报/圣经，缺{charsMissing.join('、')}，先补齐上游再生成。本步设计贯穿人物(含战力定位/语气示例/秘密/高光卷序)+群像，各卷反派在第 6 步分卷结构表里按卷定义。</p>}
        <textarea value={characters} onChange={(e) => setCharacters(e.target.value)} rows={12} placeholder="主角+长期配角(至少6人,17字段含刻画)+群像会填到这里。" className={box} />
      </section>

      <section className="rounded-xl border border-stone-200 bg-paper p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">第 5 步 · 资产表（人物分层 / 地点 / 势力 / 道具）</h3>
          <button onClick={() => setAssetTableOpen(true)} disabled={assetTableMissing.length > 0} className={genBtn}>
            {assetTable ? '重新生成资产表' : '生成资产表'}
          </button>
        </div>
        {assetTableMissing.length > 0 && <p className={hint}>本步提示词要吃简报/圣经/人物，缺{assetTableMissing.join('、')}，先补齐上游再生成。本步独立产出完整资产表：主角/配角/普通角色分层 + 地点/势力/道具，每个资产带透出卷，落库后正文按章透出时可用的资产更充足。</p>}
        <textarea value={assetTable} onChange={(e) => setAssetTable(e.target.value)} rows={12} placeholder="完整资产表会填到这里：【主角】【配角】【普通角色】【地点】【势力】【道具】六段，每行尾部统一是 透出卷｜传闻卷｜知情人。" className={box} />
      </section>

      <section className="rounded-xl border border-stone-200 bg-paper p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">第 6 步 · 结构大纲 + 情绪曲线</h3>
          <button onClick={() => setOutlineOpen(true)} disabled={outlineMissing.length > 0} className={genBtn}>
            {outline ? '重新生成大纲' : '生成大纲'}
          </button>
        </div>
        {outlineMissing.length > 0 && <p className={hint}>本步提示词要吃简报/圣经/人物，缺{outlineMissing.join('、')}，先补齐上游再生成。</p>}
        <textarea value={outline} onChange={(e) => setOutline(e.target.value)} rows={12} placeholder="分卷结构表/关键转折(12-18)/每卷事件节点/情绪曲线(强度+蓄力配比+主爽点类型)/伏笔(分级发酵)/悬念账本/终局会填到这里。" className={box} />
      </section>

      <section className="rounded-xl border border-stone-200 bg-paper p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">第 7 步 · 第1卷前20章（每章200字梗概）</h3>
          <button onClick={() => setVolumesOpen(true)} disabled={volumesMissing.length > 0} className={genBtn}>
            {volumes ? '重新生成卷章' : '生成卷章'}
          </button>
        </div>
        {volumesMissing.length > 0 && <p className={hint}>本步提示词要吃简报/圣经/人物/大纲，缺{volumesMissing.join('、')}，先补齐上游再生成。分卷结构在第 6 步大纲的【分卷结构表】里已定；本步只排第 1 卷第 1 至 20 章，每章 200 字梗概带视角人物/节拍/钩子。</p>}
        <textarea value={volumes} onChange={(e) => setVolumes(e.target.value)} rows={12} placeholder="第1卷第1至20章(每章200字梗概带视角人物/节拍/钩子)会填到这里；分卷结构在第6步大纲里定，本步只排章、不重复产分卷。" className={box} />
      </section>

      <section className="rounded-xl border border-stone-200 bg-paper p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">第 8 步 · 第21章起续排 + 资产章号回填</h3>
          <button onClick={() => setVolumes2Open(true)} disabled={!volumes || volumesMissing.length > 0} className={genBtn}>
            {volumes2 ? '重新生成后段章表' : '生成后段章表+回填'}
          </button>
        </div>
        {!volumes && <p className={hint}>先完成第 7 步。本步承接前20章的结尾钩子续排第21章起（每章150至250字梗概），并把全部资产的透出卷/传闻卷细化成透出章/传闻章。</p>}
        <textarea value={volumes2} onChange={(e) => setVolumes2(e.target.value)} rows={10} placeholder="第21章起的简表(章号｜章名｜梗概150至250字｜透出资产｜情绪节拍)+资产章号回填清单会填到这里。" className={box} />
      </section>

      <section className="rounded-xl border border-stone-200 bg-paper p-5">
        <h3 className="mb-3 font-semibold">第 9 步 · 落库成书</h3>
        <p className="mb-3 text-xs text-stone-400">书名取简报第一行(前20字)，简报为空时用当前日期+序号兜底。</p>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <span className="text-sm text-stone-600">
            待落库计数：资产 {previewCounts.assets.length} / 节拍 {previewCounts.beats.length} / 伏笔 {previewCounts.foreshadows.length}
          </span>
          <span className="text-xs text-stone-400">先核对这三个数，再落库</span>
        </div>
        {/* #10：落库前完整性提醒(不阻断，人在环路)——资产/节拍为 0 说明关键上游步骤没做，落库会是空壳书 */}
        {(previewCounts.assets.length === 0 || previewCounts.beats.length === 0) && (
          <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
            ⚠{' '}
            {previewCounts.assets.length === 0 && previewCounts.beats.length === 0
              ? '资产与节拍都为 0：还没生成资产表(第 5 步)与卷章表(第 7 步)，现在落库会是一本空书。'
              : previewCounts.assets.length === 0
                ? '资产为 0：先生成第 5 步资产表(或第 3/4 步圣经/人物)，否则落库的书没有可用资产、长篇页无法按章透出。'
                : '节拍为 0：先生成第 7 步卷章表，否则落库的书没有章节拍、长篇页排章与防剧透会失据。'}
            （仍可落库，只提醒不阻断）
          </p>
        )}
        {previewCounts.assetTableIncomplete && (
          <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
            ⚠ 资产表可能不完整（缺 {previewCounts.missingTypes.map((t) => ASSET_TYPE_LABEL[t] || t).join('、')} 段，常见于 AI 输出被截断）；已用圣经/人物解析补足 {previewCounts.supplemented} 个同类资产。若资产表本就不需要这些类型可忽略；若要完整资产表，回第 5 步重生成。
          </p>
        )}
        <div className="flex items-center gap-3">
          <button onClick={saveBook} disabled={saving} className={genBtn}>
            {saving ? '落库中…' : savedBook ? '重新保存成书' : '落库成书'}
          </button>
          {savedBook && (
            <span className="text-sm text-stone-600">
              已成书：《{savedBook.title}》（资产 {savedBook.assets?.length || 0} / 节拍 {savedBook.beats?.length || 0} / 伏笔 {savedBook.foreshadows?.length || 0}）
              <button onClick={onOpenLongForm} className="ml-3 rounded-lg bg-stone-800 px-3 py-1.5 text-sm text-white hover:bg-stone-700">
                去长篇写作
              </button>
            </span>
          )}
          {saveErr && <span className="text-sm text-red-500">{saveErr}</span>}
        </div>
        <p className="mt-2 text-xs text-stone-400">落库时：资产来自第 5 步资产表（没生成资产表时回落到圣经/人物解析），节拍来自卷章表、伏笔来自大纲；上面的计数就是即将写进书里的数量，供你先核对。</p>
      </section>

      <ClarifyModal
        open={clarifyOpen}
        questions={clarifyQuestions}
        onClose={() => setClarifyOpen(false)}
        onSubmit={(answers) => {
          setClarifyAnswers(answers)
          setClarifyOpen(false)
          setInspireOpen(true)
        }}
      />
      <PromptEditorModal
        open={inspireOpen}
        title="第 1 步 · 灵感扩写（提示词可编辑）"
        initialPrompt={inspirePrompt(targetWords || '1000000', clarifyText) + inspiration}
        onClose={() => setInspireOpen(false)}
        onAdopt={(reply, finalPrompt) => {
          setBrief(reply)
          // WZ-3：模板以"一句话灵感："结尾、inspiration 拼在其后。回写取"第一个"该标记之后的内容。
          // 不用 split(...)[1]：灵感自身含"一句话灵感："时会被切成多段、只取到第一段(截断)；也不用 lastIndexOf：会丢掉灵感前半。
          // WZ-8：灵感框是单行 input，故只取标记后到首个换行为止——用户在提示词尾部另起一行追加的指令不会被回写进灵感框。
          const marker = '一句话灵感：'
          const idx = String(finalPrompt || '').indexOf(marker)
          if (idx >= 0) setInspiration(finalPrompt.slice(idx + marker.length).split('\n')[0].trim())
          setInspireOpen(false)
        }}
      />
      <PromptEditorModal
        open={styleOpen}
        title="第 2 步 · 文风+题材（提示词可编辑）"
        initialPrompt={styleInitialPrompt}
        onClose={() => setStyleOpen(false)}
        onAdopt={(reply) => {
          setStyleProfile(reply)
          setStyleOpen(false)
        }}
      />
      <PromptEditorModal
        open={bibleOpen}
        title="第 3 步 · 世界观圣经（提示词可编辑）"
        initialPrompt={biblePrompt(brief)}
        onClose={() => setBibleOpen(false)}
        onAdopt={(reply) => {
          setBible(reply)
          setBibleOpen(false)
        }}
      />
      <PromptEditorModal
        open={charsOpen}
        title="第 4 步 · 常驻人物+群像（提示词可编辑）"
        initialPrompt={charPrompt(brief, bible)}
        onClose={() => setCharsOpen(false)}
        onAdopt={(reply) => {
          setCharacters(reply)
          setCharsOpen(false)
        }}
      />
      <PromptEditorModal
        open={assetTableOpen}
        title="第 5 步 · 资产表（提示词可编辑）"
        initialPrompt={assetTablePrompt(brief, bible, characters)}
        onClose={() => setAssetTableOpen(false)}
        onAdopt={(reply) => {
          setAssetTable(reply)
          setAssetTableOpen(false)
        }}
      />
      <PromptEditorModal
        open={outlineOpen}
        title="第 6 步 · 结构大纲+情绪曲线（提示词可编辑）"
        initialPrompt={outlinePrompt(brief, bible, characters)}
        onClose={() => setOutlineOpen(false)}
        onAdopt={(reply) => {
          setOutline(reply)
          setOutlineOpen(false)
        }}
      />
      <PromptEditorModal
        open={volumesOpen}
        title="第 7 步 · 第1卷前20章（提示词可编辑）"
        initialPrompt={volumeInitialPrompt}
        onClose={() => setVolumesOpen(false)}
        onAdopt={(reply) => {
          setVolumes(reply)
          setVolumesOpen(false)
        }}
      />
      <PromptEditorModal
        open={volumes2Open}
        title="第 8 步 · 后段章表+章号回填（提示词可编辑）"
        initialPrompt={volume2InitialPrompt}
        onClose={() => setVolumes2Open(false)}
        onAdopt={(reply) => {
          setVolumes2(reply)
          setVolumes2Open(false)
        }}
      />
      <PromptEditorModal
        open={clarifyPromptOpen}
        title="生成补全问题（提示词可编辑）"
        initialPrompt={clarifyPrompt(inspiration)}
        thinking
        temperature={0.3}
        onClose={() => setClarifyPromptOpen(false)}
        onAdopt={adoptClarify}
      />
      <PromptEditorModal
        open={distillPromptOpen}
        title="从原文蒸馏文风（提示词可编辑）"
        systemPrompt={distillSystem}
        initialPrompt={distillUserPrompt}
        temperature={0.3}
        onClose={() => setDistillPromptOpen(false)}
        onAdopt={adoptDistill}
      />
    </div>
  )
}
