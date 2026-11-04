import type { Config } from 'tailwindcss'

const systemFontStack = [
  'ui-sans-serif',
  'system-ui',
  '-apple-system',
  'BlinkMacSystemFont',
  '"Segoe UI"',
  'sans-serif',
]

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    '../web/components/DayView.tsx',
    '../web/components/DashboardPageHeader.tsx',
    '../web/ui/Button.tsx',
    '../web/ui/Container.tsx',
    '../web/ui/Spinner.tsx',
  ],
  theme: {
    borderWidth: {
      DEFAULT: '0.5px',
      0: '0px',
      2: '2px',
      4: '4px',
      8: '8px',
    },
    fontFamily: {
      sans: systemFontStack,
      display: systemFontStack,
    },
    fontSize: {
      xs: ['11px', '18px'],
      sm: ['12px', '18px'],
      md: ['14px', '20px'],
      base: ['14px', '20px'],
      lg: ['17px', '25px'],
      xl: ['21px', '29px'],
      '2xl': ['24px', '32px'],
      '3xl': ['30px', '38px'],
      '4xl': ['48px', '56px'],
      '5xl': ['68px', '76px'],
      '6xl': ['76px', '84px'],
    },
    extend: {
      colors: {
        'on-danger': 'oklch(var(--on-danger) / <alpha-value>)',
        slate: {
          50: 'oklch(var(--neutral-50, 0.984 0.003 247.858) / <alpha-value>)',
          100: 'oklch(var(--neutral-100, 0.968 0.007 247.896) / <alpha-value>)',
          200: 'oklch(var(--neutral-200, 0.929 0.013 255.508) / <alpha-value>)',
          250: 'oklch(var(--neutral-250, 0.899 0.01 255) / <alpha-value>)',
          300: 'oklch(var(--neutral-300, 0.869 0.02 252.894) / <alpha-value>)',
          400: 'oklch(var(--neutral-400, 0.711 0.035 256.788) / <alpha-value>)',
          500: 'oklch(var(--neutral-500, 0.554 0.041 257.417) / <alpha-value>)',
          600: 'oklch(var(--neutral-600, 0.446 0.037 257.281) / <alpha-value>)',
          700: 'oklch(var(--neutral-700, 0.372 0.039 257.287) / <alpha-value>)',
          800: 'oklch(var(--neutral-800, 0.279 0.037 260.031) / <alpha-value>)',
          900: 'oklch(var(--neutral-900, 0.208 0.04 265.755) / <alpha-value>)',
          950: 'oklch(var(--neutral-950, 0.129 0.041 264.695) / <alpha-value>)',
        },
        blue: {
          0: 'oklch(var(--blue-0) / <alpha-value>)',
          100: 'oklch(var(--blue-100) / <alpha-value>)',
          200: 'oklch(var(--blue-200) / <alpha-value>)',
          300: 'oklch(var(--blue-300) / <alpha-value>)',
          400: 'oklch(var(--blue-400) / <alpha-value>)',
          500: 'oklch(var(--blue-500) / <alpha-value>)',
          600: 'oklch(var(--blue-600) / <alpha-value>)',
          700: 'oklch(var(--blue-700) / <alpha-value>)',
          800: 'oklch(var(--blue-800) / <alpha-value>)',
          900: 'oklch(var(--blue-900) / <alpha-value>)',
          1000: 'oklch(var(--blue-1000) / <alpha-value>)',
        },
        success: {
          100: 'oklch(var(--success-100) / <alpha-value>)',
          200: 'oklch(var(--success-200) / <alpha-value>)',
          500: 'oklch(var(--success-500) / <alpha-value>)',
          700: 'oklch(var(--success-700) / <alpha-value>)',
        },
        warning: {
          100: 'oklch(var(--warning-100) / <alpha-value>)',
          200: 'oklch(var(--warning-200) / <alpha-value>)',
          500: 'oklch(var(--warning-500) / <alpha-value>)',
          700: 'oklch(var(--warning-700) / <alpha-value>)',
        },
        danger: {
          100: 'oklch(var(--danger-100) / <alpha-value>)',
          200: 'oklch(var(--danger-200) / <alpha-value>)',
          500: 'oklch(var(--danger-500) / <alpha-value>)',
          700: 'oklch(var(--danger-700) / <alpha-value>)',
        },
        info: {
          100: 'oklch(var(--info-100) / <alpha-value>)',
          200: 'oklch(var(--info-200) / <alpha-value>)',
          500: 'oklch(var(--info-500) / <alpha-value>)',
          700: 'oklch(var(--info-700) / <alpha-value>)',
        },
      },
      boxShadow: {
        softer: '0 4px 4px 0 rgba(23,23,23,0.04)',
        soft: '0 10px 40px -12px rgba(0,0,0,0.10), 0 2px 6px rgba(0,0,0,0.03)',
        raised: '0 0 0 1px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.05), 0 4px 10px -4px rgba(0,0,0,0.05)',
        shell: 'var(--shadow-shell)',
        inset: 'inset 0 0 0 1px rgba(0,0,0,0.05)',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}

export default config
