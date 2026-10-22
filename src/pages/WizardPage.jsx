import { useEffect, useMemo, useRef, useState } from 'react'
import PromptEditorModal from '../components/PromptEditorModal.jsx'
import { PRESET_STYLES } from '../corpus/presetStyles.js'
import { put, getAll } from '../lib/db.js'
import { digestLines } from '../lib/parseAssets.js'
import { ASSET_TYPE_LABEL } from '../lib/assets.js'
import { sampleNovel, styleAnalyzeMessages } from '../lib/prompts.js'
import { distillStyleBand } from '../lib/longform.js'
import { readDocumentFile, READ_ACCEPT } from '../lib/docio.js'
import ClarifyModal from '../components/ClarifyModal.jsx'
import {
  inspirePrompt, clarifyPrompt, STYLE_PROMPT_HEAD, biblePrompt, charPrompt, assetTablePrompt, outlinePrompt,
  volumePrompt, volumePrompt2, outlineDigest, foreshadowLinesOf, volumesTail, resolveVolumeLine, parseJsonReply,
} from '../lib/wizardPrompts.js'
import { computeParsed, mergeAssetsForResave, mergeForeshadowsForResave, combinedVolumes } from '../lib/wizardBuild.js'
import useWizardDraft from '../hooks/useWizardDraft.js'

// 新手写作：自顶向下搭建故事框架，共 9 步。每一步的提示词都经 PromptEditorModal 暴露给用户编辑、确认后才发送。
// 方案C：资产库管实体(assets)，情绪节拍(beats)与伏笔(foreshadows)分离落库；落库前用 parseBookAssets 把｜分列文本解析进三表。
// 数量带(宁多)：至少N至M，真书校准(完美世界势力核心20-25/地点25-30)；质量锚=每个资产写清前三卷不可替代的剧情作用。
// 章号断点修法A：第4-6步时序一律用【卷序】，章号在第8步排章后经【资产章号回填】细化。
// 提示词纪律：一律正向陈述；正向锚"只写上游出现过的或为其直接补全的"；字段缺省时写—。

const box = 'w-full resize-y rounded-lg border border-stone-300 bg-stone-50 p-3 text-sm leading-relaxed focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-200'
const line =
  'w-full rounded-lg border border-stone-300 bg-stone-50 px-3 py-2 text-sm focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-200'
const label = 'mb-1 block text-xs font-medium text-stone-500'
const genBtn =
  'rounded-lg bg-red-700 px-4 py-1.5 text-sm text-onaccent hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-red-700'
const hint = 'mt-2 text-xs text-stone-400'

