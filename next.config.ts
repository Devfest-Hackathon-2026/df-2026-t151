import type { NextConfig } from 'next';
const config: NextConfig = {
    output: 'standalone',
    // Search terms must not appear in Next.js development access logs.
    logging: {
        incomingRequests: {
            ignore: [/\/api\/v1\/(?:places|recommendations|itineraries\/validate)(?:[/?]|$)/],
        },
    },
};
export default config;
