import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

const featureRows = [
  {
    index: '01',
    title: '원문을 먼저 지킵니다',
    description: '한국어 맞춤법과 띄어쓰기를 다듬되, 말투와 문맥을 임의로 바꾸거나 다른 언어로 번역하지 않습니다.',
  },
  {
    index: '02',
    title: '편집 가능한 결과를 만듭니다',
    description: '전체 텍스트와 구간별 자막을 바로 확인하고 수정한 뒤, 편집한 내용 그대로 파일에 반영할 수 있습니다.',
  },
  {
    index: '03',
    title: '작업에 맞는 파일로 끝냅니다',
    description: 'SRT, TXT, ASS를 지원해 영상 편집, 원고 정리, 스타일 자막 작업까지 하나의 흐름으로 이어집니다.',
  },
  {
    index: '04',
    title: '장면에 맞는 자막을 제안합니다',
    description: '장면이나 대사를 입력하면 예능, 상황, 감성의 결에 맞춘 서로 다른 짧은 자막 후보 3개를 제안합니다.',
  },
];

const workflow = [
  ['01', '파일 선택', '휴대폰 녹음과 영상 파일을 올리고 예상 차감 시간을 확인합니다.'],
  ['02', '변환·정리', '음성을 구간별 텍스트로 만들고 필요한 맞춤법을 정리합니다.'],
  ['03', '편집·다운로드', '결과를 직접 손본 뒤 원하는 자막 형식으로 내려받습니다.'],
];

function LandingHeroVideo() {
  const videoRef = useRef(null);
  const [canPlayVideo, setCanPlayVideo] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);

  useEffect(() => {
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const desktopViewport = window.matchMedia?.('(min-width: 769px)');
    const connection = navigator.connection;
    const updatePlaybackPreference = () => {
      setCanPlayVideo(
        !reducedMotion?.matches
        && desktopViewport?.matches !== false
        && !connection?.saveData,
      );
    };

    updatePlaybackPreference();
    reducedMotion?.addEventListener?.('change', updatePlaybackPreference);
    desktopViewport?.addEventListener?.('change', updatePlaybackPreference);
    connection?.addEventListener?.('change', updatePlaybackPreference);

    return () => {
      reducedMotion?.removeEventListener?.('change', updatePlaybackPreference);
      desktopViewport?.removeEventListener?.('change', updatePlaybackPreference);
      connection?.removeEventListener?.('change', updatePlaybackPreference);
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !canPlayVideo) return undefined;

    const playVideo = () => {
      try {
        video.play()?.catch?.(() => {});
      } catch {
        setVideoFailed(true);
      }
    };

    if (typeof IntersectionObserver === 'undefined') {
      playVideo();
      return undefined;
    }

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        playVideo();
      } else {
        video.pause();
      }
    }, { threshold: 0.1 });

    observer.observe(video);
    return () => observer.disconnect();
  }, [canPlayVideo]);

  if (!canPlayVideo || videoFailed) return null;

  return (
    <video
      ref={videoRef}
      className="landing-hero__media landing-hero__media--video"
      autoPlay
      muted
      loop
      playsInline
      preload="metadata"
      aria-hidden="true"
      tabIndex={-1}
      disablePictureInPicture
      onError={() => setVideoFailed(true)}
    >
      <source src="/videos/landing.mp4" type="video/mp4" />
    </video>
  );
}

function ProductPreview() {
  return (
    <div className="product-stage" aria-label="프리뷰 자막 머신 편집 화면 예시">
      <div className="product-stage__topbar">
        <div className="product-stage__file">
          <span className="status-dot" aria-hidden="true" />
          <span>인터뷰_초안.m4a</span>
        </div>
        <span className="product-stage__status">변환 완료</span>
      </div>

      <div className="product-stage__meta">
        <div>
          <small>감지 언어</small>
          <strong>한국어</strong>
        </div>
        <div>
          <small>구간</small>
          <strong>48개</strong>
        </div>
        <div>
          <small>길이</small>
          <strong>04:32</strong>
        </div>
      </div>

      <div className="editor-preview">
        <div className="editor-preview__rail" aria-hidden="true">
          <span>00:00</span>
          <span>00:08</span>
          <span>00:15</span>
        </div>
        <div className="editor-preview__transcript">
          <div className="transcript-row is-active">
            <span className="speaker speaker--one">화자 1</span>
            <p>오늘은 첫 장면의 분위기부터 같이 맞춰볼게요.</p>
          </div>
          <div className="transcript-row">
            <span className="speaker speaker--two">화자 2</span>
            <p>좋아요. 원래 말한 느낌은 그대로 남겨주세요.</p>
          </div>
          <div className="transcript-row">
            <span className="speaker speaker--one">화자 1</span>
            <p>맞춤법만 정리하고 자막 길이를 확인하겠습니다.</p>
          </div>
        </div>
      </div>

      <div className="product-stage__footer">
        <span>자동 저장됨</span>
        <div className="format-pills" aria-label="다운로드 지원 형식">
          <span>SRT</span>
          <span>TXT</span>
          <span>ASS</span>
        </div>
      </div>
    </div>
  );
}

