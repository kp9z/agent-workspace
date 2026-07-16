import path from 'node:path';
import type { NextConfig } from 'next';

const isProd = process.env.NODE_ENV === 'production';

function buildContentSecurityPolicy() {
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    `connect-src 'self'${isProd ? '' : ' ws: wss:'}`,
    "font-src 'self' data:",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
  ];
  return directives.join('; ');
}

function buildSecurityHeaders() {
  const headers = [
    { key: 'Content-Security-Policy', value: buildContentSecurityPolicy() },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  ];

  if (isProd) {
    // Safe behind HTTPS: browsers only honor HSTS over secure origins, and we keep it production-only.
    headers.push({ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' });
  }

  return headers;
}

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.resolve(__dirname),
  async headers() {
    return [
      {
        source: '/:path*',
        headers: buildSecurityHeaders(),
      },
      {
        source: '/api/:path*',
        headers: [
          { key: 'Cache-Control', value: 'private, no-store, max-age=0, must-revalidate' },
        ],
      },
    ];
  },
  env: {
    NEXT_PUBLIC_AGENT_WORKSPACE_NAME: process.env.NEXT_PUBLIC_AGENT_WORKSPACE_NAME || process.env.AGENT_WORKSPACE_NAME || 'Agent Workspace',
    NEXT_PUBLIC_AGENT_WORKSPACE_SHORT_NAME: process.env.NEXT_PUBLIC_AGENT_WORKSPACE_SHORT_NAME || process.env.AGENT_WORKSPACE_SHORT_NAME || 'Agent',
    NEXT_PUBLIC_AGENT_DISPLAY_NAME: process.env.NEXT_PUBLIC_AGENT_DISPLAY_NAME || process.env.AGENT_DISPLAY_NAME || 'Agent',
    NEXT_PUBLIC_USER_DISPLAY_NAME: process.env.NEXT_PUBLIC_USER_DISPLAY_NAME || process.env.USER_DISPLAY_NAME || 'User',
  },
  // Type checking is run explicitly via `npm run typecheck` in CI/smoke.
  // Skipping Next's duplicate build-time TS pass keeps VPS packaging bounded.
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
