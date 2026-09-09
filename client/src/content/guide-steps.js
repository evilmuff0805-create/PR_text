import { DIARIZATION_MAX_MINUTES } from '../utils/upload-validation.js';

// Shared by the rendered guide page and the HowTo structured data, so the two
// cannot drift. Answer engines compare the schema against the visible text.
export const guideSteps = Object.freeze([
  {
    id: 'guide-upload',
    number: '01',
    title: '파일 업로드',
    summary: '프리뷰_자막 화면에서 음성 또는 영상 파일을 선택합니다.',
    details: [
      'mp3, wav, m4a, webm, mp4, mpeg, mpga, ogg, flac 형식을 지원합니다.',
      'MP3·M4A·영상 등은 최대 150MB, WAV 원본은 최대 500MB까지 선택할 수 있습니다. 150MB를 넘는 WAV는 업로드 전에 브라우저에서 자동 최적화하며, 영상 파일은 오디오만 추출합니다.',
    ],
  },
  {
    id: 'guide-language',
    number: '02',
    title: '언어와 화자 선택',
    summary: '자동 감지를 사용하거나 원본 음성의 언어를 직접 선택합니다.',
    details: [
      '한국어, 영어, 일본어, 중국어를 선택할 수 있으며 자막 변환 단계에서는 원본 언어를 유지합니다.',
      `여러 사람이 말하는 파일은 인물 여러 명을 켭니다. 다화자 모드는 최대 ${DIARIZATION_MAX_MINUTES}분까지 지원합니다.`,
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
      'SRT는 Premiere Pro, CapCut, YouTube 등에 가져올 수 있으며, CapCut에서 자막과 타임코드 호환을 확인했습니다.',
      'ASS는 프리셋, 글자 크기, 화자 색상을 확인한 뒤 다운로드할 수 있습니다.',
    ],
  },
].map((step) => Object.freeze({ ...step, details: Object.freeze(step.details) })));
