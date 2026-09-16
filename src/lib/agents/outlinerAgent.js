// Outliner 细纲师：幕内章级细化 → 逐章详纲。
// 新手期产出「第 1 卷精简地图」(volumeOutlineMessages → project.outline，120~200 字/章)；
// 长篇期产出「逐章详纲」(chapterOutlineDetailMessages → outlineDetail[章号]，500~700 字/章，阶段3 写作层用)。
// 防剧透：只喂本卷骨架(skeletonTextForRange 截取本卷章号区间)，不给全书骨架。
import { chatStream } from '../llm.js'
import { volumeOutlineMessages } from '../prompts.js'
import { skeletonTextForRange, parseVolumeArc } from '../longform.js'

// 从卷的 arc 构造「起承转合」区间文案（卷内坐标），供细纲对齐幕结构
export function volumeArcText(volume) {
  const len = volume?.length || 20
  const head = `第${volume?.volumeNo || 1}卷（第1-${len}章，章号为卷内坐标）`
  const parsed = parseVolumeArc(volume?.arc || '')
  if (!parsed || !parsed.length) return head
  return `${head}：${parsed.map((p) => `${p.name}=第${p.start}-${p.end}章`).join('；')}`
}

export const outlinerAgent = {
  id: 'outliner',
  name: 'Outliner',
  role: 'generate',
  // 第 1 卷精简细纲地图：流式回写 onDelta，返回 { outline }
  async runVolumeOutline(ctx) {
    const { apiKey, bible, volume, chapterSkeleton, skeleton, onDelta, signal, progress } = ctx
    progress?.push({ agent: 'outliner', phase: 'volumeOutline', volumeNo: volume?.volumeNo || 1 })
    const volStart = volume?.startChapter || 1
    const volEnd = volStart + (volume?.length || 20) - 1
    const volSkeleton = skeletonTextForRange(chapterSkeleton, volStart, volEnd, skeleton)
    const arcText = volumeArcText(volume)
    const messages = volumeOutlineMessages({ skeleton: volSkeleton, volume, bible, chapterCount: volume?.length || 20, arcText })
    const text = await chatStream({ apiKey, messages, temperature: 0.7, onDelta, signal })
    return { outline: String(text || '') }
  },
}
