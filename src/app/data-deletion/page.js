export const metadata = {
  title: 'Threads 데이터 삭제 안내',
};

export default async function DataDeletionPage({ searchParams }) {
  const params = await searchParams;
  const code = typeof params?.code === 'string' ? params.code.slice(0, 64) : '';
  return (
    <main style={{ maxWidth: '720px', margin: '64px auto', padding: '0 24px', lineHeight: 1.7 }}>
      <h1>Threads 데이터 삭제 안내</h1>
      {code ? (
        <>
          <p>Meta를 통해 접수된 데이터 삭제 요청 처리가 완료되었습니다.</p>
          <p><strong>확인 코드:</strong> {code}</p>
        </>
      ) : (
        <p>관리자 웹의 계정 관리에서 API 연결을 해제하면 저장된 Threads 접근 토큰이 삭제되고 자동 발행이 중지됩니다.</p>
      )}
      <p>삭제 요청 시 저장된 접근 토큰, Threads 사용자 식별정보와 외부 게시물 식별정보를 제거합니다. 사용자가 관리자 웹에서 직접 작성한 원문과 법적·보안상 필요한 최소 기록은 별도로 보존될 수 있습니다.</p>
    </main>
  );
}
