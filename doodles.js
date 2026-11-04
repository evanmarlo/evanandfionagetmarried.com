// Scatters doodles around the page behind everything, keeping clear of the
// header text, the page's main content, the footer and the home page photo.
// The first page opened in a visit also gets a burst of doodles (see the end).
// Needs doodle-masks.js loaded first and a <div class="doodles"> on the page.

// Doodle images are found next to this script, so they load from any page,
// including the "page not found" page, which can appear at any address
const DOODLE_FOLDER = new URL('.', document.currentScript.src);

const doodles = [
  { src: 'pink.png', color: 'pink' },
  { src: 'blue.png', color: 'blue' },
  { src: 'green.png', color: 'green' },
  { src: 'yellow.png', color: 'yellow' },
  { src: 'purple.png', color: 'purple' },
  // These are drawn edge to edge in their image, so they're shrunk to match the others
  { src: 'pineapple.png', color: 'yellow', scale: 0.85 },
  { src: 'charm.png', color: 'pink', scale: 0.85 },
  { src: 'lego.png', color: 'yellow', scale: 0.85 },
  { src: 'egg.png', color: 'orange', scale: 0.85 },
  { src: 'icecream.png', color: 'orange', scale: 0.85 }
];
// Tiny doodles that fill the awkward gaps the grid leaves near the text, photo and edges
const fillers = ['star.png', 'heart.png', 'gem.png', 'flower.png'];
const container = document.querySelector('.doodles');

// Each doodle's silhouette as points relative to its center (-0.5 to 0.5 of its width)
const MASK_SIZE = 32;
const silhouettes = {};
for (const [src, hex] of Object.entries(DOODLE_MASKS)) {
  const points = [];
  [...hex].forEach((digit, i) => {
    for (let bit = 0; bit < 4; bit++) {
      if (!(parseInt(digit, 16) & (8 >> bit))) continue;
      const k = i * 4 + bit;
      points.push([(k % MASK_SIZE + 0.5) / MASK_SIZE - 0.5, (Math.floor(k / MASK_SIZE) + 0.5) / MASK_SIZE - 0.5]);
    }
  });
  silhouettes[src] = points;
}

// Converts a viewport rectangle to page coordinates, grown by `pad` (or shrunk if negative)
function pageBox(r, pad) {
  return {
    left: r.left + scrollX - pad,
    right: r.right + scrollX + pad,
    top: r.top + scrollY - pad,
    bottom: r.bottom + scrollY + pad
  };
}

// Box around an element's actual text (not its full-width block).
// Null for hidden or empty elements, which take up no space.
function textBox(el, pad) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const r = range.getBoundingClientRect();
  return r.width && r.height ? pageBox(r, pad) : null;
}

function elementBox(el, pad) {
  const r = el.getBoundingClientRect();
  return r.width && r.height ? pageBox(r, pad) : null;
}

// One full back-and-forth of the CSS `dance` animation (3.5s each way). Every doodle's
// animation is offset by the page clock, so ones added later sway in step with the rest.
const SWAY_CYCLE_SECONDS = 7;

// What's placed so far, kept between layouts so a change to the page (like the
// RSVP search results appearing) only adds or removes doodles where something
// changed, instead of reshuffling the whole background
let layoutWidth = null;     // page width the current layout was made for
let layoutSize = null;      // doodle size the current layout was made for
let gridOriginX = 0;        // where the grid's first column sits, kept so new doodles line up
const gridDoodles = new Map(); // "row,col" → { cx, cy, src, color, width, tilt, img }
let tinyDoodles = [];       // { cx, cy, src, tilt, img }
let lastClear = [];         // areas kept clear last time
let lastHeight = 0;

