import path from 'node:path'

/** @type {import('next').NextConfig} */
export default {
  serverExternalPackages: ['mammoth', 'unpdf'],
  devIndicators: false,
  images: { unoptimized: true },
  outputFileTracingRoot: path.resolve('.'),
  turbopack: { root: path.resolve('.') },
}
