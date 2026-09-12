/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx}", "./components/**/*.{js,jsx}", "./lib/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        // Blue Chip house palette. Deliberately nothing pink or violet —
        // this app must not read as a Blac & Pink product.
        chip: {
          50:  "#eef4fb",
          100: "#d7e6f5",
          200: "#aec9e8",
          300: "#7ea7d6",
          400: "#4d81bf",
          500: "#2c60a0",
          600: "#1f4a80",
          700: "#193a64",
          800: "#152e4d",
          900: "#0f2035",
        },
        brass: "#9a6b1f",
      },
      fontFamily: {
        sans: ["Public Sans", "system-ui", "Segoe UI", "sans-serif"],
      },
    },
  },
  plugins: [],
};
