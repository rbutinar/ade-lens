/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // A second dev server (e.g. a preview next to the one in a terminal) must not share `.next`:
  // two `next dev` writing the same build dir corrupt each other's chunks.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // ESLint is not wired; keep `next build` non-interactive. TypeScript type-checking still runs
  // and gates the build.
  eslint: { ignoreDuringBuilds: true },
  // The SQL Server store (LENS_STORE=sqlserver) talks through msnodesqlv8, a native Windows
  // module: it is loaded by Node at runtime, never bundled.
  serverExternalPackages: ["mssql", "msnodesqlv8"],
};

export default nextConfig;
