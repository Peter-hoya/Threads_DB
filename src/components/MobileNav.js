'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_ITEMS = [
  { href: '/', icon: '📊', label: '대시보드' },
  { href: '/accounts', icon: '👤', label: '계정' },
  { href: '/templates', icon: '📝', label: '템플릿' },
  { href: '/posts', icon: '📮', label: '게시물' },
];

export default function MobileNav({ theme, onToggleTheme }) {
  const pathname = usePathname();

  return (
    <nav className="mobile-nav">
      {NAV_ITEMS.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={`mobile-nav__item${pathname === item.href ? ' active' : ''}`}
        >
          <span className="mobile-nav__icon">{item.icon}</span>
          <span className="mobile-nav__label">{item.label}</span>
        </Link>
      ))}
      <button className="mobile-nav__item" onClick={onToggleTheme}>
        <span className="mobile-nav__icon">{theme === 'dark' ? '☀️' : '🌙'}</span>
        <span className="mobile-nav__label">{theme === 'dark' ? '라이트' : '다크'}</span>
      </button>
    </nav>
  );
}
