'use client';

import { useEffect, useState } from 'react';

const STATUS_LABELS = {
  draft: '초안',
  queued: '대기',
  publishing: '발행 중',
  published: '완료',
  failed: '실패',
  cancelled: '취소',
};

function toKST(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function HomePage() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/stats')
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '대시보드를 불러오지 못했습니다.');
        setStats(data);
      })
      .catch((requestError) => setError(requestError.message));
  }, []);

  if (error) return <div className="notice notice--error">⚠️ {error}</div>;
  if (!stats) return <div className="loading-page"><div className="spinner" /></div>;

  const { counts, accountStats, recentPosts, configuration, heartbeat, jobs } = stats;
  const configurationReady = Object.values(configuration).every(Boolean);
  const workerFresh = heartbeat && Date.now() - new Date(heartbeat.lastSeenAt).getTime() < 180_000;

  return (
    <>
      <div className="page-header">
        <div>
          <h2>운영 대시보드</h2>
          <p>공식 Threads API 승인형 발행 시스템</p>
        </div>
      </div>

      {!configurationReady && (
        <div className="notice notice--info">
          계정 API 연결 전 준비 단계입니다. 아래 설정 상태에서 미완료 항목을 채운 뒤 계정을 OAuth로 연결하세요.
        </div>
      )}

      {counts.needsReconciliation > 0 && (
        <div className="notice notice--error">
          외부 발행 결과를 직접 확인해야 하는 게시물이 {counts.needsReconciliation}건 있습니다. 자동 재시도는 중지된 상태입니다. <a href="/posts">게시물 관리에서 조정</a>
        </div>
      )}

      <div className="stats-grid">
        <div className="stat-card"><div className="label">📝 초안</div><div className="value">{counts.draft}</div><div className="sub">사람 검토 필요</div></div>
        <div className="stat-card"><div className="label">⏳ 승인·대기</div><div className="value" style={{ color: 'var(--warning)' }}>{counts.queued}</div><div className="sub">작업 큐 {jobs.queued || 0}건</div></div>
        <div className="stat-card"><div className="label">✅ 발행 완료</div><div className="value" style={{ color: 'var(--success)' }}>{counts.published}</div><div className="sub">누적 {counts.total}건 중</div></div>
        <div className="stat-card"><div className="label">❌ 실패</div><div className="value" style={{ color: 'var(--error)' }}>{counts.failed}</div><div className="sub">조정 {counts.needsReconciliation || 0} · dead job {jobs.dead || 0}</div></div>
      </div>

      <div className="dashboard-panels">
        <section className="card">
          <div className="card-header"><h3>설정 상태</h3></div>
          <div className="check-list">
            {[
              ['관리자 인증', configuration.dashboardAuth],
              ['토큰 암호화 키', configuration.tokenEncryption],
              ['Meta OAuth 앱', configuration.metaOAuth],
              ['Supabase 미디어', configuration.supabase],
              ['VPS 워커', workerFresh],
            ].map(([label, ready]) => (
              <div className="check-list__item" key={label}>
                <span>{ready ? '✅' : '◻️'}</span>
                <span>{label}</span>
                <strong>{ready ? '준비됨' : '설정 필요'}</strong>
              </div>
            ))}
          </div>
          <p className="muted-text" style={{ marginTop: '12px' }}>
            {heartbeat ? `마지막 워커 신호 ${toKST(heartbeat.lastSeenAt)}` : '아직 VPS 워커 신호가 없습니다.'}
          </p>
        </section>

        <section className="card">
          <div className="card-header"><h3>계정별 운영 상태</h3></div>
          <div className="account-status-list">
            {accountStats.map((account) => (
              <div className="account-status-row" key={account.id}>
                <div>
                  <strong>{account.name}</strong>
                  <p>{account.role === 'primary' ? '수동 본계정' : '승인형 자동화'} · 게시물 {account.postCount}건</p>
                </div>
                <div className="account-status-row__badges">
                  <span className={`badge ${account.connected ? 'badge--published' : 'badge--failed'}`}>{account.connected ? 'API 연결' : 'API 미연결'}</span>
                  {account.role !== 'primary' && <span className={`badge ${account.postingEnabled ? 'badge--published' : 'badge--cancelled'}`}>{account.postingEnabled ? '발행 허용' : '발행 정지'}</span>}
                </div>
              </div>
            ))}
            {accountStats.length === 0 && <div className="empty-state"><p>등록된 계정이 없습니다.</p></div>}
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-header"><h3>최근 활동</h3></div>
        <div className="timeline">
          {recentPosts.map((post) => (
            <div className="timeline-item" key={post.id}>
              <div className="dot" style={{ background: post.status === 'published' ? 'var(--success)' : post.status === 'failed' ? 'var(--error)' : 'var(--warning)' }} />
              <div>
                <div className="post-card__meta">
                  <span className={`badge badge--${post.status}`}>{STATUS_LABELS[post.status] || post.status}</span>
                  <strong>{post.account}</strong>
                </div>
                <p style={{ marginTop: '5px', color: 'var(--text-secondary)' }}>{post.content}{post.content.length >= 60 ? '…' : ''}</p>
                <div className="time">{toKST(post.updatedAt)}</div>
                {post.error && <div className="field-error">{post.error}</div>}
              </div>
            </div>
          ))}
          {recentPosts.length === 0 && <div className="empty-state"><p>최근 활동이 없습니다.</p></div>}
        </div>
      </section>
    </>
  );
}
