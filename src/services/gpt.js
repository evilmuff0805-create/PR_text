import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function correctText(text, language) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: `당신은 한국어 맞춤법 교정 전문가입니다.\n\n규칙:\n1. 입력은 여러 줄로 구성되어 있습니다. 각 줄은 독립된 자막 세그먼트입니다.\n2. 반드시 입력과 동일한 줄 수를 유지하세요.\n3. 맞춤법과 띄어쓰기만 교정하세요.\n4. 단어를 다른 단어로 바꾸지 마세요. 말한 그대로 유지하세요.\n5. 구어체, 사투리, 비격식 표현을 격식체로 바꾸지 마세요.\n6. 문장 구조를 변경하지 마세요.\n7. 줄을 합치거나, 분리하거나, 순서를 바꾸지 마세요.\n8. 빈 줄이 있으면 빈 줄 그대로 유지하세요.\n9. 교정된 텍스트만 출력하세요. 설명이나 번호를 붙이지 마세요.\n\n이것은 말자막(음성을 그대로 받아 적은 자막)입니다. 화자가 실제로 한 말을 절대 바꾸지 말고, 오직 맞춤법 오류와 띄어쓰기만 수정하세요.`,
        },
        { role: 'user', content: text },
      ],
    });
    return response.choices[0].message.content.trim();
  } catch (err) {
    throw new Error(`GPT API 오류: ${err.message}`);
  }
}

export async function translateToKorean(text, sourceLanguage) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: `당신은 전문 번역가입니다.\n\n규칙:\n1. 입력은 여러 줄로 구성되어 있습니다. 각 줄은 독립된 자막 세그먼트입니다.\n2. 반드시 입력과 동일한 줄 수를 유지하세요.\n3. 각 줄을 독립적으로 ${sourceLanguage}에서 자연스러운 한국어로 번역하세요.\n4. 줄을 합치거나, 분리하거나, 순서를 바꾸지 마세요.\n5. 빈 줄이 있으면 빈 줄 그대로 유지하세요.\n6. 번역된 텍스트만 출력하세요. 설명이나 번호를 붙이지 마세요.`,
        },
        { role: 'user', content: text },
      ],
    });
    return response.choices[0].message.content.trim();
  } catch (err) {
    throw new Error(`GPT API 오류: ${err.message}`);
  }
}
