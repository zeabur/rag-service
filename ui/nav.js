(function () {
  var links = [
    { href: '/', label: 'Playground' },
    { href: '/dashboard', label: 'Dashboard' },
  ];
  var path = window.location.pathname;
  var container = document.getElementById('site-nav');
  if (!container) return;

  var nav = document.createElement('nav');
  nav.className = 'flex items-center bg-gray-100 rounded-lg p-0.5';

  links.forEach(function (link) {
    var a = document.createElement('a');
    a.href = link.href;
    a.textContent = link.label;
    a.className = path === link.href
      ? 'px-3 py-1 rounded-md bg-white text-indigo-700 font-medium text-sm shadow-sm'
      : 'px-3 py-1 rounded-md text-gray-500 hover:text-gray-800 text-sm transition';
    nav.appendChild(a);
  });

  container.appendChild(nav);
})();
