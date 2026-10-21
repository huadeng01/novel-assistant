import { useCallback, useEffect, useRef, useState } from 'react'
import { useBooks } from './useBooks.js'
import { getById, put } from '../lib/db.js'
import { chatJSON, STRUCTURED_TEMP } from '../lib/llm.js'
import { styleAnalyzeMessages, sampleNovel } from '../lib/prompts.js'
import { distillStyleBand } from '../lib/longform.js'
import { GENRE_STYLE_TABLE } from '../lib/worldviews/index.js' // C36：题材选项单一出处（worldviews 零依赖，无环）

// 5.3：内置题材选项（给用户一份可选清单）。C36：改由 worldviews 的 GENRE_STYLE_TABLE（题材档单一权威）**派生**，不再手写一份 12 项清单。
//   🔴第十轮订正理由（原 C36 注释的 bug 归因不成立）：Library 的题材 <select>(:166) 绑的是 **lib.genre**（useLibrary 的 genre state，只会被下拉自己 setGenre 或已存档案的 genre 赋值 ⟹ 恒是 GENRE_OPTIONS 里的值），
//   **不吃 book.genre**（WizardPage 落库的 genreNote 是 books 表字段，与 styles 表的 genre 不同源）——故原注「book.genre 是那 8 个题材时 select 找不到 option→显不限→一碰覆盖真值」的路径并不存在。
//   派生本身仍正确、有价值（属一致性改进，非 bug 修复）：①单一出处，表增删题材时选项自动跟随、不再与手写清单漂移；②把表里全部 20 个题材（含原手写漏掉的历史/都市/现实/科幻/末世/军事/轻小说/竞技）开放给用户选，
//   这些题材在表里都有 chapterWords/avgParaLen 档，选了能正常参与章字数/段长计算。选中值传入 resolveStyleRec 后由 genreSkinOf 查表，查不到（或选「不限」/无 benchmark 的题材）安全回落默认嗓音。
//   注：能否映射到主导嗓音取决于该题材在表里有无 benchmark（见 worldviews 内注释）；无 benchmark 的题材仍可选、只回落默认嗓音，不影响章字数/段长档。
export const GENRE_OPTIONS = Object.keys(GENRE_STYLE_TABLE)
const GENRE_KEY = 'na_genre'
const SELECTED_BOOK_KEY = 'na_selected_book' // M12：记住选中的书，切 tab / 刷新不丢（App 条件渲染会卸载重挂各页）

// 第一档④修：文风档案归一抽成模块级 helper，供读回侧(切书 getById('styles'))用——写侧(analyze 建 record)已内联归一，
//   但修复前存入 IDB 的对象型 profile/habits 在切书/刷新回读时未经归一直接 setStyle → Library 渲染 {style.profile}/{h} 抛「Objects are not valid as React child」持续崩、只能清空逃生。
//   读回也过这份归一(对象归空、不显 [object Object])，与写侧同口径。
function sanitizeStyleRec(rec) {
  if (!rec || typeof rec !== 'object') return null
  return {
    ...rec,
    profile: typeof rec.profile === 'string' ? rec.profile : '',
    habits: Array.isArray(rec.habits) ? rec.habits.map((h) => (typeof h === 'string' ? h.trim() : '')).filter(Boolean) : [],
    samples: Array.isArray(rec.samples) ? rec.samples.filter((s) => typeof s === 'string' && s.trim()) : [],
    forbidden: Array.isArray(rec.forbidden) ? rec.forbidden.filter((f) => typeof f === 'string') : [],
  }
}

