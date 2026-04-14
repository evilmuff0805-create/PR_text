export default function GuidePage() {
  return (
    <div>
      <h2 className="gradient-text" style={{ fontSize: '1.8rem', marginBottom: '24px' }}>
        사용법
      </h2>
      <div className="card" style={{ marginBottom: '20px' }}>
        <h3 style={{ fontSize: '1.1rem', marginBottom: '12px', color: 'var(--text-primary)' }}>Step 1. 파일 업로드</h3>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.8 }}>
          좌측 사이드바에서 "프리뷰_자막"을 클릭한 뒤, 오디오 파일을 드래그하거나 클릭하여 업로드합니다.
          지원 형식: mp3, wav, m4a, webm, mp4 (최대 150MB)
        </p>
      </div>
      <div className="card" style={{ marginBottom: '20px' }}>
        <h3 style={{ fontSize: '1.1rem', marginBottom: '12px', color: 'var(--text-primary)' }}>Step 2. 언어 선택</h3>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.8 }}>
          자동 감지를 사용하거나, 한국어/영어/일본어/중국어 중 선택할 수 있습니다.
          일본어·중국어를 선택하면 한국어 번역 자막이 생성됩니다.
        </p>
      </div>
      <div className="card" style={{ marginBottom: '20px' }}>
        <h3 style={{ fontSize: '1.1rem', marginBottom: '12px', color: 'var(--text-primary)' }}>Step 3. 변환 및 편집</h3>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.8 }}>
          "변환 시작" 버튼을 누르면 AI가 음성을 텍스트로 변환하고 맞춤법을 교정합니다.
          결과 화면에서 텍스트를 직접 수정할 수 있습니다.
        </p>
      </div>
      <div className="card" style={{ marginBottom: '20px' }}>
        <h3 style={{ fontSize: '1.1rem', marginBottom: '12px', color: 'var(--text-primary)' }}>Step 4. 다운로드</h3>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.8 }}>
          SRT, TXT, ASS 중 원하는 자막 형식을 선택하여 다운로드합니다.
          SRT와 ASS는 타임스탬프가 포함된 자막 파일이며, TXT는 텍스트만 포함됩니다.
        </p>
      </div>
    </div>
  );
}
