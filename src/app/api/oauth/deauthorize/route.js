import prisma from '@/lib/db';
import { revokeThreadsAccess } from '@/lib/meta-account-removal';
import {
  metaCallbackErrorResponse,
  readAndVerifyMetaSignedRequest,
} from '@/lib/meta-callback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ ready: true, method: 'POST' }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function POST(request) {
  try {
    const payload = await readAndVerifyMetaSignedRequest(request);
    const result = await prisma.$transaction((tx) => revokeThreadsAccess(tx, payload.user_id));
    return Response.json({ success: true, matched: result.matched }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return metaCallbackErrorResponse(error);
  }
}
