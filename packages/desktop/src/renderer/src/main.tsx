/** main.tsx — 渲染层入口：挂载 React 根节点与主题 Provider。 */

import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/tokens.common.css'
import './styles/tokens.dark.css'
import './styles/tokens.light.css'
import './styles/base.css'
import './styles/app.css'

const rootEl = document.getElementById('root')
if (!rootEl) {
  throw new Error('#root not found')
}

createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