// 书库 + 文风档案统一管理：改写润色与新手写作两个模块共用
export function useLibrary() {
  const { books, loading, loadError, importFile, createBookFromText, removeBook: removeBookRaw, refresh, syncBook } = useBooks()
  const [selectedId, setSelectedId] = useState(() => {
    try {
      return localStorage.getItem(SELECTED_BOOK_KEY) || null
    } catch {
      return null
    }
  })
  const [style, setStyle] = useState(null)
  const [analyzing, setAnalyzing] = useState(false)
  // M11：追踪最新 style 的 ref——analyze 是长异步，期间用户可能 updateForbidden 加词；写回时用 ref 里的最新 forbidden，不整体覆盖用户新加的词
  const styleRef = useRef(style)
  useEffect(() => {
    styleRef.current = style
  }, [style])
  // M-A：文风分析的中断句柄 + 挂载标记——analyze 是长异步(chatJSON 约 1 分钟)，页面卸载(切 tab)后若继续跑会白烧额度、
  //   并对已卸载组件 setAnalyzing/setStyle。卸载即 abort，且回写前查 mountedRef。
  const analyzeCtrlRef = useRef(null)
  const mountedRef = useRef(true)
  // H3 + L-新4：styles 写操作的串行队列——updateForbidden(增删禁用词) 与 analyze(文风分析写回) 共用同一条链，
  //   避免两者并发时整条 put('styles',…) 互相覆盖（analyze 覆盖掉用户刚加的禁用词 / 或反之）。
  const stylesQueueRef = useRef(Promise.resolve())
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      analyzeCtrlRef.current?.abort()
    }
  }, [])
  // 5.3：题材（genre）来源。持久化到 localStorage；绑定的书若其文风档案存过 genre，载入 effect 会用书里的 genre 覆盖。
  // M21：续写页已删除文风块（不再解析/注入文风、不消费 genre，改由 continueMessages 的 CONTINUE_STYLE_HINT 直接参照原文风格），故 genre 现仅改写润色页（RevisePage）消费——原「改写/续写两页共享、两页嗓音一致」的说明已随之失效，删去。
  const [genre, setGenreState] = useState(() => {
    try {
      return localStorage.getItem(GENRE_KEY) || ''
    } catch {
      return ''
    }
  })
  const setGenre = useCallback((g) => {
    const v = g || ''
    try {
      localStorage.setItem(GENRE_KEY, v)
    } catch {
      /* 隐私模式/配额满：仅本次会话有效 */
    }
    setGenreState(v)
  }, [])
  // 最新 selectedId 的 ref：供异步 analyze 完成时比对，防分析中切书把旧书档案上屏到新书(M15)
  const selectedIdRef = useRef(selectedId)
  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  // 切换选中书籍时加载对应文风档案
  useEffect(() => {
    let cancelled = false
    setStyle(null) // 切书先清空，避免异步窗口里持续显示上一本书的档案(M16)
    if (!selectedId) return () => {}
    getById('styles', selectedId)
      .then((rec) => {
        if (!cancelled) {
          setStyle(sanitizeStyleRec(rec)) // 第一档④：读回也归一，防修复前存入的对象型 profile/habits 毒丸刷新/切书回灌崩
          // 5.3：书的文风档案若存过 genre，带入当前题材选择（让"同一本书两页嗓音一致"跟书走）
          if (rec && typeof rec.genre === 'string' && rec.genre) setGenre(rec.genre) // #7：只在档案存过【非空】genre 时才带入；空串不覆盖用户之后改的题材（否则切 tab/刷新后被静默回滚到分析当时的值）
        }
      })
      .catch(() => {
        if (!cancelled) setStyle(null) // 读取失败不留旧值、不产生未处理 rejection(M16)
      })
    return () => {
      cancelled = true
    }
  }, [selectedId, setGenre])

  const select = useCallback((id) => {
    setSelectedId(id)
    try {
      if (id) localStorage.setItem(SELECTED_BOOK_KEY, id)
      else localStorage.removeItem(SELECTED_BOOK_KEY)
    } catch {
      /* 隐私模式/配额：仅本次会话有效 */
    }
  }, [])

  const removeBook = useCallback(
    async (id) => {
      await removeBookRaw(id)
      if (selectedId === id) {
        setSelectedId(null)
        try {
          localStorage.removeItem(SELECTED_BOOK_KEY) // M12：删书同步清掉持久化的选中项，避免刷新后指向已删书
        } catch {
          /* 忽略 */
        }
      }
    },
    [removeBookRaw, selectedId],
  )

  // P2：持久化的 selectedId 可能指向已不存在的书（在别的标签页删了 / 旧版本遗留 / 手改 localStorage / 清空数据后残留）——
  //   原来不校验，selectedBook 会恒为 null 却又占着「选中态」。books 载入后校验一次，不存在就清掉选中。
  //   L：只在「载入完成且未失败」时校验——载入中(loading)不动，避免异步载入完成前误清；载入失败(loadError)也不动，
  //     因为失败时 books 可能是空的，据此清掉会把一个本来有效的 selectedId 误清（清库 wipeAll 后 books  legitimately 为空则由本 effect 正常清脏值）。
  useEffect(() => {
    if (loading || loadError) return
    if (selectedId && !books.some((b) => b && b.id === selectedId)) select(null)
  }, [books, loading, loadError, selectedId, select])

  // 参照这本小说拆分作者书写习惯；"去除 AI 味"由 AI 自身的固有规则处理，不再从用户文章里检查
  const analyze = useCallback(
    async (apiKey) => {
      const book = books.find((b) => b.id === selectedId)
      if (!book) return
      if (!String(book.content || '').trim()) {
        throw new Error('这本书没有正文（建书页落库的书只有框架），无法抽样分析文风；请导入带正文的小说文件。')
      }
      const startedId = selectedId // 发起时的书；完成时与 selectedIdRef 比对，防切书后把旧书档案上屏到新书(M15)
      setAnalyzing(true)
      const ctrl = new AbortController() // M-A：卸载时 abort，分析不再后台空跑烧额度
      analyzeCtrlRef.current = ctrl
      try {
        const samples = sampleNovel(book.content)
        if (!samples || !samples.length) {
          throw new Error('这本书切不出足够长的样本段落（正文可能都是短行），无法分析文风。') // M17：空样本不发空请求，避免 AI 凭空编一份幻觉档案落库
        }
        // 第一档②修：在 await 之前捕获本书(发起分析时)的 forbidden 快照。
        //   原 record.forbidden 在 await 之后(:161)才读 styleRef.current，而文风分析要约 1 分钟、期间用户可能切到别的书，
        //   styleRef 已指向 B → 快照拿到 B 的禁用词；writeTask 的 sameBook=false 分支回退到 record.forbidden(=B的词) → 把 B 的禁用词污染进 A 的档案(必修5 只堵了毫秒级 getById 窗、没堵这个分钟级 await 窗)。
        //   await 前捕获 = 真正的"分析开始时本书快照"；分析期间对本书的增删仍由 writeTask 的 sameBook 分支用最新 styleRef 捕捉。
        const forbiddenAtStart = styleRef.current?.forbidden || []
        const res = await chatJSON({ apiKey, messages: styleAnalyzeMessages(samples), temperature: STRUCTURED_TEMP, signal: ctrl.signal }) // B30：低温度走 llm.js STRUCTURED_TEMP 单一出处（与 DiagnosePanel 同值）
        if (!mountedRef.current) return // M-A：已卸载，丢弃结果
        // P1-1R 量化指纹：对采样原文蒸馏本书专属多维文体指纹 + 阈值（与 LLM 定性 profile 互补，零 Token、确定性）
        const band = distillStyleBand(samples.join('\n'))
        const record = {
          bookId: book.id,
          origin: 'user',
          // 必修6同型横扫：style_profile 归一——Library:204 直接 `{style.profile}` 渲染、且 profile 落 IDB(styles)，
          //   模型把 style_profile 返对象/数组时会抛「Objects are not valid as React child」+ 随档案持久化 → 每次选中该书持续崩。typeof 守卫（对象归空、不显 [object Object]）。
          profile: typeof res.style_profile === 'string' ? res.style_profile : '',
          // habits 虽当前无 JSX 渲染点（仅注入成文提示词），仍归一成字符串数组：防对象元素污染提示词（"[object Object]"）+ 兜住将来新增渲染点。samples 下方已 filter 字符串。
          habits: Array.isArray(res.habits) ? res.habits.map((h) => (typeof h === 'string' ? h.trim() : '')).filter(Boolean) : [],
          // 文风范例（原样摘录的典型段落）：写作时作为 few-shot 注入，模仿效果强于纯描述；旧档案无此字段时为空
          samples: Array.isArray(res.samples) ? res.samples.filter((s) => typeof s === 'string' && s.trim()).slice(0, 3) : [],
          // 禁用词改为纯用户手动管理：重新分析时保留用户已添加的词，不覆盖
          forbidden: forbiddenAtStart, // 第一档②：用 await 前捕获的"分析开始时本书快照"，不在 await 后读 styleRef(那时可能已切到别书→拿到别书的词)。分析期间对本书的增删由下方 writeTask 的 sameBook 分支用最新 styleRef 捕捉。
          // 本书专属量化指纹（14 维）。注：原消费方 styleDriftScan 漂移门 / codeLayerAudit 自适应阈值已随暗箱流水线物理删除；
          // 这几个字段暂作为文风档案元数据保留（当前无新消费方），如需精简可后续评估删除——本轮按"注释保留不删字段"处理。
          metrics: band.metrics,
          thresholds: band.thresholds,
          bandReliable: band.reliable,
          genre, // 5.3：把当前题材选择存进档案，绑定该书时自动带回（改写页/续写页主导嗓音跟书一致）
          updatedAt: Date.now(),
        }
        // L-11 + item8（第十轮）：分析期间该书可能已被删除；落库 styles 前复查书是否还在，避免 put 重建指向已删书的孤儿档案。
        //   区分「读库异常」与「书确实已删」（对齐 useAssets item9 口径）——原 `.catch(()=>null)` 把读库失败也归一成 null 当"书已删"，
        //   静默丢弃已烧 token 的文风分析结果、无任何提示（用户以为成功）。读库异常改为抛出，由调用方(Library.onAnalyze)据实报错。
        let stillExists
        try {
          stillExists = await getById('books', book.id)
        } catch (e) {
          if (!mountedRef.current) return // 已卸载：静默丢弃（调用方也已卸载）
          throw new Error('文风分析已完成，但读取书籍数据失败、档案未能保存，请重试（' + (e && e.message ? e.message : String(e)) + '）')
        }
        if (!mountedRef.current) return // 已卸载：静默丢弃（调用方也已卸载，setState/报错都无意义）
        // 次修2（第十轮·再审B）：书在分析期间被删 → 不再静默 return（原会把已烧 token 的分析结果无声丢弃、用户不知发生了啥），
        //   据实抛出、由 Library.onAnalyze 显示，与 useAssets item9(:140「这本书已被删除，本次资产变更未保存」)同口径（useLibrary 无 setMsg 通道，throw 是其等价报错路径）。
        if (!stillExists) throw new Error('这本书在文风分析期间已被删除，分析结果未保存（不落孤儿档案）。')
        // L-新4：写回纳入 stylesQueue 串行链，且在【执行时】才取最新 forbidden——不与 updateForbidden 互盖。
        //   原来直接 put('styles', record)：record.forbidden 是建 record 时(:148)读的快照，若这期间用户增删了禁用词，
        //   整条 put 会把用户的新词覆盖回旧值。排队 + 执行时重读 styleRef.current.forbidden 消除这个窄窗。
        const writeTask = async () => {
          // 必修5（第十一轮）：只有 styleRef 仍指向**本书**(book.id) 时才取它的最新 forbidden（捕捉分析期间用户对本书增删禁用词，M11/L-新4 本意）；
          //   分析 A 期间切到 B（B 有档案）时 styleRef 指向 B，原 `styleRef.current?.forbidden` 会把 **B 的禁用词写进 A 的档案**（跨书污染，:190 startedId 只挡上屏不挡落库）→ 此时回退 record.forbidden（分析开始时 A 的快照）。
          const sameBook = styleRef.current?.bookId === book.id
          const finalRecord = { ...record, forbidden: (sameBook ? styleRef.current?.forbidden : null) || record.forbidden }
          await put('styles', finalRecord)
          if (startedId === selectedIdRef.current && mountedRef.current) {
            styleRef.current = finalRecord
            setStyle(finalRecord) // 仅当仍停在发起时那本书才上屏，否则丢弃结果(M15)
          }
          return finalRecord
        }
        const p = stylesQueueRef.current.then(writeTask, writeTask) // 前一次无论成败都接着跑
        stylesQueueRef.current = p.catch(() => {})
        await p
      } catch (e) {
        if (e?.name === 'AbortError' || !mountedRef.current) return // M-A：卸载中断，静默不抛（调用方也已卸载）
        throw e // 其他错误照常抛给调用方（Library.onAnalyze 显示）
      } finally {
        analyzeCtrlRef.current = null
        if (mountedRef.current) setAnalyzing(false)
      }
    },
    // P2：deps 去掉残留的 style——函数体读的是 styleRef.current?.forbidden（M11 起就用 ref 取最新禁用词），不再直接引用 style；
    //   留着 style 只会让 analyze 在每次档案变化时无谓重建（并可能把旧闭包传下去）。实际依赖只有 books/selectedId/genre。
    [books, selectedId, genre],
  )

  // 黑名单手动增删后立即持久化
  // H3：串行化 + 读最新 ref + 支持函数式更新——原来 `rec={...style, forbidden:list}` 基于闭包 style 快照、list 又由调用方
  //   从同一份快照算出；连点删两个词时第二次在首次 await put 完成前发起，整份覆写会把第一次删掉的词复活。
  //   改为：每次基于 styleRef.current（最新）算，且用 promise 队列串行执行（上一次落库完再跑下一次），并在 put 前同步 styleRef，
  //   使并发的下一次读到上一次的结果。nextOrUpdater 传函数时以最新 forbidden 为入参（调用方无需自己读快照）。
  //   队列用与 analyze 写回共享的 stylesQueueRef（L-新4），两条写 styles 的路径互不覆盖。
  const updateForbidden = useCallback((nextOrUpdater) => {
    const run = async () => {
      const base = styleRef.current
      if (!base) throw new Error('请先分析出文风档案，再管理禁用词。') // M18：无档案时明确报错，不静默吞掉用户输入
      const prevList = base.forbidden || []
      const list = typeof nextOrUpdater === 'function' ? nextOrUpdater(prevList) : nextOrUpdater
      const rec = { ...base, origin: 'user', forbidden: list, updatedAt: Date.now() }
      styleRef.current = rec // 同步先行：串行链里的下一次、以及分析写回(:148 读 styleRef)都能立刻看到最新
      try {
        await put('styles', rec)
      } catch (e) {
        // L-新1：put 失败（QuotaExceeded / 事务中止）时回滚 styleRef——否则这份没落库的 forbidden 会被下一次成功更新
        //   当作 base 悄悄写进库、也会被 analyze 写回时带入，等于「用户以为没加/没删的词其实进了档案」。回滚到本次操作前的 base。
        styleRef.current = base
        throw e
      }
      setStyle(rec)
      return rec
    }
    const p = stylesQueueRef.current.then(run, run) // 前一次无论成败都接着跑，不堵死队列
    stylesQueueRef.current = p.catch(() => {}) // 链不因单次失败而断
    return p // 返回真实 promise，调用方 await + catch 照常拿到错误提示
  }, [])

  const selectedBook = books.find((b) => b.id === selectedId) || null

  return {
    books,
    loading,
    loadError, // H2：透传 useBooks 的读取错误，Library 才能区分"真的没书"与"库打不开"（此前未透传→Library 拿到 undefined→仍显示"还没有小说"假陈述）
    importFile,
    createBookFromText, // 用户需求：从粘贴原文建书（续写页"分析原文"时若无选中书则自动建档+选中，资产才有归属）
    removeBook,
    refresh,
    syncBook, // P1-6：定点更新内存里那一本（commit 后用它替代全量 refresh）
    selectedId,
    selectedBook,
    select,
    style,
    analyzing,
    analyze,
    updateForbidden,
    genre,
    setGenre,
  }
}
