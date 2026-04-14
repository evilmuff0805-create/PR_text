export default function TermsPage() {
  return (
    <div>
      <h2 className="gradient-text" style={{ fontSize: '1.8rem', marginBottom: '24px' }}>
        이용약관
      </h2>
      <div className="card" style={{ marginBottom: '20px' }}>
        <h3 style={{ fontSize: '1.1rem', marginBottom: '12px', color: 'var(--text-primary)' }}>서비스 이용약관</h3>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.8 }}>
          본 서비스는 음성 파일을 텍스트 및 자막으로 변환하는 서비스입니다.
          업로드된 파일은 변환 완료 후 서버에서 즉시 삭제되며 별도로 저장하지 않습니다.
          변환 결과의 정확도는 음성 품질에 따라 달라질 수 있으며, 이에 대한 책임은 사용자에게 있습니다.
        </p>
      </div>
      <div className="card" style={{ marginBottom: '20px' }}>
        <h3 style={{ fontSize: '1.1rem', marginBottom: '12px', color: 'var(--text-primary)' }}>환불 정책</h3>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.8 }}>
          결제 후 서비스를 이용하지 않은 경우 전액 환불이 가능합니다.
          서비스 이용 후에는 환불이 불가합니다.
          환불 요청은 고객센터를 통해 접수해 주세요.
        </p>
      </div>
    </div>
  );
}