export default function IntroPage() {
  const location = useLocation();

  return (
    <div className="intro-page">
      {location.state?.accountDeleted && (
        <p className="landing-notice" role="status">회원 탈퇴가 완료되었습니다.</p>
      )}
      <section className="landing-hero" aria-labelledby="landing-title">
        <picture className="landing-hero__media landing-hero__media--image" aria-hidden="true">
          <source
            media="(max-width: 768px)"
            srcSet="/images/hero-editor-mobile.webp"
            type="image/webp"
          />
          <img
            src="/images/hero-editor-desktop.webp"
            alt=""
            width="1672"
            height="941"
            decoding="async"
            fetchpriority="high"
          />
        </picture>
        <LandingHeroVideo />
        <div className="landing-hero__veil" aria-hidden="true" />

        <div className="landing-hero__copy">
          <p className="eyebrow">음성·영상 자막 편집 도구 <span>V.1.1</span></p>
          <h1 id="landing-title">프리뷰 자막 머신</h1>
          <p className="landing-hero__statement">
            자막에서 자유롭고 싶은 편집자라면?
          </p>
          <p className="landing-hero__description">
            유튜브 편집부터 휴대폰 녹음까지, 빠르면 1분 안에 자막을 완성하세요.
            원문의 말투를 살리고 맞춤법까지 다듬은 파일을 바로 편집하고 내려받을 수 있습니다.
          </p>

          <div className="landing-hero__actions">
            <Link className="button button--primary" to="/transcribe">변환 시작하기</Link>
            <Link className="button button--secondary" to="/guide">사용법 보기</Link>
          </div>

          <dl className="hero-facts">
            <div>
              <dt>지원 파일</dt>
              <dd>m4a · mp4 · mp3 · wav</dd>
            </div>
            <div>
              <dt>결과 형식</dt>
              <dd>SRT · TXT · ASS</dd>
            </div>
            <div>
              <dt>작업 방식</dt>
              <dd>원문 보존 · 직접 편집</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="landing-section landing-product-proof" aria-labelledby="product-proof-title">
        <div className="section-heading landing-product-proof__copy">
          <p className="eyebrow">실제 편집 흐름</p>
          <h2 id="product-proof-title">변환한 뒤에도,<br />내가 끝까지 다듬을 수 있게.</h2>
          <p>
            구간별 문장과 화자를 확인하고 직접 수정하세요. 편집한 내용은
            SRT, TXT, ASS 다운로드 파일에 그대로 반영됩니다.
          </p>
        </div>
        <ProductPreview />
      </section>

      <section id="features" className="landing-section feature-section" aria-labelledby="feature-title">
        <div className="section-heading">
          <p className="eyebrow">편집 작업을 위한 기준</p>
          <h2 id="feature-title">원문은 지키고,<br />손이 가는 과정은 줄입니다.</h2>
          <p>빠르게 만드는 것만큼, 결과를 다시 다룰 수 있는지가 중요하니까요.</p>
        </div>

        <div className="feature-list">
          {featureRows.map((feature) => (
            <article className="feature-row" key={feature.index}>
              <span className="feature-row__index">{feature.index}</span>
              <h3>{feature.title}</h3>
              <p>{feature.description}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="workflow" className="workflow-band" aria-labelledby="workflow-title">
        <div className="landing-section workflow-section">
          <div className="section-heading section-heading--compact">
            <p className="eyebrow">하나의 작업 흐름</p>
            <h2 id="workflow-title">올리고, 확인하고, 내려받기</h2>
          </div>

          <ol className="workflow-list">
            {workflow.map(([index, title, description]) => (
              <li key={index}>
                <span>{index}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{description}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="formats" className="landing-section format-section" aria-labelledby="format-title">
        <div className="section-heading section-heading--compact">
          <p className="eyebrow">작업별 결과 형식</p>
          <h2 id="format-title">필요한 다음 단계에 맞춰 받으세요.</h2>
        </div>

        <div className="format-table" role="table" aria-label="자막 결과 형식">
          <div className="format-row" role="row">
            <strong role="cell">SRT</strong>
            <span role="cell">Premiere Pro, YouTube 등 편집·업로드용 표준 자막</span>
            <span role="cell">타임코드 포함</span>
          </div>
          <div className="format-row" role="row">
            <strong role="cell">TXT</strong>
            <span role="cell">원고 정리, 검토, 공유를 위한 전체 텍스트</span>
            <span role="cell">편집 내용 반영</span>
          </div>
          <div className="format-row" role="row">
            <strong role="cell">ASS</strong>
            <span role="cell">폰트, 위치, 화자 색상까지 지정하는 스타일 자막</span>
            <span role="cell">스타일 포함</span>
          </div>
        </div>
      </section>

      <section className="closing-band" aria-labelledby="closing-title">
        <div>
          <p className="eyebrow">충전한 시간은 만료되지 않습니다</p>
          <h2 id="closing-title">필요한 만큼 변환하고,<br />결과는 원하는 만큼 다듬으세요.</h2>
        </div>
        <div className="closing-band__actions">
          <Link className="button button--primary" to="/transcribe">첫 파일 변환하기</Link>
          <Link className="text-link" to="/payment">요금 확인</Link>
        </div>
      </section>
    </div>
  );
}

