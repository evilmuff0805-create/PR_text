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
          음성 파일을 업로드하면 자동으로 텍스트로 변환하고, 맞춤법을 교정한 뒤, SRT/TXT/ASS 자막 파일로 다운로드할 수 있는 서비스입니다. 95% 이상의 정확도를 보여주는 깔끔한 자막을 제공합니다.
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
        <div style={{
          marginTop: '16px',
          background: 'rgba(99, 102, 241, 0.15)',
          border: '1px solid rgba(99, 102, 241, 0.4)',
          borderRadius: '12px',
          padding: '20px',
          color: '#A855F7',
          fontWeight: 600,
          lineHeight: 1.8,
        }}>
          <strong>🎞️ Premiere Pro에서 내 자막 디자인 그대로 적용하기</strong>
          <p style={{ fontWeight: 400, margin: '8px 0 0' }}>
            다운로드한 SRT 파일을 Premiere Pro에 불러오면 캡션 트랙이 자동 생성됩니다. Essential Graphics 패널에서 기존에 사용하던 자막 스타일(폰트, 색상, 배경)을 하나만 설정하면, 전체 자막에 일괄 적용할 수 있습니다.
          </p>
          <p style={{ fontWeight: 400, margin: '4px 0 0' }}>
            타이밍 작업은 이미 끝나 있으니, 디자인만 입히면 완성입니다.
          </p>
          <p style={{ fontSize: '0.75rem', color: '#999', fontWeight: 400, margin: '8px 0 0' }}>
            ※ 캡션 스타일 일괄 적용은 Premiere Pro 2021 이후 버전에서 지원됩니다.
          </p>
        </div>
        <div style={{
          marginTop: '16px',
          background: 'rgba(99, 102, 241, 0.15)',
          border: '1px solid rgba(99, 102, 241, 0.4)',
          borderRadius: '12px',
          padding: '20px',
          color: '#A855F7',
          fontWeight: 600,
          lineHeight: 1.8,
        }}>
          <strong>🎨 ASS 자막 – 스타일까지 포함된 자막 파일</strong>
          <p style={{ fontWeight: 400, margin: '8px 0 0' }}>
            폰트, 크기, 색상, 외곽선, 그림자, 위치를 파일 자체에 지정하여 다운로드 즉시 스타일이 적용됩니다. 사이트 내 실시간 미리보기로 원하는 디자인을 확인한 뒤 다운로드할 수 있습니다.
          </p>
          <p style={{ fontWeight: 400, margin: '4px 0 0' }}>
            DaVinci Resolve에서 바로 import 가능하며, VLC·PotPlayer 등 영상 플레이어에서도 스타일 그대로 재생됩니다. 편집 프로그램 없이 완성된 자막이 필요할 때 적합합니다.
          </p>
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
          • 변환 결과 직접 편집 가능<br />
          • 사용 내역에서 크레딧 사용 내역 확인 및 이전 변환 텍스트 재다운로드 가능
        </p>
      </div>
    </div>
  );
}
