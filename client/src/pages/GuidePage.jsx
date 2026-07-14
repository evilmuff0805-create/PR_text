import { Link } from 'react-router-dom';

const steps = [
  {
    id: 'guide-upload',
    number: '01',
    title: '파일 업로드',
    summary: '프리뷰_자막 화면에서 음성 또는 영상 파일을 선택합니다.',
    details: [
      'mp3, wav, m4a, webm, mp4, mpeg, mpga, ogg, flac 형식을 지원합니다.',
      '파일은 최대 150MB까지 업로드할 수 있으며, 영상 파일은 오디오만 추출합니다.',
    ],
  },
  {
    id: 'guide-language',
    number: '02',
    title: '언어와 화자 선택',
    summary: '자동 감지를 사용하거나 원본 음성의 언어를 직접 선택합니다.',
    details: [
      '한국어, 영어, 일본어, 중국어를 선택할 수 있으며 자동 번역은 하지 않습니다.',
      '여러 사람이 말하는 파일은 인물 여러 명을 켭니다. 다화자 모드는 최대 20분까지 지원합니다.',
    ],
  },
  {
    id: 'guide-edit',
    number: '03',
    title: '변환과 편집',
    summary: '예상 사용 시간을 확인한 뒤 변환을 시작합니다.',
    details: [
      '변환 중에는 진행 상태가 표시되며, 다화자 작업은 새로고침 후에도 상태를 다시 불러옵니다.',
      '완료 화면에서 전체 텍스트 또는 구간별 문장을 직접 수정할 수 있습니다.',
    ],
  },
  {
    id: 'guide-download',
    number: '04',
    title: '자막 다운로드',
    summary: '편집을 마친 결과를 필요한 형식으로 내려받습니다.',
    details: [
      'SRT와 ASS는 타임스탬프를 포함하고, TXT는 텍스트만 포함합니다.',
      'ASS는 프리셋, 글자 크기, 화자 색상을 확인한 뒤 다운로드할 수 있습니다.',
    ],
  },
];

export default function GuidePage() {
  return (
    <div className="info-page">
      <header className="info-heading" aria-labelledby="guide-title">
        <p className="workspace-kicker">USER GUIDE</p>
        <div className="info-heading__row">
          <div>
            <h1 id="guide-title" className="workspace-title">음성 파일에서 자막까지</h1>
            <p className="workspace-description">
              업로드, 변환, 편집, 다운로드 순서로 필요한 작업만 빠르게 확인하세요.
            </p>
          </div>
          <div className="info-heading__actions">
            <Link className="button button--primary" to="/transcribe">변환 시작</Link>
            <Link className="button button--secondary" to="/support">문제 해결</Link>
          </div>
        </div>
      </header>

      <nav className="info-anchor-nav" aria-label="사용 단계">
        {steps.map((step) => (
          <a key={step.id} href={`#${step.id}`}>
            <span>{step.number}</span>
            {step.title}
          </a>
        ))}
      </nav>

      <section className="guide-steps" aria-label="자막 제작 순서">
        {steps.map((step) => (
          <article className="guide-step" id={step.id} key={step.id}>
            <div className="guide-step__topline">
              <span>STEP {step.number}</span>
              <span aria-hidden="true">{step.number}</span>
            </div>
            <h2>{step.title}</h2>
            <p className="guide-step__summary">{step.summary}</p>
            <ul>
              {step.details.map((detail) => <li key={detail}>{detail}</li>)}
            </ul>
          </article>
        ))}
      </section>

      <section className="info-callout" aria-labelledby="guide-credit-title">
        <div>
          <p className="info-callout__label">CREDIT CHECK</p>
          <h2 id="guide-credit-title">변환 전에 예상 사용 시간을 확인합니다</h2>
          <p>파일 길이를 기준으로 필요한 시간을 먼저 표시하고, 보유 시간보다 많으면 변환을 시작하지 않습니다.</p>
        </div>
        <Link className="button button--secondary" to="/payment">변환 시간 충전</Link>
      </section>
    </div>
  );
}
