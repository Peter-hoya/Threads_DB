# Threads_DB 대시보드

이 프로젝트는 Threads API와 X(Twitter) API를 연동하여 자동으로 콘텐츠를 예약하고 발행하는 다중 계정 포스팅 자동화 시스템의 데이터베이스 관리 및 모니터링을 위한 Next.js 대시보드 웹 애플리케이션입니다.

## 주요 기능
- **다중 계정 관리**: 계정 정보(브랜드, 페르소나 계정 등) 및 API 인증 토큰 관리
- **예약 및 발행 현황 모니터링**: 스케줄러를 통해 발행 대기(pending), 예약(scheduled), 발행완료(published), 실패(failed) 상태 실시간 추적
- **템플릿 관리**: 각 계정별 프롬프트 템플릿(A, B, C, D) 정보 저장 및 수정
- **상세 오류 로그**: 발행 실패 시 에러 메시지 확인 및 재발행 기능 제공

## 기술 스택
- **프레임워크**: Next.js (App Router)
- **데이터베이스 ORM**: Prisma (PostgreSQL / Neon DB)
- **스타일링**: Vanilla CSS 및 Next.js UI 표준
- **배포 플랫폼**: Netlify

## 로컬 개발 및 실행 환경 설정

### 1. 환경 변수 설정
프로젝트 루트 디렉토리에 `.env` 파일을 생성하고 아래 형식을 따릅니다:

```env
NETLIFY_DATABASE_URL="postgresql://[USERNAME]:[PASSWORD]@[HOST]/[DATABASE]?sslmode=require&channel_binding=require"
```

### 2. 의존성 패키지 설치
```bash
npm install
```

### 3. Prisma Client 생성 및 데이터베이스 마이그레이션
```bash
npx prisma generate
npx prisma migrate dev
```

### 4. 로컬 개발 서버 실행
```bash
npm run dev
```

## Netlify 웹 배포

이 프로젝트는 Netlify를 통해 프로덕션 환경에 호스팅됩니다.

### 빌드 및 배포 설정 (`netlify.toml`)
- **빌드 명령어**: `npm ci && npm run build`
- **배포 디렉토리**: `.next`
- **노드 버전**: 20
- **환경 변수**: Netlify 설정 대시보드에서 `NETLIFY_DATABASE_URL`을 Neon DB 연결 정보로 등록해야 빌드 및 가동이 정상적으로 작동합니다.
