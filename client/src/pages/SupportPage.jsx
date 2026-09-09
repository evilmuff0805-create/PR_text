import { Link } from 'react-router-dom';
import { supportFaqs as faqs } from '../content/support-faqs.js';


export default function SupportPage() {
  return (
    <div className="info-page">
      <header className="info-heading" aria-labelledby="support-title">
        <p className="workspace-kicker">SUPPORT</p>
        <div className="info-heading__row">
          <div>
            <h1 id="support-title" className="workspace-title">고객센터</h1>
            <p className="workspace-description">서비스 이용 중 막힌 부분을 확인하고 필요한 도움을 요청하세요.</p>
          </div>
          <a className="button button--primary" href="mailto:codemeet@naver.com">이메일 문의</a>
        </div>
      </header>

      <section className="support-contact" aria-labelledby="support-contact-title">
        <div className="support-contact__intro">
          <p className="support-contact__label">CONTACT</p>
          <h2 id="support-contact-title">문의 방법</h2>
          <p>문제 상황과 파일 형식, 화면에 표시된 오류 내용을 함께 보내주시면 확인에 도움이 됩니다.</p>
        </div>
        <dl>
          <div>
            <dt>이메일</dt>
            <dd><a href="mailto:codemeet@naver.com">codemeet@naver.com</a></dd>
          </div>
          <div>
            <dt>운영시간</dt>
            <dd>평일 10:00 - 18:00</dd>
          </div>
        </dl>
      </section>

      <div className="support-layout">
        <section className="support-faq" aria-labelledby="support-faq-title">
          <div className="section-heading">
            <p className="section-heading__eyebrow">QUICK ANSWERS</p>
            <h2 id="support-faq-title">자주 묻는 질문</h2>
          </div>
          <div className="support-faq__list">
            {faqs.map((faq, index) => (
              <details key={faq.question} open={index === 0}>
                <summary>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <strong>{faq.question}</strong>
                  <span className="support-faq__indicator" aria-hidden="true">+</span>
                </summary>
                <p>{faq.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <aside className="support-links" aria-labelledby="support-links-title">
          <p className="section-heading__eyebrow">RELATED</p>
          <h2 id="support-links-title">함께 확인하기</h2>
          <nav aria-label="관련 안내">
            <Link to="/guide">
              <strong>사용법</strong>
              <span>업로드부터 다운로드까지</span>
            </Link>
            <Link to="/terms">
              <strong>환불 규정</strong>
              <span>이용 전 환불 기준 확인</span>
            </Link>
            <Link to="/privacy">
              <strong>개인정보처리방침</strong>
              <span>파일과 기록의 보관 기준</span>
            </Link>
          </nav>
        </aside>
      </div>
    </div>
  );
}
