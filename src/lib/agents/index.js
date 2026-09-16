// agents 层 barrel：运行时地基 + 编剧团队名册 + 各层 agent 实现。
// 依赖方向：agents/ → lib/（llm/prompts/longform/continuity/db/utils），lib 绝不反向依赖（无循环）。
export * from './runtime.js'
export * from './registry.js'
export * from './trace.js'

// 构思层 6 agent（新手写作为主，长篇可回炉）
export { museAgent } from './museAgent.js'
export { worldsmithAgent } from './worldsmithAgent.js'
export { storylinerAgent } from './storylinerAgent.js'
export { structurerAgent, planPacing, actsToArc } from './structurerAgent.js'
export { outlinerAgent, volumeArcText } from './outlinerAgent.js'
export { stylistAgent } from './stylistAgent.js'

// 写作层 7 agent（长篇写作为主）
export { showrunnerAgent, planGenScope } from './showrunnerAgent.js'
export { pacerAgent, actForChapter } from './pacerAgent.js'
export { writerAgent } from './writerAgent.js'
export { logicAgent, buildFixPrompt } from './logicAgent.js'
export { editorAgent, buildChapterReviewInput, toVerdict, buildRevisionPrompt } from './editorAgent.js'
export { polisherAgent, defaultSplitTitle } from './polisherAgent.js'
export { archivistAgent } from './archivistAgent.js'
