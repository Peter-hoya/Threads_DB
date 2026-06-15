'use client';
import './globals.css';
import { useState, useEffect, useCallback } from 'react';
import Sidebar from '@/components/Sidebar';
import Toast from '@/components/Toast';

export default function RootLayout({ children }) {
  const [theme, setTheme] = useState('light');
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    const saved = localStorage.getItem('theme') || 'light';
    setTheme(saved);
    document.documentElement.setAttribute('data-theme', saved);
  }, []);

  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
  };

  const addToast = useCallback((message, type = 'info') => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <html lang="ko" data-theme={theme}>
      <head>
        <title>ThreadsHub - 자동발행 관리 대시보드</title>
        <meta name="description" content="Threads/X 자동발행 관리 대시보드" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body>
        <div className="app-layout">
          <Sidebar theme={theme} onToggleTheme={toggleTheme} />
          <main className="main-content">
            {typeof children === 'function' ? children({ addToast }) : children}
          </main>
        </div>
        <Toast toasts={toasts} onDismiss={dismissToast} />
      </body>
    </html>
  );
}
