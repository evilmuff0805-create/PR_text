import OpenAI from 'openai';
import { estimateCorrectionCostUsd, normalizeTokenUsage } from './correction-pricing.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const DEFAULT_CORRECTION_MODEL = 'gpt-5.6-luna';
const CORRECTION_FALLBACK_MODEL = 'gpt-4o';

export function getCorrectionModel() {
  const configured = process.env.GPT_CORRECTION_MODEL?.trim();
  return configured || DEFAULT_CORRECTION_MODEL;
}

export function shouldFallbackToGpt4o(error, model) {
  return model === DEFAULT_CORRECTION_MODEL && [400, 403, 404].includes(error?.status);
}

export function buildCorrectionRequest(text, model) {
  const request = {
    model,
    messages: [
      {
        role: 'system',
        content: `당신은 한국어 음성 인식 말자막의 받아쓰기·맞춤법 교정 전문가입니다.\n\n교정 범위:\n- 명백한 맞춤법·띄어쓰기·활용 오류와, 발음이 사실상 같고 문맥상 명백한 받아쓰기 오류만 수정하세요.\n- 한 줄만으로 뜻이 불분명하면 함께 입력된 앞뒤 줄을 문맥으로 읽으세요. 문맥은 판단에만 사용하고 다른 줄의 단어나 대사를 옮기거나 복사하지 마세요.\n- 뜻이 이미 맞는 단어를 바꾸거나 문장을 더 자연스럽게 재작성하지 마세요. 문맥이 애매하면 원문을 그대로 두세요. 발음이 다른 단어를 추측해 넣지 마세요.\n\n보존 규칙:\n1. 각 입력 줄은 제자리에 남아야 하는 자막 세그먼트입니다. 입력과 동일한 줄 수와 순서를 유지하고, 줄을 합치거나 분리하지 마세요.\n2. 의미, 어투, 구어체, 사투리, 비격식 표현, 감탄사, 추임새, 말버릇과 반복 횟수를 보존하세요. 격식체로 바꾸거나 문장 구조를 고치지 마세요.\n3. 단어와 대사를 추가하거나 삭제하지 마세요. 위 교정 범위의 오류만 해당 위치에서 고치세요.\n4. 숫자, 소수점, 부호, 수량과 단위를 보존하세요. 숫자를 다른 값이나 표기로 바꾸지 마세요. 단위 앞 띄어쓰기만 수정할 수 있습니다.\n5. 사람 이름, 지명, 상호와 고유명사는 추측해 바꾸지 마세요. 빈 줄은 그대로 유지하세요.\n6. 교정된 텍스트만 출력하세요. 설명, 번호, 따옴표나 코드 블록을 추가하지 마세요.\n\n허용 예시(같은 원칙을 다른 문장에도 적용):\n- 나물을 묻혀서 반찬을 만들었어 → 나물을 무쳐서 반찬을 만들었어 (음식 재료를 섞는 문맥의 받아쓰기 오류)\n- 국을 팔팔 끌였어 → 국을 팔팔 끓였어\n- 이거 몇일 걸렸어? → 이거 며칠 걸렸어?\n- 내일 할 거에요 → 내일 할 거예요\n- 이렇게 하면 되요 → 이렇게 하면 돼요\n- 3.5킬로 넣으면 되요 → 3.5 킬로 넣으면 돼요\n\n유지 예시:\n- 옷에 양념을 묻혔어 → 옷에 양념을 묻혔어 (표면에 묻는 뜻)\n- 상자가 땅에 묻혔어 → 상자가 땅에 묻혔어 (땅에 넣는 뜻)\n- 이유를 물었어 → 이유를 물었어 (질문하는 뜻)\n- 잘 묻혀서 해봐 → 잘 묻혀서 해봐 (음식인지 다른 뜻인지 애매하므로 유지)\n- 네 네 네 맞아요 → 네 네 네 맞아요\n\n예시 문장을 출력에 추가하지 마세요. 오디오가 없는 상태에서 새 내용을 추정하지 말고, 확실한 표기·받아쓰기 오류만 최소한으로 교정하세요.`,
      },
      { role: 'user', content: text },
    ],
  };

  // Luna uses its model-default sampling configuration.
  if (model !== DEFAULT_CORRECTION_MODEL) {
    request.temperature = 0.3;
  }

  return request;
}

async function withRetry(fn, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = 1000 * (attempt + 1);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

export async function correctText(text, language) {
  const result = await correctTextWithUsage(text, language);
  return result.text;
}

async function requestCorrection(text, model) {
  return withRetry(() => openai.chat.completions.create(buildCorrectionRequest(text, model)));
}

export async function correctTextWithUsage(text, language, options = {}) {
  const requestedModel = options.model || getCorrectionModel();
  let model = requestedModel;
  let fallbackUsed = false;

  try {
    let response;
    try {
      response = await requestCorrection(text, model);
    } catch (error) {
      if (!shouldFallbackToGpt4o(error, model)) throw error;

      fallbackUsed = true;
      model = CORRECTION_FALLBACK_MODEL;
      const message = String(error.message || '').replace(/\s+/g, ' ').slice(0, 500);
      console.warn(
        `[gpt] ${requestedModel} 요청 실패로 ${model}를 사용합니다. status=${error.status} code=${error.code || '-'} message=${message || '-'}`,
      );
      response = await requestCorrection(text, model);
    }

    const output = response.choices[0]?.message?.content?.trim();
    if (!output) throw new Error('GPT 교정 결과가 비어 있습니다.');

    const usage = normalizeTokenUsage(response.usage);
    return {
      text: output,
      model,
      requestedModel,
      fallbackUsed,
      usage,
      estimatedCostUsd: estimateCorrectionCostUsd(model, usage),
    };
  } catch (err) {
    throw new Error(`GPT API 오류: ${err.message}`);
  }
}

export async function translateToEnglish(text) {
  try {
    const response = await withRetry(() => openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: `당신은 전문 번역가입니다. 입력은 번호가 매겨진 한국어 자막입니다. 각 줄을 동일한 번호 형식으로 자연스러운 영어로 번역하세요. 반드시 모든 번호를 유지하고 동일한 줄 수를 출력하세요. 줄을 합치거나 분리하지 마세요. 출력 형식: '1: 번역문'`,
        },
        { role: 'user', content: text },
      ],
    }));
    return response.choices[0].message.content.trim();
  } catch (err) {
    throw new Error(`GPT API 오류: ${err.message}`);
  }
}

export async function translateToKorean(text, sourceLanguage) {
  try {
    const response = await withRetry(() => openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: `당신은 전문 번역가입니다.\n\n규칙:\n1. 입력은 여러 줄로 구성되어 있습니다. 각 줄은 독립된 자막 세그먼트입니다.\n2. 반드시 입력과 동일한 줄 수를 유지하세요.\n3. 각 줄을 독립적으로 ${sourceLanguage}에서 자연스러운 한국어로 번역하세요.\n4. 줄을 합치거나, 분리하거나, 순서를 바꾸지 마세요.\n5. 빈 줄이 있으면 빈 줄 그대로 유지하세요.\n6. 번역된 텍스트만 출력하세요. 설명이나 번호를 붙이지 마세요.`,
        },
        { role: 'user', content: text },
      ],
    }));
    return response.choices[0].message.content.trim();
  } catch (err) {
    throw new Error(`GPT API 오류: ${err.message}`);
  }
}
