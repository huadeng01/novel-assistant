// Structurer 结构规划师：把故事线 / 梗概拆成卷 / 幕 / 章 + 剧情节奏引擎分配章数。
// 是节奏引擎（resampleWeights/chaptersByRhythm/volumeRole/ACT_RATIO_GUIDE）的唯一持有者。
// 卷、幕、章名骨架三块生成；章名骨架的「多批编排 / 重试 / 补缺」属页面 UI 逻辑，本 agent 只负责「单批生成」。
import { chatJSON, chatStream } from '../llm.js'
import { volumesPlanMessages, actsPlanMessages, volumeSkeletonMessages } from '../prompts.js'
import {
  resampleWeights, chaptersByRhythm, volumeRole, RHYTHM_TEMPLATES, ACT_RATIO_GUIDE,
  fallbackVolumeEmotion, renumberPart, dedupeSkeletonBatch,
} from '../longform.js'

// 节奏分配（纯函数，零 LLM）：总字数(万)/章字数/卷数/节奏模板 → 每卷章数 + 每卷角色。
// chaptersByRhythm 保证各卷章数总和严格 === totalChapters（最大余数法）。
export function planPacing({ totalWords, chapterWords, volumeCount, rhythm }) {
  const totalChapters = Math.max(1, Math.round((totalWords * 10000) / chapterWords))
  const volumeLength = Math.max(5, Math.round(totalChapters / volumeCount))
  const weights = resampleWeights(RHYTHM_TEMPLATES[rhythm] || RHYTHM_TEMPLATES['快头肥中快尾'], volumeCount)
  const lengths = chaptersByRhythm(totalChapters, weights)
  const roles = weights.map((_, i) => volumeRole(i + 1, weights))
  return { totalChapters, volumeLength, weights, lengths, roles }
}

// 幕结构 → arc 字符串（parseVolumeArc 能反解的格式：起幕(第1-5章)→发展幕(第6-12章)→…）
export function actsToArc(acts) {
  return (acts || []).map((a) => `${a.act}(第${a.start}-${a.end}章)`).join('→')
}

export const structurerAgent = {
  id: 'structurer',
  name: 'Structurer',
  role: 'generate',
  // 卷结构：返回 { volumes }（含 emotion 兜底 + startChapter 顺序累加）
  async runVolumes(ctx) {
    const { apiKey, bible, mainline, volumeCount, lengths, roles, genre, volumeLength = 20, signal, progress } = ctx
    progress?.push({ agent: 'structurer', phase: 'volumes' })
    const res = await chatJSON({ apiKey, messages: volumesPlanMessages({ bible, mainline, volumeCount, lengths, roles, genre }), temperature: 0.7, signal })
    const volumes = (res.volumes || [])
      .filter((v) => v && v.name)
      .map((v, i) => ({
        volumeNo: Number(v.volume_no) || i + 1,
        name: v.name,
        theme: v.theme || '',
        conflict: v.conflict || '',
        arcStory: v.arc_story || '',
        gain: v.gain || '',
        location: v.location || '',
        unlockLayer: Number(v.unlock_layer) || 0,
        strategy: v.strategy || '',
        endHook: v.end_hook || '',
        emotion: v.emotion || '',
        length: lengths[i] || volumeLength,
        arc: '',
        acts: [],
        forbiddenForeshadowIds: [],
      }))
      .sort((a, b) => a.volumeNo - b.volumeNo)
    // emotion 兜底（卷间不重复）+ startChapter 顺序累加
    const used = []
    let cursor = 1
    for (const v of volumes) {
      if (!v.emotion) v.emotion = fallbackVolumeEmotion({ genre, volumeNo: v.volumeNo, used })
      if (v.emotion) used.push(v.emotion)
      v.startChapter = cursor
      cursor += v.length || volumeLength
    }
    return { volumes }
  },
  // 幕结构（单卷）：返回 { acts, arc, role }；空数组抛错由用户重试
  async runActs(ctx) {
    const { apiKey, volume, mainline, weights, signal, progress } = ctx
    const role = volumeRole(volume.volumeNo, weights)
    progress?.push({ agent: 'structurer', phase: 'acts', volumeNo: volume.volumeNo, role })
    const res = await chatJSON({ apiKey, messages: actsPlanMessages({ volume, mainline, role, ratioGuide: ACT_RATIO_GUIDE[role] }), temperature: 0.6, signal })
    const acts = (res.acts || [])
      .filter((a) => a && a.act && isFinite(Number(a.start)) && isFinite(Number(a.end)))
      .map((a) => ({ act: String(a.act), start: Number(a.start), end: Number(a.end), goal: String(a.goal || '') }))
    if (!acts.length) throw new Error('AI 未返回有效幕结构，请重试。')
    return { acts, arc: actsToArc(acts), role }
  },
  // 章名骨架（单批）：返回 { text, newTitles }（去重后）；多批编排 / 重试 / 补缺由页面负责
  async runSkeletonBatch(ctx) {
    const { apiKey, bible, mainline, volume, volumeCount, prevTail = '', rangeStart, rangeEnd, usedTitles = [], signal } = ctx
    const vs = volume?.startChapter || 1
    const actsText = (volume?.acts || []).map((a) => `${a.act}=第${vs + a.start - 1}-${vs + a.end - 1}章`).join('；')
    const n = Math.max(1, rangeEnd - rangeStart + 1)
    const messages = volumeSkeletonMessages({ bible, mainline, volume, volumeCount, prevTail, actsText, rangeStart, rangeEnd, usedTitles })
    const full = await chatStream({ apiKey, messages, temperature: 0.7, maxTokens: 1500 + n * 220, signal })
    const text = renumberPart(String(full || '').trim(), rangeStart)
    return dedupeSkeletonBatch(text, usedTitles)
  },
}
