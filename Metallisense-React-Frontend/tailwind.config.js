/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Premium Metallic Green Palette (Industrial Grade)
        primary: {
          50: "#f0fdf6",
          100: "#dcfceb",
          200: "#b9f8d6",
          300: "#7eedb4",
          400: "#3dd98b",
          500: "#15c26b", // Main brand - Rich metallic green
          600: "#0fa055", // Darker solid green
          700: "#0e7e46",
          800: "#10643a",
          900: "#0f5231",
          950: "#052e1b",
        },
        // Secondary Metallic Accent
        accent: {
          50: "#ecfdf5",
          100: "#d1fae5",
          500: "#10b981", // Emerald accent
          600: "#059669",
          700: "#047857",
        },
        // Metal/Steel Grey Palette
        metal: {
          50: "#f8fafb",
          100: "#f1f5f8",
          200: "#e5eaef",
          300: "#d1dae3",
          400: "#9eafc0",
          500: "#6b7f94",
          600: "#4f5f73",
          700: "#3d4a5a",
          800: "#2d3742",
          900: "#1a2129",
          950: "#0f1419",
        },
        // Status Colors (Premium)
        success: "#15c26b",
        warning: "#f59e0b",
        error: "#ef4444",
        info: "#0ea5e9",
      },
      fontFamily: {
        sans: ["Montserrat", "system-ui", "-apple-system", "sans-serif"],
        mono: ["JetBrains Mono", "Consolas", "monospace"],
      },
      boxShadow: {
        'metal': '0 2px 8px rgba(15, 194, 107, 0.1)',
        'metal-lg': '0 8px 24px rgba(15, 194, 107, 0.15)',
        'metal-xl': '0 16px 48px rgba(15, 194, 107, 0.2)',
      },
      backgroundImage: {
        'gradient-metal': 'linear-gradient(135deg, #15c26b 0%, #0fa055 100%)',
        'gradient-dark': 'linear-gradient(135deg, #2d3742 0%, #1a2129 100%)',
      },
    },
  },
  plugins: [],
};
