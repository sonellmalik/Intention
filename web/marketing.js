/* Tiny, framework-free enhancements for the Intention marketing site.
   Progressive enhancement only - the page is fully usable without JS. */
(function () {
    'use strict';

    var toggle = document.getElementById('mk-nav-toggle');
    var links = document.getElementById('mk-nav-links');
    if (!toggle || !links) return;

    function closeMenu() {
        links.classList.remove('mk-open');
        toggle.setAttribute('aria-expanded', 'false');
    }

    toggle.addEventListener('click', function () {
        var open = links.classList.toggle('mk-open');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    // Close the mobile menu after tapping any link inside it.
    links.addEventListener('click', function (e) {
        if (e.target.closest('a')) closeMenu();
    });

    // Close on Escape for keyboard users.
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeMenu();
    });
})();
