import { describe, it, expect } from 'vitest'
import {
  assembleVoices,
  voiceGate,
  scanAllVoiceConflicts,
  distillVoices,
  SELFREF_PRESETS,
} from '../voice.js'

// 测试书：王爷（口头禅「有意思」、自称「本王」）/ 阿昭（口头禅「且慢」、自称「在下」）/ 路人（无声音签名）
function makeProject(over = {}) {
  const characters = [
    { uid: 'a1', name: '王爷', aliases: [], alive: 'alive', voice: { catchphrases: ['有意思'], selfRef: ['本王'], note: '' } },
    { uid: 'a2', name: '阿昭', aliases: [], alive: 'alive', voice: { catchphrases: ['且慢'], selfRef: ['在下'], note: '' } },
    { uid: 'a3', name: '路人', aliases: [], alive: 'alive' },
  ]
  return { id: 'bk', characters, chapters: [], ...over }
}
const voices = (p = makeProject()) => assembleVoices(p)
const chars = (p = makeProject()) => p.characters

describe('assembleVoices：声音签名规范化', () => {
  it('只保留登记了签名的角色，解析口头禅/自称', () => {
    const v = voices()
    expect(v.length).toBe(2) // 路人无 voice 被过滤
    expect(v[0]).toMatchObject({ uid: 'a1', name: '王爷', catchphrases: ['有意思'], selfRef: ['本王'] })
    expect(v[1].uid).toBe('a2')
  })
  it('过滤通用代词自称（我/你/他），口头禅需 ≥2 字', () => {
    const p = { characters: [{ uid: 'x', name: '甲', voice: { selfRef: ['我', '本王'], catchphrases: ['嗯', '有意思'] } }] }
    const [v] = assembleVoices(p)
    expect(v.selfRef).toEqual(['本王']) // 「我」被过滤
    expect(v.catchphrases).toEqual(['有意思']) // 单字「嗯」被过滤
  })
  it('只有通用代词自称的角色视为未登记（不进清单）', () => {
    const p = { characters: [{ uid: 'x', name: '甲', voice: { selfRef: ['我'] } }] }
    expect(assembleVoices(p)).toEqual([])
  })
  it('null 安全：无 characters / 空对象', () => {
    expect(assembleVoices({})).toEqual([])
    expect(assembleVoices({ characters: null })).toEqual([])
    expect(assembleVoices({ characters: [{ uid: 'a', name: '甲' }] })).toEqual([])
  })
  it('SELFREF_PRESETS 不含通用代词', () => {
    expect(SELFREF_PRESETS).not.toContain('我')
    expect(SELFREF_PRESETS).toContain('本王')
  })
})

describe('voiceGate：台词串味（A 说出 B 的专属口头禅）', () => {
  it('阿昭说出王爷的专属口头禅「有意思」→ blocker', () => {
    const text = '阿昭说道：「这事真是有意思。」'
    const { blockers } = voiceGate(text, { voices: voices(), characters: chars(), chapterNo: 8 })
    expect(blockers.length).toBe(1)
    expect(blockers[0]).toMatchObject({ category: '角色声音穿帮', kind: '台词串味', uid: 'a2', ownerUid: 'a1', ownerName: '王爷', severity: 'blocker' })
    expect(blockers[0].what).toContain('阿昭')
    expect(blockers[0].what).toContain('有意思')
    expect(blockers[0].what).toContain('第 8 章')
  })
  it('角色说自己的口头禅 → 放行', () => {
    const text = '王爷说道：「这事有意思。」'
    const { blockers } = voiceGate(text, { voices: voices(), characters: chars() })
    expect(blockers.length).toBe(0)
  })
  it('共享口头禅（两角色都登记）非独占 → 不报', () => {
    const p = makeProject()
    p.characters[1].voice.catchphrases = ['有意思'] // 阿昭也登记「有意思」
    const text = '阿昭说道：「有意思。」'
    const { blockers } = voiceGate(text, { voices: assembleVoices(p), characters: p.characters })
    expect(blockers.length).toBe(0)
  })
  it('台词未含他人签名 → 放行', () => {
    const text = '阿昭说道：「今天天气不错。」'
    expect(voiceGate(text, { voices: voices(), characters: chars() }).blockers).toEqual([])
  })
})

