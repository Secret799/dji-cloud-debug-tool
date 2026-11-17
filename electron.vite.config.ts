import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

// 开发期放宽 script-src：Vite 的依赖预打包会把整个 `cesium` 入口一起求值，
// 而该入口会 re-export @cesium/widgets，后者内嵌的 knockout 在模块顶层执行
// `(0, eval)("this")`。这一句被 CSP 的 script-src 拦下后抛 EvalError，
// React 根本挂不上，表现为整窗白屏。
//
// 生产构建不受影响：rollup 会 tree-shake 掉未使用的 widgets（实测产物中
// `0,eval` 出现 0 次），所以 CSP 只在 dev 放宽，线上仍是 'self' + 'wasm-unsafe-eval'。
const devCspRelax = (): Plugin => ({
  name: 'dji-dev-csp-relax',
  apply: 'serve',
  transformIndexHtml: (html) => {
    const strict = "script-src 'self' 'wasm-unsafe-eval'"
    if (!html.includes(strict)) {
      throw new Error(
        `devCspRelax 未匹配到 script-src：${strict}。`
        + '若 CSP 有变动，请同步更新 electron.vite.config.ts 中的 devCspRelax。',
      )
    }
    return html.replace(strict, `${strict} 'unsafe-eval'`)
  },
})

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
    plugins: [react(), devCspRelax()],
  },
})