function layoutDoodles() {
  const size = parseFloat(getComputedStyle(container).getPropertyValue('--doodle-size'));
  container.style.height = '0';  // so the old doodles don't stretch the page measurement
  const pageWidth = document.documentElement.clientWidth;
  const pageHeight = document.documentElement.scrollHeight;

  // What to keep clear of: the header text, each page's main content column and
  // other content blocks (doodles sit behind them, so they'd show through the
  // text), and the photo
  const textBoxes = [...document.querySelectorAll('header > *, nav')].map(el => textBox(el, 12));
  const mainBoxes = [...document.querySelectorAll('main, .home-cta, footer')].map(el => elementBox(el, 24));
  const photo = document.querySelector('#home img');
  // The photo's box is shrunk inward so big doodles can tuck partway behind its frame
  const gridClear = [...textBoxes, ...mainBoxes, photo && elementBox(photo, -size * 0.3)].filter(Boolean);
  const fillerClear = [...textBoxes, ...mainBoxes, photo && elementBox(photo, 0)].filter(Boolean);

  // Does a square of half-width `half` centered at (cx, cy) touch any of the boxes?
  const overlaps = (boxes, cx, cy, half) => boxes.some(b =>
    cx - half < b.right && cx + half > b.left &&
    cy - half < b.bottom && cy + half > b.top);

  // Staggered grid (every other row shifted half a step), centered on the page
  // and extending past the edges so some doodles get cropped
  // rowGap = colGap * √3/2 makes every neighbor (side and diagonal) the same distance apart
  const colGap = size * 1.1;
  const rowGap = colGap * 0.866;
  const jitter = size * 0.04;  // small random nudge so it's not perfectly uniform

  // A real change in width (resizing the window, rotating a phone) means a whole
  // new layout. Small changes are ignored: on desktop, a scrollbar appearing or
  // disappearing when content grows or shrinks narrows the page by ~15px, and that
  // shouldn't reshuffle everything.
  const fresh = layoutWidth === null || Math.abs(pageWidth - layoutWidth) > 40 || size !== layoutSize;
  if (fresh) {
    container.replaceChildren();
    gridDoodles.clear();
    tinyDoodles = [];
    lastClear = [];
    lastHeight = 0;
    layoutWidth = pageWidth;
    layoutSize = size;
    gridOriginX = (pageWidth / 2) % colGap - colGap;
  }
  const added = [];

  // A map of the page in 4px cells, marking where doodles are drawn
  const cell = 4;
  const margin = size;  // room for doodles hanging off the edges
  const gridW = Math.ceil((pageWidth + 2 * margin) / cell);
  const gridH = Math.ceil((pageHeight + 2 * margin) / cell);
  const taken = new Uint8Array(gridW * gridH);

  // Visits every map cell a doodle covers anywhere in its sway (tilt ± sway).
  // Stops early and returns true if visit() does.
  function eachCell(src, cx, cy, width, tilt, sway, visit) {
    for (const step of [-1, -0.5, 0, 0.5, 1]) {
      const a = (tilt + step * sway) * Math.PI / 180;
      const cos = Math.cos(a), sin = Math.sin(a);
      for (const [u, v] of silhouettes[src]) {
        const gx = Math.floor((cx + (u * cos - v * sin) * width + margin) / cell);
        const gy = Math.floor((cy + (u * sin + v * cos) * width + margin) / cell);
        if (gx >= 0 && gy >= 0 && gx < gridW && gy < gridH && visit(gx, gy)) return true;
      }
    }
    return false;
  }

  // Marks a doodle's cells (plus one cell of breathing room) as taken
  function claim(src, cx, cy, width, tilt, sway) {
    eachCell(src, cx, cy, width, tilt, sway, (gx, gy) => {
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = gx + dx, y = gy + dy;
          if (x >= 0 && y >= 0 && x < gridW && y < gridH) taken[y * gridW + x] = 1;
        }
    });
  }

  function addDoodle(src, cx, cy, width, tilt) {
    const img = document.createElement('img');
    img.src = new URL(src, DOODLE_FOLDER).href;
    img.alt = '';
    img.style.left = cx - width / 2 + 'px';
    img.style.top = cy - width / 2 + 'px';
    img.style.width = img.style.height = width + 'px';
    img.style.setProperty('--tilt', tilt + 'deg');
    // Line the sway up with the page clock so it matches the doodles already there
    const phase = -(performance.now() / 1000 % SWAY_CYCLE_SECONDS) + 's';
    if (fresh) {
      img.style.animationDelay = phase;
    } else {
      img.classList.add('appear');  // fades in (see style.css)
      img.style.animationDelay = phase + ', 0s';
    }
    added.push(img);
    return img;
  }

  const randomTilt = () => Math.round(Math.random() * 50 - 25);

  const startX = gridOriginX;
  const stillOnPage = new Set();

  for (let row = 0, y0 = size * 0.1; y0 < pageHeight + size / 2; row++, y0 += rowGap) {
    const shift = row % 2 ? colGap / 2 : 0;
    for (let col = 0, x0 = startX + shift; x0 < pageWidth + size / 2; col++, x0 += colGap) {
      const key = row + ',' + col;
      // The drawings don't fill their whole square, so only check the middle 80%
      const existing = gridDoodles.get(key);
      if (existing) {
        if (!overlaps(gridClear, existing.cx, existing.cy, size * 0.4)) {
          stillOnPage.add(key);
          continue;
        }
        existing.img.remove();  // content has moved over it
        gridDoodles.delete(key);
      }

      const cx = x0 + (Math.random() * 2 - 1) * jitter;
      const cy = y0 + (Math.random() * 2 - 1) * jitter;
      if (overlaps(gridClear, cx, cy, size * 0.4)) continue;

      // Pick a random doodle whose color doesn't match any neighbor
      const near = [...gridDoodles.values()].filter(p => Math.hypot(p.cx - cx, p.cy - cy) < colGap * 1.6);
      const options = [...doodles].sort(() => Math.random() - 0.5);
      const pick = options.find(d => !near.some(p => p.color === d.color))
        || options.find(d => !near.some(p => p.src === d.src))
        || options[0];

      const width = size * (pick.scale || 1);
      const tilt = randomTilt();
      const img = addDoodle(pick.src, cx, cy, width, tilt);
      gridDoodles.set(key, { cx, cy, src: pick.src, color: pick.color, width, tilt, img });
      stillOnPage.add(key);
    }
  }
  // Rows past the bottom of a page that got shorter
  for (const [key, doodle] of gridDoodles) {
    if (!stillOnPage.has(key)) {
      doodle.img.remove();
      gridDoodles.delete(key);
    }
  }
  gridDoodles.forEach(d => claim(d.src, d.cx, d.cy, d.width, d.tilt, 5));  // big doodles sway ±5°

  // Tiny fillers: tuck into any gap where their actual shape, through their
  // whole sway, doesn't touch another doodle's shape
  const tiny = size * 0.3;
  const crowdsContent = (cx, cy) => overlaps(fillerClear, cx, cy, tiny * 0.45 + 16);  // extra room around text
  const hitsDoodle = (src, cx, cy, tilt) => eachCell(src, cx, cy, tiny, tilt, 15, (gx, gy) => taken[gy * gridW + gx]);

  // Keep the tiny doodles that still fit
  tinyDoodles = tinyDoodles.filter(t => {
    const fits = t.cy < pageHeight && !crowdsContent(t.cx, t.cy) && !hitsDoodle(t.src, t.cx, t.cy, t.tilt);
    if (fits) claim(t.src, t.cx, t.cy, tiny, t.tilt, 15);  // tiny doodles sway ±15°
    else t.img.remove();
    return fits;
  });

  // Only look for new spots where something changed: around content that moved,
  // grew or shrank, and any new length at the bottom (or the whole page, the first time)
  const boxKey = b => [b.left, b.top, b.right, b.bottom].map(Math.round).join(',');
  const before = new Set(lastClear.map(boxKey));
  const now = new Set(fillerClear.map(boxKey));
  const regions = fresh
    ? [{ left: 0, top: 0, right: pageWidth, bottom: pageHeight }]
    : [...lastClear.filter(b => !now.has(boxKey(b))), ...fillerClear.filter(b => !before.has(boxKey(b)))]
      .map(b => ({ left: b.left - size, top: b.top - size, right: b.right + size, bottom: b.bottom + size }));
  if (!fresh && pageHeight > lastHeight) regions.push({ left: 0, top: lastHeight - size, right: pageWidth, bottom: pageHeight });
  lastClear = fillerClear;
  lastHeight = pageHeight;

  const areas = regions
    .map(r => ({ left: Math.max(0, r.left), top: Math.max(0, r.top), right: Math.min(pageWidth, r.right), bottom: Math.min(pageHeight, r.bottom) }))
    .filter(r => r.right > r.left && r.bottom > r.top);
  const totalArea = areas.reduce((sum, r) => sum + (r.right - r.left) * (r.bottom - r.top), 0);
  // About 3000 tries per screenful
  const attempts = Math.round(3000 * totalArea / (1400 * 1100));
  for (let attempt = 0; attempt < attempts; attempt++) {
    // Pick an area in proportion to its size, then a random spot in it
    let pickArea = Math.random() * totalArea, r = areas[0];
    for (const a of areas) {
      r = a;
      pickArea -= (a.right - a.left) * (a.bottom - a.top);
      if (pickArea <= 0) break;
    }
    const cx = r.left + Math.random() * (r.right - r.left);
    const cy = r.top + Math.random() * (r.bottom - r.top);
    if (crowdsContent(cx, cy)) continue;
    if (tinyDoodles.some(t => Math.hypot(t.cx - cx, t.cy - cy) < tiny * 1.5)) continue;
    const src = fillers[tinyDoodles.length % fillers.length];
    const tilt = randomTilt();
    if (hitsDoodle(src, cx, cy, tilt)) continue;

    claim(src, cx, cy, tiny, tilt, 15);
    const img = addDoodle(src, cx, cy, tiny, tilt);
    img.classList.add('tiny');
    tinyDoodles.push({ cx, cy, src, tilt, img });
  }

  container.style.height = pageHeight + 'px';
  container.append(...added);
  lastLayout = bodyLayout();
  lastWindowHeight = innerHeight;
}

