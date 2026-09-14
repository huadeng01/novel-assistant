import { defineConfig } from 'vitest/config'

// 独立的测试配置：不加载 vite.config.js 里的 react / tailwindcss 插件。
// 本项目的单测只覆盖 src/lib 下的纯函数（详纲解析、越界监管、世界观拼装、上下文精简选项），
// 不渲染组件、不碰 DOM，node 环境即可，省掉插件链的启动开销。
// 单独放一个文件而不是往 vite.config.js 里加 test 段：构建产物不需要测试配置，两者解耦后互不影响。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
    // 纯函数测试应当是毫秒级的；超过这个时间说明有函数在偷偷做 IO 或退化成指数复杂度
    testTimeout: 10000,
  },
})
