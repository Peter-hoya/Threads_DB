'use client';
import { useState, useEffect } from 'react';
import Modal from '@/components/Modal';

export default function AccountsPage() {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ accountName: '', description: '', threadsUserId: '', threadsAccessToken: '' });

  const fetchAccounts = () => {
    fetch('/api/accounts').then((r) => r.json()).then(setAccounts).finally(() => setLoading(false));
  };

  useEffect(() => { fetchAccounts(); }, []);

  const handleSubmit = async () => {
    const url = editingId ? `/api/accounts/${editingId}` : '/api/accounts';
    const method = editingId ? 'PATCH' : 'POST';
    const payload = { ...form };
    if (editingId && !payload.threadsAccessToken) {
      delete payload.threadsAccessToken;
    }
    await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    setModalOpen(false);
    setEditingId(null);
    setForm({ accountName: '', description: '', threadsUserId: '', threadsAccessToken: '' });
    fetchAccounts();
  };

  const handleEdit = (a) => {
    setEditingId(a.id);
    setForm({
      accountName: a.accountName,
      description: a.description || '',
      threadsUserId: a.threadsUserId || '',
      // 수정 시 마스킹된 토큰 값은 넣지 않음 — 빈칸이면 기존 값 유지
      threadsAccessToken: '',
    });
    setModalOpen(true);
  };

  const handleDelete = async (id) => {
    if (!confirm('정말 삭제하시겠습니까? 관련된 모든 템플릿과 게시물도 삭제됩니다.')) return;
    await fetch(`/api/accounts/${id}`, { method: 'DELETE' });
    fetchAccounts();
  };

  const handleToggle = async (a) => {
    await fetch(`/api/accounts/${a.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: !a.isActive }),
    });
    fetchAccounts();
  };

  if (loading) return <div className="loading-page"><div className="spinner" /></div>;

  return (
    <>
      <div className="page-header">
        <div><h2>계정 관리</h2><p>브랜드/페르소나 계정 및 Threads API 연동을 관리합니다</p></div>
        <button className="btn btn--primary" onClick={() => { setEditingId(null); setForm({ accountName: '', description: '', threadsUserId: '', threadsAccessToken: '' }); setModalOpen(true); }}>
          + 계정 추가
        </button>
      </div>

      <div className="card-grid">
        {accounts.map((a) => (
          <div className="account-card" key={a.id} style={{ opacity: a.isActive ? 1 : 0.5 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div className="account-card__name">
                  {a.accountName}
                  {!a.isActive && <span className="badge badge--failed" style={{ marginLeft: '8px' }}>비활성</span>}
                </div>
                <div className="account-card__desc">{a.description || '설명 없음'}</div>
              </div>
              <div style={{ display: 'flex', gap: '4px' }}>
                <button className="btn btn--secondary btn--sm" onClick={() => handleToggle(a)}>
                  {a.isActive ? '비활성화' : '활성화'}
                </button>
                <button className="btn btn--secondary btn--sm" onClick={() => handleEdit(a)}>수정</button>
                <button className="btn btn--danger btn--sm" onClick={() => handleDelete(a.id)}>삭제</button>
              </div>
            </div>

            {/* Threads API 연동 상태 */}
            <div style={{ margin: '12px 0 4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{
                display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%',
                background: a._hasToken ? 'var(--success)' : 'var(--warning)',
              }} />
              <span style={{ fontSize: '13px', color: a._hasToken ? 'var(--success)' : 'var(--warning)', fontWeight: 500 }}>
                {a._hasToken ? 'Threads API 연동됨' : '우회 모드 (실제 발행 안됨)'}
              </span>
              {a.threadsUserId && (
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  ID: {a.threadsUserId}
                </span>
              )}
            </div>

            <div className="account-card__stats">
              <div className="account-card__stat">게시물 <strong>{a._count.posts}</strong></div>
              <div className="account-card__stat">템플릿 <strong>{a._count.templates}</strong></div>
            </div>
          </div>
        ))}
        {accounts.length === 0 && (
          <div className="empty-state"><div className="icon">👤</div><p>등록된 계정이 없습니다.</p></div>
        )}
      </div>

      <Modal
        open={modalOpen}
        title={editingId ? '계정 수정' : '계정 추가'}
        onClose={() => { setModalOpen(false); setEditingId(null); }}
        footer={
          <>
            <button className="btn btn--secondary" onClick={() => setModalOpen(false)}>취소</button>
            <button className="btn btn--primary" onClick={handleSubmit} disabled={!form.accountName.trim()}>
              {editingId ? '수정' : '추가'}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label className="form-label">계정 이름 *</label>
          <input className="form-input" placeholder="예: 럭키걸" value={form.accountName}
            onChange={(e) => setForm({ ...form, accountName: e.target.value })} />
        </div>
        <div className="form-group">
          <label className="form-label">설명</label>
          <input className="form-input" placeholder="계정 설명 (선택)" value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>

        <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '20px 0 16px' }} />
        <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px', lineHeight: 1.5 }}>
          🔗 <strong>Threads API 연동</strong> — 메타 API를 연동하려면 아래 정보를 입력하세요.<br />
          <span style={{ color: 'var(--warning)', display: 'inline-block', marginTop: '4px' }}>⚠️ 비워둘 경우 실제 발행 없이 <strong>가짜(Mock) 성공 처리로 우회(Bypass)</strong>됩니다. (UI/기능 테스트용)</span>
        </p>

        <div className="form-group">
          <label className="form-label">Threads User ID</label>
          <input className="form-input" placeholder="선택 입력 (토큰으로 자동 확인)" value={form.threadsUserId}
            onChange={(e) => setForm({ ...form, threadsUserId: e.target.value })} />
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', display: 'block' }}>
            실제 발행 계정은 액세스 토큰을 기준으로 자동 확인됩니다.
          </span>
        </div>
        <div className="form-group">
          <label className="form-label">Threads Access Token</label>
          <input className="form-input" type="password" placeholder={editingId ? '변경하려면 새 토큰 입력 (비우면 기존 유지)' : 'Meta 개발자 포털에서 발급받은 토큰'} value={form.threadsAccessToken}
            onChange={(e) => setForm({ ...form, threadsAccessToken: e.target.value })} />
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', display: 'block' }}>
            토큰은 암호화되어 저장되며, 화면에 노출되지 않습니다.
          </span>
        </div>
      </Modal>
    </>
  );
}
