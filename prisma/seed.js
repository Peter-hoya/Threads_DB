const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const DEFAULT_ACCOUNTS = [
  {
    accountName: '럭키걸',
    description: '럭키걸 콘텐츠 계정',
    role: 'automation',
    postingEnabled: false,
  },
  {
    accountName: '럭키맨',
    description: '럭키맨 콘텐츠 계정',
    role: 'automation',
    postingEnabled: false,
  },
];

const DEFAULT_TEMPLATES = [
  ['럭키걸', 'A', '일상 공감', '20~40대 여성이 공감할 수 있는 자연스러운 한국 Threads 글을 작성합니다. 광고체를 피하고 짧은 문장과 대화하듯 끊는 호흡을 사용합니다.'],
  ['럭키걸', 'B', '상품 정보', '운영자가 제공한 실제 사용 경험이나 확인 가능한 상품 정보만 사용합니다. 경험을 지어내지 말고 첫 문장에 궁금증을 주되 과장 없이 구체적인 장점을 씁니다.'],
  ['럭키맨', 'A', 'IT 아이디어', '20~30대 남성이 흥미를 느낄 IT 또는 아이디어 상품 콘텐츠를 자연스러운 반말체로 작성합니다.'],
  ['럭키맨', 'B', '생활 논쟁', '누구나 경험하지만 선택이 갈리는 생활 소재를 3~5문장으로 작성하고 자연스러운 질문으로 마무리합니다.'],
];

async function main() {
  const accounts = new Map();
  for (const data of DEFAULT_ACCOUNTS) {
    const account = await prisma.account.upsert({
      where: { accountName: data.accountName },
      update: {},
      create: data,
    });
    accounts.set(account.accountName, account);
  }

  for (const [accountName, templateCode, templateName, promptText] of DEFAULT_TEMPLATES) {
    const account = accounts.get(accountName);
    await prisma.template.upsert({
      where: { accountId_templateCode: { accountId: account.id, templateCode } },
      update: {},
      create: { accountId: account.id, templateCode, templateName, promptText },
    });
  }

  // 안전 기본값: seed를 다시 실행해도 발행 대기 글은 절대 생성하지 않는다.
  // 명시적으로 요청한 로컬 개발 환경에서만 검토되지 않은 draft 한 건을 만든다.
  if (process.env.SEED_SAMPLE_POSTS === 'true' && process.env.NODE_ENV !== 'production') {
    const account = accounts.get('럭키걸');
    const existing = await prisma.post.findFirst({
      where: { accountId: account.id, content: '[개발용 초안] Threads 발행 흐름 점검' },
    });
    if (!existing) {
      await prisma.post.create({
        data: {
          accountId: account.id,
          platform: 'threads',
          content: '[개발용 초안] Threads 발행 흐름 점검',
          status: 'draft',
          approvalStatus: 'draft',
          rightsConfirmed: false,
          policyReviewConfirmed: false,
        },
      });
    }
  }

  console.log(`Seed complete: ${accounts.size} accounts, ${DEFAULT_TEMPLATES.length} templates, no queued posts.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
