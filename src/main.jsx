// 应用入口：挂载 React 根、引入全局样式。StrictMode 只在开发期双跑 effect，用于暴露副作用问题。
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
