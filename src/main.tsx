import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app/App';
import { installTooltips } from './lib/tooltip';
import './styles/global.css';

installTooltips();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
