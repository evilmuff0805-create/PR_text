import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function PasswordResetPage() {
  const { recoverySession, recoveryError, completePasswordRecovery } = useAuth();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [completed, setCompleted] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');

    if (newPassword.length < 8) {
      return setError('비밀번호는 8자 이상이어야 합니다.');
    }
    if (newPassword !== confirmPassword) {
      return setError('새 비밀번호가 일치하지 않습니다.');
    }

    setLoading(true);
    try {
      await completePasswordRecovery(newPassword);
      setNewPassword('');
      setConfirmPassword('');
      setCompleted(true);
    } catch (submitError) {
      setError(submitError.message || '비밀번호 재설정을 완료하지 못했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="settings-page password-recovery-page">
      <section className="settings-heading" aria-labelledby="password-recovery-title">
        <p className="workspace-kicker">ACCOUNT RECOVERY</p>
        <h1 id="password-recovery-title" className="workspace-title">비밀번호 재설정</h1>
        <p className="workspace-description">새 비밀번호를 설정한 뒤 다시 로그인합니다.</p>
      </section>

      <section className="settings-panel password-recovery-panel">
        {completed ? (
          <div className="password-recovery-result" role="status">
            <p className="settings-panel__kicker">PASSWORD UPDATED</p>
            <h2>비밀번호가 변경되었습니다</h2>
            <p>이 화면의 임시 인증 정보를 삭제했습니다. 새 비밀번호로 다시 로그인해주세요.</p>
            <Link
              className="button button--primary"
              to="/transcribe"
              state={{ openAuth: true }}
            >
              로그인 화면으로 이동
            </Link>
          </div>
        ) : !recoverySession ? (
          <div className="password-recovery-result" role="alert">
            <p className="settings-panel__kicker">LINK REQUIRED</p>
            <h2>재설정 링크를 다시 확인해주세요</h2>
            <p className="settings-alert settings-alert--error">
              {recoveryError || '재설정 링크가 만료되었거나 이미 사용되었습니다.'}
            </p>
            <p>로그인 화면에서 비밀번호 재설정 메일을 다시 요청할 수 있습니다.</p>
            <Link
              className="button button--secondary"
              to="/transcribe"
              state={{ openAuth: true }}
            >
              로그인 화면으로 돌아가기
            </Link>
          </div>
        ) : (
          <>
            <div className="settings-panel__heading">
              <div>
                <p className="settings-panel__kicker">NEW PASSWORD</p>
                <h2>새 비밀번호 입력</h2>
              </div>
              <span className="settings-panel__status">8자 이상</span>
            </div>

            <form className="settings-password-form" onSubmit={handleSubmit} noValidate>
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

              {(error || recoveryError) && (
                <p className="settings-alert settings-alert--error" role="alert">
                  {error || recoveryError}
                </p>
              )}

              <div className="settings-password-form__footer">
                <p>변경 후 이 화면의 임시 인증 정보가 삭제되며 다시 로그인해야 합니다.</p>
                <button
                  className="gradient-btn settings-password-form__submit"
                  disabled={loading}
                  type="submit"
                >
                  {loading ? '변경 중...' : '비밀번호 재설정'}
                </button>
              </div>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
