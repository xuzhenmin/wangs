import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ali-oss contains optional runtime-only proxy loading that Turbopack cannot
  // statically resolve. Keep the SDK in Node.js instead of bundling it.
  serverExternalPackages: ["ali-oss"],
  // Keep production builds usable on small Linux servers. Turbopack otherwise
  // creates workers based on the host CPU count and can exhaust limited RAM.
  experimental: {
    cpus: 1,
  },
};

export default nextConfig;
