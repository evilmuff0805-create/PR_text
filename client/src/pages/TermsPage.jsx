export default function TermsPage() {
  return (
    <div>
      <h2 className="gradient-text" style={{ fontSize: '1.8rem', marginBottom: '24px' }}>
        이용약관
      </h2>

      {/* 환불 규정 (이용약관 상단 명시) */}
      <div className="card" style={{ marginBottom: '20px' }}>
        <h3 style={{ fontSize: '1.1rem', marginBottom: '12px', color: 'var(--text-primary)' }}>환불 규정</h3>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.8 }}>
          본 서비스는 음성을 텍스트·자막으로 변환하는 디지털 콘텐츠 서비스로, 변환을 실행하여
          결과물(텍스트·자막)을 제공받은 사용분에 대해서는 환불이 제한됩니다.
        </p>
        <ul style={{ color: 'var(--text-secondary)', lineHeight: 1.9, paddingLeft: '20px', marginTop: '12px' }}>
          <li>
            <strong style={{ color: 'var(--text-primary)' }}>이용 전 환불</strong> — 결제 후 변환 서비스를
            한 번도 이용하지 않은 경우, 결제일로부터 7일 이내 전액 환불이 가능합니다.
          </li>
          <li>
            <strong style={{ color: 'var(--text-primary)' }}>회사 귀책사유</strong> — 결제 오류 또는 회사의
            귀책사유로 서비스가 정상 제공되지 않은 경우 전액 환불됩니다.
          </li>
          <li>
            환불 신청은 고객센터(이메일)를 통해 접수해 주세요.
          </li>
        </ul>
      </div>

      <div className="card" style={{ marginBottom: '20px' }}>
        <h3 style={{ fontSize: '1.1rem', marginBottom: '12px', color: 'var(--text-primary)' }}>서비스 이용약관</h3>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.8 }}>
          본 서비스는 음성 파일을 텍스트 및 자막으로 변환하는 서비스입니다.
          업로드된 원본 음성 파일은 변환 과정에서만 사용하고, 변환 완료 후 서비스 데이터베이스에 영구
          저장하지 않습니다. 이용자가 결과를 확인할 수 있도록 변환 이력과 사용·결제 기록은
          개인정보처리방침에 정한 범위에서 보관합니다.
          변환 결과의 정확도는 음성 품질에 따라 달라질 수 있으며, 이에 대한 책임은 사용자에게 있습니다.
        </p>
      </div>
    </div>
  );
}
