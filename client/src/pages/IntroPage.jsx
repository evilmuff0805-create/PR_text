import { useEffect } from 'react';

export default function IntroPage() {
  useEffect(() => {
    localStorage.setItem('visited', 'true');
  }, []);

  return (
    <div>
      <h2 className="gradient-text" style={{ fontSize: '1.8rem', marginBottom: '24px' }}>
        프리뷰 자막 머신
      </h2>
      <div className="card" style={{ marginBottom: '20px' }}>
        <h3 style={{ fontSize: '1.1rem', marginBottom: '12px', color: 'var(--text-primary)' }}>프리뷰 자막 머신 V.1.0</h3>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.8 }}>
          음성 파일을 업로드하면 AI가 자동으로 텍스트로 변환하고, 맞춤법을 교정한 뒤, SRT/TXT/ASS 자막 파일로 다운로드할 수 있는 서비스입니다. AI가 불필요한 단어를 자동 삭제하여 정확도 95% 이상의 깔끔한 자막을 제공합니다.
        </p>
        <div style={{
          marginTop: '16px',
          background: 'rgba(99, 102, 241, 0.15)',
          border: '1px solid rgba(99, 102, 241, 0.4)',
          borderRadius: '10px',
          padding: '20px',
          color: '#A855F7',
          fontWeight: 600,
          lineHeight: 1.8,
        }}>
          🎬 SRT 자막 파일을 영상 편집 프로그램에 불러오면, 오디오 싱크에 맞춰 자동으로 자막이 삽입됩니다. 별도의 타이밍 작업 없이 바로 사용할 수 있습니다.
        </div>
      </div>
      <div className="card" style={{ marginBottom: '20px' }}>
        <h3 style={{ fontSize: '1.1rem', marginBottom: '12px', color: 'var(--text-primary)' }}>지원 기능</h3>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.8 }}>
          • 한국어 음성 → 텍스트 변환 + 맞춤법 교정<br />
          • 일본어/중국어 음성 → 한국어 번역 자막<br />
          • 영어 음성 → 텍스트 변환<br />
          • 최대 150MB 오디오 파일 지원 (약 109분)<br />
          • SRT, TXT, ASS 자막 포맷 다운로드<br />
          • 변환 결과 직접 편집 가능
        </p>
      </div>
    </div>
  );
}
