'use client';

import { useCallback, useEffect, useState } from 'react';
import Modal from '@/components/Modal';

const EMPTY_FORM = {
  accountName: '',
  description: '',
  role: 'automation',
  postingEnabled: false,
  dailyPostLimit: 5,
  operatingStartMinute: 420,
  operatingEndMinute: 120,
  timezone: 'Asia/Seoul',
};

async function apiRequest(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `요청 실패 (${response.status})`);
  return data;
}

function minuteToTime(value) {
  const minutes = Number(value) || 0;
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function timeToMinute(value) {
  const [hour, minute] = String(value).split(':').map(Number);
  return hour * 60 + minute;
}

export default function AccountsPage() {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);

  const fetchAccounts = useCallback(async () => {
    try {
      setError('');
      const data = await apiRequest('/api/accounts');
      setAccounts(Array.isArray(data) ? data : []);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchAccounts(); }, [fetchAccounts]);

  const openNew = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError('');
    setModalOpen(true);
  };

  const openEdit = (account) => {
    setEditingId(account.id);
    setForm({
      accountName: account.accountName,
      description: account.description || '',
      role: account.role || 'automation',
      postingEnabled: account.role === 'primary' ? false : Boolean(account.postingEnabled),
      dailyPostLimit: account.dailyPostLimit || 5,
      operatingStartMinute: account.operatingStartMinute ?? 420,
      operatingEndMinute: account.operatingEndMinute ?? 120,
      timezone: account.timezone || 'Asia/Seoul',
    });
    setError('');
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    setSaving(true);
    setError('');
    try {
      const payload = {
        ...form,
        postingEnabled: form.role === 'primary' ? false : form.postingEnabled,
        dailyPostLimit: Number(form.dailyPostLimit),
        operatingStartMinute: Number(form.operatingStartMinute),
        operatingEndMinute: Number(form.operatingEndMinute),
      };
      await apiRequest(editingId ? `/api/accounts/${editingId}` : '/api/accounts', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setModalOpen(false);
      setEditingId(null);
      setForm(EMPTY_FORM);
      await fetchAccounts();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (account) => {
    try {
      await apiRequest(`/api/accounts/${account.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !account.isActive }),
      });
      await fetchAccounts();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const handlePostingToggle = async (account) => {
    try {
      await apiRequest(`/api/accounts/${account.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postingEnabled: !account.postingEnabled }),
      });
      await fetchAccounts();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const handleDisconnect = async (account) => {
    if (!window.confirm(`${account.accountName}의 저장된 Threads 토큰을 제거하고 자동 발행을 정지할까요?`)) return;
    try {
      await apiRequest(`/api/accounts/${account.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadsAccessToken: null, postingEnabled: false }),
      });
      await fetchAccounts();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('API·초안·템플릿·작업 이력이 전혀 없는 빈 계정만 삭제됩니다. 계속할까요?')) return;
    try {
      await apiRequest(`/api/accounts/${id}`, { method: 'DELETE' });
      await fetchAccounts();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  if (loading) return <div className="loading-page"><div className="spinner" /></div>;

  return (
    <>
      <div className="page-header">
        <div>
          <h2>계정 관리</h2>
          <p>본계정은 수동 전용, 자동화 계정은 공식 Threads OAuth로 각각 연결합니다.</p>
        </div>
        <button className="btn btn--primary" onClick={openNew}>+ 계정 추가</button>
      </div>

      {error && <div className="notice notice--error">⚠️ {error}</div>}

      <div className="notice notice--info" style={{ marginBottom: '20px' }}>
        토큰이 없는 계정은 발행되지 않습니다. 가짜 성공 처리나 다른 계정의 공용 토큰 대체는 사용하지 않습니다.
      </div>

      <div className="card-grid">
        {accounts.map((account) => {
          const isPrimary = account.role === 'primary';
          const connected = Boolean(account._hasToken);
          return (
            <article className="account-card" key={account.id} style={{ opacity: account.isActive ? 1 : 0.62 }}>
              <div className="account-card__top">
                <div>
                  <div className="account-card__name">
                    {account.accountName}
                    <span className={`badge ${isPrimary ? 'badge--info' : 'badge--threads'}`} style={{ marginLeft: '8px' }}>
                      {isPrimary ? '수동 본계정' : '승인형 자동화'}
                    </span>
                  </div>
                  <div className="account-card__desc">{account.description || '설명 없음'}</div>
                </div>
                {!account.isActive && <span className="badge badge--failed">비활성</span>}
              </div>

              <div className="connection-row">
                <span className={`connection-dot ${connected ? 'is-connected' : ''}`} />
                <strong>{connected ? 'Threads API 연결됨' : 'Threads API 연결 필요'}</strong>
                {account.threadsUserId && <span className="muted-text">ID {account.threadsUserId}</span>}
              </div>

              {account.tokenExpiresAt && (
                <p className="muted-text">토큰 만료: {new Date(account.tokenExpiresAt).toLocaleString('ko-KR')}</p>
              )}

              <div className="account-card__stats">
                <div className="account-card__stat">게시물 <strong>{account._count?.posts || 0}</strong></div>
                <div className="account-card__stat">템플릿 <strong>{account._count?.templates || 0}</strong></div>
                {!isPrimary && (
                  <div className="account-card__stat">
                    자동 발행 <strong>{account.postingEnabled ? '허용' : '정지'}</strong>
                  </div>
                )}
              </div>

              <div className="account-card__actions">
                <a className="btn btn--success btn--sm" href={`/api/oauth/start?accountId=${account.id}`}>
                  {connected ? 'OAuth 다시 연결' : 'OAuth 연결'}
                </a>
                {connected && (
                  <button className="btn btn--danger btn--sm" onClick={() => handleDisconnect(account)}>
                    API 연결 해제
                  </button>
                )}
                {!isPrimary && (
                  <button className="btn btn--secondary btn--sm" onClick={() => handlePostingToggle(account)} disabled={!connected && !account.postingEnabled}>
                    {account.postingEnabled ? '발행 정지' : '발행 허용'}
                  </button>
                )}
                <button className="btn btn--secondary btn--sm" onClick={() => handleToggle(account)}>
                  {account.isActive ? '비활성화' : '활성화'}
                </button>
                <button className="btn btn--secondary btn--sm" onClick={() => openEdit(account)}>수정</button>
                <button className="btn btn--danger btn--sm" onClick={() => handleDelete(account.id)}>삭제</button>
              </div>
            </article>
          );
        })}
        {accounts.length === 0 && (
          <div className="empty-state"><div className="icon">👤</div><p>등록된 계정이 없습니다.</p></div>
        )}
      </div>

      <Modal
        open={modalOpen}
        title={editingId ? '계정 수정' : '계정 추가'}
        onClose={() => setModalOpen(false)}
        footer={(
          <>
            <button className="btn btn--secondary" onClick={() => setModalOpen(false)}>취소</button>
            <button className="btn btn--primary" onClick={handleSubmit} disabled={!form.accountName.trim() || saving}>
              {saving ? '저장 중...' : '저장'}
            </button>
          </>
        )}
      >
        <div className="form-group">
          <label className="form-label">계정 이름 *</label>
          <input className="form-input" value={form.accountName} onChange={(event) => setForm({ ...form, accountName: event.target.value })} />
        </div>
        <div className="form-group">
          <label className="form-label">운영 구분 *</label>
          <select className="form-select" value={form.role} onChange={(event) => {
            const role = event.target.value;
            setForm({ ...form, role, postingEnabled: role === 'primary' ? false : form.postingEnabled });
          }}>
            <option value="primary">본계정 — 수동 전용</option>
            <option value="automation">부계정 — 승인 후 자동 발행</option>
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">설명</label>
          <input className="form-input" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
        </div>

        {form.role === 'automation' && (
          <>
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">하루 내부 한도</label>
                <input className="form-input" type="number" min="1" max="50" value={form.dailyPostLimit} onChange={(event) => setForm({ ...form, dailyPostLimit: event.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">시간대</label>
                <input className="form-input" value={form.timezone} readOnly />
              </div>
            </div>
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">운영 시작 시각</label>
                <input className="form-input" type="time" value={minuteToTime(form.operatingStartMinute)} onChange={(event) => setForm({ ...form, operatingStartMinute: timeToMinute(event.target.value) })} />
              </div>
              <div className="form-group">
                <label className="form-label">운영 종료 시각</label>
                <input className="form-input" type="time" value={minuteToTime(form.operatingEndMinute)} onChange={(event) => setForm({ ...form, operatingEndMinute: timeToMinute(event.target.value) })} />
              </div>
            </div>
            <label className="checkbox-row">
              <input type="checkbox" checked={form.postingEnabled} onChange={(event) => setForm({ ...form, postingEnabled: event.target.checked })} />
              승인된 게시물 자동 발행 허용
            </label>
          </>
        )}

        <hr className="form-divider" />
        <p className="muted-text">
          계정을 저장한 뒤 카드의 OAuth 연결 버튼을 사용하세요. Threads ID와 사용자명은 토큰 소유자 확인 후 서버가 자동으로 기록합니다.
        </p>
      </Modal>
    </>
  );
}
