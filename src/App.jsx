import { Component, useState } from 'react'
import Ic from './components/Ic.jsx'
import { setWriterProvider } from './lib/llm.js'
import RevisePage from './pages/RevisePage.jsx'
import WizardPage from './pages/WizardPage.jsx'
import ContinuePage from './pages/ContinuePage.jsx'
import LongFormPage from './pages/LongFormPage.jsx'
import ProfilePage from './pages/ProfilePage.jsx'
import RanksPage from './pages/RanksPage.jsx'
import { safeGetItem } from './lib/utils.js' // B27：localStorage 容错读单一出处（原本页留一份多行副本、llm.js 留一份单行副本，已统一下沉 utils.js）

const TABS = [
  { id: 'revise', label: '改写润色', icon: 'pencil' },
  { id: 'continue', label: '续写', icon: 'book' },
  { id: 'longform', label: '长篇写作', icon: 'mountain' },
  { id: 'wizard', label: '新手写作', icon: 'sprout' },
  { id: 'ranks', label: '榜单', icon: 'flame' },
  { id: 'profile', label: '我的', icon: 'user' },
]

// P1-7：页面级错误边界——任一页 render 抛错时，原来会整站白屏(连同顶部导航一起没)，用户未落库的编辑全丢且无从恢复。
//   这里只包住 <main> 里的页面内容(导航栏留在边界外仍可点)，出错时给兜底 UI + 一键回改写页；切 tab 时 key 变化会重挂载自动清错。
class PageErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="mx-auto max-w-md rounded-2xl border border-red-200 bg-red-50 p-6 text-center">
        <p className="text-sm font-bold text-red-700">这一页出错了</p>
        <p className="mt-2 text-xs leading-relaxed text-red-600">
          页面渲染时遇到意外错误。未落库的编辑可能已丢失，但已保存的小说、文风档案与草稿都还在本机，不受影响。
        </p>
        <button
          onClick={() => {
            this.setState({ error: null })
            if (this.props.onRecover) this.props.onRecover()
          }}
          className="mt-4 rounded-full bg-stone-800 px-5 py-2 text-sm font-medium text-white hover:bg-stone-700"
        >
          回到改写润色页
        </button>
      </div>
    )
  }
}

export default function App() {
  // 记住上次停留的页签：中断/刷新后重进直接回到原页面，配合长篇页的书级恢复实现无缝续写
  // #3：持久化的 tab id 可能是脏值(旧版页签名 / 手改 localStorage)→ 首屏匹配不到任何页、整页空白；用 TABS 白名单校验，脏值回落 'revise'
  const [tab, setTabState] = useState(() => {
    const t = safeGetItem('na_tab')
    return TABS.some((x) => x.id === t) ? t : 'revise'
  })
  // M-J：错误边界恢复用的重挂载计数——恢复时 +1，让 boundary 的 key 变化强制重挂载子树。
  //   原来 key={tab}、恢复只 setTab('revise')：若出错时就在 revise，tab 不变→key 不变→不重挂载，子树立刻再抛同错、恢复按钮像失效。
  const [remountN, setRemountN] = useState(0)
  const setTab = (t) => {
    // L16：localStorage 写入在隐私模式/存储被禁用/配额满时会抛错；若不保护，抛错会让后面的 setTabState 不执行 → 点导航栏页签完全没反应(界面像卡死)
    try {
      localStorage.setItem('na_tab', t)
    } catch {
      /* 记忆失败不影响本次切换 */
    }
    setTabState(t)
  }
  const [apiKey, setApiKey] = useState(() => safeGetItem('ds_api_key') || '')
  const [qwenKey, setQwenKey] = useState(() => safeGetItem('qwen_api_key') || '')

  const refreshKey = () => {
    setApiKey(safeGetItem('ds_api_key') || '')
    setQwenKey(safeGetItem('qwen_api_key') || '')
  }
  // 写作引擎（DeepSeek / 通义千问）选择状态；下发给各页面的 Key 始终对应当前选中的引擎，缺 Key 引导也自然指向对应引擎。
  // #2：writerProvider()(llm.js) 内部裸读 localStorage，隐私模式抛错→整站白屏；App 侧改用已包 try/catch 的 safeGetItem 判定初始引擎(llm.js 内部裸读属 B 区，报告标注转 B)
  // 决策3：默认引擎改为通义千问（项目主引擎 qwen3.8-max）——只有用户显式存过 'deepseek' 才回落 DeepSeek，其余(含首次/无存储)默认 qwen。
  // C3（审计轮5 记接受、不改）：引擎「真值」存在两份——App 的 provider state（下发 activeKey 给各页）与 llm.js writerConfig() 内部裸读 localStorage。
  //   正常情况两者一致（changeProvider 同时 setWriterProvider + setProviderState）；仅在隐私模式/配额满致 setWriterProvider 写失败时可能短暂分叉，属可接受边缘，不额外同步。
  const [provider, setProviderState] = useState(() => (safeGetItem('writer_provider') === 'deepseek' ? 'deepseek' : 'qwen'))
  const changeProvider = (p) => {
    try {
      setWriterProvider(p)
    } catch {
      /* 存储不可用：本次会话仍切换，只是刷新不记住 */
    }
    setProviderState(p)
  }
  const activeKey = provider === 'qwen' ? qwenKey : apiKey

  return (
    <div className="min-h-screen text-ink">
      <header className="sticky top-0 z-20 glass border-b border-stone-200/70 bg-paper/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 py-3">
          <h1 className="flex shrink-0 items-center gap-2 text-lg font-bold tracking-wide">
            {/* 朱砂印章：产品的签名元素 */}
            <span
              aria-hidden
              className="flex h-8 w-8 rotate-[-3deg] items-center justify-center rounded-[0.3rem] bg-amber-600 text-base text-paper shadow-sm"
            >
              墨
            </span>
            墨语<span className="ml-1 hidden text-sm font-normal text-stone-400 sm:inline">AI 小说写作助手</span>
          </h1>
          <nav className="flex gap-1" aria-label="主导航">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                aria-current={tab === t.id ? 'page' : undefined}
                className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                  tab === t.id ? 'bg-stone-800 text-white' : 'text-stone-600 hover:bg-stone-100'
                }`}
              >
                <Ic n={t.icon} className="mr-1" />
                <span className="hidden sm:inline">{t.label}</span>
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 pb-16">
        <PageErrorBoundary key={`${tab}:${remountN}`} onRecover={() => { setTab('revise'); setRemountN((n) => n + 1) }}>
          {tab === 'revise' && <RevisePage apiKey={activeKey} onNeedKey={() => setTab('profile')} />}
          {tab === 'continue' && <ContinuePage apiKey={activeKey} onNeedKey={() => setTab('profile')} />}
          {/* LF-5：LongFormPage 已自管 Key 读取与缺 Key 引导，不再从 App 接收 apiKey/onNeedKey（A 区已改） */}
          {tab === 'longform' && <LongFormPage />}
          {tab === 'wizard' && <WizardPage onOpenLongForm={() => setTab('longform')} />}
          {tab === 'ranks' && <RanksPage />}
          {tab === 'profile' && <ProfilePage apiKey={apiKey} qwenKey={qwenKey} provider={provider} onProviderChange={changeProvider} onKeyChange={refreshKey} />}
        </PageErrorBoundary>
      </main>
    </div>
  )
}
