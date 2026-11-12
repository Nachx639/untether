module.exports = {
  plugins: [
    require('@tailwindcss/postcss'),
    // The client build's id, after Tailwind (scripts/postcss-build-id.js)
    require('./scripts/postcss-build-id.js'),
  ],
}
