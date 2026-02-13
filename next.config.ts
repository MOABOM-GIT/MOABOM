import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'self' *",
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=*, microphone=*, fullscreen=*',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
