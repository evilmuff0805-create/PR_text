# 무료 체험 IP 제한 운영 메모

## 동작과 적용 시점

- `guarded` 모드에서만 IP 제한이 적용됩니다. 제한 기록에는 원문 IP 대신 서버 비밀키로 만든 HMAC값만 저장합니다. 기록은 7일 경과 후 정기 삭제되며, 서버가 중단되면 실제 정리 시점은 늦어질 수 있습니다.
- `guarded` 모드에서는 같은 네트워크에서 24시간에 한 계정만 10분을 받을 수 있고, 7일 안의 두 번째 신규 계정부터 Turnstile 추가 확인이 필요합니다. 추가 확인은 24시간 지급 제한을 우회하지 못합니다.
- `guarded` 모드에서 가족·회사·학교의 공유 네트워크는 같은 IP로 판단될 수 있습니다. VPN이나 IP 변경은 완전한 가입 제한을 보장하지 않습니다.
- 임시 `identity` 모드는 기존 identity 중복 방지 기록만 사용하며 IP 사용 기록을 새로 만들지 않습니다.

## 운영 설정 순서

기본 운영 모드는 `identity`입니다. 이메일 인증 후 동일 로그인 신원에 한 번 10분을 자동 지급하며, 네트워크 단위 IP 제한과 Turnstile 확인은 적용하지 않습니다. 따라서 다른 이메일·로그인 신원으로 반복 가입하는 시도는 막지 못할 수 있습니다.

IP 제한과 추가 확인이 실제로 검증된 환경에서만 `WELCOME_CREDIT_MODE=guarded`를 명시적으로 설정합니다. 이 모드는 아래의 모든 항목이 준비되고 확인되지 않으면 신규 무료 지급만 보류하며 로그인, 변환, 결제는 계속됩니다. 자동으로 `guarded`에 진입하는 설정 준비도 기반 fallback은 없습니다.
`WELCOME_CREDIT_MODE`가 없거나 정확히 `identity`면 기본 지급을 적용하고, 정확히 `guarded`면 검증 보호 모드를 적용합니다. 다른 값은 무료 지급만 비활성화하며 로그인은 유지합니다.

1. Supabase migration을 적용하고 DB 동시성·권한 점검을 통과시킵니다. 기존 사용자의 profile 잔액은 건드리지 않습니다.
2. Cloudflare Turnstile에 실제 서비스 도메인 위젯을 만들고 공개 site key와 비밀 secret key를 Railway의 서비스 변수로 설정합니다.
3. `APP_URL`을 운영 서비스의 HTTPS origin으로 설정합니다. 이 host가 Turnstile 검증 결과의 `hostname`과 정확히 일치해야 합니다.
4. `WELCOME_CREDIT_SECURITY_HMAC_KEY`에 충분히 긴 임의 비밀값을 설정합니다. 기존 Supabase 키를 재사용하지 않습니다. 교체하면 이전 7일 이내 IP 제한 관측값과 account 식별값을 읽을 수 없으므로 키 교체는 제한 이력 초기화로 취급합니다.
5. Railway의 proxy가 외부에서 보낸 `X-Forwarded-For`를 덮어쓰거나 안전하게 정제하는지 staging에서 직접 확인합니다. 직접 위조 헤더와 정상 경유 요청의 `req.ip`가 각각 기대값인지 확인하고, 그 증거를 남긴 뒤에만 `WELCOME_CREDIT_TRUSTED_PROXY_IP=true`를 설정합니다.
6. `WELCOME_CREDIT_TRUSTED_PROXY_IP`를 포함해 모든 값이 설정된 뒤 신규 이메일 인증 계정, 동일 IP 두 번째 계정의 challenge, 24시간 제한, 로그인·결제 유지, 계정 삭제 후 기록 보존을 확인합니다.

`guarded` 모드의 필수 환경 변수는 `WELCOME_CREDIT_MODE=guarded`, `APP_URL`, `WELCOME_CREDIT_TRUSTED_PROXY_IP`, `WELCOME_CREDIT_SECURITY_HMAC_KEY`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`입니다. Turnstile secret과 HMAC key는 클라이언트 변수로 만들거나 로그·문서·저장소에 기록하지 않습니다.

Railway proxy의 IP 정제 동작을 staging에서 검증하지 못했다면 `WELCOME_CREDIT_TRUSTED_PROXY_IP`를 설정하지 않습니다. 변수 누락, Turnstile 설정 누락, challenge 검증 실패, DB 오류, IP 파싱 실패는 모두 무료 지급만 거부합니다. 예전 profile-creation RPC도 0분 신규 profile만 만들기 때문에 구 경로를 통해 자동 지급되지 않습니다.

문제가 생기면 `WELCOME_CREDIT_MODE=guarded`를 유지하고 필수 설정을 비워 무료 지급 경로만 중지합니다. DB migration을 되돌리거나 이전 profile-creation RPC를 복구하면 기존 지급 보호가 사라지므로 금지합니다. 코드 롤백이 필요해도 migration은 유지하고, 복구한 서비스 버전이 profile 준비 RPC를 0분용으로 계속 호출하는지 확인합니다.

## 저장 및 정기 정리

HMAC-only 시도·지급 기록은 7일 경과 후 시간 인덱스를 이용해 최대 1,000행씩 정리됩니다. API 준비 과정에서도 제한된 분량만 정리하며, 서버 시작 15초 후 첫 정리 및 이후 매시간 정리를 실행합니다. 서비스가 멈춰 있는 동안 기록은 7일을 넘겨 남을 수 있고, 다시 시작한 후 정리됩니다.
