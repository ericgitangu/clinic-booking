/* global window, document, localStorage, MutationObserver */
/* Theme, scroll shadow and menu keys for the frame on /docs and /redoc. Loaded as a blocking script
   in <head> so the theme is set before first paint; same-origin, so the page CSP (script-src 'self')
   holds. The theme uses the key the rest of the site stores its choice under. */
(function () {
  var root = document.documentElement;
  var stored = null;
  try { stored = localStorage.getItem("theme"); } catch { /* storage blocked: follow the system */ }
  var media = window.matchMedia("(prefers-color-scheme: dark)");
  function apply(choice) {
    var dark = choice === "dark" || (choice !== "light" && media.matches);
    root.classList.toggle("dark", dark);
    root.setAttribute("data-theme", dark ? "dark" : "light");
    return dark;
  }
  var dark = apply(stored);

  document.addEventListener("DOMContentLoaded", function () {
    var header = document.querySelector(".shell-header");
    var menu = document.getElementById("shell-menu");
    var theme = document.getElementById("shell-theme");

    function label() {
      theme.setAttribute("aria-label", dark ? "Switch to the light theme" : "Switch to the dark theme");
      theme.textContent = dark ? "Light" : "Dark";
    }
    if (theme) {
      label();
      theme.addEventListener("click", function () {
        var next = dark ? "light" : "dark";
        try { localStorage.setItem("theme", next); } catch { /* the choice lasts for this page only */ }
        dark = apply(next);
        label();
      });
    }

    // Swagger UI treats the URL hash as a deep link to an operation, so "#main" would be taken from
    // it. Moving focus directly leaves the hash alone; without this script the plain link still works.
    var skip = document.querySelector(".shell-skip");
    var main = document.getElementById("main");
    if (skip && main) {
      skip.addEventListener("click", function (e) {
        e.preventDefault();
        main.focus();
      });
    }

    // Swagger UI draws its "Servers" select without a label. Name it from the wrapper, and any other
    // unnamed select by what it chooses, as the viewer re-renders.
    var swagger = document.getElementById("swagger-ui");
    if (swagger) {
      var nameSelects = function () {
        var found = swagger.querySelectorAll("select");
        for (var i = 0; i < found.length; i++) {
          var sel = found[i];
          if (sel.getAttribute("aria-label")) continue;
          sel.setAttribute("aria-label", sel.closest(".servers") ? "Servers" : "Choose an option");
        }
      };
      new MutationObserver(nameSelects).observe(swagger, { childList: true, subtree: true });
      nameSelects();
    }

    function onScroll() { header.setAttribute("data-scrolled", String(window.scrollY > 0)); }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    if (menu) {
      menu.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && menu.open) {
          menu.open = false;
          menu.querySelector("summary").focus();
        }
      });
      menu.addEventListener("focusout", function (e) {
        if (menu.open && !menu.contains(e.relatedTarget)) menu.open = false;
      });
      document.addEventListener("pointerdown", function (e) {
        if (menu.open && !menu.contains(e.target)) menu.open = false;
      });
    }
  });
})();