// 新手写作页：9 步自顶向下搭建故事框架并落库成书，每步提示词可编辑可重生成。
export default function WizardPage({ onOpenLongForm }) {
  const wz = useWizardDraft()
  const {
    inspiration, setInspiration, targetWords, setTargetWords, brief, setBrief,
    clarifyQuestions, setClarifyQuestions, clarifyAnswers, setClarifyAnswers,
    stylePreset, setStylePreset, genreNote, setGenreNote, styleNote, setStyleNote,
    styleProfile, setStyleProfile, styleSourceText, setStyleSourceText,
    styleHabits, setStyleHabits, styleSamples, setStyleSamples,
    styleMetrics, setStyleMetrics, styleReliable, setStyleReliable, styleMetricsFrom, setStyleMetricsFrom,
    bible, setBible, characters, setCharacters, assetTable, setAssetTable, outline, setOutline,
    volumes, setVolumes, volumes2, setVolumes2,
    savedBook, setSavedBook, saveErr, setSaveErr, draftSaveError, draftLoaded, loadedIdbSourceRef, clearDraft,
  } = wz
  const [inspireOpen, setInspireOpen] = useState(false)
  const [clarifyOpen, setClarifyOpen] = useState(false)
  const [clarifyPromptOpen, setClarifyPromptOpen] = useState(false)
  const [clarifyErr, setClarifyErr] = useState('')
  const [styleOpen, setStyleOpen] = useState(false)
  const [distillPromptOpen, setDistillPromptOpen] = useState(false)
  const [distillSystem, setDistillSystem] = useState('')
  const [distillUserPrompt, setDistillUserPrompt] = useState('')
  const [distillSamples, setDistillSamples] = useState([])
  const [distillErr, setDistillErr] = useState('')
  const [bibleOpen, setBibleOpen] = useState(false)
  const [charsOpen, setCharsOpen] = useState(false)
  const [assetTableOpen, setAssetTableOpen] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [volumesOpen, setVolumesOpen] = useState(false)
  const [volumes2Open, setVolumes2Open] = useState(false)
  const [saving, setSaving] = useState(false)
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

  // 改用 400ms 防抖快照算计数(仅供第9步 UI 核对)；落库时 saveBook 用当前值即时重算，不吃防抖滞后值，保证落库=用户最后编辑。
  const [debouncedSrc, setDebouncedSrc] = useState({ assetTable, bible, characters, outline, volumes, volumes2 })
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSrc({ assetTable, bible, characters, outline, volumes, volumes2 }), 400)
    return () => clearTimeout(t)
  }, [assetTable, bible, characters, outline, volumes, volumes2])
  const previewCounts = useMemo(() => computeParsed(debouncedSrc), [debouncedSrc])

  // （对圣经与人物全文各扫多次），大文本下每次按键都重算、弹窗关闭时也照算。改 useMemo 缓存，两个弹窗共享 digestLines 结果，只在上游文本变化时重算。
  const bibleDigest = useMemo(() => digestLines(bible, 7), [bible])
  const charsDigest = useMemo(() => digestLines(characters, 17), [characters])
  const volumeInitialPrompt = useMemo(
    () => volumePrompt(resolveVolumeLine(brief, targetWords, genreNote), bibleDigest, charsDigest, outlineDigest(outline)),
    [brief, targetWords, genreNote, bibleDigest, charsDigest, outline]
  )
  const volume2InitialPrompt = useMemo(
    () => volumePrompt2(volumesTail(volumes), bibleDigest, charsDigest, foreshadowLinesOf(outline)),
    [volumes, bibleDigest, charsDigest, outline]
  )

  // 真蒸馏链路（对齐 novel-local stylistAgent.distillOne）：sampleNovel切样本 → 文风分析提示词经弹窗给用户看/改 → 发送后回复解析 → distillStyleBand(零Token 14维量化)。
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
    // 原"落库净化+消费端再净化"是双重净化；且预设/书库路径本就不过建书侧净化，口径不一。统一消费端单次净化覆盖所有来源。
    //   但模型返对象元素时会污染提示词（"[object Object]"）；原 `res.habits||[]` 不归一、`filter(Boolean)` 会放过对象，故按 typeof 过滤。
    setStyleHabits(Array.isArray(res.habits) ? res.habits.map((h) => (typeof h === 'string' ? h.trim() : '')).filter(Boolean) : [])
    setStyleSamples(Array.isArray(res.samples) ? res.samples.filter((s) => typeof s === 'string' && s.trim()).slice(0, 3) : [])
    setStyleMetrics(band.metrics || null)
    setStyleReliable(!!band.reliable)
    setStyleMetricsFrom('distill') // 第2项：标记指纹来自原文蒸馏(徽标显示"已蒸馏…")
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
      if (String(styleSourceText || '').trim() && String(styleSourceText) !== String(text) && !window.confirm('导入会替换当前的原文样本（当前未另存的内容将丢失）。确定导入吗？')) return
      loadedIdbSourceRef.current = ''
      setStyleSourceText(text)
      setDistillErr('')
    } catch (err) {
      setDistillErr(err && err.message ? err.message : String(err))
    }
  }

  const clarifyText = clarifyAnswers
    ? clarifyAnswers
        .map((a, i) => {
          const q = clarifyQuestions[i]
          if (!q) return ''
          const opt = a.option >= 0 && q.options ? q.options[a.option] : null
          const sel = opt ? (opt.description ? `${opt.label}（${opt.description}）` : opt.label) : ''
          const val = (a.free || '').trim() || sel
          return val ? `${q.question} → ${val}` : ''
        })
        .filter(Boolean)
        .join('\n')
    : ''

  const genClarify = () => {
    const answered = Array.isArray(clarifyAnswers) ? clarifyAnswers.filter((a) => a.option >= 0 || (a.free || '').trim()).length : 0
    if (answered > 0 && !window.confirm(`重新生成补全问题会丢弃已作答的 ${answered} 题，确定继续？`)) return
    setClarifyErr('')
    setClarifyPromptOpen(true)
  }

  const adoptClarify = (reply) => {
    const data = parseJsonReply(reply)
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
    if (saving) return
    setSaving(true)
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
      styleMetrics,
      styleReliable,
      styleNote,
      bible,
      characters,
      assetTable,
      outline,
      volumes: combinedVolumes(volumes, volumes2),
      assets: savedBook ? mergeAssetsForResave(parsed.assets, savedBook.assets) : parsed.assets,
      beats: parsed.beats,
      foreshadows: savedBook ? mergeForeshadowsForResave(parsed.foreshadows, savedBook.foreshadows) : parsed.foreshadows,
      volOneChapters: parsed.beats.reduce((m, b) => Math.max(m, b.chapter_no || 0), 0),
      chapters: savedBook?.chapters || [],
      graphPos: savedBook?.graphPos,
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
      if (!savedBook) setSavedBook(null)
      setSaveErr('落库失败：' + (e && e.message ? e.message : String(e)) + '（可能存储空间不足）' + (savedBook ? '；原书未改动、仍在书库，可重试。' : ''))
    } finally {
      setSaving(false)
    }
  }

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
            loadedIdbSourceRef.current = ''
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
          // 不用 split(...)[1]：灵感自身含"一句话灵感："时会被切成多段、只取到第一段(截断)；也不用 lastIndexOf：会丢掉灵感前半。
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
