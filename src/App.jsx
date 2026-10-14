import { useState } from 'react'
import Ic from './components/Ic.jsx'
import { writerProvider, setWriterProvider } from './lib/llm.js'
import RevisePage from './pages/RevisePage.jsx'
import WizardPage from './pages/WizardPage.jsx'
import ContinuePage from './pages/ContinuePage.jsx'
import LongFormPage from './pages/LongFormPage.jsx'
import ProfilePage from './pages/ProfilePage.jsx'
import RanksPage from './pages/RanksPage.jsx'

const TABS = [
  { id: 'revise', label: '改写润色', icon: 'pencil' },
  { id: 'continue', label: '续写', icon: 'book' },
  { id: 'longform', label: '长篇写作', icon: 'mountain' },
  { id: 'wizard', label: '新手写作', icon: 'sprout' },
  { id: 'ranks', label: '榜单', icon: 'flame' },
  { id: 'profile', label: '我的', icon: 'user' },
]

// M13：localStorage 读取包 try/catch——隐私模式/存储被禁用/配额满时 getItem 抛错会让 useState 初始化失败 → 整个 App 白屏(点导航都没反应)
const safeGetItem = (key) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export default function App() {
  // 记住上次停留的页签：中断/刷新后重进直接回到原页面，配合长篇页的书级恢复实现无缝续写
  const [tab, setTabState] = useState(() => safeGetItem('na_tab') || 'revise')
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
  const [provider, setProviderState] = useState(() => writerProvider())
  const changeProvider = (p) => {
    setWriterProvider(p)
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
          <nav className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
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
        {tab === 'revise' && <RevisePage apiKey={activeKey} onNeedKey={() => setTab('profile')} />}
        {tab === 'continue' && <ContinuePage apiKey={activeKey} onNeedKey={() => setTab('profile')} />}
        {/* LF-5：LongFormPage 已自管 Key 读取与缺 Key 引导，不再从 App 接收 apiKey/onNeedKey（A 区已改） */}
        {tab === 'longform' && <LongFormPage />}
        {tab === 'wizard' && <WizardPage onOpenLongForm={() => setTab('longform')} />}
        {tab === 'ranks' && <RanksPage />}
        {tab === 'profile' && <ProfilePage apiKey={apiKey} qwenKey={qwenKey} provider={provider} onProviderChange={changeProvider} onKeyChange={refreshKey} />}
      </main>
    </div>
  )
}
