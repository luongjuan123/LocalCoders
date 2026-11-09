/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        ide: {
          bg: '#0f172a',
          sidebar: '#111827',
          activityBar: '#0b0f19',
          editor: '#1e1e2e',
          activeTab: '#1e1e2e',
          inactiveTab: '#141724',
          panel: '#111827',
          border: '#1f2937',
          hover: '#1e293b',
          accent: '#38bdf8',
          accentHover: '#0284c7',
          critic: '#ef4444',
          subagent: '#10b981',
          mainAgent: '#818cf8',
          textMuted: '#94a3b8',
          textBright: '#f8fafc'
        }
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'Courier New', 'monospace'],
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      }
    },
  },
  plugins: [],
}
