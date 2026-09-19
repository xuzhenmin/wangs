import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allows isolated build/runtime verification without replacing a running site's assets.
  distDir: process.env.WANGS_BUILD_DIR || ".next",
  // ali-oss contains optional runtime-only proxy loading that Turbopack cannot
  // statically resolve. Keep the SDK in Node.js instead of bundling it.
  serverExternalPackages: ["ali-oss"],
  // Private video task records and downloaded media are runtime data, not build assets.
  outputFileTracingExcludes: {
    "/*": ["./data/video-imports/**/*"],
  },
  // Keep production builds usable on small Linux servers. Turbopack otherwise
  // creates workers based on the host CPU count and can exhaust limited RAM.
  experimental: {
    cpus: 1,
  },
};

export default nextConfig;
