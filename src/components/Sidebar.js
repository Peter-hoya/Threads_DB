'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_ITEMS = [
  { href: '/', icon: '📊', label: '대시보드' },
  { href: '/accounts', icon: '👤', label: '계정 관리' },
  { href: '/templates', icon: '📝', label: '템플릿 관리' },
  { href: '/posts', icon: '📮', label: '게시물 관리' },
];

export default function Sidebar({ theme, onToggleTheme }) {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <h1>ThreadsHub</h1>
        <p>자동발행 관리 대시보드</p>
      </div>
      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`sidebar-link${pathname === item.href ? ' active' : ''}`}
          >
            <span className="icon">{item.icon}</span>
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="sidebar-footer">
        <button className="theme-toggle" onClick={onToggleTheme}>
          <span>{theme === 'dark' ? '☀️' : '🌙'}</span>
          {theme === 'dark' ? '라이트 모드' : '다크 모드'}
        </button>
      </div>
    </aside>
  );
}
