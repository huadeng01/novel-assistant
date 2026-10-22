// parseAssets.js 的回归测试网：把已经修稳的解析行为钉成用例，防止后续改动悄悄改坏。只测现有代码、不改 src。
// 覆盖：状态词归一不兜底「活跃」、段头与首行数据同行的剥壳、势力/地点按尾列锚定、情绪锚取最后一个强度标记、
//   段头判定单一出处、人物 17 列与群像 5 列的列数漂移、卷号列拒自由文本章号、### 子标题不关段、详情剥 markdown、章号回填单一出处。
import { describe, it, expect } from 'vitest'
import {
  parseAnalyze, parseBookAssets, parseAssetTable, parseExpandAssets,
  backfillChapterNos, revealChapterOf, rumorChapterOf, isSectionHead,
  matchesName, findAssetByName, findForeshadowByTitle, chapLineNo,
} from '../parseAssets.js'
// 类型归一的单一出处在 assets.js（parseAssets 只吐提示词词表里的中文规范词）；测试里两侧都验，钉住「解析→归一→建档」链路
import { typeKeyOf, applyFlowToRoster } from '../assets.js'

describe('parseAnalyze · normState（决策#7：未识别词→空、不兜底活跃）', () => {
  it('已死亡/未知词 → state 空串（不再变活跃）；死亡 → 死亡', () => {
    const r = parseAnalyze('【已有资产更新】\n陆沉｜战死｜已死亡\n王五｜x｜未知词\n赵六｜y｜死亡')
    expect(r.updates[0].state).toBe('')
    expect(r.updates[1].state).toBe('')
    expect(r.updates[2].state).toBe('死亡')
  })
})

describe('parseAnalyze · 五段解析 + H2 同行段头剥壳', () => {
  const five = ['【已有资产更新】陆沉｜中毒加深｜死亡', '【新资产】道具｜传讯符｜一次性通讯｜44',
    '【状态变更】陆沉｜生理｜中毒｜左臂未解｜45', '【资产流转】陆沉｜消耗｜传讯符｜44',
    '【伏笔推进】身世之谜｜回收｜本章揭晓｜45'].join('\n')
  it('段标题与数据同行也能解析（不整行 continue 吃掉）', () => {
    const r = parseAnalyze(five)
    expect(r.updates).toHaveLength(1)
    expect(r.newAssets).toHaveLength(1)
    expect(r.stateChanges).toHaveLength(1)
    expect(r.flows).toHaveLength(1)
    expect(r.hookMoves).toHaveLength(1)
  })
  it('stateChanges 维度中文→key、flows 动作→枚举、hookMoves 动作→生命周期', () => {
    const r = parseAnalyze(five)
    expect(r.stateChanges[0]).toMatchObject({ name: '陆沉', dim: '生理', dimKey: 'phys', state: '中毒', since: 45 })
    expect(r.flows[0]).toMatchObject({ person: '陆沉', change: 'consumed', asset: '传讯符', ch: 44 })
    expect(r.hookMoves[0]).toMatchObject({ title: '身世之谜', move: 'resolved', ch: 45 })
  })
  it('分行写法的五段同样解析（回归）', () => {
    const r = parseAnalyze('【已有资产更新】\n陆沉｜中毒｜死亡')
    expect(r.updates).toHaveLength(1)
  })
})

