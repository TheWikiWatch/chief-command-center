// Tailwind v4 through PostCSS. Which files it scans is set in app/globals.css (`source("..")`, relative to
// that file), so a server started from another folder still compiles this app's classes.
module.exports = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
