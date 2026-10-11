const MESSAGES = {
  contact_missing: '연락처를 찾을 수 없습니다. 목록을 새로고침하고 등록 정보를 확인해 주세요.',
  email_changed: '이메일 주소 확인 필요. 현재 연락처와 수신 동의를 다시 확인해 주세요.',
  unsubscribed: '수신거부한 주소입니다. 발송 대상에서 제외합니다.',
  consent_required: '수신 동의 확인 필요. 명시적 동의 근거와 일시를 기록해 주세요.',
  foreign_channel: '한국 외 채널입니다. 발송 대상에서 제외합니다.',
  korea_unverified: '한국 채널 확인 필요. 공식 소개를 확인하고 근거를 기록해 주세요.',
  subscribers_unverified: '구독자 10만 명 이상인지 재확인해 주세요.',
  channel_check_expired: '채널 정보 재확인 필요. 최신 검색 결과를 확인하고 저장해 주세요.',
  recently_contacted: '최근 30일 발송 또는 전송 결과 확인 필요. 기존 발송 상태를 먼저 확인해 주세요.',
  template_too_long: '개별 문안이 너무 깁니다. 제목·본문을 줄인 새 캠페인을 작성해 주세요.',
  campaign_paused: '캠페인이 일시정지되어 대기 중입니다. 준비가 되면 순차 발송을 재개해 주세요.',
  send_limit: '발송 한도 또는 간격에 따라 대기 중입니다. 다음 발송 가능 시각까지 기다려 주세요.',
  SMTP_AUTH_UNCERTAIN: '메일 서버 인증을 확인해 주세요. 실제 전송 여부를 확인한 뒤 처리하세요.',
  SMTP_SEND_UNCERTAIN: '메일 전송 결과를 확인하지 못했습니다. 실제 수신 여부를 확인해 주세요.',
  SMTP_RESULT_PERSISTENCE_UNCERTAIN: '메일 서버 응답을 발송 기록에 확정하지 못했습니다. 실제 수신과 기록을 확인해 주세요.',
  WORKER_LOST_DURING_SEND: '전송 중 처리가 중단되어 결과 확인이 필요합니다. 실제 수신 여부를 확인해 주세요.',
  WORKER_STOPPED_BEFORE_SMTP: '전송 전에 처리가 중단되었습니다. 발송 설정과 실행 상태를 확인해 주세요.',
};

export function outreachFeedback(code) {
  if (typeof code === 'string' && Object.hasOwn(MESSAGES, code)) return { message: MESSAGES[code], supportCode: null };
  let message = '처리 결과 확인이 필요합니다. 상태를 새로고침하거나 관리자에게 문의해 주세요.';
  if (typeof code === 'string' && code.startsWith('SMTP_')) message = '메일 서버 처리 확인이 필요합니다. 발송 설정과 실제 수신 여부를 확인해 주세요.';
  else if (typeof code === 'string' && code.startsWith('WORKER_')) message = '발송 처리 상태 확인이 필요합니다. 상태를 새로고침하고 실행 설정을 확인해 주세요.';
  return { message, supportCode: typeof code === 'string' && /^[A-Za-z0-9_:-]{1,96}$/.test(code) ? code : null };
}