describe('parseAnalyze · 【资产流转】资产类型列（任务③：AI 标类型 → flow.assetType → 下游 typeKeyOf 归一）', () => {
  it('类型写在章号后（提示词标准列序）→ assetType=灵兽、ch 仍取章号列', () => {
    const r = parseAnalyze('【资产流转】\n陆沉｜获得｜小白｜12｜灵兽')
    expect(r.flows[0]).toMatchObject({ person: '陆沉', change: 'gain', asset: '小白', ch: 12, assetType: '灵兽' })
  })
  it('AI 把类型写在章号前（列序漂移）→ 按词形定位，类型与章号都不错位', () => {
    const r = parseAnalyze('【资产流转】\n陆沉｜获得｜小白｜灵兽｜12')
    expect(r.flows[0]).toMatchObject({ asset: '小白', ch: 12, assetType: '灵兽' })
  })
  it('七类词都能认出，且都能被 assets.js typeKeyOf 归一到英文 key', () => {
    const rows = ['陆沉｜获得｜甲｜1｜人物', '陆沉｜获得｜乙｜1｜群像', '陆沉｜获得｜丙｜1｜势力',
      '陆沉｜获得｜丁｜1｜地点', '陆沉｜获得｜戊｜1｜道具', '陆沉｜获得｜己｜1｜功法', '陆沉｜获得｜庚｜1｜灵兽']
    const r = parseAnalyze(`【资产流转】\n${rows.join('\n')}`)
    expect(r.flows.map((f) => f.assetType)).toEqual(['人物', '群像', '势力', '地点', '道具', '功法', '灵兽'])
    expect(r.flows.map((f) => typeKeyOf(f.assetType))).toEqual(['person', 'group', 'faction', 'place', 'item', 'skill', 'beast'])
    expect(r.flows.every((f) => f.ch === 1)).toBe(true)
  })
  it('老格式 4 列（无类型列）→ assetType 留 undefined，下游兜底 item', () => {
    const r = parseAnalyze('【资产流转】\n陆沉｜消耗｜传讯符｜44')
    expect(r.flows[0].assetType).toBeUndefined()
    expect(r.flows[0].ch).toBe(44)
  })
  it('类型格是认不出的词/占位 → undefined（不猜、不抛错）', () => {
    expect(parseAnalyze('【资产流转】\n陆沉｜获得｜某物｜7｜未知').flows[0].assetType).toBeUndefined()
    expect(parseAnalyze('【资产流转】\n陆沉｜获得｜某物｜7｜—').flows[0].assetType).toBeUndefined()
    expect(parseAnalyze('【资产流转】\n陆沉｜获得｜某物｜7｜').flows[0].assetType).toBeUndefined()
  })
  it('端到端：解析出的 flow 直接喂 applyFlowToRoster → 灵兽建成 beast（此前恒建成 item）', () => {
    const { flows } = parseAnalyze('【资产流转】\n陆沉｜获得｜小白｜12｜灵兽\n陆沉｜获得｜传讯符｜12｜道具')
    let assets = []
    const created = []
    for (const fl of flows) {
      const r = applyFlowToRoster(assets, fl, { idPrefix: 'cx' })
      assets = r.assets
      created.push(...r.created)
    }
    expect(created.find((c) => c.name === '小白').type).toBe('beast')
    expect(created.find((c) => c.name === '传讯符').type).toBe('item')
    expect(assets.find((a) => a.name === '小白').type).toBe('beast')
  })
})

describe('parseBookAssets · 人物17列/群像5列/faction-place 尾锚', () => {
  const cols17 = ['陆沉', '剑修', '欲', '力', '关', '弧', '秘', '识', '语', '貌', '高光事件', '三', '一至五', '2', '3', '甲,乙', '死(护城战触发)']
  it('M1：人物 17 列 index16「退场方式」进 detail（此前被 slice(1,13) 丢弃）', () => {
    const p = parseBookAssets({ characters: cols17.join('｜') }).assets.find((a) => a.name === '陆沉')
    expect(p.detail).toContain('护城战触发')
    expect(p.reveal_volume).toBe(2)
    expect(p.rumor_volume).toBe(3)
    expect(p.knowers).toEqual(['甲', '乙'])
  })
  it('M2：群像 5 列尾 1 列锚定，detail 保留身份+高光事件+高光卷序（不被尾3列剥空）', () => {
    const g = parseBookAssets({ characters: '青云门弟子｜一群剑修｜围剿魔教立功｜三｜5' }).assets.find((a) => a.name === '青云门弟子')
    expect(g.type).toBe('group')
    expect(g.detail).toContain('围剿魔教立功')
    expect(g.reveal_volume).toBe(5)
  })
  it('H4：势力标准 7 列 reveal/rumor/knowers 正确', () => {
    const f = parseBookAssets({ bible: '【势力】\n天庭｜立场｜关系｜功能位｜甲,乙｜3｜2' }).assets.find((a) => a.name === '天庭')
    expect(f.reveal_volume).toBe(3)
    expect(f.rumor_volume).toBe(2)
    expect(f.knowers).toEqual(['甲', '乙'])
  })
  it('H4：势力列漂移（8 列）尾锚仍不错位', () => {
    const f = parseBookAssets({ bible: '【势力】\n天庭｜立场｜关系｜功能位｜额外｜甲,乙｜3｜2' }).assets.find((a) => a.name === '天庭')
    expect(f.reveal_volume).toBe(3)
    expect(f.rumor_volume).toBe(2)
  })
  it('H4：地点标准 5 列 reveal/rumor 正确', () => {
    const p = parseBookAssets({ bible: '【地点】\n青云城｜层级：域/区域：东｜功能/控制方：天庭｜3｜2' }).assets.find((a) => a.name === '青云城')
    expect(p.reveal_volume).toBe(3)
    expect(p.rumor_volume).toBe(2)
  })
})

