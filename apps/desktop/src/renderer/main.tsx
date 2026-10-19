import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import './shell.css'
import { App } from './App'
import { startApp } from './lib/sync'

// The application lifecycle (runtime connection, restore, event subscription) runs outside React, so
// it is started exactly once per page – also under StrictMode, which mounts components twice in dev.
startApp()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
