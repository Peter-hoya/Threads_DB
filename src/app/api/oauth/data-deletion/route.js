import prisma from '@/lib/db';
import { revokeThreadsAccess } from '@/lib/meta-account-removal';
import {
  dataDeletionConfirmationCode,
  metaCallbackErrorResponse,
  readAndVerifyMetaSignedRequest,
} from '@/lib/meta-callback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ ready: true, method: 'POST', statusPage: '/data-deletion' }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function POST(request) {
  try {
    const payload = await readAndVerifyMetaSignedRequest(request);
    const confirmationCode = dataDeletionConfirmationCode(payload.user_id);
    await prisma.$transaction((tx) => revokeThreadsAccess(tx, payload.user_id, {
      deleteMetaData: true,
      confirmationCode,
    }));

    const statusUrl = new URL('/data-deletion', request.url);
    statusUrl.searchParams.set('code', confirmationCode);
    return Response.json({
      url: statusUrl.toString(),
      confirmation_code: confirmationCode,
    }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return metaCallbackErrorResponse(error);
  }
}
