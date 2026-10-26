/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Analytics base driven by CSS variables so the whole surface/text
        // palette can swap between the light "Stride" theme and a dark theme
        // (see `:root` / `.dark` in index.css). `ink` = surfaces, `fg` = text,
        // `line` = hairline borders/rings. Brand/data-viz accents below stay
        // constant across themes. Channel-triplet vars keep `<alpha-value>`
        // opacity modifiers (e.g. `bg-ink-800/60`) working.
        ink: {
          900: "rgb(var(--c-ink-900) / <alpha-value>)", // page canvas
          800: "rgb(var(--c-ink-800) / <alpha-value>)", // panels / cards / menus
          700: "rgb(var(--c-ink-700) / <alpha-value>)", // subtle fills / hover chips
          600: "rgb(var(--c-ink-600) / <alpha-value>)",
          500: "rgb(var(--c-ink-500) / <alpha-value>)",
        },
        fg: {
          DEFAULT: "rgb(var(--c-fg) / <alpha-value>)",       // primary text
          muted: "rgb(var(--c-fg-muted) / <alpha-value>)",   // secondary text
          subtle: "rgb(var(--c-fg-subtle) / <alpha-value>)", // labels / disabled
        },
        line: {
          DEFAULT: "var(--c-line)",       // hairline border / ring
          strong: "var(--c-line-strong)",
        },
        accent: {
          DEFAULT: "#3E4754",
          400: "#5A6574",
          500: "#3E4754",
          600: "#323A45",
          700: "#272D36",
        },
        // One-release alias: leftover `brick` classes compile to quiet signal.bad.
        brick: {
          DEFAULT: "#9A5A52",
          400: "#9A5A52",
          500: "#9A5A52",
          600: "#9A5A52",
          700: "#9A5A52",
        },
        gold: {
          400: "#C79A3E",
          500: "#A98A34",
          600: "#8C6F28",
        },
        blue: {
          400: "#5B9BD5",
          500: "#3179C9",
          600: "#2A67AD",
        },
        teal: {
          400: "#3BC2B6",
          500: "#2BB0A6",
        },
        violet: {
          400: "#9A8CF0",
          500: "#7C6FE0",
          600: "#6A5CD0",
          700: "#5A4CC0",
        },
        cyan: {
          400: "#3BC2B6",
          500: "#22A5C9",
        },
        // Soft pastel data-cell / heatmap tints (Stride-style).
        heat: {
          blue: "#DCEAF8",
          tan: "#EAE0C6",
          pink: "#F6DAD5",
          green: "#DBEBDC",
        },
        signal: {
          good: "#4A7A5C",
          drift: "#8F7A3A",
          warn: "#A6843A",
          bad: "#9A5A52",
          critical: "#8A4E47",
        },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui"],
        mono: ["'JetBrains Mono'", "ui-monospace", "SFMono-Regular"],
        display: ["'Inter'", "ui-sans-serif"],
      },
      boxShadow: {
        tile: "0 1px 2px rgba(16,18,23,0.04), 0 0 0 1px rgba(16,18,23,0.05)",
        "tile-hover":
          "0 1px 2px rgba(16,18,23,0.05), 0 0 0 1px rgba(62,71,84,0.18), 0 12px 28px -10px rgba(62,71,84,0.18)",
        "glow-brick":
          "0 1px 2px rgba(16,18,23,0.04), 0 0 0 1px rgba(16,18,23,0.05)",
        "glow-gold": "0 6px 18px -8px rgba(169,138,52,0.22)",
        "glow-violet": "0 6px 18px -8px rgba(124,111,224,0.22)",
        depth: "0 10px 30px -12px rgba(16,18,23,0.18), 0 0 0 1px rgba(16,18,23,0.06)",
      },
      backgroundImage: {
        mesh: "radial-gradient(at 12% 4%, rgba(62,71,84,0.04) 0%, transparent 42%), radial-gradient(at 92% 0%, rgba(124,111,224,0.05) 0%, transparent 40%)",
        grain: "radial-gradient(rgba(16,18,23,0.022) 1px, transparent 1px)",
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        shimmer: "shimmer 2.4s linear infinite",
        marquee: "marquee 60s linear infinite",
        "ring-pulse": "ring-pulse 2.4s cubic-bezier(0,0,0.2,1) infinite",
        drift: "drift 14s ease-in-out infinite",
      },
      keyframes: {
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        marquee: {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(-50%)" },
        },
        "ring-pulse": {
          "0%": { transform: "scale(0.6)", opacity: "0.45" },
          "100%": { transform: "scale(2.2)", opacity: "0" },
        },
        drift: {
          "0%, 100%": { transform: "translate3d(0, 0, 0)" },
          "50%": { transform: "translate3d(2%, -1.5%, 0)" },
        },
      },
    },
  },
  plugins: [],
};
