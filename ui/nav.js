(function () {
  const links = [
    { href: '/', label: 'Search' },
    { href: '/report', label: 'Report' },
    { href: '/learn', label: 'Learn' },
    { href: '/dashboard', label: 'Dashboard' },
  ];
  const path = window.location.pathname;
  const container = document.getElementById('site-nav');
  if (!container) return;
  const nav = document.createElement('nav');
  nav.className = 'flex items-center space-x-1';
  links.forEach(function ({ href, label }) {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = label;
    a.className = path === href
      ? 'px-3 py-1.5 rounded-md bg-indigo-50 text-indigo-700 font-medium text-sm'
      : 'px-3 py-1.5 rounded-md text-gray-500 hover:text-gray-800 hover:bg-gray-100 transition text-sm';
    nav.appendChild(a);
  });
  container.appendChild(nav);
})();
