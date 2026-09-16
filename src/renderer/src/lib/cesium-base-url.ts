// 必须在导入 cesium 之前执行，Cesium 在模块初始化时读取该变量来定位
// Assets / Workers / Widgets 等运行时资源。
//
// 不能写在 index.html 的内联 <script> 里：CSP 的 script-src 'self' 会拦截内联脚本。
// 因此改用副作用模块，并在 MapView 中作为第一个 import 引入。
declare global {
  interface Window {
    CESIUM_BASE_URL?: string
  }
}

// vitest 运行在 node 环境，没有 window；守卫后 MapView 的静态渲染测试才能通过
if (typeof window !== 'undefined') window.CESIUM_BASE_URL = './cesium/'

export {}
