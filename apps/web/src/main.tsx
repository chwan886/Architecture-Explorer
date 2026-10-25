import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import '@xyflow/react/dist/style.css';
import './styles.css';
import './workspace-navigation.css';
import './architecture/architecture.css';
import './semantics/semantic.css';
import './control/control.css';
import './control/floating-progress.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
