# 무료 체험 IP 제한 운영 메모

## 동작과 사용자 안내

- 기본 `identity` 모드는 이메일 인증 후 동일 로그인 신원에 무료 10분을 1회 자동 지급합니다. 아직 네트워크 한도는 적용하지 않습니다.
- `ip` 모드는 `WELCOME_CREDIT_MODE=ip`와 신뢰된 프록시 설정이 모두 정확히 준비된 경우에만 이메일 인증 계정의 첫 로그인에서 자동 지급합니다. 같은 IP에서는 24시간에 한 계정만 지급하며 Turnstile/CAPTCHA에 의존하지 않습니다.
- `guarded` 모드는 기존 IP 제한과 Turnstile 추가 확인 경로입니다. `ip` 모드와 별도로 유지합니다.
- `ip` 모드에서만 네트워크 제한 상태 조회와 지급에 Railway가 전달하는 `X-Real-IP`를 사용합니다. 이 모드는 `req.ip`나 임의 `X-Forwarded-For`로 대체하지 않습니다. 값 누락, 중복, 쉼표 포함, 잘못된 주소, 신뢰 플래그 누락, HMAC 키 누락은 무료 지급만 보류하며 로그인은 유지합니다. 기존 `guarded` 모드의 경로는 기존 `req.ip` 처리를 유지합니다.
- 가족·회사·학교·공용 와이파이처럼 여러 사람이 공유하는 네트워크는 같은 IP로 판단될 수 있습니다. VPN이나 IP 변경은 반복 가입 방지를 보장하지 않습니다.
- 네트워크 주소와 계정 식별값은 전용 HMAC 키로 처리한 값만 DB에 보관합니다. 관련 IP·계정 HMAC 기록은 7일 후 정기 삭제하며, 정리 작업이 중단된 동안에는 삭제 시점이 늦어질 수 있습니다. 원문 IP는 이 기능의 DB에 저장하지 않습니다.

## 단계적 운영 적용

첫 배포 시 `WELCOME_CREDIT_MODE`는 `identity`(또는 unset)로 둡니다. IP 제한을 켜기 전에 각 운영 도메인에서 실제 Railway 유입 IP가 안정적으로 같은 `X-Real-IP` 값으로 표현되는지 확인합니다.

1. Supabase migration을 적용하고 PG17에서 단일 지급, 같은 IP 동시 지급, 정확한 24시간 경계, 다른 IP, 이메일 미인증, 수동 welcome 지급, 유료·adjustment 잔액 보존과 RLS 실행 권한을 확인합니다. 기존 profile 잔액은 건드리지 않습니다.
2. Railway 서비스 변수에 32바이트 이상의 전용 `WELCOME_CREDIT_SECURITY_HMAC_KEY`를 설정합니다. Supabase service-role key를 재사용하지 않습니다. 키를 교체하면 이전 7일 기록은 새 키로 읽을 수 없으므로 네트워크 한도 이력이 초기화된 것처럼 처리됩니다.
3. 임시 진단 토큰 `WELCOME_CREDIT_IP_PROBE_TOKEN`을 최소 32바이트의 무작위 비밀값으로 설정합니다. 이 변수는 IP probe 확인 직후 제거합니다.
4. `https://pr-text.com/api/internal/welcome-ip-check`와 `https://prtext-production.up.railway.app/api/internal/welcome-ip-check`에 `Authorization: Bearer <token>` 또는 `X-Probe-Token: <token>`으로 각각 요청합니다. 토큰은 URL/query, 저장소, 로그에 넣지 않습니다. 토큰이 없거나 잘못되면 endpoint는 캐시 금지 404를 반환합니다.
5. 진단 응답의 `ipHash`, `source`, `mode`, `ready`, `requestId`만 확인합니다. `source`가 `x-real-ip`인지, `ipHash`가 같은 실제 접속 경로에서 반복 가능한지, 도메인별 Railway request ID와 요청 시각이 맞는지 기록으로 대조합니다. 응답에는 원문 IP나 계정 식별값이 포함되지 않습니다. 헤더가 없거나 복수/잘못된 값이면 `source=invalid`, `ipHash=null`로 나타납니다. 진단은 DB 지급을 실행하지 않습니다.
6. proxy source 확인 뒤 `WELCOME_CREDIT_TRUSTED_PROXY_IP=true`를 설정하고 모드를 `ip`로 전환합니다. 일반 설정에서 `ready=true`인지 확인한 뒤 신규 이메일 인증 계정, 동일 IP 두 번째 계정의 `ip_limit` 및 `retryAt`, 다른 IP의 지급, 로그인 유지, 계정 삭제 후 7일 이력 보존을 확인합니다. probe 토큰은 반드시 비워 404로 비활성화합니다.

`ip` 모드에는 `WELCOME_CREDIT_MODE=ip`, `WELCOME_CREDIT_TRUSTED_PROXY_IP=true`, `WELCOME_CREDIT_SECURITY_HMAC_KEY`가 필요합니다. CAPTCHA key는 필요하지 않습니다. 이 설정이 준비되지 않으면 신규 무료 지급만 보류하고 로그인, 변환, 결제는 계속됩니다.

Railway의 공식 public networking 문서는 요청의 `X-Real-IP` 헤더를 설명합니다: [Railway Networking: Specs and Limits](https://docs.railway.com/networking/public-networking/specs-and-limits). 문서만으로 이 서비스의 실제 프록시 전달 경로가 확인되는 것은 아니므로 위의 운영 probe를 먼저 수행합니다.

잘못된 IP 설정이나 probe 불일치가 발견되면 모드를 자동으로 `identity`로 낮추지 않습니다. `ip` 모드를 유지하면 신규 무료 지급만 보류되고 로그인은 계속됩니다. `identity`로 전환하는 것은 같은 IP 24시간 제한을 일시 해제하는 결정이므로 사용자의 명시 결정과 별도 운영 판단이 있을 때만 수행합니다. DB migration을 되돌리거나 이전 profile-creation RPC를 복구하지 않습니다. 코드 롤백이 필요해도 migration은 유지하고, 복구한 서비스 버전이 기존 무료 지급 경로를 우회하지 않는지 확인합니다.
