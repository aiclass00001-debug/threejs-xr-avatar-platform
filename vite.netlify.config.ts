import netlify from "@netlify/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: {
    exclude: ["mind-ar"],
  },
  plugins: [
    {
      name: "mindar-three-modern-compat",
      enforce: "pre",
      transform(code, id) {
        if (!id.includes("mindar-image-three.prod.js")) return null;
        return code
          .replace("sRGBEncoding as Si", "SRGBColorSpace as Si")
          .replace("renderer.outputEncoding = Si", "renderer.outputColorSpace = Si");
      },
    },
    react(),
    netlify(),
  ],
  build: {
    outDir: "netlify-dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