describe('voiceGate：自称漂移（A 自称 B 的专属称谓）', () => {
  it('阿昭自称「本王」（王爷专属）→ blocker', () => {
    const text = '阿昭说道：「本王乏了，退下吧。」'
    const { blockers } = voiceGate(text, { voices: voices(), characters: chars(), chapterNo: 3 })
    expect(blockers.length).toBe(1)
    expect(blockers[0]).toMatchObject({ kind: '自称漂移', uid: 'a2', ownerUid: 'a1', phrase: '本王' })
  })
  it('角色用自己的自称 → 放行', () => {
    const text = '王爷说道：「本王准了。」'
    expect(voiceGate(text, { voices: voices(), characters: chars() }).blockers).toEqual([])
  })
  it('通用代词「我」永不当作专属自称', () => {
    const p = { characters: [
      { uid: 'a1', name: '王爷', voice: { selfRef: ['本王'] } },
      { uid: 'a2', name: '阿昭', voice: { selfRef: ['我'] } },
    ] }
    const text = '阿昭说道：「我知道了。」'
    expect(voiceGate(text, { voices: assembleVoices(p), characters: p.characters }).blockers).toEqual([])
  })
})

describe('voiceGate：仿拟护栏 + 边界', () => {
  it('打趣/模仿语境 → 串味降级为 warning（finding）', () => {
    const text = '阿昭打趣道：「有意思。」'
    const { blockers, warnings } = voiceGate(text, { voices: voices(), characters: chars(), chapterNo: 5 })
    expect(blockers.length).toBe(0)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toMatchObject({ kind: '台词串味', severity: 'finding' })
    expect(warnings[0].what).toContain('仿拟')
  })
  it('无声音签名 / 无人物 / 空文本 → 空结果不报错', () => {
    expect(voiceGate('', { voices: voices(), characters: chars() }).blockers).toEqual([])
    expect(voiceGate('阿昭说道：「有意思。」', { voices: [], characters: chars() }).blockers).toEqual([])
    expect(voiceGate('阿昭说道：「有意思。」', { voices: voices(), characters: [] }).blockers).toEqual([])
  })
  it('scanned 统计说话归因次数', () => {
    const text = '王爷说道：「来。」阿昭答道：「好。」'
    expect(voiceGate(text, { voices: voices(), characters: chars() }).scanned).toBe(2)
  })
})

describe('scanAllVoiceConflicts：全书声音穿帮总扫', () => {
  it('跨章聚合 blockers/warnings，按章号升序', () => {
    const p = makeProject({
      chapters: [
        { chapterNo: 2, title: '起因', content: '阿昭说道：「有意思。」' },
        { chapterNo: 9, title: '对峙', content: '阿昭怒道：「本王忍你很久了！」' },
        { chapterNo: 5, title: '平静', content: '王爷一个人走着。' },
      ],
    })
    const { blockers } = scanAllVoiceConflicts(p)
    expect(blockers.length).toBe(2)
    expect(blockers[0]).toMatchObject({ chapterNo: 2, kind: '台词串味' })
    expect(blockers[1]).toMatchObject({ chapterNo: 9, kind: '自称漂移' })
  })
  it('无声音签名 → 空', () => {
    expect(scanAllVoiceConflicts({ characters: [], chapters: [] })).toEqual({ blockers: [], warnings: [] })
  })
})

describe('distillVoices：从正文蒸馏专属签名候选', () => {
  it('挖出某角色高频且专属的短语，去掉子串', () => {
    const p = makeProject({
      chapters: [
        { chapterNo: 1, content: '王爷说道：「有意思。」阿昭说道：「且慢，容我想想。」' },
        { chapterNo: 2, content: '王爷又道：「有意思。」阿昭答道：「且慢，别冲动。」' },
      ],
    })
    const out = distillVoices(p)
    const wang = out.find((d) => d.uid === 'a1')
    expect(wang).toBeTruthy()
    const phrases = wang.candidates.map((c) => c.phrase)
    expect(phrases).toContain('有意思')
    expect(phrases).not.toContain('意思') // 子串被极大化过滤
    expect(phrases).not.toContain('有意思。') // 不带标点
  })
  it('两角色都说的短语非专属 → 不进候选', () => {
    const p = makeProject({
      chapters: [
        { chapterNo: 1, content: '王爷说道：「走吧。」阿昭说道：「走吧。」' },
        { chapterNo: 2, content: '王爷又道：「走吧。」阿昭又道：「走吧。」' },
      ],
    })
    const out = distillVoices(p)
    const wang = out.find((d) => d.uid === 'a1')
    const phrases = (wang?.candidates || []).map((c) => c.phrase)
    expect(phrases.some((x) => x.includes('走吧'))).toBe(false)
  })
  it('台词不足 2 行的角色不蒸馏；null 安全', () => {
    const p = makeProject({ chapters: [{ chapterNo: 1, content: '王爷说道：「有意思。」' }] })
    expect(distillVoices(p)).toEqual([])
    expect(distillVoices({})).toEqual([])
    expect(distillVoices({ characters: [], chapters: [] })).toEqual([])
  })
})
