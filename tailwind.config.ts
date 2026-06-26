import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        bg:              '#f0f4f9',
        surface:         '#ffffff',
        'surface-raised':'#ffffff',
        'surface-hover': '#f4f7fb',
        border:          '#dde3ed',
        'border-light':  '#c9d2e0',
        'text-primary':  '#0f172a',
        'text-secondary':'#475569',
        'text-muted':    '#94a3b8',
        accent:          '#4f46e5',
        'accent-dim':    'rgba(79,70,229,0.08)',
        'accent-glow':   'rgba(79,70,229,0.18)',
        success:         '#16a34a',
        warning:         '#d97706',
        danger:          '#dc2626',
        locked:          '#64748b',
      },
      fontFamily: {
        mono: ['IBM Plex Mono', 'JetBrains Mono', 'monospace'],
        sans: ['Inter', 'DM Sans', 'sans-serif'],
      },
      boxShadow: {
        'glow-sm':    '0 0 12px rgba(79,70,229,0.12)',
        'glow':       '0 0 24px rgba(79,70,229,0.18)',
        'card':       '0 1px 3px rgba(15,23,42,0.06), 0 4px 16px rgba(15,23,42,0.04)',
        'card-hover': '0 4px 24px rgba(15,23,42,0.1)',
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(ellipse at center, var(--tw-gradient-stops))',
      },
      animation: {
        'spin-slow':     'spin 2s linear infinite',
        'pulse-subtle':  'pulse 3s ease-in-out infinite',
      },
      borderRadius: {
        'xl':  '12px',
        '2xl': '16px',
      },
    },
  },
  plugins: [],
}
export default config
