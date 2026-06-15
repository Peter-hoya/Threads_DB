'use client';
import { useState, useEffect } from 'react';
import Modal from '@/components/Modal';

export default function TemplatesPage() {
  const [templates, setTemplates] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterAccount, setFilterAccount] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ accountId: '', templateCode: '', templateName: '', promptText: '' });

  // 콘텐츠 생성 관련 state
  const [genTemplate, setGenTemplate] = useState(null); // 현재 "생성" 모드인 템플릿
  const [genDraft, setGenDraft] = useState('');          // 작성 중인 콘텐츠
  const [genResults, setGenResults] = useState([]);      // 생성된 콘텐츠 결과 목록
  const [selectedResults, setSelectedResults] = useState(new Set());
  const [sending, setSending] = useState(false);
  const [genPlatform, setGenPlatform] = useState('threads');

  const fetchData = async () => {
    const [tRes, aRes] = await Promise.all([
      fetch(`/api/templates${filterAccount ? `?accountId=${filterAccount}` : ''}`),
      fetch('/api/accounts'),
    ]);
    setTemplates(await tRes.json());
    setAccounts(await aRes.json());
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, [filterAccount]);

  const handleSubmit = async () => {
    const url = editingId ? `/api/templates/${editingId}` : '/api/templates';
    const method = editingId ? 'PATCH' : 'POST';
    await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
    setModalOpen(false);
    setEditingId(null);
    fetchData();
  };

  const handleEdit = (t) => {
    setEditingId(t.id);
    setForm({ accountId: String(t.accountId), templateCode: t.templateCode, templateName: t.templateName || '', promptText: t.promptText });
    setModalOpen(true);
  };

  const handleDelete = async (id) => {
    if (!confirm('이 템플릿을 삭제하시겠습니까?')) return;
    await fetch(`/api/templates/${id}`, { method: 'DELETE' });
    fetchData();
  };

  // === 콘텐츠 생성 ===
  const openGenerator = (t) => {
    setGenTemplate(t);
    setGenDraft('');
    setGenResults([]);
    setSelectedResults(new Set());
    setGenPlatform('threads');
  };

  const closeGenerator = () => {
    setGenTemplate(null);
    setGenDraft('');
    setGenResults([]);
    setSelectedResults(new Set());
  };

  const addToResults = () => {
    if (!genDraft.trim()) return;
    setGenResults((prev) => [...prev, { id: Date.now(), content: genDraft.trim() }]);
    setGenDraft('');
  };

  const removeResult = (id) => {
    setGenResults((prev) => prev.filter((r) => r.id !== id));
    setSelectedResults((prev) => { const next = new Set(prev); next.delete(id); return next; });
  };

  const toggleSelect = (id) => {
    setSelectedResults((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedResults.size === genResults.length) {
      setSelectedResults(new Set());
    } else {
      setSelectedResults(new Set(genResults.map((r) => r.id)));
    }
  };

  const sendToPosts = async () => {
    if (selectedResults.size === 0) return;
    setSending(true);
    const selected = genResults.filter((r) => selectedResults.has(r.id));
    try {
      for (const item of selected) {
        await fetch('/api/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId: genTemplate.accountId,
            platform: genPlatform,
            content: item.content,
            templateId: genTemplate.id,
            status: 'pending',
          }),
        });
      }
      alert(`✅ ${selected.length}개 게시물이 대기열에 추가되었습니다.\n게시물 관리 탭에서 확인하세요.`);
      // 보내진 결과 제거
      setGenResults((prev) => prev.filter((r) => !selectedResults.has(r.id)));
      setSelectedResults(new Set());
    } catch (e) {
      alert(`❌ 전송 실패: ${e.message}`);
    }
    setSending(false);
  };

  if (loading) return <div className="loading-page"><div className="spinner" /></div>;

  return (
    <>
      <div className="page-header">
        <div><h2>템플릿 관리</h2><p>계정별 프롬프트 템플릿을 관리하고 콘텐츠를 생성합니다</p></div>
        <button className="btn btn--primary" onClick={() => {
          setEditingId(null);
          setForm({ accountId: accounts[0]?.id?.toString() || '', templateCode: '', templateName: '', promptText: '' });
          setModalOpen(true);
        }}>+ 템플릿 추가</button>
      </div>

      <div className="filter-bar">
        <select className="form-select" value={filterAccount} onChange={(e) => setFilterAccount(e.target.value)}>
          <option value="">전체 계정</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.accountName}</option>)}
        </select>
      </div>

      <div className="card-grid">
        {templates.map((t) => (
          <div className="card" key={t.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
              <div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <span style={{ background: 'var(--accent)', color: '#fff', width: '28px', height: '28px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', fontWeight: 700 }}>
                    {t.templateCode}
                  </span>
                  <span style={{ fontWeight: 700, fontSize: '15px' }}>{t.templateName || `템플릿 ${t.templateCode}`}</span>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                  {t.account?.accountName}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '4px' }}>
                <button className="btn btn--success btn--sm" onClick={() => openGenerator(t)}>📝 생성</button>
                <button className="btn btn--secondary btn--sm" onClick={() => handleEdit(t)}>수정</button>
                <button className="btn btn--danger btn--sm" onClick={() => handleDelete(t.id)}>삭제</button>
              </div>
            </div>
            <div style={{ fontSize: '13px', lineHeight: '1.7', whiteSpace: 'pre-wrap', background: 'var(--bg-input)', padding: '12px', borderRadius: 'var(--radius-md)', maxHeight: '180px', overflowY: 'auto' }}>
              {t.promptText}
            </div>
          </div>
        ))}
        {templates.length === 0 && <div className="empty-state"><div className="icon">📝</div><p>등록된 템플릿이 없습니다.</p></div>}
      </div>

      {/* ============ 콘텐츠 생성 패널 ============ */}
      {genTemplate && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.35)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
          paddingTop: '40px', overflowY: 'auto',
        }} onClick={(e) => { if (e.target === e.currentTarget) closeGenerator(); }}>
          <div style={{
            background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)',
            width: '100%', maxWidth: '860px', padding: '28px',
            boxShadow: 'var(--shadow-lg)', maxHeight: 'calc(100vh - 80px)', overflowY: 'auto',
          }}>
            {/* 헤더 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '18px' }}>
                  📝 콘텐츠 생성
                  <span style={{ marginLeft: '10px', background: 'var(--accent)', color: '#fff', padding: '2px 10px', borderRadius: '12px', fontSize: '12px', fontWeight: 600 }}>
                    {genTemplate.account?.accountName} · {genTemplate.templateCode}
                  </span>
                </h3>
              </div>
              <button className="btn btn--secondary btn--sm" onClick={closeGenerator}>✕ 닫기</button>
            </div>

            {/* 2컬럼: 프롬프트 참고 + 작성 영역 */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px' }}>
              {/* 왼쪽: 프롬프트 참고 */}
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                  📋 프롬프트 (참고용)
                </label>
                <div style={{
                  fontSize: '13px', lineHeight: '1.7', whiteSpace: 'pre-wrap',
                  background: 'var(--bg-input)', padding: '14px', borderRadius: 'var(--radius-md)',
                  maxHeight: '240px', overflowY: 'auto', border: '1px solid var(--border)',
                }}>
                  {genTemplate.promptText}
                </div>
              </div>

              {/* 오른쪽: 콘텐츠 작성 */}
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                  ✏️ 콘텐츠 작성
                </label>
                <textarea
                  className="form-textarea"
                  placeholder={'프롬프트를 참고하여 게시물 콘텐츠를 작성하세요.\n작성 후 "추가" 버튼을 눌러 아래 결과 목록에 넣으세요.\n여러 개를 작성할 수 있습니다.'}
                  value={genDraft}
                  onChange={(e) => setGenDraft(e.target.value)}
                  rows={8}
                  style={{ resize: 'vertical' }}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px' }}>
                  <button className="btn btn--primary btn--sm" onClick={addToResults} disabled={!genDraft.trim()}>
                    + 결과에 추가
                  </button>
                </div>
              </div>
            </div>

            {/* 구분선 */}
            <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '8px 0 20px' }} />

            {/* 결과 목록 헤더 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <h4 style={{ margin: 0, fontSize: '15px' }}>📦 생성된 콘텐츠 ({genResults.length}개)</h4>
                {genResults.length > 0 && (
                  <label style={{ fontSize: '13px', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <input type="checkbox" checked={selectedResults.size === genResults.length && genResults.length > 0} onChange={toggleSelectAll} />
                    전체 선택
                  </label>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <select className="form-select" value={genPlatform} onChange={(e) => setGenPlatform(e.target.value)}
                  style={{ width: 'auto', minWidth: '120px', fontSize: '13px', padding: '4px 8px' }}>
                  <option value="threads">Threads</option>
                  <option value="x">X (Twitter)</option>
                </select>
                <button
                  className="btn btn--primary btn--sm"
                  onClick={sendToPosts}
                  disabled={selectedResults.size === 0 || sending}
                >
                  {sending ? '전송 중...' : `🚀 선택 항목 게시물로 보내기 (${selectedResults.size})`}
                </button>
              </div>
            </div>

            {/* 결과 리스트 */}
            {genResults.length === 0 ? (
              <div style={{
                textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)',
                background: 'var(--bg-input)', borderRadius: 'var(--radius-md)', border: '2px dashed var(--border)',
              }}>
                <div style={{ fontSize: '32px', marginBottom: '8px' }}>📝</div>
                <p style={{ margin: 0 }}>위에서 콘텐츠를 작성하고 "결과에 추가" 버튼을 눌러주세요.</p>
                <p style={{ margin: '4px 0 0', fontSize: '12px' }}>추가된 콘텐츠를 체크박스로 선택하여 게시물로 보낼 수 있습니다.</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {genResults.map((r, idx) => (
                  <div key={r.id} style={{
                    display: 'flex', gap: '12px', alignItems: 'flex-start',
                    padding: '14px', borderRadius: 'var(--radius-md)',
                    border: `2px solid ${selectedResults.has(r.id) ? 'var(--accent)' : 'var(--border)'}`,
                    background: selectedResults.has(r.id) ? 'var(--accent-light)' : 'var(--bg-card)',
                    transition: 'all 0.15s ease',
                  }}>
                    <input
                      type="checkbox"
                      checked={selectedResults.has(r.id)}
                      onChange={() => toggleSelect(r.id)}
                      style={{ marginTop: '3px', cursor: 'pointer', width: '18px', height: '18px', accentColor: 'var(--accent)' }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)' }}>#{idx + 1}</span>
                        <button
                          className="btn btn--danger btn--sm"
                          style={{ padding: '2px 8px', fontSize: '11px' }}
                          onClick={() => removeResult(r.id)}
                        >삭제</button>
                      </div>
                      <div style={{ fontSize: '14px', lineHeight: '1.7', whiteSpace: 'pre-wrap' }}>
                        {r.content}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 템플릿 추가/수정 모달 */}
      <Modal
        open={modalOpen}
        title={editingId ? '템플릿 수정' : '템플릿 추가'}
        onClose={() => { setModalOpen(false); setEditingId(null); }}
        footer={
          <>
            <button className="btn btn--secondary" onClick={() => setModalOpen(false)}>취소</button>
            <button className="btn btn--primary" onClick={handleSubmit} disabled={!form.templateCode || !form.promptText}>
              {editingId ? '수정' : '추가'}
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
          <label className="form-label">템플릿 코드 * (A, B, C 등)</label>
          <input className="form-input" placeholder="예: A" maxLength={5} value={form.templateCode}
            onChange={(e) => setForm({ ...form, templateCode: e.target.value.toUpperCase() })} />
        </div>
        <div className="form-group">
          <label className="form-label">템플릿 이름</label>
          <input className="form-input" placeholder="예: 일상 긍정 메시지" value={form.templateName}
            onChange={(e) => setForm({ ...form, templateName: e.target.value })} />
        </div>
        <div className="form-group">
          <label className="form-label">프롬프트 텍스트 *</label>
          <textarea className="form-textarea" placeholder="AI에게 전달할 프롬프트를 작성하세요..." value={form.promptText}
            onChange={(e) => setForm({ ...form, promptText: e.target.value })} rows={6} />
        </div>
      </Modal>
    </>
  );
}