describe('parseBookAssets · 段头识别（H6/M1 单一出处 isSectionHead + 同行剥壳）', () => {
  it('## 伏笔（无【】）也识别、不丢整段', () => {
    expect(parseBookAssets({ outline: '## 伏笔\n谜甲｜描甲｜1｜3' }).foreshadows).toHaveLength(1)
  })
  it('段头与首行数据同行（【伏笔】谜甲｜…）→ 剥壳后首行+后续都解析（M1 回归修复）', () => {
    const r = parseBookAssets({ outline: '【伏笔】谜甲｜描甲｜1｜3\n谜乙｜描乙｜2｜4' }).foreshadows
    expect(r.map((f) => f.title)).toEqual(['谜甲', '谜乙'])
  })
  it('数据行以段名开头但有竖线 → 不当段头（isSectionHead 无竖线门）', () => {
    expect(isSectionHead('伏笔回收｜描述｜1｜2', '伏笔')).toBe(false)
    expect(isSectionHead('【伏笔】', '伏笔')).toBe(true)
    expect(isSectionHead('## 伏笔', '伏笔')).toBe(true)
  })
  it('M5：### 子标题只跳过、不关段（其后数据行不丢）', () => {
    const r = parseAssetTable('【配角】\n张三｜d｜1｜2｜\n### 东部子区\n李四｜d｜3｜4｜')
    expect(r.map((a) => a.name)).toContain('李四')
  })
  it('未识别【终极真相】关闭区块，其后行不挂进伏笔', () => {
    const r = parseBookAssets({ outline: '【伏笔】\n谜甲｜描｜1｜3\n【终极真相】\n真相行｜x｜1' })
    expect(r.foreshadows).toHaveLength(1)
  })
})

describe('numVolume（M3变体：卷号列拒自由文本里的章号）', () => {
  const revealOf = (line) => parseAssetTable(`【配角】\n${line}`).find((a) => a.name === '张三').reveal_volume
  it('第三卷/卷三 → 3；纯数字 → 该数', () => {
    expect(revealOf('张三｜d｜第三卷｜2｜')).toBe(3)
    expect(revealOf('张三｜d｜卷三｜2｜')).toBe(3)
    expect(revealOf('张三｜d｜5｜2｜')).toBe(5)
  })
  it('含「章」的自由文本 → 0（不被当卷号 ×perVol 放大污染 buckets）', () => {
    expect(revealOf('张三｜d｜第5章登场｜2｜')).toBe(0)
  })
  it('占位 — → 0', () => {
    expect(revealOf('张三｜d｜—｜2｜')).toBe(0)
  })
  it('整格包裹记号 → 剥壳后取卷号（AI 常写「【卷1】」，原逻辑整表归 0 → 资产全落 ban 桶）', () => {
    expect(revealOf('张三｜d｜【卷1】｜2｜')).toBe(1)
    expect(revealOf('张三｜d｜【卷一】｜【卷3】｜')).toBe(1)
    expect(revealOf('张三｜d｜[卷7]｜2｜')).toBe(7)
    expect(revealOf('张三｜d｜**卷2**｜2｜')).toBe(2)
  })
  it('剥壳只认首尾成对包裹：格内夹字/列错位仍 → 0', () => {
    expect(revealOf('张三｜d｜【卷1】备注｜2｜')).toBe(0)
    expect(revealOf('张三｜d｜冥河老祖、主角｜2｜')).toBe(0)
  })
})

describe('情绪锚（H5 末匹配 + INTENSITY_RE 兼容 强度：4 / +4+）', () => {
  const beat = (row) => parseBookAssets({ volumes: `## 第一卷章节\n${row}` }).beats[0]
  it('INTENSITY_RE 认「强度：4」', () => {
    const b = beat('3｜决战｜梗概｜主角｜断剑｜情绪 强度：4｜甲,乙｜钩子')
    expect(b.intensity).toBe(4)
    expect(b.reveal_assets).toBe('断剑')
  })
  it('INTENSITY_RE 认「+4+」', () => {
    expect(beat('4｜决战｜梗概｜主角｜断剑｜紧张+4+｜甲,乙｜钩子').intensity).toBe(4)
  })
  it('H1：早期列含「强度3」不误锚（取最后一个匹配列）', () => {
    const b = beat('3｜决战｜冲突强度3升级｜主角视角｜断剑｜情绪 强度4｜甲,乙｜最终钩子')
    expect(b.mood_raw).toBe('情绪 强度4')
    expect(b.reveal_assets).toBe('断剑')
    expect(b.pov).toBe('主角视角')
    expect(b.cast).toEqual(['甲', '乙'])
    expect(b.hook).toBe('最终钩子')
  })
})

