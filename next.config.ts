import { readFileSync } from "node:fs";

import type { NextConfig } from "next";

import { MAX_REQUEST_BODY_BYTES } from "./src/lib/types/domain.ts";

// The version this deployment runs, compared with the latest release by
// "Check for updates" in Settings (src/lib/software-update.ts).
const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as {
  version: string;
};

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_SIGNUDOC_VERSION: version,
  },
  experimental: {
    // Every request passes through the Proxy (src/proxy.ts), and Next.js
    // keeps only the first 10 MB of a body that does. With local disk
    // storage the PDF is sent in the request itself, so the limit has to
    // fit a PDF at the 20 MB upload limit and the rest of the form.
    // https://nextjs.org/docs/app/api-reference/config/next-config-js/proxyClientMaxBodySize
    proxyClientMaxBodySize: MAX_REQUEST_BODY_BYTES,
  },
  images: {
    unoptimized: true,
  },
  // Finished PDFs are drawn with fonts read from disk at runtime, cut down
  // by a WebAssembly subsetter (src/lib/services/pdf-fonts.ts). Listing the
  // files here makes sure they are copied into the deployed functions.
  outputFileTracingIncludes: {
    "/api/**": [
      "./src/assets/fonts/*.ttf",
      "./node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm",
    ],
  },
};

export default nextConfig;