// Lay out once the page settles, and update whenever its content changes size:
// a different window width (full new layout), fonts loading, or parts of a page
// appearing or disappearing (like the RSVP search results). Phones hiding their
// address bar while scrolling don't change the body's size, so they don't
// trigger anything. The doodles themselves are positioned absolutely, so they
// never count toward the body's size.
const bodyLayout = () => document.body.offsetWidth + 'x' + document.body.offsetHeight;
let lastLayout = '';
let lastWindowHeight = 0;
let layoutTimer;

function scheduleLayout() {
  clearTimeout(layoutTimer);
  // Wait for the web fonts so the text is measured at its real size
  layoutTimer = setTimeout(() => document.fonts.ready.then(layoutDoodles), 200);
}

new ResizeObserver(() => {
  if (bodyLayout() !== lastLayout) scheduleLayout();
}).observe(document.body);

// On pages shorter than the window, the doodles fill the window instead. A taller
// or shorter window then changes the area to cover without changing the body's
// size, so watch the window height for those pages too.
addEventListener('resize', () => {
  const pageFillsWindow = lastHeight <= lastWindowHeight + 1;
  if (pageFillsWindow && Math.abs(innerHeight - lastWindowHeight) > 1) scheduleLayout();
});

// ---------- Welcome burst ----------