describe('章表区块自愈（无段头 + 两种章行写法）', () => {
  it('无区块标题、行首「第N章｜」也进章表区块（第7步完整表原口径整段丢节拍）', () => {
    const p = parseBookAssets({ volumes: '第1章｜投胎也是个技术活｜梗概｜主角视角｜赵算,老李｜情绪 强度3｜甲,乙｜钩子' })
    expect(p.beats.length).toBe(1)
    expect(p.beats[0].chapter_no).toBe(1)
    expect(p.beats[0].intensity).toBe(3)
  })
  it('无区块标题、行首纯数字仍进章表区块（第8步简表原行为不回退）', () => {
    const p = parseBookAssets({ volumes: '21｜暗房里的原始凭证｜梗概｜主角视角｜断剑｜情绪 强度4｜甲,乙｜钩子' })
    expect(p.beats.length).toBe(1)
    expect(p.beats[0].chapter_no).toBe(21)
  })
  it('两种写法混排（第7步+第8步拼接）都收，章号连续', () => {
    const p = parseBookAssets({
      volumes: '第1章｜甲｜梗概｜视角｜资产｜情绪 强度2｜出场｜钩子\n第2章｜乙｜梗概｜视角｜资产｜情绪 强度3｜出场｜钩子\n21｜丙｜梗概｜视角｜资产｜情绪 强度4｜出场｜钩子',
    })
    expect(p.beats.map((b) => b.chapter_no)).toEqual([1, 2, 21])
  })
})

describe('M7 cleanDetail（剥 markdown **/反引号、保留《》）', () => {
  it('detail 去 ** 与反引号、留《》', () => {
    const a = parseAssetTable('【配角】\n王五｜**剑修**｜持`青竹剑`｜《秘籍》｜1｜2｜').find((x) => x.name === '王五')
    expect(a.detail).toContain('《秘籍》')
    expect(a.detail).not.toContain('**')
    expect(a.detail).not.toContain('`')
  })
})

describe('M8 parseExpandAssets（reveal=末列、道具 detail 去持有者、地点控制方尾锚）', () => {
  it('道具 detail 不含持有者名、reveal 取末列', () => {
    const it = parseExpandAssets('【道具】\n青竹剑｜陆沉｜锋利长剑｜3')[0]
    expect(it.holder).toBe('陆沉')
    expect(it.detail).not.toContain('陆沉')
    expect(it.reveal_volume).toBe(3)
  })
  it('地点控制方尾锚 c[n-2] 建 controlled_by', () => {
    const p = parseExpandAssets('【地点】\n荒村｜东洲｜破败｜天庭｜2').find((a) => a.name === '荒村')
    expect(p.links).toEqual([{ type: 'controlled_by', to: '天庭' }])
  })
})

describe('backfillChapterNos（M11③ 单一出处 + >0 守卫）', () => {
  it('空/「—」不清零已有精确章号', () => {
    const assets = [{ name: '天庭', ch_reveal: 5, ch_rumor: 6 }]
    backfillChapterNos(assets, [], '【资产章号回填】\n天庭｜—｜—')
    expect(assets[0].ch_reveal).toBe(5)
    expect(assets[0].ch_rumor).toBe(6)
  })
  it('正整数才写（9 写入、0 不覆盖）', () => {
    const assets = [{ name: '天庭', ch_reveal: 5, ch_rumor: 6 }]
    backfillChapterNos(assets, [], '【资产章号回填】\n天庭｜9｜0')
    expect(assets[0].ch_reveal).toBe(9)
    expect(assets[0].ch_rumor).toBe(6)
  })
  it('parseBookAssets 内联回填已收敛到 backfillChapterNos（卷章表回填生效）', () => {
    const r = parseBookAssets({ bible: '【势力】\n天庭｜a｜b｜c｜甲｜3｜2', volumes: '## 资产章号回填\n天庭｜7｜8' })
    expect(r.assets.find((a) => a.name === '天庭').ch_reveal).toBe(7)
  })
})

