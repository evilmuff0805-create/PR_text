import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useDialogAccessibility } from '../utils/use-dialog-accessibility.js';

export default function SettingsPage() {
  const { user, getToken, replaceToken, loginWithGoogle, clearSession } = useAuth();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [deletionPreview, setDeletionPreview] = useState(null);
  const [deletionPreviewError, setDeletionPreviewError] = useState('');
  const [deletionOpen, setDeletionOpen] = useState(false);
  const [deletionEmail, setDeletionEmail] = useState('');
  const [deletionPassword, setDeletionPassword] = useState('');
  const [deletionConsent, setDeletionConsent] = useState(false);
  const [deletionError, setDeletionError] = useState('');
  const [deletionLoading, setDeletionLoading] = useState(false);
  const deletionDialogRef = useRef(null);
  const deletionTriggerRef = useRef(null);
  const deletionCloseRef = useRef(null);

  const closeDeletion = useCallback(() => {
    if (deletionLoading) return;
    setDeletionOpen(false);
    setDeletionError('');
  }, [deletionLoading]);

  useDialogAccessibility({
    active: deletionOpen,
    containerRef: deletionDialogRef,
    initialFocusRef: deletionCloseRef,
    onClose: closeDeletion,
    restoreFocusRef: deletionTriggerRef,
    closeOnEscape: !deletionLoading,
  });

  const loadDeletionPreview = useCallback(async () => {
    if (!user) return;
    setDeletionPreviewError('');
    try {
      const res = await fetch('/api/account/deletion-preview', {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setDeletionPreview(data);
    } catch (previewError) {
      setDeletionPreview(null);
      setDeletionPreviewError(previewError.message || '탈퇴 가능 여부를 확인하지 못했습니다.');
    }
  }, [getToken, user]);

  useEffect(() => {
    loadDeletionPreview();
  }, [loadDeletionPreview]);

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

  const openDeletion = () => {
    setDeletionError('');
    setDeletionEmail('');
    setDeletionPassword('');
    setDeletionConsent(false);
    setDeletionOpen(true);
    loadDeletionPreview();
  };

  const handleDeleteAccount = async (event) => {
    event.preventDefault();
    setDeletionError('');

    if (!deletionConsent) {
      return setDeletionError('탈퇴 시 삭제되는 정보와 크레딧 소멸 내용을 확인해주세요.');
    }

    setDeletionLoading(true);
    try {
      const res = await fetch('/api/account', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({
          confirmationEmail: deletionEmail,
          currentPassword: deletionPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.preview) setDeletionPreview(data.preview);
        throw new Error(data.error);
      }

      clearSession();
      navigate('/', { replace: true, state: { accountDeleted: true } });
    } catch (deleteError) {
      setDeletionError(deleteError.message || '회원 탈퇴를 완료하지 못했습니다.');
    } finally {
      setDeletionLoading(false);
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

      <section className="settings-danger" aria-labelledby="account-deletion-title">
        <div>
          <p className="settings-panel__kicker">ACCOUNT DELETION</p>
          <h2 id="account-deletion-title">회원 탈퇴</h2>
          <p>
            변환 결과와 사용 내역은 삭제되며, 법령상 보관이 필요한 결제 기록은 계정 정보와 분리해 보관합니다.
          </p>
          {deletionPreviewError && (
            <p className="settings-alert settings-alert--error" role="alert">{deletionPreviewError}</p>
          )}
        </div>
        <button ref={deletionTriggerRef} className="button settings-danger__button" type="button" onClick={openDeletion}>
          회원 탈퇴
        </button>
      </section>

      {deletionOpen && (
        <div className="settings-dialog-backdrop" role="presentation" onMouseDown={closeDeletion}>
          <section
            ref={deletionDialogRef}
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="deletion-dialog-title"
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="settings-dialog__heading">
              <div>
                <p className="settings-panel__kicker">FINAL CONFIRMATION</p>
                <h2 id="deletion-dialog-title">정말 탈퇴하시겠습니까?</h2>
              </div>
              <button
                ref={deletionCloseRef}
                className="settings-dialog__close"
                type="button"
                onClick={closeDeletion}
                aria-label="닫기"
              >
                ×
              </button>
            </div>

            {!deletionPreview ? (
              <p className="settings-dialog__loading">탈퇴 가능 여부를 확인하고 있습니다...</p>
            ) : !deletionPreview.canDelete ? (
              <div className="settings-deletion-blocked">
                <p className="settings-alert settings-alert--error" role="alert">
                  {deletionPreview.blockerMessage}
                </p>
                <p>결제 또는 변환 작업을 정리한 뒤 다시 확인해주세요.</p>
                <div className="settings-dialog__actions">
                  <Link className="button button--secondary" to="/payment" onClick={closeDeletion}>
                    결제 내역 확인
                  </Link>
                  <Link className="button button--secondary" to="/support" onClick={closeDeletion}>
                    고객센터
                  </Link>
                </div>
              </div>
            ) : deletionPreview.requiresRecentLogin ? (
              <div className="settings-deletion-blocked">
                <p>계정 보호를 위해 최근 10분 이내의 Google 인증이 필요합니다.</p>
                <button
                  className="gradient-btn"
                  type="button"
                  onClick={() => loginWithGoogle('/settings')}
                >
                  Google로 다시 인증
                </button>
              </div>
            ) : (
              <form className="settings-deletion-form" onSubmit={handleDeleteAccount}>
                <div className="settings-deletion-summary">
                  <strong>탈퇴하면 다음 정보가 삭제됩니다.</strong>
                  <ul>
                    <li>계정 정보와 로그인 권한</li>
                    <li>변환 결과, 자막 세그먼트 및 재다운로드 내역</li>
                    <li>일반 사용 내역과 임시 오디오 파일</li>
                  </ul>
                </div>

                {deletionPreview.credits > 0 && (
                  <p className="settings-alert settings-alert--error">
                    현재 잔여 무료 크레딧 {deletionPreview.credits.toLocaleString()}분은 탈퇴 즉시 소멸하며
                    복구하거나 환불받을 수 없습니다.
                  </p>
                )}

                <p className="settings-alert">
                  탈퇴 후 같은 로그인 계정으로 다시 가입할 수 있지만, 신규 가입 무료 10분은 다시 지급되지 않습니다.
                </p>

                <label className="settings-field">
                  <span>계정 이메일 확인</span>
                  <input
                    type="email"
                    value={deletionEmail}
                    onChange={(event) => setDeletionEmail(event.target.value)}
                    placeholder={user.email}
                    autoComplete="email"
                    required
                  />
                </label>

                {deletionPreview.confirmationMethod === 'password' && (
                  <label className="settings-field">
                    <span>현재 비밀번호</span>
                    <input
                      type="password"
                      value={deletionPassword}
                      onChange={(event) => setDeletionPassword(event.target.value)}
                      placeholder="현재 비밀번호 입력"
                      autoComplete="current-password"
                      required
                    />
                  </label>
                )}

                <label className="settings-deletion-consent">
                  <input
                    type="checkbox"
                    checked={deletionConsent}
                    onChange={(event) => setDeletionConsent(event.target.checked)}
                  />
                  <span>
                    삭제되는 정보, 잔여 무료 크레딧 소멸 및 재가입 시 무료 10분 미지급 내용을 확인했습니다.
                  </span>
                </label>

                {deletionError && (
                  <p className="settings-alert settings-alert--error" role="alert">{deletionError}</p>
                )}

                <div className="settings-dialog__actions">
                  <button className="button button--secondary" type="button" onClick={closeDeletion}>
                    취소
                  </button>
                  <button
                    className="button settings-danger__button"
                    type="submit"
                    disabled={deletionLoading || !deletionConsent}
                  >
                    {deletionLoading ? '탈퇴 처리 중...' : '회원 탈퇴 완료'}
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
