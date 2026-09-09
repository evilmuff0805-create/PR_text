import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.OPENAI_API_KEY ||= 'test-key';

const { GPT_MAX_ATTEMPTS, GPT_REQUEST_TIMEOUT_MS } = await import('../src/services/gpt.js');
const { CAPTION_IDEA_REQUEST_TIMEOUT_MS } = await import('../src/services/caption-ideas.js');

// 2026-08-24 작업 ca20160f에서 교정 청크 하나가 610,312ms 걸렸다.
// 600,000ms는 openai-node v4의 기본 타임아웃이고, 형제 청크는 7.6~9.9초였다.
const OBSERVED_CHUNK_P95_MS = 18_059;
const SDK_DEFAULT_TIMEOUT_MS = 600_000;

test('교정 예산은 실측 p95보다 넉넉하다', () => {
  // 너무 조이면 느리지만 정상인 호출을 끊는다. PR #87에서 실제로 그렇게 실사용자를 끊었다.
  assert.ok(
    GPT_REQUEST_TIMEOUT_MS >= OBSERVED_CHUNK_P95_MS * 6,
    `${GPT_REQUEST_TIMEOUT_MS}ms는 관측 p95 ${OBSERVED_CHUNK_P95_MS}ms의 6배에 못 미친다`,
  );
});

test('교정 청크 하나의 최악 대기가 6분으로 묶인다', () => {
  // 수정 전: 앱 3회 x SDK 3회 x 600초 = 5,400초(90분).
  const worstCaseMs = GPT_REQUEST_TIMEOUT_MS * GPT_MAX_ATTEMPTS;

  assert.ok(worstCaseMs <= 360_000, `최악 ${worstCaseMs}ms는 6분을 넘는다`);
  assert.ok(worstCaseMs < SDK_DEFAULT_TIMEOUT_MS * 9, '수정 전보다 반드시 짧아야 한다');
});

test('재시도는 한 겹만 쓴다', async () => {
  // SDK 기본 재시도를 그대로 두면 앱 재시도와 곱해져 9회가 된다.
  const source = await readFile(new URL('../src/services/gpt.js', import.meta.url), 'utf8');

  assert.match(source, /maxRetries: 0/);
  assert.match(source, /timeout: GPT_REQUEST_TIMEOUT_MS/);
});

test('자막 아이디어는 사용자가 기다리는 화면이라 더 짧게 끊는다', async () => {
  const source = await readFile(new URL('../src/services/caption-ideas.js', import.meta.url), 'utf8');

  // 실측 39건 p95 8.3초, 최대 9.1초.
  assert.ok(CAPTION_IDEA_REQUEST_TIMEOUT_MS >= 9_120 * 5);
  assert.ok(CAPTION_IDEA_REQUEST_TIMEOUT_MS < GPT_REQUEST_TIMEOUT_MS);
  assert.match(source, /maxRetries: 0/);
  assert.match(source, /timeout: CAPTION_IDEA_REQUEST_TIMEOUT_MS/);
});

test('OpenAI 클라이언트는 어디서든 대기 시간 상한이 있어야 한다', async () => {
  // 이 테스트가 있었다면 610초 사건은 애초에 나지 않았다.
  // whisper.js는 클라이언트가 아니라 요청별 옵션으로 상한을 준다.
  const files = ['gpt.js', 'caption-ideas.js'];

  for (const file of files) {
    const source = await readFile(new URL(`../src/services/${file}`, import.meta.url), 'utf8');
    const construction = source.match(/new OpenAI\(\{[\s\S]*?\}\)/);

    assert.ok(construction, `${file}에서 OpenAI 생성부를 찾지 못했다`);
    assert.match(construction[0], /timeout:/, `${file}의 OpenAI 클라이언트에 timeout이 없다`);
  }
});
