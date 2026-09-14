import { describe, it, expect } from 'vitest'
import {
  assembleSecrets,
  knowerGate,
  readerSeenScan,
  applyReaderSeen,
  dramaticIrony,
  scanAllKnowledgeConflicts,
} from '../knowledge.js'

// 构造测试书：两位在世角色 + 一位死者；一条秘密（林昭知情、苏晚不知情）
function makeProject(over = {}) {
  const characters = [
    { uid: 'a1', name: '林昭', aliases: ['阿昭'], alive: 'alive' },
    { uid: 'a2', name: '苏晚', aliases: ['晚儿'], alive: 'alive' },
    { uid: 'a3', name: '老周', aliases: [], alive: 'dead' },
  ]
  const secrets = [
    { id: 's1', statement: '林昭的生父是灭门案真凶', aliases: ['生父真凶', '灭门真凶'], knowers: ['a1'], readerSeenChapter: null, objective: 'true', note: '' },
  ]
  return {
    id: 'bk',
    characters,
    bible: { secrets },
    chapters: [],
    ...over,
  }
}

describe('assembleSecrets：三层状态规范化', () => {
  it('解析知情人 uid→name，并算出在世但不知情的角色', () => {
    const [s] = assembleSecrets(makeProject())
    expect(s.id).toBe('s1')
    expect(s.knowers).toEqual(['a1'])
    expect(s.knowerNames).toEqual(['林昭'])
    // 在世不知情 = 苏晚（老周已死，不计入）
    expect(s.unawareNames).toEqual(['苏晚'])
    expect(s.readerSeen).toBe(false)
    expect(s.objective).toBe('true')
  })
  it('过滤掉无 statement 的空秘密；bible 为 null 时返回空', () => {
    expect(assembleSecrets({ characters: [], bible: { secrets: [{ id: 'x', statement: '' }] } })).toEqual([])
    expect(assembleSecrets({ characters: [], bible: null })).toEqual([])
    expect(assembleSecrets({})).toEqual([])
  })
  it('readerSeenChapter 有值时 readerSeen=true', () => {
    const p = makeProject()
    p.bible.secrets[0].readerSeenChapter = 6
    expect(assembleSecrets(p)[0].readerSeen).toBe(true)
  })
})

describe('knowerGate：非知情人泄露秘密（悬疑命门）', () => {
  const secrets = () => assembleSecrets(makeProject())
  const chars = () => makeProject().characters

  it('非知情人在台词里说出秘密代号 → blocker', () => {
    const text = '苏晚沉声道：「原来生父真凶就是你，林昭。」'
    const { blockers } = knowerGate(text, { secrets: secrets(), characters: chars(), chapterNo: 8 })
    expect(blockers.length).toBe(1)
    expect(blockers[0].uid).toBe('a2')
    expect(blockers[0].category).toBe('知识状态穿帮')
    expect(blockers[0].what).toContain('苏晚')
    expect(blockers[0].what).toContain('第 8 章')
  })
  it('知情人说自己的秘密 → 放行', () => {
    const text = '林昭说道：「生父真凶这件事，我迟早会查清。」'
    const { blockers } = knowerGate(text, { secrets: secrets(), characters: chars(), chapterNo: 8 })
    expect(blockers.length).toBe(0)
  })
  it('台词未触及秘密代号 → 放行', () => {
    const text = '苏晚说道：「今天天气不错，我们走吧。」'
    const { blockers } = knowerGate(text, { secrets: secrets(), characters: chars(), chapterNo: 3 })
    expect(blockers.length).toBe(0)
  })
  it('无秘密 / 无人物 / 空文本 → 空结果不报错', () => {
    expect(knowerGate('', { secrets: secrets(), characters: chars() }).blockers).toEqual([])
    expect(knowerGate('苏晚说道：「生父真凶」', { secrets: [], characters: chars() }).blockers).toEqual([])
    expect(knowerGate('苏晚说道：「生父真凶」', { secrets: secrets(), characters: [] }).blockers).toEqual([])
  })
  it('scanned 统计说话归因次数', () => {
    const text = '林昭说道：「走。」苏晚答道：「好。」'
    const { scanned } = knowerGate(text, { secrets: secrets(), characters: chars() })
    expect(scanned).toBe(2)
  })
})

describe('readerSeenScan / applyReaderSeen：读者已见追踪', () => {
  it('正文命中秘密代号 → 返回该 secret id', () => {
    const seen = readerSeenScan('旁白揭示了灭门真凶的真相。', makeProject().bible.secrets)
    expect(seen).toEqual(['s1'])
  })
  it('未命中 → 空', () => {
    expect(readerSeenScan('风平浪静的一天。', makeProject().bible.secrets)).toEqual([])
  })
  it('applyReaderSeen 首次命中回填章号；已有值不覆盖；无命中返回 null', () => {
    const p = makeProject()
    const next = applyReaderSeen(p, 6, '这一章揭晓了生父真凶。')
    expect(next[0].readerSeenChapter).toBe(6)
    // 已有 readerSeenChapter → 不覆盖，返回 null（无变化）
    const p2 = makeProject()
    p2.bible.secrets[0].readerSeenChapter = 3
    expect(applyReaderSeen(p2, 9, '生父真凶')).toBe(null)
    // 无命中 → null
    expect(applyReaderSeen(makeProject(), 5, '无关内容')).toBe(null)
    // 无 secrets → null
    expect(applyReaderSeen({ bible: null }, 5, '生父真凶')).toBe(null)
  })
})

describe('dramaticIrony：戏剧反讽张力点', () => {
  it('读者已见 + 仍有在世角色不知情 → 列出知情/不知情双方', () => {
    const p = makeProject()
    p.bible.secrets[0].readerSeenChapter = 4
    const [ir] = dramaticIrony(p)
    expect(ir.knowers).toEqual(['林昭'])
    expect(ir.unaware).toEqual(['苏晚'])
    expect(ir.readerSeenChapter).toBe(4)
  })
  it('读者未见 → 不算反讽', () => {
    expect(dramaticIrony(makeProject())).toEqual([])
  })
})

describe('scanAllKnowledgeConflicts：全书知情人穿帮总扫', () => {
  it('跨章聚合非知情人泄露，按章号升序', () => {
    const p = makeProject({
      chapters: [
        { chapterNo: 2, title: '起因', content: '苏晚问道：「生父真凶到底是谁？」' },
        { chapterNo: 9, title: '对峙', content: '苏晚怒道：「我早知生父真凶是你！」' },
        { chapterNo: 5, title: '平静', content: '林昭一个人走着。' },
      ],
    })
    const out = scanAllKnowledgeConflicts(p)
    expect(out.length).toBe(2)
    expect(out[0].chapterNo).toBe(2)
    expect(out[1].chapterNo).toBe(9)
    expect(out[0].name).toBe('苏晚')
  })
  it('无秘密 → 空', () => {
    expect(scanAllKnowledgeConflicts({ characters: [], chapters: [], bible: null })).toEqual([])
  })
})
