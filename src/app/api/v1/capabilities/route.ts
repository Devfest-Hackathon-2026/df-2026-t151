import { apiCapabilities } from '../../../../server/api-capabilities.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
    return Response.json(apiCapabilities(), {
        headers: { 'Cache-Control': 'private, no-store, max-age=0' },
    });
}
