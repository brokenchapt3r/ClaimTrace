import React from 'react';
import ReactDOM from 'react-dom/client';
import './global.less';
import HomePage from './pages/home';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HomePage />
  </React.StrictMode>,
);
