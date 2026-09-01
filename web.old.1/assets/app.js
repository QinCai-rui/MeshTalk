/* MeshTalk — shared interactions */

// Theme toggle
const themeToggle = document.getElementById('themeToggle');
const html = document.documentElement;
const savedTheme = localStorage.getItem('meshtalk-theme');
if (savedTheme) html.dataset.theme = savedTheme;
else if (window.matchMedia('(prefers-color-scheme: dark)').matches) html.dataset.theme = 'dark';

if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    const next = html.dataset.theme === 'dark' ? 'light' : 'dark';
    html.dataset.theme = next;
    localStorage.setItem('meshtalk-theme', next);
  });
}

// Mobile nav
const hamburger = document.querySelector('.hamburger');
const navLinks = document.querySelector('.nav-links');
if (hamburger && navLinks) {
  hamburger.addEventListener('click', () => navLinks.classList.toggle('open'));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.nav-inner')) navLinks.classList.remove('open');
  });
}

// Mesh canvas animation
(function() {
  const canvas = document.getElementById('mesh');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let w, h, nodes = [], active = true;
  const threshold = 110;
  const count = 70;

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    w = canvas.width = rect.width;
    h = canvas.height = rect.height;
  }
  window.addEventListener('resize', resize);
  resize();

  function initNodes() {
    nodes = [];
    for (let i = 0; i < count; i++) {
      nodes.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
        r: 2 + Math.random() * 2.5
      });
    }
  }
  initNodes();

  function getStyle() {
    const root = getComputedStyle(document.documentElement);
    return {
      accent: root.getPropertyValue('--accent').trim() || '#e8451e',
      inkFaint: root.getPropertyValue('--ink-faint').trim() || '#8a8174',
      line: root.getPropertyValue('--line').trim() || '#e5dccb'
    };
  }

  function draw() {
    if (!active) return;
    const style = getStyle();
    ctx.clearRect(0, 0, w, h);
    const ac = style.accent;
    const dim = style.inkFaint;
    const line = style.line;

    // draw edges
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < threshold) {
          const alpha = 1 - d / threshold;
          ctx.beginPath();
          ctx.moveTo(nodes[i].x, nodes[i].y);
          ctx.lineTo(nodes[j].x, nodes[j].y);
          ctx.strokeStyle = alpha > 0.25 ? ac : dim;
          ctx.globalAlpha = 0.25 + 0.45 * alpha;
          ctx.lineWidth = 0.8 + 1.2 * alpha;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }
    // draw nodes
    for (const n of nodes) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = n.r > 3.2 ? ac : line;
      ctx.fill();
      if (n.r > 3.2) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = ac;
        ctx.globalAlpha = 0.15;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    // move
    for (const n of nodes) {
      n.x += n.vx;
      n.y += n.vy;
      if (n.x < 0) n.x = w;
      else if (n.x > w) n.x = 0;
      if (n.y < 0) n.y = h;
      else if (n.y > h) n.y = 0;
    }
    requestAnimationFrame(draw);
  }

  // pause when hidden to save CPU
  document.addEventListener('visibilitychange', () => {
    active = document.visibilityState === 'visible';
    if (active) draw();
  });
  if (document.visibilityState === 'visible') draw();

  window.addEventListener('resize', () => {
    resize();
    initNodes();
  });
})();

// Copy buttons for code blocks
document.querySelectorAll('.code-wrap').forEach(wrap => {
  const btn = wrap.querySelector('.copy');
  const code = wrap.querySelector('pre.code')?.textContent;
  if (!btn || !code) return;
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(code).then(() => {
      btn.textContent = '✓ Copied';
      setTimeout(() => btn.textContent = 'Copy', 2000);
    }).catch(() => {});
  });
});

// Reveal animations (IntersectionObserver)
const reveals = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window) {
  const obs = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) e.target.classList.add('in');
    }
  }, { threshold: 0.12, rootMargin: '0px 0px -30px 0px' });
  reveals.forEach(el => obs.observe(el));
} else {
  reveals.forEach(el => el.classList.add('in'));
}

// Footer year
document.querySelectorAll('.year').forEach(el => el.textContent = new Date().getFullYear());
