// 章节审核面板：每写满 5 章解锁一次审核机会，由智谱 GLM 审核最近 5 章的剧情连贯性
//（只查硬性矛盾，明确禁止挑刺）；不通过时给出按章绑定的修改提示词，
// 一键修改复用 ChapterRewriter（DeepSeek 定向重写 + 预览确认后替换回已保存正文）。
import { useState } from 'react'
import { glmChatJSON } from '../lib/llm.js'
import { chapterReviewMessages } from '../lib/prompts.js'
import { REVIEW_WINDOW, reviewOpportunity, buildReviewInput, applyReview, dismissReview } from '../lib/longform.js'
import ChapterRewriter from './ChapterRewriter.jsx'
import Ic from './Ic.jsx'

export default function ReviewPanel({ project, saveProject, apiKey, glmKey, onNeedGlmKey, busy: globalBusy }) {
  const [reviewing, setReviewing] = useState(false)
  const [err, setErr] = useState('')

  const opp = reviewOpportunity(project)
  const current = project.review?.current
  const showResult = current && !current.dismissed
  const busy = globalBusy || reviewing

  // 执行审核：消耗一次机会，结果落库（刷新不丢）
  const runReview = async () => {
    if (!glmKey) return onNeedGlmKey?.()
    if (!opp.available) return
    setErr('')
    setReviewing(true)
    try {
      const input = buildReviewInput(project)
      let res
      try {
        res = await glmChatJSON({ apiKey: glmKey, messages: chapterReviewMessages(input), temperature: 0.2 })
      } catch (e) {
        // GLM 输出格式不稳时降温度重试一次
        if (/格式/.test(e.message)) res = await glmChatJSON({ apiKey: glmKey, messages: chapterReviewMessages(input), temperature: 0.1 })
        else throw e
      }
      await saveProject(applyReview(project, res))
    } catch (e) {
      setErr(e.message)
    } finally {
      setReviewing(false)
    }
  }

  const fixed = current?.fixed || []

  return (
    <section className="rounded-2xl bg-[#fbf8ef] p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold"><Ic n="search" /> 章节审核（GLM-4.7-Flash）</h2>
          <p className="mt-1 text-xs leading-relaxed text-stone-400">
            每写满 {REVIEW_WINDOW} 章解锁一次审核：严格对照世界观、时间线与前文连贯性，只查硬性矛盾（设定冲突 /
            时间线矛盾 / 人物矛盾 / 剧情断裂 / 伏笔误处理），不挑文风。
          </p>
        </div>
        <button
          onClick={runReview}
          disabled={busy || !opp.available}
          className="rounded-full bg-stone-800 px-5 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
        >
          {reviewing ? 'GLM 审核中…' : opp.available ? `开始审核（窗口：最近 ${REVIEW_WINDOW} 章）` : opp.written < REVIEW_WINDOW ? `再写 ${opp.toNext} 章解锁审核` : '暂无审核机会'}
        </button>
      </div>

      {!glmKey && (
        <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800">
          审核需要智谱 GLM API Key，请到「我的」页面填写（免费额度即可）。
        </p>
      )}
      {err && <p className="mt-3 rounded-xl bg-red-50 px-4 py-2.5 text-xs text-red-700">{err}</p>}

      {/* 当前审核结果 */}
      {showResult && (
        <div className="mt-4 space-y-3">
          <div className={`rounded-xl p-3 ${current.pass && !current.suggestions.length ? 'bg-emerald-50' : 'bg-amber-50'}`}>
            <p className={`text-xs font-semibold ${current.pass && !current.suggestions.length ? 'text-emerald-700' : 'text-amber-700'}`}>
              {current.pass && !current.suggestions.length ? <><Ic n="ok" /> 审核通过</> : <><Ic n="alert" /> 发现连贯性问题</>}
              <span className="ml-1 font-normal opacity-70">（审核窗口：截至第 {current.windowEnd} 章的最近 {REVIEW_WINDOW} 章）</span>
            </p>
            <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-stone-600">{current.analysis}</p>
          </div>

          {/* 按章拆分的修改建议卡 */}
          {current.suggestions.map((s, i) => {
            const done = fixed.includes(s.chapterNo)
            const target = (project.chapters || []).find((c) => c.chapterNo === s.chapterNo)
            return (
              <div key={i} className={`rounded-xl border p-3 ${done ? 'border-emerald-200 bg-emerald-50/50' : 'border-stone-200 bg-white'}`}>
                <p className="text-sm font-semibold text-stone-700">
                  第 {s.chapterNo} 章{target ? `《${target.title}》` : '（该章不存在，请核对章号）'}
                  {done && <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-normal text-emerald-700"><Ic n="ok" /> 已修复</span>}
                </p>
                <p className="mt-2 text-xs leading-relaxed text-stone-600">
                  <span className="font-medium text-red-600">问题：</span>
                  {s.problem}
                </p>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-stone-500 hover:text-stone-700">查看修改提示词（可复制到任意 AI 使用）</summary>
                  <p className="mt-2 whitespace-pre-wrap rounded-lg bg-stone-50 p-3 text-xs leading-relaxed text-stone-600">{s.fixPrompt}</p>
                </details>
                {!done && target && (
                  <div className="mt-3">
                    <ChapterRewriter
                      project={project}
                      saveProject={saveProject}
                      apiKey={apiKey}
                      chapterNo={s.chapterNo}
                      fixPrompt={s.fixPrompt}
                      label={`一键修改第 ${s.chapterNo} 章`}
                      disabled={busy || !apiKey}
                    />
                  </div>
                )}
              </div>
            )
          })}

          {/* 安全阀：放弃建议，绝不阻塞写作 */}
          {current.suggestions.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => saveProject(dismissReview(project))}
                disabled={busy}
                className="rounded-full border border-red-200 px-4 py-1.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                <Ic n="ban" /> 放弃全部修改建议（直接继续写作）
              </button>
              <p className="text-xs text-stone-400">放弃后不影响继续写下一章；已修复的章节不受影响。</p>
            </div>
          )}
        </div>
      )}

      {/* 无待处理审核时的状态提示 */}
      {!showResult && !reviewing && (
        <p className="mt-3 text-xs text-stone-400">
          {current?.dismissed
            ? '上次审核建议已放弃。'
            : opp.available
              ? `当前有 1 次审核机会，审核窗口为最近 ${REVIEW_WINDOW} 章。`
              : `已写 ${opp.written} 章；写满 ${REVIEW_WINDOW} 章的整数倍时解锁下一次审核。`}
        </p>
      )}
    </section>
  )
}