describe('revealChapterOf / rumorChapterOf（卷号→章换算 + 精确章优先）', () => {
  it('透出卷 + perVol 换算', () => {
    expect(revealChapterOf({ reveal_volume: 3 }, 40)).toBe(81)
    expect(rumorChapterOf({ rumor_volume: 2 }, 40)).toBe(41)
  })
  it('精确章号优先于卷号换算', () => {
    expect(revealChapterOf({ ch_reveal: 7, reveal_volume: 3 }, 40)).toBe(7)
  })
  it('空资产 → 0', () => {
    expect(revealChapterOf(null)).toBe(0)
    expect(revealChapterOf({})).toBe(0)
  })
})

describe('第三轮 决策1+5 名字匹配下沉 parseAssets + 严格化 + L6 findForeshadowByTitle', () => {
  const roster = [{ id: 'i1', name: '玄铁令', type: 'item', aliases: ['玄铁'] }]
  it('matchesName/findAssetByName 从 parseAssets 导出、严格匹配（别名/《》命中，子串不误配）', () => {
    expect((findAssetByName(roster, '玄铁') || {}).id).toBe('i1')
    expect((findAssetByName(roster, '《玄铁令》') || {}).id).toBe('i1')
    expect(findAssetByName(roster, '铁令')).toBeNull()
    expect(matchesName(roster[0], '玄铁')).toBe(true)
    expect(matchesName(roster[0], '铁令')).toBe(false)
  })
  it('assets.js re-export 与 parseAssets 是同一函数引用', async () => {
    const A = await import('../assets.js')
    expect(A.findAssetByName).toBe(findAssetByName)
    expect(A.matchesName).toBe(matchesName)
  })
  it('findForeshadowByTitle 精确/《》/包含命中、无关与短名拒绝', () => {
    const fs = [{ title: '身世之谜', id: 'f1' }, { title: '断剑的来历', id: 'f2' }]
    expect((findForeshadowByTitle(fs, '身世之谜') || {}).id).toBe('f1')
    expect((findForeshadowByTitle(fs, '《身世之谜》') || {}).id).toBe('f1')
    expect((findForeshadowByTitle(fs, '身世之谜的真相') || {}).id).toBe('f1')
    expect((findForeshadowByTitle(fs, '断剑') || {}).id).toBe('f2')
    expect(findForeshadowByTitle(fs, '完全无关')).toBeNull()
    expect(findForeshadowByTitle(fs, '剑')).toBeNull()
  })
})

describe('第五轮 chapLineNo（章行→章号，A 区两份重复下沉的单一出处）', () => {
  it('认多格式：21｜/第21章｜/第21章 章名/第21章/21 ｜/｜21｜/裸 21/| 21 |', () => {
    expect(chapLineNo('21｜')).toBe(21)
    expect(chapLineNo('第21章｜')).toBe(21)
    expect(chapLineNo('第21章 决战')).toBe(21)
    expect(chapLineNo('第21章')).toBe(21)
    expect(chapLineNo('21 ｜梗概')).toBe(21)
    expect(chapLineNo('｜21｜')).toBe(21)
    expect(chapLineNo('21')).toBe(21)
    expect(chapLineNo('| 21 |')).toBe(21)
  })
  it('认中文数字章号（复用 cnToNum）', () => {
    expect(chapLineNo('第一章｜')).toBe(1)
    expect(chapLineNo('第二十章｜')).toBe(20)
    expect(chapLineNo('第二十一章｜x')).toBe(21)
    expect(chapLineNo('第十章')).toBe(10)
  })
  it('排区间/散文：至/到/-/～/〜(U+301C)/－/、// → 0', () => {
    for (const s of ['第21章至本卷末', '第21章到第30章', '第21章-', '第21章--', '第21章～', '第21章〜', '第21章－', '第21章、30章', '第21章/30章', '21-30', '21至30', '21、30']) {
      expect(chapLineNo(s), s).toBe(0)
    }
  })
  it('行首非章号的普通文本 → 0（不误判）', () => {
    expect(chapLineNo('这一章讲了很多')).toBe(0)
    expect(chapLineNo('讲述第二章的故事')).toBe(0)
    expect(chapLineNo('卷三')).toBe(0)
    expect(chapLineNo('')).toBe(0)
  })
})
