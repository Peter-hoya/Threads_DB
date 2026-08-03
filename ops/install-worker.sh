#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/threads-db"
SERVICE_USER="threads-worker"
ENV_FILE="/etc/threads-worker.env"
SERVICE_FILE="/etc/systemd/system/threads-worker.service"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

if [[ ! -f "${APP_DIR}/worker/src/main.js" || ! -f "${APP_DIR}/package-lock.json" ]]; then
  echo "APP_DIR must point to the checked-out Threads_DB repository: ${APP_DIR}" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer must be installed first." >&2
  exit 1
fi

read -r NODE_MAJOR NODE_MINOR < <(node -p 'process.versions.node.split(".").slice(0, 2).join(" ")')
if (( NODE_MAJOR < 20 || (NODE_MAJOR == 20 && NODE_MINOR < 11) )); then
  echo "Node.js 20.11 or newer is required; found $(node --version)." >&2
  exit 1
fi

if ! getent passwd "${SERVICE_USER}" >/dev/null; then
  useradd --system --home-dir "/var/lib/${SERVICE_USER}" --shell /usr/sbin/nologin "${SERVICE_USER}"
fi
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0750 "/var/lib/${SERVICE_USER}"

if [[ ! -e "${ENV_FILE}" ]]; then
  install -o root -g "${SERVICE_USER}" -m 0640 \
    "${APP_DIR}/ops/threads-worker.env.example" "${ENV_FILE}"
  echo "Created ${ENV_FILE}. Replace every placeholder before starting the service."
fi

set -a
# Prisma generate reads both datasource variables from the schema.
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

cd "${APP_DIR}"
npm ci --omit=dev
npx --no-install prisma generate

if ! runuser -u "${SERVICE_USER}" -- test -r "${APP_DIR}/worker/src/main.js"; then
  echo "${SERVICE_USER} cannot read ${APP_DIR}; keep code root-owned but make it group/world-readable." >&2
  exit 1
fi
install -o root -g root -m 0644 "${APP_DIR}/ops/threads-worker.service" "${SERVICE_FILE}"

systemctl daemon-reload
systemctl enable threads-worker.service

if [[ "${RUN_MIGRATIONS:-0}" == "1" ]]; then
  if grep -Eq 'REPLACE_WITH|YOUR_PROJECT|USER:PASSWORD|DIRECT_HOST|@HOST/' "${ENV_FILE}"; then
    echo "Refusing migration while ${ENV_FILE} still contains placeholders." >&2
    exit 1
  fi
  runuser -u "${SERVICE_USER}" -- npx --no-install prisma migrate deploy
fi

if [[ "${INSTALL_START:-0}" == "1" ]]; then
  if grep -Eq 'REPLACE_WITH|YOUR_PROJECT|USER:PASSWORD|DIRECT_HOST|@HOST/' "${ENV_FILE}"; then
    echo "Refusing to start while ${ENV_FILE} still contains placeholders." >&2
    exit 1
  fi
  systemctl restart threads-worker.service
else
  echo "Installed and enabled. Configure ${ENV_FILE}, then run:"
  echo "  systemctl start threads-worker.service"
fi
