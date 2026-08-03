'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Modal from '@/components/Modal';

const DEFAULT_DISCLOSURE = '이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.';

const STATUS_LABELS = {
  draft: '📝 초안',
  queued: '⏳ 승인·대기',
  publishing: '🚀 발행 중',
  published: '✅ 완료',
  failed: '❌ 실패',
  cancelled: '⛔ 취소',
};

const EMPTY_FORM = {
  accountId: '',
  platform: 'threads',
  content: '',
  mediaUrl: '',
  mediaType: 'image',
  replyContent: '',
  affiliateDisclosure: DEFAULT_DISCLOSURE,
  sourceUrl: '',
  rightsConfirmed: false,
  policyReviewConfirmed: false,
  scheduledAt: '',
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

function toLocalInput(value) {
  if (!value) return '';
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

async function apiRequest(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || `요청 실패 (${response.status})`);
  return data;
}

function uploadWithTus(file, config) {
  return import('tus-js-client').then(({ Upload }) => new Promise((resolve, reject) => {
    const upload = new Upload(file, {
      endpoint: config.endpoint,
      headers: config.headers,
      chunkSize: config.chunkSize,
      metadata: config.metadata,
      removeFingerprintOnSuccess: true,
      retryDelays: [0, 1_000, 3_000, 5_000],
      onError: reject,
      onSuccess: resolve,
    });
    upload.findPreviousUploads().then((previous) => {
      if (previous.length > 0) upload.resumeFromPreviousUpload(previous[0]);
      upload.start();
    }).catch(reject);
  }));
}

export default function PostsPage() {
  const [posts, setPosts] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [accountFilter, setAccountFilter] = useState('');
  const [sortOrder, setSortOrder] = useState('desc');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkForm, setBulkForm] = useState({ accountId: '', content: '' });
  const [bulkSaving, setBulkSaving] = useState(false);

  const selectedAccount = useMemo(
    () => accounts.find((account) => String(account.id) === String(form.accountId)),
    [accounts, form.accountId],
  );

  const fetchPosts = useCallback(async () => {
    try {
      const query = new URLSearchParams({ page: String(page), limit: '12', sort: sortOrder });
      if (statusFilter) query.set('status', statusFilter);
      if (accountFilter) query.set('accountId', accountFilter);
      const data = await apiRequest(`/api/posts?${query}`);
      setPosts(data.posts || []);
      setTotal(data.total || 0);
      setTotalPages(data.totalPages || 1);
      setError('');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, accountFilter, sortOrder]);

  useEffect(() => { void fetchPosts(); }, [fetchPosts]);
  useEffect(() => {
    apiRequest('/api/accounts')
      .then(setAccounts)
      .catch((requestError) => setError(requestError.message));
  }, []);

  const openNew = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, accountId: String(accounts[0]?.id || '') });
    setError('');
    setEditorOpen(true);
  };

  const openEdit = (post) => {
    setEditingId(post.id);
    setForm({
      accountId: String(post.accountId),
      platform: 'threads',
      content: post.content,
      mediaUrl: post.mediaUrl || '',
      mediaType: post.mediaType || 'image',
      replyContent: post.replyContent || '',
      affiliateDisclosure: post.affiliateDisclosure || '',
      sourceUrl: post.sourceUrl || '',
      rightsConfirmed: Boolean(post.rightsConfirmed),
      policyReviewConfirmed: Boolean(post.policyReviewConfirmed),
      scheduledAt: toLocalInput(post.scheduledAt),
    });
    setError('');
    setEditorOpen(true);
  };

  const saveDraft = async () => {
    setSaving(true);
    setError('');
    try {
      const payload = {
        ...form,
        mediaUrl: form.mediaUrl || null,
        mediaType: form.mediaUrl ? form.mediaType : null,
        replyContent: form.replyContent || null,
        affiliateDisclosure: form.affiliateDisclosure || null,
        sourceUrl: form.sourceUrl || null,
        scheduledAt: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : null,
      };
      await apiRequest(editingId ? `/api/posts/${editingId}` : '/api/posts', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setEditorOpen(false);
      setEditingId(null);
      await fetchPosts();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  };

  const approvePost = async (post) => {
    const account = accounts.find((item) => item.id === post.accountId);
    if (account?.role === 'primary') {
      setError('본계정은 수동 운영 전용입니다. 자동 발행 대기열에 넣을 수 없습니다.');
      return;
    }
    if (!window.confirm('최종 문안·미디어 권리·광고 표시를 확인하고 VPS 발행 대기열에 넣을까요?')) return;
    try {
      await apiRequest(`/api/posts/${post.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      await fetchPosts();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const deletePost = async (id) => {
    if (!window.confirm('초안은 삭제하고, 대기 중인 글은 취소합니다. 계속할까요?')) return;
    try {
      await apiRequest(`/api/posts/${id}`, { method: 'DELETE' });
      await fetchPosts();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const reconcilePost = async (post) => {
    const target = post.postIdExternal && post.replyContent && !post.replyPostIdExternal ? 'reply' : 'main';
    const answer = window.prompt(
      `${target === 'main' ? '본문' : '답글'}이 Threads에 게시됐다면 Meta 게시물 ID를 입력하세요. 게시되지 않았음을 직접 확인했다면 NONE을 입력하세요.`,
    );
    if (!answer) return;
    const notPublished = answer.trim().toUpperCase() === 'NONE';
    if (notPublished && !window.confirm('Threads 앱에서 실제로 게시되지 않았음을 확인했나요? 잘못 확인하면 중복 발행될 수 있습니다.')) return;
    if (!notPublished && !window.confirm(`현재 연결된 계정의 ${target === 'main' ? '본문' : '답글'} ID가 “${answer.trim()}”인지 다시 확인했나요?`)) return;
    const note = window.prompt('확인 시각·계정·확인 방법을 기록해주세요.');
    if (!note?.trim()) return;
    try {
      await apiRequest(`/api/posts/${post.id}/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target,
          outcome: notPublished ? 'not_published' : 'published',
          externalId: notPublished ? null : answer.trim(),
          confirmedNotPublished: notPublished,
          confirmedPublished: !notPublished,
          note: note.trim(),
        }),
      });
      await fetchPosts();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const retryReply = async (post) => {
    if (!window.confirm('본문은 다시 발행하지 않고, 승인된 첫 답글만 다시 시도할까요?')) return;
    try {
      await apiRequest(`/api/posts/${post.id}/retry-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      await fetchPosts();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const uploadMedia = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setUploading(true);
    setUploadProgress('업로드 준비 중');
    setError('');
    try {
      const signed = await apiRequest('/api/upload/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, contentType: file.type, size: file.size }),
      });

      if (signed.upload.protocol === 'standard') {
        setUploadProgress('Supabase에 업로드 중');
        const uploadResponse = await fetch(signed.upload.standard.url, {
          method: signed.upload.standard.method,
          headers: signed.upload.standard.headers,
          body: file,
        });
        if (!uploadResponse.ok) throw new Error(`스토리지 업로드 실패 (${uploadResponse.status})`);
      } else {
        setUploadProgress('대용량 이어올리기 중');
        await uploadWithTus(file, signed.upload.tus);
      }

      setUploadProgress('파일 검증 및 공개 준비 중');
      const completed = await apiRequest(signed.completion.url, {
        method: signed.completion.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signed.completion.body),
      });
      setForm((current) => ({
        ...current,
        mediaUrl: completed.url,
        mediaType: completed.mediaType,
        rightsConfirmed: false,
        policyReviewConfirmed: false,
      }));
      setUploadProgress('업로드 완료');
    } catch (requestError) {
      setError(requestError.message);
      setUploadProgress('');
    } finally {
      setUploading(false);
    }
  };

  const submitBulk = async () => {
    const contents = bulkForm.content.split('---').map((item) => item.trim()).filter(Boolean);
    if (!contents.length) return;
    setBulkSaving(true);
    try {
      for (const content of contents) {
        await apiRequest('/api/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId: bulkForm.accountId, platform: 'threads', content }),
        });
      }
      setBulkOpen(false);
      setBulkForm({ accountId: '', content: '' });
      await fetchPosts();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBulkSaving(false);
    }
  };

  if (loading) return <div className="loading-page"><div className="spinner" /></div>;

  return (
    <>
      <div className="page-header">
        <div><h2>게시물 관리</h2><p>초안 {total}개 포함 · 승인된 글만 VPS 워커가 발행합니다.</p></div>
        <div className="header-actions">
          <button className="btn btn--primary" onClick={openNew}>+ 새 게시물</button>
          <button className="btn btn--secondary" onClick={() => {
            setBulkForm({ accountId: String(accounts[0]?.id || ''), content: '' });
            setBulkOpen(true);
          }}>대량 초안</button>
        </div>
      </div>

      {error && <div className="notice notice--error">⚠️ {error}</div>}

      {editorOpen ? (
        <section className="editor-panel">
          <div className="editor-panel__header">
            <div><h3>{editingId ? '게시물 수정' : '새 초안'}</h3><p>수정하면 기존 승인은 자동으로 무효화됩니다.</p></div>
            <button className="btn btn--secondary btn--sm" onClick={() => setEditorOpen(false)}>닫기</button>
          </div>

          <div className="editor-panel__body">
            <div className="form-group">
              <label className="form-label">발행 계정 *</label>
              <select className="form-select" value={form.accountId} onChange={(event) => setForm({
                ...form,
                accountId: event.target.value,
                rightsConfirmed: false,
                policyReviewConfirmed: false,
              })}>
                <option value="">선택</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.accountName} · {account.role === 'primary' ? '수동 본계정' : '자동화 계정'}
                  </option>
                ))}
              </select>
              {selectedAccount?.role === 'primary' && <span className="field-warning">본계정 글은 저장만 가능하며 자동 발행되지 않습니다.</span>}
            </div>

            <div className="form-group">
              <label className="form-label">본문 * <span className="char-count">{[...form.content].length}/500</span></label>
              <textarea className="form-textarea" rows={8} value={form.content} maxLength={500} onChange={(event) => setForm({
                ...form,
                content: event.target.value,
                rightsConfirmed: false,
                policyReviewConfirmed: false,
              })} />
            </div>

            <div className="form-group">
              <label className="form-label">이미지·동영상</label>
              <div className="media-upload-row">
                <label className={`btn btn--secondary btn--sm ${uploading ? 'is-disabled' : ''}`}>
                  {uploading ? '업로드 중...' : '파일 선택'}
                  <input type="file" accept="image/jpeg,image/png,video/mp4,video/quicktime" hidden disabled={uploading} onChange={uploadMedia} />
                </label>
                {uploadProgress && <span className="muted-text">{uploadProgress}</span>}
              </div>
              <div className="media-url-row">
                <select className="form-select" value={form.mediaType} onChange={(event) => setForm({
                  ...form,
                  mediaType: event.target.value,
                  rightsConfirmed: false,
                  policyReviewConfirmed: false,
                })}>
                  <option value="image">이미지</option>
                  <option value="video">동영상</option>
                </select>
                <input className="form-input" type="url" placeholder="검증된 threads-publish Supabase URL" value={form.mediaUrl} onChange={(event) => setForm({
                  ...form,
                  mediaUrl: event.target.value,
                  rightsConfirmed: false,
                  policyReviewConfirmed: false,
                })} />
              </div>
              <span className="muted-text">자동 발행은 위 업로드 절차로 검증된 Supabase 원본만 승인됩니다.</span>
              <label className="checkbox-row">
                <input type="checkbox" checked={form.rightsConfirmed} onChange={(event) => setForm({ ...form, rightsConfirmed: event.target.checked })} />
                본문과 미디어를 게시할 권리를 보유하거나 사용 허락을 받았습니다.
              </label>
            </div>

            <div className="form-group">
              <label className="form-label">첫 답글 <span className="char-count">{[...form.replyContent].length}/500</span></label>
              <textarea className="form-textarea" rows={3} maxLength={500} placeholder="쿠팡파트너스 링크와 상품 설명을 넣을 수 있습니다." value={form.replyContent} onChange={(event) => {
                const replyContent = event.target.value;
                setForm({
                  ...form,
                  replyContent,
                  rightsConfirmed: false,
                  policyReviewConfirmed: false,
                });
              }} />
            </div>

            <div className="form-group">
              <label className="form-label">광고·제휴 고지 <span className="required">필수</span></label>
              <textarea className="form-textarea" rows={2} maxLength={500} placeholder={DEFAULT_DISCLOSURE} value={form.affiliateDisclosure} onChange={(event) => setForm({
                ...form,
                affiliateDisclosure: event.target.value,
                rightsConfirmed: false,
                policyReviewConfirmed: false,
              })} />
              <span className="muted-text">모든 자동 발행 글에 필수입니다. 발행 시 답글이 있으면 답글 끝에, 없으면 본문 끝에 자동으로 포함됩니다.</span>
            </div>

            <label className="checkbox-row policy-check">
              <input type="checkbox" checked={form.policyReviewConfirmed} onChange={(event) => setForm({ ...form, policyReviewConfirmed: event.target.checked })} />
              Meta의 브랜디드 콘텐츠 표시와 쿠팡파트너스 고지 요건을 확인했습니다. Threads API가 Paid partnership 라벨을 자동 설정하지 않는 점도 확인했습니다.
            </label>

            <div className="form-group">
              <label className="form-label">콘텐츠 출처·사용허락 기록</label>
              <input className="form-input" type="url" placeholder="https://... (선택)" value={form.sourceUrl} onChange={(event) => setForm({
                ...form,
                sourceUrl: event.target.value,
                rightsConfirmed: false,
                policyReviewConfirmed: false,
              })} />
              <span className="muted-text">외부 미디어나 원문을 사용했다면 원본 또는 허락 근거 URL을 기록하세요. 이 값은 게시물에 공개되지 않습니다.</span>
            </div>

            <div className="form-group">
              <label className="form-label">희망 발행 시간</label>
              <input className="form-input" type="datetime-local" value={form.scheduledAt} onChange={(event) => setForm({ ...form, scheduledAt: event.target.value })} />
              <span className="muted-text">비워두면 승인 직후 대기열에 들어갑니다. 계정별 운영 시간과 내부 한도는 워커가 다시 확인합니다.</span>
            </div>
          </div>

          <div className="editor-panel__actions">
            <button className="btn btn--secondary" onClick={() => setEditorOpen(false)}>취소</button>
            <button className="btn btn--primary" onClick={saveDraft} disabled={saving || !form.accountId || !form.content.trim()}>{saving ? '저장 중...' : '초안 저장'}</button>
          </div>
        </section>
      ) : (
        <>
          <div className="tabs tabs--wrap">
            {[
              ['', '전체'],
              ['draft', '📝 초안'],
              ['queued', '⏳ 대기'],
              ['publishing', '🚀 발행 중'],
              ['published', '✅ 완료'],
              ['failed', '❌ 실패'],
              ['cancelled', '⛔ 취소'],
            ].map(([value, label]) => (
              <button key={value} className={`tab${statusFilter === value ? ' active' : ''}`} onClick={() => { setStatusFilter(value); setPage(1); }}>{label}</button>
            ))}
          </div>

          <div className="filter-bar">
            <select className="form-select" value={accountFilter} onChange={(event) => { setAccountFilter(event.target.value); setPage(1); }}>
              <option value="">전체 계정</option>
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.accountName}</option>)}
            </select>
            <button className="btn btn--secondary btn--sm" onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}>
              {sortOrder === 'asc' ? '등록순' : '최신순'}
            </button>
          </div>

          <div className="card-grid">
            {posts.map((post) => (
              <article className="post-card" key={post.id}>
                <div className="post-card__meta">
                  <span className="badge badge--threads">Threads</span>
                  <span className={`badge badge--${post.status}`}>{STATUS_LABELS[post.status] || post.status}</span>
                  <strong className="muted-text">{post.account?.accountName}</strong>
                  {post.account?.role === 'primary' && <span className="badge badge--info">수동</span>}
                  {post.mediaUrl && <span className="badge badge--info">{post.mediaType === 'video' ? '🎬' : '🖼️'} 미디어</span>}
                  {post.replyContent && <span className="badge badge--info">💬 답글</span>}
                  {post.needsReconciliation && <span className="badge badge--failed">외부 결과 확인 필요</span>}
                </div>
                <div className="post-card__content">{post.content}</div>
                {post.affiliateDisclosure && <p className="disclosure-preview">광고 고지: {post.affiliateDisclosure}</p>}
                <div className="post-card__footer">
                  <div className="post-card__time">
                    {post.publishedAt ? `발행 ${toKST(post.publishedAt)}` : post.scheduledAt ? `예정 ${toKST(post.scheduledAt)}` : `등록 ${toKST(post.createdAt)}`}
                    {post.jobs?.[0] && <div>작업 {post.jobs[0].status} · 시도 {post.jobs[0].attempts}</div>}
                    {post.errorMessage && <div className="field-error">{post.errorMessage}</div>}
                    {post.reconciliationNote && <div className="muted-text">조정 기록: {post.reconciliationNote}</div>}
                  </div>
                  <div className="post-card__actions">
                    {post.needsReconciliation && (
                      <button className="btn btn--danger btn--sm" onClick={() => reconcilePost(post)}>결과 조정</button>
                    )}
                    {!post.needsReconciliation && post.status === 'published' && post.replyContent && !post.replyPostIdExternal && ['failed', 'dead'].includes(post.jobs?.[0]?.status) && (
                      <button className="btn btn--primary btn--sm" onClick={() => retryReply(post)}>답글 재시도</button>
                    )}
                    {!post.needsReconciliation && ['draft', 'failed', 'cancelled'].includes(post.status) && post.account?.role !== 'primary' && (
                      <button className="btn btn--primary btn--sm" onClick={() => approvePost(post)}>검토·승인</button>
                    )}
                    {!post.needsReconciliation && ['draft', 'queued', 'failed', 'cancelled'].includes(post.status) && (
                      <button className="btn btn--secondary btn--sm" onClick={() => openEdit(post)}>수정</button>
                    )}
                    {!post.needsReconciliation && !['publishing', 'published'].includes(post.status) && (
                      <button className="btn btn--danger btn--sm" onClick={() => deletePost(post.id)}>{post.status === 'queued' ? '취소' : '삭제'}</button>
                    )}
                  </div>
                </div>
              </article>
            ))}
            {posts.length === 0 && <div className="empty-state"><div className="icon">📮</div><p>게시물이 없습니다.</p></div>}
          </div>

          {totalPages > 1 && (
            <div className="pagination">
              <button className="btn btn--secondary btn--sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>이전</button>
              <span>{page} / {totalPages}</span>
              <button className="btn btn--secondary btn--sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>다음</button>
            </div>
          )}
        </>
      )}

      <Modal
        open={bulkOpen}
        title="대량 초안 등록"
        onClose={() => setBulkOpen(false)}
        footer={(
          <>
            <button className="btn btn--secondary" onClick={() => setBulkOpen(false)}>취소</button>
            <button className="btn btn--primary" onClick={submitBulk} disabled={bulkSaving || !bulkForm.accountId || !bulkForm.content.trim()}>{bulkSaving ? '등록 중...' : '초안 등록'}</button>
          </>
        )}
      >
        <div className="form-group">
          <label className="form-label">계정 *</label>
          <select className="form-select" value={bulkForm.accountId} onChange={(event) => setBulkForm({ ...bulkForm, accountId: event.target.value })}>
            <option value="">선택</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.accountName}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">내용 — 게시물 사이를 --- 로 구분</label>
          <textarea className="form-textarea" rows={14} value={bulkForm.content} onChange={(event) => setBulkForm({ ...bulkForm, content: event.target.value })} />
        </div>
        <div className="notice notice--info">대량 등록은 모두 초안으로 저장됩니다. 계정별 최종 검토·승인은 각각 해야 합니다.</div>
      </Modal>
    </>
  );
}
