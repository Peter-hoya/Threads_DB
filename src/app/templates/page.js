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
  const [activeTemplateId, setActiveTemplateId] = useState(null); // 현재 생성 활성화된 템플릿 ID
  const [generating, setGenerating] = useState(false);
  const [genResults, setGenResults] = useState([]);
  const [selectedResults, setSelectedResults] = useState(new Set());
  const [sending, setSending] = useState(false);
  const [genPlatform, setGenPlatform] = useState('threads');
  const [genAccountId, setGenAccountId] = useState('');

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

  // === AI 콘텐츠 생성 ===
  const handleGenerate = async (t) => {
    setActiveTemplateId(t.id);
    setGenResults([]);
    setSelectedResults(new Set());
    setGenPlatform('threads');
    setGenAccountId(String(t.accountId));
    setGenerating(true);

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          promptText: t.promptText,
          templateCode: t.templateCode,
          accountName: t.account?.accountName || 'Unknown',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '생성 실패');

      const newResults = data.posts.map((content, idx) => ({
        id: Date.now() + idx,
        content,
      }));
      setGenResults(newResults);
      setSelectedResults(new Set(newResults.map((r) => r.id)));
    } catch (e) {
      alert(`❌ AI 생성 오류: ${e.message}`);
      setActiveTemplateId(null);
    } finally {
      setGenerating(false);
    }
  };

  const closeGenerator = () => {
    setActiveTemplateId(null);
    setGenResults([]);
    setSelectedResults(new Set());
    setGenAccountId('');
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
    const activeTemplate = templates.find((t) => t.id === activeTemplateId);
    const selected = genResults.filter((r) => selectedResults.has(r.id));
    try {
      for (const item of selected) {
        await fetch('/api/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId: parseInt(genAccountId),
            platform: genPlatform,
            content: item.content,
            templateId: activeTemplate?.id || null,
            status: 'pending',
          }),
        });
      }
      alert(`✅ ${selected.length}개 게시물이 대기열에 추가되었습니다.\n게시물 관리 탭에서 확인하세요.`);
      setGenResults((prev) => prev.filter((r) => !selectedResults.has(r.id)));
      setSelectedResults(new Set());
      if (selected.length === genResults.length) closeGenerator();
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

      {/* 템플릿 목록 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        {templates.map((t) => (
          <div key={t.id}>
            {/* 템플릿 카드 */}
            <div className="card" style={{ marginBottom: activeTemplateId === t.id ? '0' : undefined, borderRadius: activeTemplateId === t.id ? 'var(--radius-lg) var(--radius-lg) 0 0' : undefined }}>
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
                  <button
                    className="btn btn--success btn--sm"
                    onClick={() => activeTemplateId === t.id ? closeGenerator() : handleGenerate(t)}
                    disabled={generating && activeTemplateId === t.id}
                  >
                    {generating && activeTemplateId === t.id ? '⏳ 생성중...' : activeTemplateId === t.id ? '✕ 닫기' : '📝 생성'}
                  </button>
                  <button className="btn btn--secondary btn--sm" onClick={() => handleEdit(t)}>수정</button>
                  <button className="btn btn--danger btn--sm" onClick={() => handleDelete(t.id)}>삭제</button>
                </div>
              </div>
              <div style={{ fontSize: '13px', lineHeight: '1.7', whiteSpace: 'pre-wrap', background: 'var(--bg-input)', padding: '12px', borderRadius: 'var(--radius-md)', maxHeight: '180px', overflowY: 'auto' }}>
                {t.promptText}
              </div>
            </div>

            {/* 생성 결과 패널 (해당 템플릿 바로 아래 인라인) */}
            {activeTemplateId === t.id && (
              <div style={{
                background: 'var(--bg-card)', border: '1px solid var(--border)', borderTop: 'none',
                borderRadius: '0 0 var(--radius-lg) var(--radius-lg)', padding: '20px',
              }}>
                {/* 로딩 상태 */}
                {generating ? (
                  <div style={{ textAlign: 'center', padding: '48px 20px' }}>
                    <div className="spinner" style={{ margin: '0 auto 16px', borderTopColor: 'var(--accent)' }} />
                    <p style={{ margin: 0, fontWeight: 600, fontSize: '15px', color: 'var(--text)' }}>AI가 10개의 게시물을 자동 생성 중입니다...</p>
                    <p style={{ margin: '6px 0 0', fontSize: '13px', color: 'var(--text-muted)' }}>약 10~20초 소요</p>
                  </div>
                ) : (
                  <>
                    {/* 액션 바 */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <h4 style={{ margin: 0, fontSize: '15px' }}>📦 생성 결과 ({genResults.length}개)</h4>
                        {genResults.length > 0 && (
                          <label style={{ fontSize: '13px', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <input type="checkbox" checked={selectedResults.size === genResults.length && genResults.length > 0} onChange={toggleSelectAll} />
                            전체 선택
                          </label>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <select className="form-select" value={genAccountId} onChange={(e) => setGenAccountId(e.target.value)}
                          style={{ width: 'auto', minWidth: '130px', fontSize: '13px', padding: '4px 8px' }}>
                          {accounts.filter((a) => a.isActive).map((a) => (
                            <option key={a.id} value={a.id}>{a.accountName}</option>
                          ))}
                        </select>
                        <select className="form-select" value={genPlatform} onChange={(e) => setGenPlatform(e.target.value)}
                          style={{ width: 'auto', minWidth: '120px', fontSize: '13px', padding: '4px 8px' }}>
                          <option value="threads">Threads</option>
                          <option value="x">X (Twitter)</option>
                        </select>
                        <button
                          className="btn btn--primary btn--sm"
                          onClick={sendToPosts}
                          disabled={selectedResults.size === 0 || sending || !genAccountId}
                        >
                          {sending ? '전송 중...' : `🚀 게시물로 보내기 (${selectedResults.size})`}
                        </button>
                        <button className="btn btn--success btn--sm" onClick={() => handleGenerate(t)} disabled={generating}>
                          🔄 다시 생성
                        </button>
                      </div>
                    </div>

                    {/* 카드 그리드 */}
                    {genResults.length === 0 ? (
                      <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)', background: 'var(--bg-input)', borderRadius: 'var(--radius-md)', border: '2px dashed var(--border)' }}>
                        <p style={{ margin: 0 }}>생성된 게시물이 없습니다.</p>
                      </div>
                    ) : (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px' }}>
                        {genResults.map((r, idx) => (
                          <div
                            key={r.id}
                            onClick={() => toggleSelect(r.id)}
                            style={{
                              padding: '14px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
                              border: `2px solid ${selectedResults.has(r.id) ? 'var(--accent)' : 'var(--border)'}`,
                              background: selectedResults.has(r.id) ? 'var(--accent-light)' : 'var(--bg-card)',
                              transition: 'all 0.15s ease', position: 'relative',
                            }}
                          >
                            {/* 헤더: 번호 + 체크 + 삭제 */}
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <input
                                  type="checkbox"
                                  checked={selectedResults.has(r.id)}
                                  onChange={(e) => { e.stopPropagation(); toggleSelect(r.id); }}
                                  onClick={(e) => e.stopPropagation()}
                                  style={{ cursor: 'pointer', width: '16px', height: '16px', accentColor: 'var(--accent)' }}
                                />
                                <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>#{idx + 1}</span>
                              </div>
                              <button
                                className="btn btn--danger btn--sm"
                                style={{ padding: '2px 8px', fontSize: '11px' }}
                                onClick={(e) => { e.stopPropagation(); removeResult(r.id); }}
                              >삭제</button>
                            </div>
                            {/* 콘텐츠 */}
                            <div style={{ fontSize: '13px', lineHeight: '1.7', whiteSpace: 'pre-wrap', maxHeight: '160px', overflowY: 'auto' }}>
                              {r.content}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        ))}
        {templates.length === 0 && <div className="empty-state"><div className="icon">📝</div><p>등록된 템플릿이 없습니다.</p></div>}
      </div>

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
