import { NextResponse } from 'next/server';
import OpenAI from 'openai';

export async function POST(request) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { error: 'OPENAI_API_KEY가 설정되지 않았습니다. .env 파일을 확인해주세요.' },
        { status: 500 }
      );
    }

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const { promptText, templateCode, accountName } = await request.json();

    if (!promptText) {
      return NextResponse.json({ error: '프롬프트 텍스트가 필요합니다.' }, { status: 400 });
    }

    const systemPrompt = `
당신은 소셜 미디어(Threads 및 X) 전문 콘텐츠 크리에이터입니다.
사용자가 제공하는 가이드라인(프롬프트)에 따라 정확히 10개의 고품질 게시물을 작성해야 합니다.

조건:
1. 각 게시물은 사용자의 가이드라인을 완벽히 준수해야 합니다.
2. 결과는 반드시 JSON 배열 형태로 반환해야 합니다.
3. 각 배열의 요소는 개별 게시물의 텍스트(문자열)여야 합니다.
4. 게시물 내에 적절한 줄바꿈과 이모지를 포함하세요.
5. 정확히 10개의 게시물을 생성하세요.

JSON 응답 포맷 예시:
{
  "posts": [
    "게시물 내용 1...",
    "게시물 내용 2...",
    ...
  ]
}
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `다음 프롬프트를 바탕으로 게시물 10개를 생성해주세요.\n\n계정 페르소나: ${accountName}\n템플릿 코드: ${templateCode}\n\n[템플릿 프롬프트]\n${promptText}` }
      ],
      response_format: { type: "json_object" },
      temperature: 0.7,
    });

    const resultText = response.choices[0].message.content;
    const parsed = JSON.parse(resultText);

    if (!parsed.posts || !Array.isArray(parsed.posts)) {
      throw new Error("올바른 JSON 포맷을 받지 못했습니다.");
    }

    return NextResponse.json({ posts: parsed.posts });
  } catch (error) {
    console.error('OpenAI Generate Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
