/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: ["./views/**/*.hbs"],
  theme: {
    extend: {
      colors: {
        mesh: {
          bg: "#0a0e14",
          surface: "#111820",
          card: "#151d28",
          border: "#1e2a3a",
          accent: "#00d4ff",
          accentDim: "#00a8cc",
          green: "#00ff88",
          purple: "#a855f7",
          muted: "#6b7a8d",
          text: "#c8d6e5",
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Fira Code"', "monospace"],
      },
    },
  },
  plugins: [],
};
