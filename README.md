# Threads 공식 API 승인형 자동 발행 시스템

본계정은 사람이 직접 운영하고, 본인이 소유한 부계정은 **공식 Meta Threads API**로만 발행하는 운영 시스템입니다. 관리자가 초안의 문안·미디어 권리·광고 고지를 확인해 승인하면, Contabo VPS의 단일 worker가 Neon durable queue를 처리합니다.

로그인 자동화, 모바일 기기 위장, 계정 구매, 제재 우회, 무승인 복제 발행은 포함하지 않습니다. 토큰이 없거나 정책 확인이 빠진 작업은 성공으로 가장하지 않고 중단됩니다.

## 구성

| 구성요소 | 역할 |
|---|---|
| Netlify / Next.js | Basic Auth 관리자 화면, 계정 OAuth, 초안·승인, 미디어 API |
| Neon Postgres | 계정 메타데이터, 암호화 자격증명, 게시물, job queue, 감사 로그 |
| Supabase Storage | 비공개 staging → 검증 → 공개 Threads 원본 URL |
| Contabo Ubuntu VPS | systemd로 24시간 동작하는 공식 Threads API worker |

## 안전한 발행 흐름

1. 본계정 또는 부계정용 초안을 관리자 화면에 저장합니다.
2. 본계정(`primary`) 글은 기록만 가능하며 worker가 절대 발행하지 않습니다.
3. 부계정 글은 사용 권리와 Meta·쿠팡파트너스 정책 확인 후 사람이 승인합니다. 미디어는 검증된 `threads-publish` Supabase 원본만 허용합니다.
4. 승인은 불변 payload hash와 account-neutral 중복 지문을 만들고 job을 한 번만 큐에 넣습니다.
5. worker는 운영 시간, 일일 내부 한도, 토큰 상태, 승인 hash와 중복을 다시 검증합니다.
6. Threads container를 만든 뒤 상태를 확인하고 `threads_publish`를 호출합니다.
7. 첫 답글이 있으면 별도 deduplicated job으로 발행해 답글 실패가 본문 재발행으로 이어지지 않게 합니다.

모든 자동 발행 게시물은 광고·제휴 고지가 필수입니다. 고지는 첫 답글이 있으면 답글 끝에, 없으면 본문 끝에 붙습니다. 고지를 붙인 최종 문장이 500자를 넘으면 승인 단계에서 차단됩니다. API가 제공하지 않는 Paid partnership UI 라벨은 계정별 실제 게시 정책을 따로 확인해야 합니다.

## 처음 한 번 설정

요구 사항은 Node.js 20.11+, PostgreSQL 호환 Neon 프로젝트, Supabase 프로젝트, Meta Threads 앱입니다.

```bash
npm ci
cp .env.example .env
```

`.env`의 placeholder를 실제 값으로 바꾼 뒤 확인합니다. 비밀값은 검사 출력에 표시되지 않습니다.

```bash
node --env-file=.env scripts/check-env.mjs --mode=all
npx prisma generate
npx prisma migrate deploy
node scripts/import-legacy-data.mjs
node scripts/import-legacy-data.mjs --apply
npm test
npm run build
```

`import-legacy-data`는 기본이 dry-run입니다. 기존 `social_accounts`, `content_templates`, `publish_queue`가 있으면 비밀 자격증명을 제외한 계정·템플릿·발행 이력만 새 스키마로 가져옵니다. 가져온 기존 계정은 안전하게 `primary`, API 미연결, 자동 발행 정지 상태가 됩니다.

## 환경 변수

전체 예시는 [`.env.example`](./.env.example)에 있습니다.

| 범위 | 변수 | 설명 |
|---|---|---|
| Neon | `NETLIFY_DATABASE_URL` | 앱·worker용 pooled TLS URL |
| Neon | `DIRECT_DATABASE_URL` | Prisma migration용 direct TLS URL |
| 관리자 | `ADMIN_BASIC_AUTH_USERNAME`, `ADMIN_BASIC_AUTH_PASSWORD` | production에서 미설정 시 관리자 화면 전체 차단 |
| 암호화 | `THREADS_TOKEN_ENCRYPTION_KEY` | 웹과 VPS가 공유하는 32-byte AES 키 |
| Meta | `THREADS_APP_ID`, `THREADS_APP_SECRET`, `THREADS_OAUTH_REDIRECT_URI` | 계정별 공식 OAuth 연결 |
| Supabase | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | service role은 서버에만 저장 |
| 내부 API | `UPLOAD_SIGNING_SECRET`, `CRON_SECRET`, `INTERNAL_API_SECRET` | 서로 다른 긴 임의 값 사용 |
| 콘텐츠 | `CONTENT_REUSE_COOLDOWN_DAYS` | 동일 콘텐츠 재사용 제한, 기본 90일 |
| 선택 AI | `OPENAI_API_KEY`, `OPENAI_MODEL` | 템플릿 기반 초안 생성; 모델을 명시적으로 고정 |

