import { Link } from 'react-router-dom';

export default function TermsPage() {
  return (
    <div className="info-page document-page">
      <header className="info-heading" aria-labelledby="terms-title">
        <p className="workspace-kicker">TERMS OF SERVICE</p>
        <div className="info-heading__row">
          <div>
            <h1 id="terms-title" className="workspace-title">이용약관</h1>
            <p className="workspace-description">서비스 이용과 환불에 적용되는 기준을 안내합니다.</p>
          </div>
          <Link className="button button--secondary" to="/support">고객센터</Link>
        </div>
        <p className="info-heading__meta">시행일: 2026년 7월 16일</p>
      </header>

      <div className="document-layout">
        <aside className="document-toc" aria-label="이용약관 목차">
          <p>CONTENTS</p>
          <nav>
            <a href="#terms-refund"><span>01</span>환불 규정</a>
            <a href="#terms-service"><span>02</span>서비스 이용약관</a>
            <a href="#terms-withdrawal"><span>03</span>회원 탈퇴</a>
          </nav>
        </aside>

        <article className="document-content">
          <section className="document-section document-section--featured" id="terms-refund" aria-labelledby="terms-refund-title">
            <div className="document-section__heading">
              <span>01</span>
              <h2 id="terms-refund-title">환불 규정</h2>
            </div>
            <p>
              본 서비스는 음성을 텍스트·자막으로 변환하는 디지털 콘텐츠 서비스로, 변환을 실행하여
              결과물(텍스트·자막)을 제공받은 사용분에 대해서는 환불이 제한됩니다.
            </p>
            <ul>
              <li>
                <strong>이용 전 환불</strong>
                결제 후 변환 서비스를 한 번도 이용하지 않은 경우, 결제일로부터 7일 이내 전액 환불이 가능합니다.
              </li>
              <li>
                <strong>회사 귀책사유</strong>
                결제 오류 또는 회사의 귀책사유로 서비스가 정상 제공되지 않은 경우 전액 환불됩니다.
              </li>
              <li>
                <strong>일부 이용 후 환불</strong>
                결제한 변환 시간을 일부 이용한 경우에는 사용분과 관련 법령상 공제 금액을 반영하여 환불 가능
                여부를 확인합니다. 자동 환불이 지원되지 않는 경우 고객센터에서 개별 검토합니다.
              </li>
              <li>
                <strong>환불 신청</strong>
                환불 신청은 고객센터(이메일)를 통해 접수해 주세요.
              </li>
            </ul>
          </section>

          <section className="document-section" id="terms-service" aria-labelledby="terms-service-title">
            <div className="document-section__heading">
              <span>02</span>
              <h2 id="terms-service-title">서비스 이용약관</h2>
            </div>
            <p>
              본 서비스는 음성 파일을 텍스트 및 자막으로 변환하는 서비스입니다.
              업로드된 원본 음성 파일은 변환 과정에서만 사용하고, 변환 완료 후 서비스 데이터베이스에 영구
              저장하지 않습니다. 이용자가 결과를 확인할 수 있도록 변환 이력과 사용·결제 기록은
              개인정보처리방침에 정한 범위에서 보관합니다.
              변환 결과의 정확도는 음성 품질에 따라 달라질 수 있으며, 이에 대한 책임은 사용자에게 있습니다.
            </p>
          </section>

          <section className="document-section" id="terms-withdrawal" aria-labelledby="terms-withdrawal-title">
            <div className="document-section__heading">
              <span>03</span>
              <h2 id="terms-withdrawal-title">회원 탈퇴</h2>
            </div>
            <p>
              무료 또는 이벤트로 지급된 잔여 변환 시간은 회원 탈퇴와 동시에 소멸하며 복구하거나 환불받을 수
              없습니다. 결제한 변환 시간이 남아 있거나 결제·환불 처리가 진행 중인 경우에는 환불 가능 여부와
              정산 상태를 먼저 확인한 뒤 탈퇴할 수 있습니다.
            </p>
            <p>
              탈퇴가 완료되면 계정과 변환 결과는 삭제됩니다. 관계 법령상 보관이 필요한 결제 및 환불 기록은
              계정 식별정보와 분리하여 필요한 기간 동안 보관할 수 있습니다.
            </p>
          </section>

          <div className="document-contact">
            <div>
              <strong>환불 또는 이용 문의</strong>
              <span>codemeet@naver.com · 평일 10:00 - 18:00</span>
            </div>
            <a href="mailto:codemeet@naver.com">이메일 보내기</a>
          </div>
        </article>
      </div>
    </div>
  );
}
