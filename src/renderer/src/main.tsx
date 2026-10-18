import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

const savedTheme = window.localStorage.getItem('arkive-theme')
document.documentElement.dataset.theme = savedTheme === 'night' ? 'night' : 'day'

const root = document.getElementById('root')
if (!root) throw new Error('Root element is missing')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