암호화 키는 한 번 생성해 Netlify와 VPS에 동일하게 저장합니다. 키를 잃으면 기존 토큰을 복구할 수 없고, 키를 바꾸려면 먼저 별도 재암호화 절차가 필요합니다.

```bash
openssl rand -base64 32
openssl rand -hex 32
```

## Netlify

Netlify 프로젝트에 `.env.example`의 웹 환경 변수를 등록합니다. build는 `netlify.toml`에 정의돼 있으며, production 배포 전에 migration을 별도로 완료합니다. OAuth redirect URI는 정확히 다음 형태로 Meta 앱에도 등록합니다.

```text
https://YOUR_ADMIN_DOMAIN/api/oauth/callback
```

배포 후 Basic Auth로 관리자 화면에 접속해 `/api/upload/setup`에 `POST`하면 `threads-staging` 비공개 버킷과 `threads-publish` 공개 버킷을 생성·검증합니다. 브라우저 업로드는 6 MiB 이하는 signed PUT, 그보다 큰 파일은 TUS 6 MiB chunk를 사용합니다.

## 계정 API 연결

1. 계정 관리에서 본계정 하나를 `본계정 — 수동 전용`으로 저장합니다.
2. 본인이 소유한 부계정을 `부계정 — 승인 후 자동 발행`으로 저장합니다.
3. 각 카드의 `OAuth 연결`을 눌러 해당 Threads 계정으로 동의합니다.
4. 연결 계정과 표시된 Threads ID가 맞는지 확인한 뒤 `발행 허용`을 켭니다.
5. 게시물 관리에서 초안을 저장하고 최종 검토 후 승인합니다.

액세스 토큰은 AES-256-GCM으로 계정 ID에 묶어 암호화하며 API 응답이나 worker 로그에 반환하지 않습니다. 필요하면 카드의 `API 연결 해제`로 토큰을 지우고 발행을 즉시 정지할 수 있습니다.

Threads 장기 토큰은 영구 토큰이 아닙니다. 대시보드와 `/api/cron/status`가 만료 7일 전부터 대상 계정을 표시하므로 만료 전에 OAuth로 다시 연결해야 합니다. 만료되거나 연결이 해제된 계정은 승인과 worker 발행이 모두 차단됩니다.

템플릿 화면의 AI 기능은 DB에 저장된 활성 템플릿만 읽고 Threads 초안을 만듭니다. 생성물은 곧바로 발행되지 않으며 모든 글이 `draft`로 저장되어 권리·정책·광고 고지 검토와 개별 승인을 거칩니다. AI를 사용하지 않으면 `OPENAI_*` 변수를 비워둬도 나머지 시스템은 동작합니다.

## VPS worker

저장소를 `/opt/threads-db`에 배치하고 [ops/README.md](./ops/README.md)를 따릅니다.

```bash
cd /opt/threads-db
sudo bash ops/install-worker.sh
sudoedit /etc/threads-worker.env
sudo RUN_MIGRATIONS=1 bash ops/install-worker.sh
```

기존 OpenClaw/Hermes direct-publish cron은 worker 시작 전에 중지합니다. 환경 설정 후 읽기 전용 preview를 먼저 실행하고, 정상일 때만 시작합니다.

```bash
sudo -u threads-worker bash -c '
  set -a
  source /etc/threads-worker.env
  set +a
  DRY_RUN=1 DRY_RUN_ONCE=1 node /opt/threads-db/worker/src/main.js
'
sudo systemctl start threads-worker
sudo systemctl status threads-worker
```

worker의 lease, retry, 장애 복구 및 Meta 발행 ambiguity 설명은 [worker/README.md](./worker/README.md)에 있습니다.

## 개발·검증 명령

```bash
npm run dev
npm run test:web
npm run test:worker
npm test
npm run build
git diff --check
```

`/api/posts/:id/publish`는 의도적으로 `410 Gone`을 반환합니다. 발행은 오직 승인 route가 만든 durable job을 VPS worker가 처리합니다.

Basic Auth를 사용하는 비브라우저 관리 API 호출은 CSRF 방어를 통과하도록 `X-Threads-Admin-Request: 1` 헤더도 보내야 합니다. 브라우저 관리 화면은 same-origin 요청 정보를 자동으로 사용합니다.
