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


  // Filters
  const [statusFilter, setStatusFilter] = useState('');
  const [accountFilter, setAccountFilter] = useState('');
  const [platformFilter, setPlatformFilter] = useState('');
  const [sortOrder, setSortOrder] = useState('asc'); // asc: 적재순서(큐 순), desc: 최신순

  // Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [form, setForm] = useState({ accountId: '', platform: 'threads', content: '', mediaUrl: '', mediaType: 'image', replyContent: '', scheduledAt: '' });

  // Bulk Modal
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkForm, setBulkForm] = useState({ accountId: '', platform: 'threads', content: '' });
  const [bulkSending, setBulkSending] = useState(false);

  const fetchPosts = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), limit: '12', sort: sortOrder });
    if (statusFilter) params.set('status', statusFilter);
    if (accountFilter) params.set('accountId', accountFilter);
    if (platformFilter) params.set('platform', platformFilter);
    const res = await fetch(`/api/posts?${params}`);
    const data = await res.json();
    setPosts(data.posts || []);
    setTotal(data.total || 0);
    setTotalPages(data.totalPages || 1);
    setLoading(false);
  }, [page, statusFilter, accountFilter, platformFilter, sortOrder]);

  useEffect(() => { fetchPosts(); }, [fetchPosts]);
  useEffect(() => {
    fetch('/api/accounts').then((r) => r.json()).then(setAccounts);
  }, []);

  const handleSubmit = async () => {
    const url = editingId ? `/api/posts/${editingId}` : '/api/posts';
    const method = editingId ? 'PATCH' : 'POST';
    const body = { ...form };
    // 만약 scheduledAt이 비어있으면 null 처리 (즉시 대기)
    if (!body.scheduledAt) {
      body.scheduledAt = null;
      body.status = 'pending';
    } else {
      body.status = 'scheduled';
    }

    await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    setModalOpen(false);
    setEditingId(null);
    fetchPosts();
  };

  const handlePublishNow = async (id) => {
    if (!confirm('이 게시물을 즉시 발행하시겠습니까?')) return;
    try {
      const res = await fetch(`/api/posts/${id}/publish`, { method: 'POST' });
      const responseText = await res.text();
      let data = {};
      try {
        data = responseText ? JSON.parse(responseText) : {};
      } catch {
        throw new Error(`서버 응답 오류 (${res.status})`);
      }
      if (!res.ok || !data.success) {
        throw new Error(data.error || data.message || `발행 실패 (${res.status})`);
      }
      alert('✅ 즉시 발행 성공!');
      fetchPosts();
    } catch (err) {
      alert(`❌ 즉시 발행 에러: ${err.message}`);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('이 게시물을 삭제하시겠습니까?')) return;
    await fetch(`/api/posts/${id}`, { method: 'DELETE' });
    fetchPosts();
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (file.size > 15 * 1024 * 1024) {
      alert('파일 크기는 15MB를 초과할 수 없습니다.');
      return;
    }

    setIsUploading(true);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '업로드 실패');
      
      setForm(prev => ({ ...prev, mediaUrl: data.url, mediaType: data.mediaType }));
    } catch (error) {
      alert(`업로드 에러: ${error.message}`);
    } finally {
      setIsUploading(false);
      e.target.value = '';
    }
  };



  const handleEdit = (p) => {
    setEditingId(p.id);
    let schedTime = '';
    if (p.scheduledAt) {
      // Convert to local datetime string for input: YYYY-MM-DDTHH:mm
      const d = new Date(p.scheduledAt);
      const tzOffset = d.getTimezoneOffset() * 60000;
      schedTime = (new Date(d - tzOffset)).toISOString().slice(0, 16);
    }
    setForm({
      accountId: String(p.accountId),
      platform: p.platform,
      content: p.content,
      mediaUrl: p.mediaUrl || '',
      mediaType: p.mediaType || 'image',
      replyContent: p.replyContent || '',
      scheduledAt: schedTime,
    });
    setModalOpen(true);
  };

  const openNewModal = () => {
    setEditingId(null);
    setForm({ accountId: accounts[0]?.id?.toString() || '', platform: 'threads', content: '', mediaUrl: '', mediaType: 'image', replyContent: '', scheduledAt: '' });
    setModalOpen(true);
  };

  const openBulkModal = () => {
    setBulkForm({ accountId: accounts[0]?.id?.toString() || '', platform: 'threads', content: '' });
    setBulkModalOpen(true);
  };

  const handleBulkSubmit = async () => {
    const posts = bulkForm.content
      .split('---')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (posts.length === 0) return alert('등록할 게시물이 없습니다.');
    if (!confirm(`${posts.length}개의 게시물을 등록하시겠습니까?`)) return;
    setBulkSending(true);
    try {
      for (const content of posts) {
        await fetch('/api/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId: bulkForm.accountId,
            platform: bulkForm.platform,
            content,
          }),
        });
      }
      alert(`✅ ${posts.length}개 게시물이 대기열에 등록되었습니다.`);
      setBulkModalOpen(false);
      fetchPosts();
    } catch (e) {
      alert(`❌ 등록 실패: ${e.message}`);
    }
    setBulkSending(false);
  };

  if (loading) return <div className="loading-page"><div className="spinner" /></div>;

  return (
    <>
      <div className="page-header">
        <div><h2>게시물 관리</h2><p>총 {total}개 게시물</p></div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="btn btn--primary" onClick={openNewModal}>+ 새 게시물</button>
          <button className="btn btn--secondary" onClick={openBulkModal}>📋 대량 등록</button>
        </div>
      </div>


      {modalOpen ? (
        <div style={{ background: 'var(--bg-card)', padding: '32px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', marginTop: '24px', boxShadow: '0 4px 20px rgba(0,0,0,0.05)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', paddingBottom: '16px', borderBottom: '1px solid var(--border)' }}>
            <h3 style={{ fontSize: '18px', fontWeight: 700 }}>{editingId ? '✏️ 게시물 수정' : '📝 새 게시물 작성'}</h3>
            <button className="btn btn--secondary btn--sm" onClick={() => { setModalOpen(false); setEditingId(null); }}>닫기 ✕</button>
          </div>
          
          <div style={{ maxWidth: '800px' }}>
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
          <label className="form-label">게시물 내용 *</label>
          <textarea className="form-textarea" placeholder="게시물 내용을 입력하세요...&#10;줄바꿈도 그대로 반영됩니다." value={form.content}
            onChange={(e) => setForm({ ...form, content: e.target.value })} rows={8} />
        </div>

        <div className="form-group">
          <label className="form-label">미디어 (선택)</label>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            <input type="file" id="media-upload" accept="image/*,video/*" style={{ display: 'none' }} onChange={handleFileUpload} />
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => document.getElementById('media-upload').click()} disabled={isUploading}>
              {isUploading ? '⏳ 업로드 중...' : '📁 내 PC에서 선택'}
            </button>
            {isUploading && <span style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: '32px' }}>서버에 파일을 저장하는 중입니다...</span>}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <select className="form-select" style={{ width: '120px' }} value={form.mediaType} onChange={(e) => setForm({ ...form, mediaType: e.target.value })}>
              <option value="image">이미지</option>
              <option value="video">동영상</option>
            </select>
            <input type="text" className="form-input" placeholder="미디어 파일의 웹 URL 주소를 입력하세요 (예: https://...)" style={{ flex: 1 }}
              value={form.mediaUrl} onChange={(e) => setForm({ ...form, mediaUrl: e.target.value })} />
          </div>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>* 외부에서 접근 가능한 웹 주소를 입력해야 정상 발행됩니다.</p>
        </div>

        <div className="form-group">
          <label className="form-label">첫 댓글 (자동 스레드 / 선택)</label>
          <textarea className="form-textarea" placeholder="본문 작성 후 이어질 첫 번째 답글을 입력하세요. 링크를 첨부하기 좋습니다." value={form.replyContent}
            onChange={(e) => setForm({ ...form, replyContent: e.target.value })} rows={3} />
        </div>

        <div className="form-group">
          <label className="form-label">발행 방식</label>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input type="radio" id="publish-pending" checked={!form.scheduledAt} onChange={() => setForm({ ...form, scheduledAt: '' })} />
            <label htmlFor="publish-pending">큐 대기 (순차 자동 발행)</label>
            
            <input type="radio" id="publish-scheduled" checked={!!form.scheduledAt} onChange={() => {
              const d = new Date();
              const tzOffset = d.getTimezoneOffset() * 60000;
              setForm({ ...form, scheduledAt: (new Date(d - tzOffset)).toISOString().slice(0, 16) });
            }} style={{ marginLeft: '12px' }} />
            <label htmlFor="publish-scheduled">예약 발행 (지정된 시간에 최우선 발행)</label>
          </div>
          {form.scheduledAt !== '' && (
            <div style={{ marginTop: '8px' }}>
              <input type="datetime-local" className="form-input" value={form.scheduledAt} onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })} />
            </div>
          )}
        </div>

          </div>

          <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '32px', paddingTop: '24px', borderTop: '1px solid var(--border)' }}>
            <button className="btn btn--secondary" onClick={() => { setModalOpen(false); setEditingId(null); }} style={{ padding: '0 24px' }}>취소</button>
            <button className="btn btn--primary" onClick={handleSubmit} disabled={!form.content.trim() || !form.accountId} style={{ padding: '0 32px' }}>
              {editingId ? '수정 완료' : '게시물 등록'}
            </button>
          </div>
        </div>
      ) : (
        <>
      {/* Tabs */}
      <div className="tabs">
        {[{ label: '전체', value: '' }, { label: '⏳ 대기', value: 'pending' }, { label: '📅 예약', value: 'scheduled' }, { label: '✅ 완료', value: 'published' }, { label: '❌ 실패', value: 'failed' }].map((t) => (
          <button key={t.value} className={`tab${statusFilter === t.value ? ' active' : ''}`}
            onClick={() => { setStatusFilter(t.value); setPage(1); setSortOrder(t.value === 'pending' || t.value === 'scheduled' ? 'asc' : 'desc'); }}>{t.label}</button>
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
        <button className={`btn btn--sm ${sortOrder === 'asc' ? 'btn--primary' : 'btn--secondary'}`}
          onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
          title={sortOrder === 'asc' ? '적재 순서 (큐 순)' : '최신순'}>
          {sortOrder === 'asc' ? '📦 큐 순서' : '🕒 최신순'}
        </button>
      </div>

      {/* Posts Grid */}
      <div className="card-grid">
        {posts.map((p, idx) => (
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
              {p.status === 'pending' && sortOrder === 'asc' && (
                <span style={{ fontSize: '11px', background: 'var(--warning-bg)', color: 'var(--warning)', padding: '2px 8px', borderRadius: '10px', fontWeight: 700 }}>
                  #{idx + 1 + (page - 1) * 12}
                </span>
              )}
              {p.template && (
                <span style={{ fontSize: '11px', background: 'var(--accent-light)', color: 'var(--accent)', padding: '2px 6px', borderRadius: '4px' }}>
                  {p.template.templateCode}
                </span>
              )}
              {p.mediaUrl && (
                <span style={{ fontSize: '11px', background: 'rgba(236, 72, 153, 0.1)', color: '#ec4899', padding: '2px 6px', borderRadius: '4px' }}>
                  {p.mediaType === 'video' ? '🎬 비디오' : '🖼️ 이미지'}
                </span>
              )}
              {p.replyContent && (
                <span style={{ fontSize: '11px', background: 'rgba(16, 185, 129, 0.1)', color: '#10b981', padding: '2px 6px', borderRadius: '4px' }}>
                  💬 답글
                </span>
              )}
            </div>
            <div className="post-card__content">{p.content}</div>
            <div className="post-card__footer">
              <div className="post-card__time">
                {p.status === 'scheduled' && p.scheduledAt ? `예약: ${toKST(p.scheduledAt)}` : p.publishedAt ? `발행: ${toKST(p.publishedAt)}` : `등록: ${toKST(p.createdAt)}`}
                {p.errorMessage && <div style={{ color: 'var(--error)', fontSize: '11px', marginTop: '2px' }}>⚠️ {p.errorMessage.substring(0, 60)}</div>}
              </div>
              <div className="post-card__actions">
                {(p.status === 'pending' || p.status === 'scheduled' || p.status === 'failed') && (
                  <button className="btn btn--primary btn--sm" onClick={() => handlePublishNow(p.id)}>🚀 즉시 발행</button>
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

        </>
      )}

      {/* Bulk Modal */}
      <Modal
        open={bulkModalOpen}
        title="대량 게시물 등록"
        onClose={() => setBulkModalOpen(false)}
        footer={
          <>
            <button className="btn btn--secondary" onClick={() => setBulkModalOpen(false)}>취소</button>
            <button className="btn btn--primary" onClick={handleBulkSubmit}
              disabled={!bulkForm.content.trim() || !bulkForm.accountId || bulkSending}>
              {bulkSending ? '등록 중...' : `등록 (${bulkForm.content.split('---').map((s) => s.trim()).filter((s) => s.length > 0).length}개)`}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label className="form-label">계정 *</label>
          <select className="form-select" value={bulkForm.accountId} onChange={(e) => setBulkForm({ ...bulkForm, accountId: e.target.value })}>
            <option value="">선택</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.accountName}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">플랫폼 *</label>
          <select className="form-select" value={bulkForm.platform} onChange={(e) => setBulkForm({ ...bulkForm, platform: e.target.value })}>
            <option value="threads">Threads</option>
            <option value="x">X (Twitter)</option>
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">게시물 내용 (--- 로 구분)</label>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 8px' }}>
            각 게시물을 <code style={{ background: 'var(--bg-input)', padding: '1px 6px', borderRadius: '4px' }}>---</code> 로 구분하여 입력하세요. 줄바꿈은 그대로 반영됩니다.
          </p>
          <textarea className="form-textarea" placeholder={`첫 번째 게시물 내용\n줄바꿈도 가능합니다.\n---\n두 번째 게시물 내용\n---\n세 번째 게시물 내용`}
            value={bulkForm.content}
            onChange={(e) => setBulkForm({ ...bulkForm, content: e.target.value })} rows={14} />
        </div>
        {bulkForm.content.trim() && (
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', padding: '10px 14px', background: 'var(--bg-input)', borderRadius: 'var(--radius-md)' }}>
            📦 감지된 게시물: <strong>{bulkForm.content.split('---').map((s) => s.trim()).filter((s) => s.length > 0).length}개</strong>
          </div>
        )}
      </Modal>
    </>
  );
}
