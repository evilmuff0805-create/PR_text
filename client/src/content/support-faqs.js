// Shared by the visible support content and FAQPage data to keep both aligned.
export const supportFaqs = Object.freeze([
  {
    id: 'create-subtitles',
    question: '음성이나 영상으로 자동 자막을 어떻게 만드나요?',
    answer: '음성 또는 영상 파일을 선택하고 원본 언어를 자동 감지하거나 직접 고른 뒤 변환을 시작합니다. 완료되면 구간별 문장을 확인하고 수정해 SRT, TXT, ASS로 내려받을 수 있습니다. 영상은 오디오를 추출해 자막을 만듭니다.',
    relatedLinks: [{ href: '/guide#guide-upload', label: '파일 업로드와 언어 선택 순서 보기' }],
  },
  {
    id: 'supported-formats',
    question: '어떤 파일 형식과 용량을 지원하나요?',
    answer: 'mp3, wav, m4a, webm, mp4, mpeg, mpga, ogg, flac 형식을 지원합니다. MP3·M4A·영상 파일은 최대 150MB, WAV 원본은 최대 500MB까지 선택할 수 있습니다. 150MB를 넘는 WAV는 업로드 전에 자동 최적화합니다.',
    relatedLinks: [{ href: '/guide#guide-upload', label: '업로드 형식과 용량 안내 보기' }],
  },
  {
    id: 'output-formats',
    question: 'SRT, TXT, ASS는 어떻게 다른가요?',
    answer: 'SRT와 ASS에는 자막 시간 정보가 들어가며, TXT에는 전체 텍스트가 들어갑니다. 영상 편집 프로그램에 시간 정보가 있는 자막을 가져오려면 SRT를, 문장만 정리하려면 TXT를, 스타일 정보를 포함하려면 ASS를 선택할 수 있습니다. 스타일 반영 범위는 편집 프로그램에 따라 다릅니다.',
    relatedLinks: [{ href: '/guide#guide-download', label: '자막 파일을 내려받는 방법 보기' }],
  },
  {
    id: 'premiere-pro',
    question: 'Premiere Pro에 SRT 자막을 어떻게 가져오나요?',
    answer: 'PR-text에서 SRT를 내려받아 Premiere Pro 프로젝트 패널로 가져온 다음, 원본 영상의 시작 위치에 맞춰 타임라인에 배치합니다. 자막을 넣은 뒤 글꼴·크기·위치는 Premiere Pro에서 조절할 수 있습니다.',
    relatedLinks: [{ href: '/guide#guide-manual', label: 'Premiere Pro 반입 이미지 설명서 보기' }],
  },
  {
    id: 'capcut',
    question: 'CapCut에서 SRT 자막을 사용할 수 있나요?',
    answer: 'SRT를 내려받아 CapCut의 자막 가져오기 기능으로 불러올 수 있습니다. PR-text는 CapCut에서 SRT 자막과 타임코드 호환을 확인했습니다. 메뉴 이름과 사용 방식은 CapCut 버전에 따라 다를 수 있습니다.',
    relatedLinks: [{ href: '/guide#guide-download', label: 'SRT 다운로드와 형식 안내 보기' }],
  },
  {
    id: 'edit-subtitles',
    question: '변환한 자막 문장을 직접 수정할 수 있나요?',
    answer: '네. 완료 화면에서 전체 텍스트나 구간별 문장을 수정할 수 있습니다. 저장된 편집 내용은 이후 내려받는 SRT, TXT, ASS 파일에 반영됩니다.',
    relatedLinks: [{ href: '/guide#guide-edit', label: '변환 결과 편집 방법 보기' }],
  },
  {
    id: 'speaker-separation',
    question: '화자 구분은 어떤 파일에서 사용할 수 있나요?',
    answer: '여러 사람이 말하는 파일은 변환 전에 화자 구분 옵션을 켤 수 있습니다. 다화자 모드는 최대 20분 파일까지 지원하며, 일반 변환보다 처리 시간이 더 걸릴 수 있습니다.',
    relatedLinks: [{ href: '/guide#guide-language', label: '화자 옵션과 지원 시간 확인하기' }],
  },
  {
    id: 'source-language-translation',
    question: '한국어 외의 음성은 자동으로 번역되나요?',
    answer: '자막 변환은 음성의 원문 언어로 진행합니다. 언어를 자동 감지하거나 한국어·영어·일본어·중국어 중에서 직접 선택할 수 있습니다. 한국어 자막은 완료 화면에서 영어 번역을 선택적으로 만들고 TXT로 내려받을 수 있습니다.',
    relatedLinks: [{ href: '/guide#guide-language', label: '원본 언어와 화자 선택 안내 보기' }],
  },
  {
    id: 'credit-calculation',
    question: '변환 시간은 어떤 기준으로 계산되나요?',
    answer: '변환 전에 파일의 오디오 길이를 기준으로 예상 사용 시간을 표시합니다. 분 단위로 올림해 계산하며, 1분보다 짧은 파일은 최소 1분으로 계산합니다.',
    relatedLinks: [{ href: '/payment', label: '변환 시간 요금과 충전 방법 확인하기' }],
  },
  {
    id: 'download-again',
    question: '완료한 자막 파일을 다시 내려받을 수 있나요?',
    answer: '로그인한 뒤 변환_재다운로드 메뉴에서 저장된 변환 결과를 열어 파일을 다시 받을 수 있습니다. 재다운로드 가능한 결과와 계정 기록의 보관 기준은 개인정보처리방침을 확인해 주세요.',
    relatedLinks: [
      { href: '/privacy#privacy-purpose', label: '변환 결과와 기록의 보관 기준 확인하기' },
      { href: '/support#output-formats', label: '다시 받을 수 있는 자막 파일 형식 확인하기' },
    ],
  },
  {
    id: 'audio-storage',
    question: '업로드한 원본 음성 파일은 저장되나요?',
    answer: '원본 음성 파일은 변환에 사용하며 서비스 데이터베이스에 영구 저장하지 않습니다. 변환 과정에서 생긴 임시 파일은 처리가 끝난 뒤 삭제합니다. 변환 결과와 계정 기록의 보관·삭제 기준은 개인정보처리방침에서 확인할 수 있습니다.',
    relatedLinks: [{ href: '/privacy#privacy-purpose', label: '음성 파일과 변환 기록의 처리 기준 보기' }],
  },
  {
    id: 'processing-time',
    question: '자막 변환에는 얼마나 걸리나요?',
    answer: '처리 시간은 파일 길이와 음질, 화자 수, 외부 변환 서비스 상태에 따라 달라집니다. 화면에서 현재 처리 상태를 확인할 수 있으며, 다화자 변환은 일반 변환보다 오래 걸릴 수 있습니다.',
    relatedLinks: [{ href: '/guide#guide-edit', label: '변환 진행과 완료 후 편집 방법 보기' }],
  },
].map((faq) => Object.freeze({ ...faq, relatedLinks: Object.freeze(faq.relatedLinks.map((link) => Object.freeze(link))) })));
