'use client';
import { useState, useEffect, useCallback } from 'react';
import Modal from '@/components/Modal';

function toKST(dateStr) {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const STATUS_LABELS = { pending: '⏳ 대기', scheduled: '📅 예약', published: '✅ 완료', failed: '❌ 실패' };

export default function PostsPage() {
  const [posts, setPosts] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState('');
  const [accountFilter, setAccountFilter] = useState('');
  const [platformFilter, setPlatformFilter] = useState('');

  // Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ accountId: '', platform: 'threads', content: '', scheduledAt: '' });

  const fetchPosts = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), limit: '12' });
    if (statusFilter) params.set('status', statusFilter);
    if (accountFilter) params.set('accountId', accountFilter);
    if (platformFilter) params.set('platform', platformFilter);
    const res = await fetch(`/api/posts?${params}`);
    const data = await res.json();
    setPosts(data.posts || []);
    setTotal(data.total || 0);
    setTotalPages(data.totalPages || 1);
    setLoading(false);
  }, [page, statusFilter, accountFilter, platformFilter]);

  useEffect(() => { fetchPosts(); }, [fetchPosts]);
  useEffect(() => {
    fetch('/api/accounts').then((r) => r.json()).then(setAccounts);
  }, []);

  const handleSubmit = async () => {
    const url = editingId ? `/api/posts/${editingId}` : '/api/posts';
    const method = editingId ? 'PATCH' : 'POST';
    const body = { ...form };
    if (!body.scheduledAt) delete body.scheduledAt;
    await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    setModalOpen(false);
    setEditingId(null);
    fetchPosts();
  };

  const handleDelete = async (id) => {
    if (!confirm('이 게시물을 삭제하시겠습니까?')) return;
    await fetch(`/api/posts/${id}`, { method: 'DELETE' });
    fetchPosts();
  };

  const handlePublish = async (id) => {
    if (!confirm('이 게시물을 지금 Threads에 발행하시겠습니까?\n(약 30초 소요)')) return;
    setPublishing(id);
    try {
      const res = await fetch(`/api/posts/${id}/publish`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        alert('✅ 발행 성공!');
      } else {
        alert(`❌ 발행 실패: ${data.error}`);
      }
    } catch (e) {
      alert(`❌ 오류: ${e.message}`);
    }
    setPublishing(null);
    fetchPosts();
  };

  const handleEdit = (p) => {
    setEditingId(p.id);
    setForm({
      accountId: String(p.accountId),
      platform: p.platform,
      content: p.content,
      scheduledAt: p.scheduledAt ? new Date(p.scheduledAt).toISOString().slice(0, 16) : '',
    });
    setModalOpen(true);
  };

  const openNewModal = () => {
    setEditingId(null);
    setForm({ accountId: accounts[0]?.id?.toString() || '', platform: 'threads', content: '', scheduledAt: '' });
    setModalOpen(true);
  };

  if (loading) return <div className="loading-page"><div className="spinner" /></div>;

  return (
    <>
      <div className="page-header">
        <div><h2>게시물 관리</h2><p>총 {total}개 게시물</p></div>
        <button className="btn btn--primary" onClick={openNewModal}>+ 새 게시물</button>
      </div>

      {/* Tabs */}
      <div className="tabs">
        {[{ label: '전체', value: '' }, { label: '⏳ 대기', value: 'pending' }, { label: '📅 예약', value: 'scheduled' }, { label: '✅ 완료', value: 'published' }, { label: '❌ 실패', value: 'failed' }].map((t) => (
          <button key={t.value} className={`tab${statusFilter === t.value ? ' active' : ''}`}
            onClick={() => { setStatusFilter(t.value); setPage(1); }}>{t.label}</button>
        ))}
      </div>

      {/* Filters */}
      <div className="filter-bar">
        <select className="form-select" value={accountFilter} onChange={(e) => { setAccountFilter(e.target.value); setPage(1); }}>
          <option value="">전체 계정</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.accountName}</option>)}
        </select>
        <select className="form-select" value={platformFilter} onChange={(e) => { setPlatformFilter(e.target.value); setPage(1); }}>
          <option value="">전체 플랫폼</option>
          <option value="threads">Threads</option>
          <option value="x">X</option>
        </select>
      </div>

      {/* Posts Grid */}
      <div className="card-grid">
        {posts.map((p) => (
          <div className="post-card" key={p.id}>
            <div className="post-card__meta">
              <span className={`badge badge--${p.platform === 'threads' ? 'threads' : 'x'}`}>
                {p.platform === 'threads' ? 'Threads' : 'X'}
              </span>
              <span className={`badge badge--${p.status}`}>
                {STATUS_LABELS[p.status] || p.status}
              </span>
              <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>
                {p.account?.accountName}
              </span>
              {p.template && (
                <span style={{ fontSize: '11px', background: 'var(--accent-light)', color: 'var(--accent)', padding: '2px 6px', borderRadius: '4px' }}>
                  {p.template.templateCode}
                </span>
              )}
            </div>
            <div className="post-card__content">{p.content}</div>
            <div className="post-card__footer">
              <div className="post-card__time">
                {p.publishedAt ? `발행: ${toKST(p.publishedAt)}` : p.scheduledAt ? `예약: ${toKST(p.scheduledAt)}` : `등록: ${toKST(p.createdAt)}`}
                {p.errorMessage && <div style={{ color: 'var(--error)', fontSize: '11px', marginTop: '2px' }}>⚠️ {p.errorMessage.substring(0, 60)}</div>}
              </div>
              <div className="post-card__actions">
                {p.status !== 'published' && p.platform === 'threads' && (
                  <button className="btn btn--success btn--sm" onClick={() => handlePublish(p.id)}
                    disabled={publishing === p.id}>
                    {publishing === p.id ? '발행중...' : '🚀 발행'}
                  </button>
                )}
                <button className="btn btn--secondary btn--sm" onClick={() => handleEdit(p)}>수정</button>
                <button className="btn btn--danger btn--sm" onClick={() => handleDelete(p.id)}>삭제</button>
              </div>
            </div>
          </div>
        ))}
        {posts.length === 0 && <div className="empty-state" style={{ gridColumn: '1/-1' }}><div className="icon">📮</div><p>게시물이 없습니다.</p></div>}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginTop: '24px' }}>
          <button className="btn btn--secondary btn--sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>← 이전</button>
          <span style={{ fontSize: '14px', lineHeight: '32px', color: 'var(--text-secondary)' }}>{page} / {totalPages}</span>
          <button className="btn btn--secondary btn--sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>다음 →</button>
        </div>
      )}

      {/* New/Edit Modal */}
      <Modal
        open={modalOpen}
        title={editingId ? '게시물 수정' : '새 게시물 작성'}
        onClose={() => { setModalOpen(false); setEditingId(null); }}
        footer={
          <>
            <button className="btn btn--secondary" onClick={() => setModalOpen(false)}>취소</button>
            <button className="btn btn--primary" onClick={handleSubmit} disabled={!form.content.trim() || !form.accountId}>
              {editingId ? '수정' : '등록'}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label className="form-label">계정 *</label>
          <select className="form-select" value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
            <option value="">선택</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.accountName}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">플랫폼 *</label>
          <select className="form-select" value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>
            <option value="threads">Threads</option>
            <option value="x">X (Twitter)</option>
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">발행 예약 시간 (선택)</label>
          <input className="form-input" type="datetime-local" value={form.scheduledAt}
            onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })} />
        </div>
        <div className="form-group">
          <label className="form-label">게시물 내용 *</label>
          <textarea className="form-textarea" placeholder="게시물 내용을 입력하세요...&#10;줄바꿈도 그대로 반영됩니다." value={form.content}
            onChange={(e) => setForm({ ...form, content: e.target.value })} rows={8} />
        </div>
        {form.content && (
          <div className="form-group">
            <label className="form-label">미리보기</label>
            <div style={{ fontSize: '14px', lineHeight: '1.7', whiteSpace: 'pre-wrap', background: 'var(--bg-input)', padding: '14px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
              {form.content}
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
