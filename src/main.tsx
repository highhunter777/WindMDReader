import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/index.css';
import { preloadSanitizer } from './renderer/enhance';

// 启动即并行下载 DOMPurify 动态 chunk:首篇文档渲染(清洗)时通常已命中缓存
preloadSanitizer();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
