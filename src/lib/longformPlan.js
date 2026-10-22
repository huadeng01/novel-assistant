import { chapLineNo } from './parseAssets.js'

// 长篇工作台的两个配置常量：草稿在 drafts 表里的键、每章历史快照的保留上限。
// 草稿键按书分槽（每本书一条），切书时各书草稿互不覆盖，切回原书能恢复未保存的正文。
export const lfDraftKey = (bookId) => `lf_current:${bookId}`

// 每章最多保留的旧正文快照数，超出丢弃最旧的一版
export const HISTORY_MAX = 5

// 把卷号写法解析成数字，覆盖阿拉伯数字与中文数字 1–99（「卷二」「第十二卷」里的二、十二）。解析不出返回 0。
export const cnVolNo = (s) => {
  const t = String(s || '').trim()
  if (/^[0-9]+$/.test(t)) return parseInt(t, 10)
  if (!/^[一二三四五六七八九十]+$/.test(t)) return 0
  const d = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const shi = t.indexOf('十')
  if (shi < 0) return d[t] || 0
  const tens = shi === 0 ? 1 : d[t[shi - 1]] || 0
  const ones = shi === t.length - 1 ? 0 : d[t[shi + 1]] || 0
  return tens * 10 + ones
}

// 从卷号单元格里抽出数字核再解析，兼容「第2卷」「卷二」「2」「二」等写法。
// AI 常把分卷结构表行写成这些变体，只认裸数字会漏取整卷。
export const volNoOfCell = (s) => {
  const m = String(s || '').match(/[0-9]+|[一二三四五六七八九十]+/)
  return m ? cnVolNo(m[0]) : 0
}

// 续排下一卷时算卷号：从卷章表的「第N卷…章节」标题里取最大卷号加 1。
// 不用「已排最大章 ÷ 每卷章数」反推——各卷章数不等时除法会算错卷号、喂错卷大纲。
// 卷标题解析不到时回落除法估算，保持可用。
export const nextVolumeNoOf = (volumes, maxPlanChapter, pv) => {
  let maxVol = 0
  const re = /第\s*([0-9]+|[一二三四五六七八九十]+)\s*卷[^】\n]*章节/g
  const text = String(volumes || '')
  let m
  while ((m = re.exec(text))) {
    const n = cnVolNo(m[1])
    if (n > maxVol) maxVol = n
  }
  if (maxVol > 0) return maxVol + 1
  return maxPlanChapter > 0 ? Math.ceil(maxPlanChapter / (pv || 40)) + 1 : 2
}

// 定位某一章落在哪一卷：逐行扫卷章表，遇卷标题更新当前卷，遇章号等于目标章的章行即返回其所属卷。
// 同样不用除法反推——各卷章数不等时除法错卷，会让伏笔的「已埋未回收 / 本卷应回收」两组筛选双双错卷。
// 卷章表没有卷标题或定位不到该章时回落除法估算，保持可用。
export const volOfChapter = (volumes, targetCh, perVol) => {
  if (!(targetCh > 0)) return 0
  const headerRe = /第\s*([0-9]+|[一二三四五六七八九十]+)\s*卷[^】\n]*章节/
  let curVol = 0
  for (const raw of String(volumes || '').split('\n')) {
    const l = raw.trim()
    if (!l) continue
    const hm = l.match(headerRe)
    if (hm) {
      const n = cnVolNo(hm[1])
      if (n > 0) curVol = n
      continue // 卷标题行本身不是章行，先于章号判定拦截
    }
    if (curVol > 0 && chapLineNo(l) === targetCh) return curVol
  }
  return perVol > 0 ? Math.ceil(targetCh / perVol) : 0
}
