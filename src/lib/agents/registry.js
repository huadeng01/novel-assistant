// 编剧团队名册：13 个专职 agent 的元数据（供编剧团队可视化面板 + 新手/长篇各步标注）。
// 每个 agent 只管一块，职责单一；本文件只存「身份证」，具体 run 逻辑在各 agent 文件（阶段2/3）。
//
// role:  generate（生成，产出文本/结构）| critic（审校，只读不改文，产出裁决）| orchestrator（编排，调度他人）
// group: concept（构思层，新手写作为主，长篇可回炉）| writing（写作层，长篇写作为主）
// icon:  对应 components/Ic.jsx 的图标名（lucide 线条图标，strokeWidth 统一 1.8）
export const AGENTS = [
  // —— 构思层 6：把「一个念头」养成「可写的完整故事世界」 ——
  { id: 'muse', name: 'Muse', cn: '灵感选题师', role: 'generate', group: 'concept', icon: 'bulb', duty: '立意 / 题材 / 爽点 / 核心冲突' },
  { id: 'worldsmith', name: 'Worldsmith', cn: '世界架构师', role: 'generate', group: 'concept', icon: 'globe', duty: '完善故事世界 → 小说圣经（势力盘 / 冲突线 / 真相层）' },
  { id: 'storyliner', name: 'Storyliner', cn: '故事线作家', role: 'generate', group: 'concept', icon: 'thread', duty: '写 5000-8000 字完整故事线，分段生成后拼合' },
  { id: 'structurer', name: 'Structurer', cn: '结构规划师', role: 'generate', group: 'concept', icon: 'map', duty: '把故事线拆成卷 / 幕 / 章 + 节奏引擎分配章数' },
  { id: 'outliner', name: 'Outliner', cn: '细纲师', role: 'generate', group: 'concept', icon: 'notepad', duty: '幕内章级细化 → 逐章详纲' },
  { id: 'stylist', name: 'Stylist', cn: '文风蒸馏师', role: 'generate', group: 'concept', icon: 'style', duty: '真·语言指纹（用词 / 口头禅 / 语气词 / 称呼）' },
  // —— 写作层 7：把「结构」逐章写成「成稿」并归档 ——
  { id: 'showrunner', name: 'Showrunner', cn: '总编剧', role: 'orchestrator', group: 'writing', icon: 'scene', duty: '编排幕 / 卷生成、状态回灌、断点续跑、意见调度' },
  { id: 'pacer', name: 'Pacer', cn: '节奏把控师', role: 'critic', group: 'writing', icon: 'target', duty: '注入本幕 goal / 情感曲线 / 爽点分布，监控节奏偏离' },
  { id: 'writer', name: 'Writer', cn: '执笔写手', role: 'generate', group: 'writing', icon: 'pen', duty: '单章写作：逐场景扩写，只管写不自审' },
  { id: 'logic', name: 'Logic', cn: '逻辑审校', role: 'critic', group: 'writing', icon: 'doctor', duty: '确定性硬门（连贯 / 剧透 / 复读 / 文风红线），零 Token', readonly: true },
  { id: 'editor', name: 'Editor', cn: '综合主编', role: 'critic', group: 'writing', icon: 'clipboard', duty: 'GLM 语义评审 + 裁决 verdict + 定点修订指令', readonly: true },
  { id: 'polisher', name: 'Polisher', cn: '单章精修师', role: 'generate', group: 'writing', icon: 'wand', duty: '去 AI 味 / 残留重复 / 标点归一 / 段级改写' },
  { id: 'archivist', name: 'Archivist', cn: '归档师', role: 'generate', group: 'writing', icon: 'box', duty: '章后归档：摘要 / 状态 / 伏笔 / 一致性 / 故事线 / 记忆回写' },
]

export const AGENT_MAP = Object.fromEntries(AGENTS.map((a) => [a.id, a]))
export const CONCEPT_AGENTS = AGENTS.filter((a) => a.group === 'concept')
export const WRITING_AGENTS = AGENTS.filter((a) => a.group === 'writing')

// 角色视觉语言（与 index.css @theme 的 --color-agent-* token 对应）。
// 守「单一强调色」原则：不引入新色相，generate=朱砂(创造)、critic=黛青(审视)、orchestrator=墨黑(统筹)。
export const ROLE_THEME = {
  generate: { label: '生成', text: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-200', dot: 'bg-amber-500' },
  critic: { label: '审校', text: 'text-sky-600', bg: 'bg-sky-50', border: 'border-sky-200', dot: 'bg-sky-500' },
  orchestrator: { label: '编排', text: 'text-stone-700', bg: 'bg-stone-100', border: 'border-stone-300', dot: 'bg-stone-600' },
}

// agent 运行状态灯（面板用）：idle 灰 / running 朱砂脉冲 / done 苔绿对勾 / blocked 朱砂警示 / error 警示
export const AGENT_STATUS = {
  idle: { label: '待命', dot: 'bg-stone-300' },
  running: { label: '运行中', dot: 'bg-amber-500 animate-pulse' },
  done: { label: '完成', dot: 'bg-emerald-500' },
  blocked: { label: '被拦', dot: 'bg-amber-600' },
  error: { label: '出错', dot: 'bg-amber-700' },
}

// 层层递进流水线阶段（progress 事件流顺序，供面板时间线渲染）。
// 上层喂下层：故事线 → 卷幕章 → 详纲 → 初稿 → 逻辑门 → 主编审 → 精修 → 归档。
export const PIPELINE = [
  { id: 'storyline', label: '故事线', agent: 'storyliner' },
  { id: 'structure', label: '卷幕章', agent: 'structurer' },
  { id: 'outline', label: '详纲', agent: 'outliner' },
  { id: 'draft', label: '初稿', agent: 'writer' },
  { id: 'logic', label: '逻辑门', agent: 'logic' },
  { id: 'edit', label: '主编审', agent: 'editor' },
  { id: 'polish', label: '精修', agent: 'polisher' },
  { id: 'archive', label: '归档', agent: 'archivist' },
]
