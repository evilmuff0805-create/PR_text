// Shared by the rendered support page and the FAQPage structured data.
//
// Answer engines treat a mismatch between visible text and JSON-LD as spam, so
// both must come from here rather than being written out twice.
export const supportFaqs = Object.freeze([
  {
    question: '어떤 파일 형식을 지원하나요?',
    answer: 'mp3, wav, m4a, webm, mp4, mpeg, mpga, ogg, flac 파일을 지원합니다. MP3·M4A·영상 등은 최대 150MB, WAV 원본은 최대 500MB까지 선택할 수 있으며, 150MB를 넘는 WAV는 업로드 전에 자동 최적화합니다.',
  },
  {
    question: '변환 시간은 얼마나 걸리나요?',
    answer: '파일 길이와 음질, 화자 수, 외부 변환 서비스 상태에 따라 달라집니다. 진행 중 화면에서 경과 시간과 처리 상태를 확인할 수 있으며, 다화자 변환은 일반 변환보다 오래 걸릴 수 있습니다.',
  },
  {
    question: '업로드한 파일은 저장되나요?',
    answer: '원본 음성 파일은 변환에만 사용하고 서비스 데이터베이스에 영구 저장하지 않습니다. 변환 이력과 사용·결제 기록의 보관 기준은 개인정보처리방침에서 확인할 수 있습니다.',
  },
].map((faq) => Object.freeze(faq)));
