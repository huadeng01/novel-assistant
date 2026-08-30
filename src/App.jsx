import { useState } from 'react'
import RevisePage from './pages/RevisePage.jsx'
import WizardPage from './pages/WizardPage.jsx'
import ContinuePage from './pages/ContinuePage.jsx'
import ProfilePage from './pages/ProfilePage.jsx'

const TABS = [
  { id: 'revise', label: '改写润色', icon: '✏️' },
  { id: 'continue', label: '续写', icon: '📖' },
  { id: 'wizard', label: '新手写作', icon: '🌱' },
  { id: 'profile', label: '我的', icon: '👤' },
]

export default function App() {
  const [tab, setTab] = useState('revise')
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('ds_api_key') || '')

  const refreshKey = () => setApiKey(localStorage.getItem('ds_api_key') || '')

  return (
    <div className="min-h-screen text-stone-800">
      <header className="sticky top-0 z-20 border-b border-stone-200/70 bg-[#fffaf6]/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 py-3">
          <h1 className="shrink-0 text-lg font-bold tracking-wide">
            🍡 墨语<span className="ml-1 hidden text-sm font-normal text-stone-400 sm:inline">AI 小说写作助手</span>
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
                <span className="mr-1">{t.icon}</span>
                <span className="hidden sm:inline">{t.label}</span>
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 pb-16">
        {tab === 'revise' && <RevisePage apiKey={apiKey} onNeedKey={() => setTab('profile')} />}
        {tab === 'continue' && <ContinuePage apiKey={apiKey} onNeedKey={() => setTab('profile')} />}
        {tab === 'wizard' && <WizardPage apiKey={apiKey} onNeedKey={() => setTab('profile')} />}
        {tab === 'profile' && <ProfilePage apiKey={apiKey} onKeyChange={refreshKey} />}
      </main>
    </div>
  )
}
