import { parseBookAssets, parseAssetTable, backfillChapterNos } from './parseAssets.js'
import { normalizeAsset } from './assets.js'

// 新手写作落库域的纯函数：把 9 步产出的文本解析成资产/节拍/伏笔三表、
// 重新保存成书时与库内旧书做非破坏性合并、以及前段+后段卷章文本的拼接。
// 落库前的预览计数和真正落库共用同一套解析，保证用户核对的数字就是写进书里的内容。

// 第 7 步前段与第 8 步后段章表拼成完整卷章表的单一出处。预览计数与落库共用，防两处拼接写法漂移。
export const combinedVolumes = (volumes, volumes2) => `${volumes}\n${volumes2}`

// 解析三表。资产优先取独立的「资产表」（更完整、分层、带透出卷），资产表为空时回落圣经/人物解析；
// 再把卷章表里的「资产章号回填」写回资产与伏笔，否则第 8 步的回填成果会丢。
// AI 输出被长度上限截断时（如资产表只写到【地点】段），用圣经/人物解析里同类型且未重名的资产补足缺失段，
// 并回传告警标志供界面明示，避免用户只看到一个偏小的数字而无从察觉。
const TABLE_EXPECTED_TYPES = ['person', 'place', 'faction', 'item']
export const computeParsed = ({ assetTable, bible, characters, outline, volumes, volumes2 }) => {
  const vols = combinedVolumes(volumes, volumes2)
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

// 重新保存成书时的资产合并：向导重解析出的表派生字段（类型/层级/详情/透出卷/传闻卷/知情人/别名/章号/持有者）更新，
// 但保留长篇页写进去的成果——资产状态（结算产出）、手改与状态派生的关系边、长篇页新增的资产、原 id 与创建时间。
// 详情直接取向导的新值（覆盖不追加），反复重新保存不会累积重复详情。
export const mergeAssetsForResave = (parsedAssets, savedAssets) => {
  const savedByName = new Map((savedAssets || []).map((a) => [a.name, a]))
  const parsedNames = new Set()
  const merged = (parsedAssets || []).map((pa) => {
    parsedNames.add(pa.name)
    const sa = savedByName.get(pa.name)
    if (!sa) return pa // 向导表里新增的资产，直接用
    return normalizeAsset(
      {
        ...pa,
        id: sa.id, // 保留原 id，否则指向它的关系边全断
        state: sa.state, // 保留长篇页结算写的状态
        createdAt: sa.createdAt,
        links: [...(sa.links || []), ...(pa.links || [])], // 手改/状态派生边与表内绑定边取并集，由 normalizeAsset 去重
      },
      { idPrefix: 'lf' }
    )
  })
  const savedOnly = (savedAssets || []).filter((a) => !parsedNames.has(a.name)) // 长篇页新增、向导表里没有的资产：保留不丢
  return [...merged, ...savedOnly]
}

// 伏笔合并：按标题对齐，保留长篇页结算写的生命周期（状态/最后推进章/回收提示），向导只更新描述与埋设回收卷等表派生字段。
export const mergeForeshadowsForResave = (parsedFs, savedFs) => {
  const savedByTitle = new Map((savedFs || []).map((f) => [f.title, f]))
  return (parsedFs || []).map((pf) => {
    const sf = savedByTitle.get(pf.title)
    return sf ? { ...pf, state: sf.state || pf.state, lastAdvancedChapter: sf.lastAdvancedChapter, payoff_hint: sf.payoff_hint || pf.payoff_hint } : pf
  })
}
