import type { Config } from "tailwindcss";

/**
 * ade-lens design tokens — the ADE family look (slate chrome + sky accent) on a
 * real Tailwind pipeline (not the CDN). Components lean on
 * Tailwind's slate/sky scales directly; the semantic aliases below let us
 * rebrand from one place without touching every class.
 */
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./content/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#0284c7", // sky-600 — primary accent (FAB, CTAs)
          accent: "#38bdf8", // sky-400 — logo accent, highlights
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};

export default config;
