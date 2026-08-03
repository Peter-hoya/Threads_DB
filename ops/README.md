# VPS operations

The worker is installed as a dedicated, unprivileged `threads-worker` systemd
service. The systemd hardening profile expects the repository at
`/opt/threads-db`.

기존 OpenClaw/Hermes가 직접 발행하던 cron은 새 worker를 시작하기 전에 반드시
중지하십시오. 두 발행기가 같은 큐를 처리하면 중복 게시 위험이 있습니다. 예를 들어
`openclaw cron list`로 확인한 뒤 기존 `social-publisher-neon-direct` 작업을 disable
또는 remove하고, 대시보드의 durable queue만 단일 발행 원천으로 사용합니다.

```bash
cd /opt/threads-db
sudo bash ops/install-worker.sh
sudoedit /etc/threads-worker.env
sudo RUN_MIGRATIONS=1 bash ops/install-worker.sh
sudo systemctl start threads-worker
```

The installer deliberately does not start the service by default, so a sample
database URL or encryption key can never be used accidentally. To install,
migrate and start in one invocation after the environment file is valid:

```bash
sudo RUN_MIGRATIONS=1 INSTALL_START=1 bash ops/install-worker.sh
```

Operational commands:

```bash
sudo systemctl status threads-worker
sudo journalctl -u threads-worker -f
sudo systemctl restart threads-worker
sudo systemctl stop threads-worker
```

`CONTENT_REUSE_COOLDOWN_DAYS` defaults to 90. It applies only to already
published content; identical queued or publishing content is always blocked.
Jobs marked `needs_reconciliation` must be compared with the live Threads account
before any manual requeue.

Before a release, perform a read-only preview without editing the saved service
configuration:

```bash
sudo systemctl stop threads-worker
sudo -u threads-worker bash -c '
  set -a
  source /etc/threads-worker.env
  set +a
  DRY_RUN=1 DRY_RUN_ONCE=1 node /opt/threads-db/worker/src/main.js
'
```

See [`worker/README.md`](../worker/README.md) for the queue and recovery model.
