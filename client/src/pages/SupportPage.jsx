export default function SupportPage() {
  return (
    <div>
      <h2 className="gradient-text" style={{ fontSize: '1.8rem', marginBottom: '24px' }}>
        고객센터
      </h2>
      <div className="card" style={{ marginBottom: '20px' }}>
        <h3 style={{ fontSize: '1.1rem', marginBottom: '12px', color: 'var(--text-primary)' }}>문의 방법</h3>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.8 }}>
          서비스 이용 중 문제가 발생하거나 문의사항이 있으시면 아래로 연락해 주세요.
        </p>
        <div style={{ marginTop: '16px', padding: '16px', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
          <p style={{ color: 'var(--text-secondary)', lineHeight: 1.8 }}>
            이메일: codemeet@naver.com<br />
            운영시간: 평일 10:00 - 18:00
          </p>
        </div>
      </div>
      <div className="card" style={{ marginBottom: '20px' }}>
        <h3 style={{ fontSize: '1.1rem', marginBottom: '12px', color: 'var(--text-primary)' }}>자주 묻는 질문</h3>
        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.8 }}>
          <p style={{ marginBottom: '12px' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Q. 어떤 파일 형식을 지원하나요?</strong><br />
            mp3, wav, m4a, webm, mp4 파일을 지원하며, 최대 150MB까지 업로드할 수 있습니다.
          </p>
          <p style={{ marginBottom: '12px' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Q. 변환 시간은 얼마나 걸리나요?</strong><br />
            파일 크기에 따라 다르지만, 일반적으로 1~5분 정도 소요됩니다.
          </p>
          <p>
            <strong style={{ color: 'var(--text-primary)' }}>Q. 업로드한 파일은 저장되나요?</strong><br />
            아닙니다. 변환 완료 후 즉시 삭제되며, 별도로 저장하지 않습니다.
          </p>
        </div>
      </div>
    </div>
  );
}