// Doodles explode out from the names, spinning outward and fading off the edges,
// while the background doodles fade in behind them
function playWelcomeBurst() {
  const names = document.querySelector('header h1');
  if (!names) return;
  const origin = names.getBoundingClientRect();
  const originX = origin.left + origin.width / 2;
  const originY = origin.top + origin.height / 2;
  const size = parseFloat(getComputedStyle(container).getPropertyValue('--doodle-size'));
  const screenDiagonal = Math.hypot(innerWidth, innerHeight);

  const layer = document.createElement('div');
  layer.className = 'doodle-burst';
  layer.setAttribute('aria-hidden', 'true');
  const choices = [
    ...doodles.map(d => ({ src: d.src, width: size * (d.scale || 1) * 0.8 })),
    ...fillers.map(src => ({ src, width: size * 0.35 }))
  ];

  const flights = [];
  for (let i = 0; i < 50; i++) {
    const pick = choices[i % choices.length];
    const width = pick.width * (0.7 + Math.random() * 0.5);
    const img = document.createElement('img');
    img.src = new URL(pick.src, DOODLE_FOLDER).href;
    img.alt = '';
    img.style.width = img.style.height = width + 'px';
    img.style.left = originX - width / 2 + 'px';
    img.style.top = originY - width / 2 + 'px';
    layer.append(img);

    // A random direction, far enough to reach (or pass) the edge of the screen
    const angle = Math.random() * Math.PI * 2;
    const distance = screenDiagonal * (0.35 + Math.random() * 0.45);
    const dx = Math.cos(angle) * distance;
    const dy = Math.sin(angle) * distance;
    const spin = (Math.random() * 2 - 1) * 360;
    flights.push(img.animate([
      { transform: 'translate(0, 0) scale(0.2) rotate(0deg)', opacity: 0 },
      { opacity: 1, offset: 0.08 },
      { opacity: 1, offset: 0.65 },
      { transform: `translate(${dx}px, ${dy}px) scale(1) rotate(${spin}deg)`, opacity: 0 }
    ], {
      duration: 1500 + Math.random() * 700,
      delay: Math.random() * 150,
      easing: 'cubic-bezier(0.15, 0.85, 0.35, 1)',  // fast pop, then glide
      fill: 'backwards'
    }));
  }
  document.body.append(layer);
  Promise.allSettled(flights.map(f => f.finished)).then(() => layer.remove());
}

// Only on the first page someone opens in a visit (moving between pages doesn't
// replay it), and never for visitors who've asked their device to reduce motion
let firstPageThisVisit = false;
try {
  firstPageThisVisit = !sessionStorage.getItem('doodleBurstPlayed');
  sessionStorage.setItem('doodleBurstPlayed', '1');
} catch (err) {
  // Storage can be blocked (some private browsing modes); just skip the burst then
}

if (firstPageThisVisit && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  // Hide the background until the burst starts, so it can fade in behind it
  container.style.opacity = '0';
  // Wait for the doodle images (so the burst isn't blank squares) and the fonts
  // (so the names are in their final spot), but no more than 2 seconds for images
  const imagesLoaded = Promise.all([...doodles.map(d => d.src), ...fillers].map(src => {
    const img = new Image();
    img.src = new URL(src, DOODLE_FOLDER).href;
    return img.decode().catch(() => {});
  }));
  const giveUp = new Promise(resolve => setTimeout(resolve, 2000));
  Promise.all([document.fonts.ready, Promise.race([imagesLoaded, giveUp])]).then(() => {
    playWelcomeBurst();
    setTimeout(() => {
      container.style.transition = 'opacity 1.4s ease';
      container.style.opacity = '';
    }, 500);
  });
}
