import { useState } from 'react'
import Ic from './components/Ic.jsx'
import RevisePage from './pages/RevisePage.jsx'
import WizardPage from './pages/WizardPage.jsx'
import ContinuePage from './pages/ContinuePage.jsx'
import LongFormPage from './pages/LongFormPage.jsx'
import ProfilePage from './pages/ProfilePage.jsx'

const TABS = [
  { id: 'revise', label: '改写润色', icon: 'pencil' },
  { id: 'continue', label: '续写', icon: 'book' },
  { id: 'longform', label: '长篇写作', icon: 'mountain' },
  { id: 'wizard', label: '新手写作', icon: 'sprout' },
  { id: 'profile', label: '我的', icon: 'user' },
]

export default function App() {
  // 记住上次停留的页签：中断/刷新后重进直接回到原页面，配合长篇页的书级恢复实现无缝续写
  const [tab, setTabState] = useState(() => localStorage.getItem('na_tab') || 'revise')
  const setTab = (t) => {
    localStorage.setItem('na_tab', t)
    setTabState(t)
  }
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('ds_api_key') || '')
  const [glmKey, setGlmKey] = useState(() => localStorage.getItem('glm_api_key') || '')

  const refreshKey = () => setApiKey(localStorage.getItem('ds_api_key') || '')
  const refreshGlmKey = () => setGlmKey(localStorage.getItem('glm_api_key') || '')

  return (
    <div className="min-h-screen text-stone-800">
      <header className="sticky top-0 z-20 border-b border-stone-200/70 bg-[#fbf8ef]/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 py-3">
          <h1 className="flex shrink-0 items-center gap-2 text-lg font-bold tracking-wide">
            {/* 朱砂印章：产品的签名元素 */}
            <span
              aria-hidden
              className="flex h-8 w-8 rotate-[-3deg] items-center justify-center rounded-[0.3rem] bg-amber-600 text-base text-[#fbf8ef] shadow-sm"
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
        {tab === 'revise' && <RevisePage apiKey={apiKey} onNeedKey={() => setTab('profile')} />}
        {tab === 'continue' && <ContinuePage apiKey={apiKey} onNeedKey={() => setTab('profile')} onOpenLongForm={() => setTab('longform')} />}
        {tab === 'longform' && <LongFormPage apiKey={apiKey} glmKey={glmKey} onNeedKey={() => setTab('profile')} />}
        {tab === 'wizard' && <WizardPage apiKey={apiKey} onNeedKey={() => setTab('profile')} onOpenLongForm={() => setTab('longform')} />}
        {tab === 'profile' && <ProfilePage apiKey={apiKey} onKeyChange={refreshKey} glmKey={glmKey} onGlmKeyChange={refreshGlmKey} />}
      </main>
    </div>
  )
}
