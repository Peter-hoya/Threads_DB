import { parseBasicAuthorization } from '@/lib/request-auth';

function clean(value, maxLength) {
  if (!value) return null;
  return String(value).slice(0, maxLength);
}

export function buildAuditEvent(request, {
  action,
  entityType,
  entityId = null,
  accountId = null,
  metadata = null,
  actorType = 'admin',
} = {}) {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const actorId = parseBasicAuthorization(request)?.username
    || process.env.ADMIN_BASIC_AUTH_USERNAME
    || 'dashboard-admin';

  return {
    accountId,
    actorType,
    actorId: clean(actorId, 200),
    action,
    entityType,
    entityId: entityId === null ? null : clean(entityId, 200),
    metadata,
    ipAddress: clean(request.headers.get('x-nf-client-connection-ip') || forwarded, 100),
    userAgent: clean(request.headers.get('user-agent'), 1000),
  };
}

