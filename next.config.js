/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The box is shared with Pulse. Keeping source maps off in production is a
  // meaningful chunk of build memory on a 3.7 GB machine.
  productionBrowserSourceMaps: false,
};
module.exports = nextConfig;
