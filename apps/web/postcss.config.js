const path = require("path");

module.exports = {
  plugins: {
    // Tailwind looks for its config in the working directory unless told; a server started from
    // another folder would silently compile that folder's classes.
    tailwindcss: { config: path.join(__dirname, "tailwind.config.ts") },
    autoprefixer: {},
  },
};
