import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// base 使用相对路径，部署到 Vercel / GitHub Pages 子路径均可正常加载资源
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
})
