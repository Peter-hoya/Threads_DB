import { signedUploadPost, uploadContractResponse } from './_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return uploadContractResponse();
}

export async function POST(request) {
  return signedUploadPost(request);
}
