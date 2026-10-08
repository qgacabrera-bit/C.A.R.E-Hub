// Light / dark theme. Follows the device setting until the student taps the sun/moon button; that
// choice is remembered in this browser. Loaded as a plain (blocking) script in <head> so the saved
// theme is applied before the page paints - no flash of the wrong theme.
(function () {
  var KEY = 'care.theme';
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function saved() {
    try {
      var value = localStorage.getItem(KEY);
      return value === 'light' || value === 'dark' ? value : null;
    } catch (e) {
      return null;
    }
  }
  function current() {
    return root.getAttribute('data-theme') || (media && media.matches ? 'dark' : 'light');
  }

  var choice = saved();
  if (choice) root.setAttribute('data-theme', choice);

  // Static, trusted icon markup (no user content).
  var SUN = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  function paint(button) {
    var dark = current() === 'dark';
    var label = dark ? 'Switch to light mode' : 'Switch to dark mode';
    button.innerHTML = dark ? SUN : MOON;
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  document.addEventListener('DOMContentLoaded', function () {
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    buttons.forEach(function (button) {
      paint(button);
      button.addEventListener('click', function () {
        var next = current() === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        try {
          localStorage.setItem(KEY, next);
        } catch (e) {
          /* private mode: the choice lasts for this page only */
        }
        buttons.forEach(paint);
      });
    });
    // Until the student picks a theme, keep following the device (e.g. automatic night mode).
    if (media && media.addEventListener) {
      media.addEventListener('change', function () {
        if (!saved()) buttons.forEach(paint);
      });
    }
  });
})();
