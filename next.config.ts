import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep production builds usable on small Linux servers. Turbopack otherwise
  // creates workers based on the host CPU count and can exhaust limited RAM.
  experimental: {
    cpus: 1,
  },
};

export default nextConfig;
