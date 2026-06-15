// DB 테이블 검증 및 초기 시드 데이터 삽입 스크립트
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// UTC → KST 변환 헬퍼
function toKST(date) {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000);
}

function formatKST(date) {
  const kst = toKST(date);
  return kst.toISOString().replace('T', ' ').replace('Z', '') + ' KST';
}

async function main() {
  console.log('========================================');
  console.log('  Threads/X 자동발행 DB 검증 시작');
  console.log('========================================\n');

  // 1. 계정 생성
  console.log('[1/4] 계정 생성 중...');
  const luckyGirl = await prisma.account.upsert({
    where: { accountName: '럭키걸' },
    update: {},
    create: {
      accountName: '럭키걸',
      description: '럭키걸 브랜드 계정 - 여성 타겟 긍정 콘텐츠',
    },
  });

  const luckyMan = await prisma.account.upsert({
    where: { accountName: '럭키맨' },
    update: {},
    create: {
      accountName: '럭키맨',
      description: '럭키맨 브랜드 계정 - 남성 타겟 동기부여 콘텐츠',
    },
  });

  console.log(`  ✅ ${luckyGirl.accountName} (ID: ${luckyGirl.id}) - 생성시간: ${formatKST(luckyGirl.createdAt)}`);
  console.log(`  ✅ ${luckyMan.accountName} (ID: ${luckyMan.id}) - 생성시간: ${formatKST(luckyMan.createdAt)}`);

  // 2. 템플릿 생성
  console.log('\n[2/4] 템플릿 생성 중...');

  const templates = [
    {
      accountId: luckyGirl.id,
      templateCode: 'A',
      templateName: '일상 긍정 메시지',
      promptText: '20대~30대 여성을 위한 따뜻하고 긍정적인 일상 메시지를 작성해주세요.\n톤: 밝고 친근한\n길이: 2-3문장\n해시태그: 3개 이내',
    },
    {
      accountId: luckyGirl.id,
      templateCode: 'B',
      templateName: '자기계발 명언',
      promptText: '여성 자기계발과 성장에 대한 명언 스타일 콘텐츠를 작성해주세요.\n톤: 진지하지만 따뜻한\n형식: 명언 + 짧은 해설\n해시태그: 2개',
    },
    {
      accountId: luckyMan.id,
      templateCode: 'A',
      templateName: '동기부여 메시지',
      promptText: '20대~30대 남성을 위한 강력한 동기부여 메시지를 작성해주세요.\n톤: 강렬하고 직접적인\n길이: 2-3문장\n해시태그: 3개 이내',
    },
    {
      accountId: luckyMan.id,
      templateCode: 'B',
      templateName: '성공 습관 팁',
      promptText: '남성 성공 습관과 자기관리 팁을 공유하는 콘텐츠를 작성해주세요.\n톤: 전문적이고 실용적인\n형식: 팁 제목 + 설명\n해시태그: 2개',
    },
  ];

  for (const t of templates) {
    const created = await prisma.template.upsert({
      where: {
        accountId_templateCode: {
          accountId: t.accountId,
          templateCode: t.templateCode,
        },
      },
      update: {},
      create: t,
    });
    const account = t.accountId === luckyGirl.id ? '럭키걸' : '럭키맨';
    console.log(`  ✅ [${account}] 템플릿 ${created.templateCode} - "${created.templateName}"`);
  }

  // 3. 샘플 게시물 생성
  console.log('\n[3/4] 샘플 게시물 생성 중...');

  const samplePosts = [
    {
      accountId: luckyGirl.id,
      platform: 'threads',
      content: '오늘도 나를 사랑하는 하루 💗\n\n작은 것에 감사하고\n큰 꿈을 꾸는 당신이\n이미 충분히 아름다워요 ✨\n\n#럭키걸 #긍정에너지 #오늘의한마디',
      templateId: null,
      status: 'pending',
    },
    {
      accountId: luckyGirl.id,
      platform: 'x',
      content: '매일 아침, 거울 속 나에게 말해줘요.\n"넌 할 수 있어" 💪\n\n#럭키걸 #자기사랑',
      templateId: null,
      status: 'pending',
    },
    {
      accountId: luckyMan.id,
      platform: 'threads',
      content: '성공은 습관이다.\n\n매일 1%씩 성장하면\n1년 후 37배가 된다.\n\n지금 시작해라. 🔥\n\n#럭키맨 #동기부여 #성장마인드',
      templateId: null,
      status: 'pending',
    },
    {
      accountId: luckyMan.id,
      platform: 'x',
      content: '새벽 5시에 일어나는 것이\n성공의 비결이 아니다.\n\n일어나서 무엇을 하느냐가 비결이다.\n\n#럭키맨 #성공습관',
      templateId: null,
      status: 'pending',
    },
  ];

  for (const p of samplePosts) {
    const created = await prisma.post.create({ data: p });
    const account = p.accountId === luckyGirl.id ? '럭키걸' : '럭키맨';
    console.log(`  ✅ [${account}/${p.platform}] ID:${created.id} - 적재시간: ${formatKST(created.createdAt)}`);
    console.log(`     상태: ${created.status}`);
    console.log(`     내용 미리보기: "${created.content.substring(0, 30)}..."`);
  }

  // 4. 검증: 데이터 조회
  console.log('\n[4/4] 데이터 검증 중...');

  // 4-1. 계정별 게시물 수
  const accountStats = await prisma.account.findMany({
    include: {
      _count: { select: { posts: true, templates: true } },
    },
  });

  console.log('\n  📊 계정별 통계:');
  for (const a of accountStats) {
    console.log(`     ${a.accountName}: 게시물 ${a._count.posts}개 | 템플릿 ${a._count.templates}개`);
  }

  // 4-2. 플랫폼별 pending 게시물
  const pendingByPlatform = await prisma.post.groupBy({
    by: ['platform'],
    where: { status: 'pending' },
    _count: true,
  });

  console.log('\n  📊 플랫폼별 대기 중 게시물:');
  for (const p of pendingByPlatform) {
    console.log(`     ${p.platform}: ${p._count}개`);
  }

  // 4-3. 줄바꿈 검증
  const samplePost = await prisma.post.findFirst({
    where: { platform: 'threads' },
  });
  
  console.log('\n  📝 줄바꿈 검증 (threads 첫 번째 게시물):');
  console.log('  ─────────────────────────────────');
  console.log(samplePost.content);
  console.log('  ─────────────────────────────────');

  console.log('\n========================================');
  console.log('  ✅ 모든 테이블 생성 및 검증 완료!');
  console.log('========================================');
}

main()
  .catch((e) => {
    console.error('❌ 에러 발생:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
