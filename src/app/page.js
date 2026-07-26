'use client';
import { useState, useEffect } from 'react';

function toKST(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function HomePage() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/stats')
      .then((r) => r.json())
      .then(setStats)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading-page"><div className="spinner" /></div>;
  if (!stats) return <div className="empty-state"><p>데이터를 불러올 수 없습니다.</p></div>;

  const { counts, accountStats, platformStats, recentPosts } = stats;
  const maxPlatform = Math.max(...platformStats.map((p) => p.count), 1);

  return (
    <>
      <div className="page-header">
        <div>
          <h2>대시보드</h2>
          <p>Threads/X 자동발행 시스템 현황</p>
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="label">📦 전체 게시물</div>
          <div className="value">{counts.total}</div>
          <div className="sub">누적 등록 콘텐츠</div>
        </div>
        <div className="stat-card">
          <div className="label">⏳ 대기 중</div>
          <div className="value" style={{ color: 'var(--warning)' }}>{counts.pending}</div>
          <div className="sub">발행 예정</div>
        </div>
        <div className="stat-card">
          <div className="label">✅ 발행 완료</div>
          <div className="value" style={{ color: 'var(--success)' }}>{counts.published}</div>
          <div className="sub">{counts.total > 0 ? Math.round((counts.published / counts.total) * 100) : 0}% 완료율</div>
        </div>
        <div className="stat-card">
          <div className="label">❌ 실패</div>
          <div className="value" style={{ color: 'var(--error)' }}>{counts.failed}</div>
          <div className="sub">재시도 필요</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '28px' }}>
        {/* 계정별 현황 */}
        <div className="card">
          <div className="card-header"><h3>👤 계정별 현황</h3></div>
          {accountStats.length === 0 ? (
            <div className="empty-state"><p>등록된 계정이 없습니다.</p></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {accountStats.map((a) => (
                <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: 'var(--bg-input)', borderRadius: 'var(--radius-md)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '15px' }}>{a.name}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      게시물 {a.postCount}개 · 템플릿 {a.templateCount}개
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <span className="badge badge--published">✅ {a.byStatus.published}</span>
                    <span className="badge badge--pending">⏳ {a.byStatus.pending}</span>
                    {a.byStatus.failed > 0 && <span className="badge badge--failed">❌ {a.byStatus.failed}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 발행 큐 현황 */}
        <div className="card">
          <div className="card-header"><h3>📦 발행 큐 현황</h3></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {/* 플랫폼별 대기 수 */}
            <div style={{ display: 'flex', gap: '12px' }}>
              {platformStats.map((p) => {
                const pendingCount = accountStats.reduce((sum, a) => sum + (a.byPlatform?.[p.platform] || 0), 0);
                return (
                  <div key={p.platform} style={{
                    flex: 1, padding: '14px', background: 'var(--bg-input)', borderRadius: 'var(--radius-md)',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px',
                  }}>
                    <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>
                      {p.platform === 'threads' ? 'Threads' : 'X'}
                    </span>
                    <span style={{ fontSize: '24px', fontWeight: 800 }}>{p.count}</span>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>전체</span>
                  </div>
                );
              })}
              {platformStats.length === 0 && (
                <div style={{ flex: 1, textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontSize: '13px' }}>
                  등록된 게시물이 없습니다.
                </div>
              )}
            </div>
            {/* 대기 중 요약 */}
            <div style={{
              padding: '12px 16px', borderRadius: 'var(--radius-md)',
              background: counts.pending > 0 ? 'var(--warning-bg)' : 'var(--success-bg)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: counts.pending > 0 ? 'var(--warning)' : 'var(--success)' }}>
                {counts.pending > 0 ? `⏳ ${counts.pending}건 발행 대기 중` : '✅ 모든 게시물 발행 완료'}
              </span>
              {counts.pending > 0 && (
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  오픈클로 cron으로 자동 발행
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '20px', marginBottom: '28px' }}>
        {/* 플랫폼별 분포 */}
        <div className="card">
          <div className="card-header"><h3>📱 플랫폼별 분포</h3></div>
          <div className="bar-chart">
            {platformStats.map((p) => (
              <div className="bar-row" key={p.platform}>
                <div className="bar-label">{p.platform === 'threads' ? 'Threads' : 'X'}</div>
                <div className="bar-track">
                  <div
                    className="bar-fill"
                    style={{
                      width: `${Math.max((p.count / maxPlatform) * 100, 12)}%`,
                      background: p.platform === 'threads' ? 'linear-gradient(90deg,#000,#333)' : 'linear-gradient(90deg,#1d9bf0,#60b8f6)',
                    }}
                  >
                    {p.count}개
                  </div>
                </div>
              </div>
            ))}
            {platformStats.length === 0 && <div className="empty-state"><p>데이터가 없습니다.</p></div>}
          </div>
        </div>
      </div>

      {/* 최근 활동 */}
      <div className="card">
        <div className="card-header"><h3>🕐 최근 활동</h3></div>
        {recentPosts.length === 0 ? (
          <div className="empty-state"><p>최근 활동이 없습니다.</p></div>
        ) : (
          <div className="timeline">
            {recentPosts.map((p) => (
              <div className="timeline-item" key={p.id}>
                <div className="dot" style={{
                  background: p.status === 'published' ? 'var(--success)' : p.status === 'failed' ? 'var(--error)' : 'var(--warning)',
                }} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span className={`badge badge--${p.platform === 'threads' ? 'threads' : 'x'}`}>{p.platform === 'threads' ? 'Threads' : 'X'}</span>
                    <span className={`badge badge--${p.status}`}>{p.status}</span>
                    <span style={{ fontSize: '13px', fontWeight: 600 }}>{p.account}</span>
                  </div>
                  <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>{p.content}...</div>
                  <div className="time">{toKST(p.updatedAt)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
