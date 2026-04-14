# CLAUDE.md — App-STT v2 코딩 가이드라인

## 프로젝트 개요
음성 파일 → 텍스트 변환 → 맞춤법 교정 → SRT/TXT/ASS 자막 다운로드 웹 앱.
편집자 대상 유료 서비스로, 토스페이먼츠 결제 연동 포함.

## 기술 스택
- 백엔드: Node.js + Express.js (ESM)
- 프론트엔드: React 18 + Vite
- AI: OpenAI Whisper API (whisper-1, verbose_json) + GPT-4o (후처리)
- 맞춤법: GPT-4o (메인) + hanspell (폴백, 선택옵션)
- 결제: 토스페이먼츠 결제위젯
- 배포: Railway (GitHub push → 자동 재배포)

## 프로젝트 구조 규칙
- 단일 폴더 구조 (모노레포 아님)
- 빌드 시 React를 빌드하고 Express가 정적 파일로 서빙
- 루트 package.json 하나로 모든 dependencies 관리
- start 스크립트 하나로 배포 완료

## 코딩 규칙
- ESM 사용 (import/export). require() 사용 금지
- import 경로에 .js 확장자 반드시 포함
- 모든 비동기 함수는 try-catch로 에러 핸들링
- 환경변수는 .env 파일로 관리, dotenv로 로드
- .gitignore에 node_modules, .env, dist 반드시 포함

## 디자인 가이드라인
- 스타일: 다크 UI (Effct.io 참고)
- 키 컬러: 형광 그린 → 형광 시안 그라데이션 (#39FF14 → #00F5FF)
- 배경: #0A0A0F (거의 블랙), 카드 배경: #12121A
- 텍스트: #FFFFFF (제목), #9CA3AF (본문/설명)
- 보더: #1E1E2E (카드 테두리)
- 에러: #FF4444, 성공: #39FF14
- 버튼: 그라데이션 배경 + 흰색 텍스트
- 카드: 둥근 모서리(12px~16px), 미묘한 보더
- 여백: 넉넉하게, 섹션 간 80px 이상
- 폰트: Pretendard (한국어 최적화 웹폰트)

## 자막 최적화 규칙
- 한 자막당 최대 30자
- 5자 미만 짧은 세그먼트는 다음과 병합
- 한국어 종결어미(~다, ~요, ~입니다, ~죠, ~네요, ~거든요, ~니다)에서 문장 분리
- 단어 중간에서 절대 자르지 않음 (띄어쓰기/문장부호 기준)

## 다국어 규칙
- 영어 음성 → 영어 텍스트 그대로
- 한국어 음성 → 한국어 텍스트 그대로
- 일본어 음성 → 한국어로 번역 (GPT-4o)
- 중국어 음성 → 한국어로 번역 (GPT-4o)
- 언어 자동 감지 (Whisper) + 사용자 수동 선택

## 과거 실수 방지
- .gitignore 없이 git add -A 절대 금지
- Railway 배포 시 단일 구조 유지 (모노레포 금지)
- ESM import에 .js 확장자 빠뜨리지 말 것
- 코드가 "정상으로 보여도" 실제 동작을 확인할 것
