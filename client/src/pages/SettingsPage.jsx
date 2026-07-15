import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function SettingsPage() {
  const { user, getToken, replaceToken } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  if (!user) {
    return (
      <div className="settings-page">
        <section className="settings-auth-state" aria-labelledby="settings-login-title">
          <p className="workspace-kicker">ACCOUNT SETTINGS</p>
          <h1 id="settings-login-title">로그인 후 계정을 관리할 수 있습니다</h1>
          <p>로그인하면 보유 변환 시간과 계정 정보를 확인하고 비밀번호를 변경할 수 있습니다.</p>
          <Link className="button button--primary" to="/transcribe">
            변환 화면으로 이동
          </Link>
        </section>
      </div>
    );
  }

  const handleChange = async (event) => {
    event.preventDefault();
    setError('');
    setSuccess('');
    if (!currentPassword) return setError('현재 비밀번호를 입력해주세요.');
    if (newPassword.length < 8) return setError('비밀번호는 8자 이상이어야 합니다.');
    if (currentPassword === newPassword) return setError('새 비밀번호는 현재 비밀번호와 달라야 합니다.');
    if (newPassword !== confirmPassword) return setError('비밀번호가 일치하지 않습니다.');

    setLoading(true);
    try {
      const res = await fetch('/api/auth/password', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      replaceToken(data.token);
      setSuccess('비밀번호가 변경되었습니다.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(err.message || '비밀번호 변경에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const planLabels = {
    free: '무료 계정',
    basic: '베이직',
    pro: '프로',
    creator: '크리에이터',
  };
  const planLabel = planLabels[user.plan] || user.plan || '무료 계정';
  const parsedCredits = Number(user.credits);
  const credits = Number.isFinite(parsedCredits) ? parsedCredits : 0;

  return (
    <div className="settings-page">
      <section className="settings-heading" aria-labelledby="settings-title">
        <p className="workspace-kicker">ACCOUNT SETTINGS</p>
        <div className="settings-heading__row">
          <div>
            <h1 id="settings-title" className="workspace-title">계정 설정</h1>
            <p className="workspace-description">계정 정보와 보안을 한곳에서 관리합니다.</p>
          </div>
          <Link className="button button--secondary settings-heading__action" to="/usage">
            사용 내역 보기
          </Link>
        </div>
      </section>

      <section className="settings-summary" aria-label="계정 요약">
        <div className="settings-summary__email">
          <span>계정 이메일</span>
          <strong>{user.email}</strong>
        </div>
        <div>
          <span>보유 변환 시간</span>
          <strong>{credits.toLocaleString()}분</strong>
        </div>
        <div>
          <span>계정 유형</span>
          <strong>{planLabel}</strong>
        </div>
      </section>

      <div className="settings-layout">
        <section className="settings-panel" aria-labelledby="password-title">
          <div className="settings-panel__heading">
            <div>
              <p className="settings-panel__kicker">SECURITY</p>
              <h2 id="password-title">비밀번호 변경</h2>
            </div>
            <span className="settings-panel__status">
              {user.canChangePassword ? '이메일 계정' : 'Google 계정'}
            </span>
          </div>

          {user.canChangePassword ? (
            <form className="settings-password-form" onSubmit={handleChange} noValidate>
            <label className="settings-field">
              <span>현재 비밀번호</span>
              <input
                type="password"
                placeholder="현재 비밀번호 입력"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <label className="settings-field">
              <span>새 비밀번호</span>
              <input
                type="password"
                placeholder="8자 이상 입력"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </label>
            <label className="settings-field">
              <span>새 비밀번호 확인</span>
              <input
                type="password"
                placeholder="같은 비밀번호를 다시 입력"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </label>

            {error && <p className="settings-alert settings-alert--error" role="alert">{error}</p>}
            {success && <p className="settings-alert" role="status">{success}</p>}

            <div className="settings-password-form__footer">
              <p>새 비밀번호는 8자 이상이어야 합니다.</p>
              <button
                className="gradient-btn settings-password-form__submit"
                disabled={loading}
                type="submit"
              >
                {loading ? '변경 중...' : '비밀번호 변경'}
              </button>
            </div>
            </form>
          ) : (
            <p className="settings-alert" role="status">
              Google 로그인 계정은 별도의 비밀번호를 사용하지 않습니다.
            </p>
          )}
        </section>

        <aside className="settings-panel settings-panel--links" aria-labelledby="account-links-title">
          <div className="settings-panel__heading">
            <div>
              <p className="settings-panel__kicker">ACCOUNT</p>
              <h2 id="account-links-title">계정 관리</h2>
            </div>
          </div>

          <nav className="settings-link-list" aria-label="계정 관리 바로가기">
            <Link to="/payment">
              <span>
                <strong>변환 시간 충전</strong>
                <small>충전 상품과 분당 가격 확인</small>
              </span>
              <span aria-hidden="true">→</span>
            </Link>
            <Link to="/usage">
              <span>
                <strong>사용 내역</strong>
                <small>충전, 차감, 환불 기록 확인</small>
              </span>
              <span aria-hidden="true">→</span>
            </Link>
            <Link to="/redownload">
              <span>
                <strong>변환 재다운로드</strong>
                <small>완료된 변환과 자막 파일 다시 받기</small>
              </span>
              <span aria-hidden="true">→</span>
            </Link>
            <Link to="/support">
              <span>
                <strong>고객센터</strong>
                <small>계정과 결제 관련 문의</small>
              </span>
              <span aria-hidden="true">→</span>
            </Link>
            <Link to="/privacy">
              <span>
                <strong>개인정보처리방침</strong>
                <small>계정 정보 처리 기준 확인</small>
              </span>
              <span aria-hidden="true">→</span>
            </Link>
          </nav>
        </aside>
      </div>
    </div>
  );
}
