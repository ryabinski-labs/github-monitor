// Loaded synchronously from <head> so the stored theme is on <html> before the
// stylesheet paints; a light-theme user would otherwise get a flash of dark
// while app.js boots. It lives in a file rather than inline in index.html
// because the server sends "script-src 'self'", which blocks inline scripts.
try {
  const settings = JSON.parse(localStorage.getItem("pr-deck:v1") || "{}");
  document.documentElement.dataset.theme = settings.theme === "light" ? "light" : "dark";
} catch {
  document.documentElement.dataset.theme = "dark";
}
