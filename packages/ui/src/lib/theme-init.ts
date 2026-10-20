// The script that sets the theme class on <html> before first paint, so a dark-mode visitor never sees
// a light flash. next-themes writes an equivalent script of its own, but it renders it from a function
// the bundler re-minifies, so its text (and hash) changes with the build. This one is a plain string,
// so its hash is fixed and the Content-Security-Policy can name it (THEME_SCRIPT_HASH in csp.ts, checked
// by a unit test). The theme provider turns next-themes' own script inert and renders this one.
// It does what next-themes does for this app's settings: class attribute, stored under "theme",
// following the system until a choice is made, and the matching color-scheme.
export const THEME_INIT_SCRIPT =
  '(function(){try{var d=document.documentElement,t=localStorage.getItem("theme")||"system",r=t==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):t;d.classList.remove("light","dark");d.classList.add(r);if(r==="light"||r==="dark")d.style.colorScheme=r}catch(e){}})()';
