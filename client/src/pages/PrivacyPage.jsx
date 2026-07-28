import { Link } from 'react-router-dom';

const sections = [
  { id: 'privacy-data', number: '01', title: '처리하는 개인정보' },
  { id: 'privacy-purpose', number: '02', title: '이용 목적과 보유 기간' },
  { id: 'privacy-services', number: '03', title: '외부 서비스 이용' },
  { id: 'privacy-rights', number: '04', title: '이용자의 권리와 문의' },
  { id: 'privacy-business', number: '05', title: '사업자 정보' },
  { id: 'privacy-changes', number: '06', title: '방침 변경' },
];

function SectionHeading({ section }) {
  return (
    <div className="document-section__heading">
      <span>{section.number}</span>
      <h2 id={`${section.id}-title`}>{section.title}</h2>
    </div>
  );
}

export default function PrivacyPage() {
  return (
    <div className="info-page document-page">
      <header className="info-heading" aria-labelledby="privacy-title">
        <p className="workspace-kicker">PRIVACY POLICY</p>
        <div className="info-heading__row">
          <div>
            <h1 id="privacy-title" className="workspace-title">개인정보처리방침</h1>
            <p className="workspace-description">서비스 제공 과정에서 처리하는 정보와 이용자의 권리를 안내합니다.</p>
          </div>
          <Link className="button button--secondary" to="/support">개인정보 문의</Link>
        </div>
        <p className="info-heading__meta">시행일: 2026년 7월 22일</p>
      </header>

      <div className="document-layout">
        <aside className="document-toc" aria-label="개인정보처리방침 목차">
          <p>CONTENTS</p>
          <nav>
            {sections.map((section) => (
              <a key={section.id} href={`#${section.id}`}>
                <span>{section.number}</span>{section.title}
              </a>
            ))}
          </nav>
        </aside>

        <article className="document-content">
          <section className="document-section" id="privacy-data" aria-labelledby="privacy-data-title">
            <SectionHeading section={sections[0]} />
            <p>프리뷰 자막 머신은 서비스 제공에 필요한 최소한의 정보만 처리합니다.</p>
            <ul>
              <li>회원 정보: 이메일 주소, 서비스 사용자 식별자</li>
              <li>변환 정보: 업로드 파일명, 길이, 언어 설정, 변환 텍스트 및 세그먼트</li>
              <li>이용 정보: 사용 크레딧, 변환 횟수와 시간, 이용 시각</li>
              <li>자막 아이디어 정보: 선택한 유형, 생성 결과, 모델 사용량과 처리 시각</li>
              <li>결제 정보: 주문 번호, 상품명, 결제 금액, 결제 상태 및 결제 식별값</li>
              <li>
                무료 혜택 중복 지급 방지 정보: 이메일 또는 OAuth 제공자 식별자의 원문을 저장하지 않는
                서버 HMAC 식별값
              </li>
            </ul>
          </section>

          <section className="document-section" id="privacy-purpose" aria-labelledby="privacy-purpose-title">
            <SectionHeading section={sections[1]} />
            <p>
              수집한 정보는 회원 관리, 음성 변환 및 자막 제공, 변환 이력 제공, 크레딧 관리, 결제 확인과
              고객 문의 대응을 위해 사용합니다.
            </p>
            <ul>
              <li>
                업로드한 원본 음성 파일은 변환 처리에만 사용합니다. 서비스 데이터베이스에 영구 저장하지 않으며,
                변환 과정에서 생긴 임시 파일은 처리가 끝난 뒤 삭제합니다.
              </li>
              <li>
                자막 아이디어에 입력한 장면과 대사는 서비스 데이터베이스에 저장하지 않습니다. 생성 결과 3개는
                사용 내역 제공과 네트워크 오류 시 같은 요청 복구를 위해 최대 90일 보관한 뒤 삭제합니다. 요청 식별값과
                모델 사용량 등 원문을 포함하지 않는 운영 기록도 안정적인 서비스 제공을 위해 최대 90일 보관합니다.
              </li>
              <li>
                회원 정보, 변환 이력, 이용 및 결제 기록은 서비스 제공과 분쟁 대응에 필요한 기간 동안 보관하며,
                삭제 요청이 처리되면 관련 법령상 보관 의무가 있는 정보를 제외하고 삭제합니다.
              </li>
              <li>
                회원 탈퇴 시 계정 정보, 변환 결과와 일반 사용 내역은 삭제합니다. 관계 법령상 보관이 필요한
                결제·환불 기록은 계정 이메일과 분리하여 필요한 기간 동안 보관합니다.
              </li>
              <li>
                동일 로그인 계정에 신규 무료 혜택이 반복 지급되는 것을 방지하기 위한 HMAC 식별값은
                무료 혜택 운영 기간 동안만 보관하며, 혜택 종료 후 지체 없이 삭제합니다.
              </li>
            </ul>
          </section>

          <section className="document-section" id="privacy-services" aria-labelledby="privacy-services-title">
            <SectionHeading section={sections[2]} />
            <p>
              서비스 제공을 위해 아래 외부 서비스의 인증, 데이터베이스, 음성 변환 및 결제 기능을 이용합니다.
              개인정보를 판매하거나 광고 목적으로 제공하지 않습니다.
            </p>
            <ul>
              <li>Supabase: 회원 인증, 계정 및 서비스 이용 기록 저장</li>
              <li>OpenAI: 업로드 음성의 텍스트 변환, 화자 구분 및 자막 아이디어 생성 처리</li>
              <li>Toss Payments: 결제 승인 및 결제 결과 확인</li>
            </ul>
            <p>
              외부 서비스는 각 서비스 제공에 필요한 범위에서만 정보를 처리합니다. 결제수단의 상세 정보는
              PR_text 서버에 저장하지 않습니다. 자막 아이디어 입력문은 생성 처리를 위해 OpenAI에 전송되며,
              외부 서비스에서의 처리는 해당 제공자의 데이터 처리 기준을 따릅니다.
            </p>
          </section>

          <section className="document-section" id="privacy-rights" aria-labelledby="privacy-rights-title">
            <SectionHeading section={sections[3]} />
            <p>
              이용자는 자신의 개인정보에 대한 열람, 정정, 삭제 또는 처리 정지를 요청할 수 있습니다. 요청 및
              개인정보 관련 문의는 아래 고객센터로 보내 주세요. 법령상 보관 의무가 있는 정보는 해당 기간 동안
              보관될 수 있습니다.
            </p>
            <p>
              이메일: codemeet@naver.com
            </p>
          </section>

          <section className="document-section" id="privacy-business" aria-labelledby="privacy-business-title">
            <SectionHeading section={sections[4]} />
            <p>
              상호명: 코드밋(CodeMeet)<br />
              대표자: 석예림<br />
              사업자등록번호: 470-32-01835<br />
              통신판매업 신고번호: 제 2026-경기김포-4391 호<br />
              사업장 주소: 경기도 김포시 김포한강9로12번길 50(구래동)
            </p>
          </section>

          <section className="document-section" id="privacy-changes" aria-labelledby="privacy-changes-title">
            <SectionHeading section={sections[5]} />
            <p>
              이 방침은 서비스 또는 관련 법령의 변경에 따라 수정될 수 있으며, 중요한 변경 사항은 서비스 내에
              안내합니다.
            </p>
          </section>
        </article>
      </div>
    </div>
  );
}
