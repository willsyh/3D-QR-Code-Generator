import * as THREE from 'three';
import qrcode from 'qrcode-generator';
import jsQR from 'jsqr';

// Ubin-ubin kode QR menggulung menjadi badan lampion: kolom QR melingkari
// lampion, baris QR turun dari atas ke bawah. Ketuk untuk membentangkannya
// kembali menjadi QR datar yang siap dipindai.

const BORDER = 1; // cincin ubin terang di tepi alas
const PAGE = 0xf6f1e7;
const LIGHT_TILE = new THREE.Color('#ece6dc');

// Jenis lampion. `profile(G)` memberi bentuk badan sebagai kurva putar:
// v = 0 (atas) sampai 1 (bawah) -> [jari-jari, tinggi], untuk QR selebar G ubin.
const STYLES = {
  imlek: {
    label: 'Imlek',
    paper: '#d8222b', trim: '#e2b04a', dark: '#7d1620', dark2: '#a3222a',
    ribs: 12,
    profile: (G) => (v) => {
      const lat = 1.05 - 2.1 * v;
      return [0.31 * G * Math.cos(lat), 0.33 * G * Math.sin(lat)];
    },
  },
  chochin: {
    label: 'Chochin',
    paper: '#c8202a', trim: '#262220', dark: '#2b2623', dark2: '#453c36',
    hoops: 9,
    profile: (G) => (v) => {
      const s = 1 - 2 * v;
      return [0.21 * G * (0.55 + 0.45 * (1 - Math.abs(s) ** 3)), 0.42 * G * s];
    },
  },
  hoian: {
    label: 'Hoi An',
    paper: '#e8a917', trim: '#5a3a22', dark: '#0e5a5e', dark2: '#17787a',
    ribs: 8,
    profile: (G) => (v) => {
      const s = 1 - 2 * v;
      return [0.34 * G * (0.3 + 0.7 * (1 - Math.abs(s) ** 1.3)), 0.4 * G * s];
    },
  },
  terbang: {
    label: 'Terbang',
    paper: '#ff9a3c', trim: '#8a5a2b', dark: '#9a3f0e', dark2: '#bd5a1c',
    sky: true, // lampion terbang: tanpa tali dan rumbai, ada nyala api di bawah
    profile: (G) => (v) => {
      const f =
        v < 0.28
          ? 0.3 + 0.7 * Math.sin((v / 0.28) * (Math.PI / 2))
          : 1 - 0.4 * ((v - 0.28) / 0.72) ** 1.3;
      return [0.3 * G * f, 0.4 * G * (1 - 2 * v)];
    },
  },
};

// Titik pada kurva profil beserta arah turun (dr, dy) dan panjang turunannya.
function sampleProfile(profile, v) {
  const v0 = Math.max(0, v - 1e-3);
  const v1 = Math.min(1, v + 1e-3);
  const [r, y] = profile(v);
  const [r0, y0] = profile(v0);
  const [r1, y1] = profile(v1);
  const dr = (r1 - r0) / (v1 - v0);
  const dy = (y1 - y0) / (v1 - v0);
  const len = Math.hypot(dr, dy);
  return { r, y, dr: dr / len, dy: dy / len, len };
}

const $ = (id) => document.getElementById(id);
const ui = {
  canvas: $('scene'),
  text: $('text'),
  themes: $('themes'),
  toggle: $('toggle'),
  download: $('download'),
  status: $('status'),
  notice: $('notice'),
  dock: document.querySelector('.dock'),
};

// ---------- Renderer & scene ----------

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: true });
} catch (error) {
  window.__lampionReady = true;
  ui.notice.hidden = false;
  ui.notice.textContent =
    'Browser ini tidak bisa menjalankan WebGL, jadi tampilan 3D tidak dapat ditampilkan. ' +
    'Coba aktifkan akselerasi hardware atau gunakan browser lain.';
  throw error;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(PAGE);

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);

scene.add(new THREE.HemisphereLight(0xffffff, 0xe6d8c4, 2.1));
const sun = new THREE.DirectionalLight(0xfff4e2, 1.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0005;
sun.shadow.radius = 7;
sun.shadow.blurSamples = 16;
scene.add(sun);

// Cahaya hangat dari lampion yang jatuh ke alas.
const warmth = new THREE.PointLight(0xffb36b, 0, 0, 1.6);
scene.add(warmth);

// ---------- Bahan & geometri bersama ----------

const paperMat = new THREE.MeshStandardMaterial({
  roughness: 0.65,
  emissiveIntensity: 0.45,
  side: THREE.DoubleSide,
});
const trimMat = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.3 });
const tileMat = new THREE.MeshStandardMaterial({ roughness: 0.85 });
const flameMat = new THREE.MeshBasicMaterial({ color: 0xfff0b8 });
const slabMat = new THREE.MeshStandardMaterial({ color: 0xcbbda9, roughness: 1 });
// Kulit lampion: permukaan halus bertekstur pola QR yang berpendar dari dalam.
const skinMat = new THREE.MeshStandardMaterial({
  roughness: 0.8,
  emissive: 0xffffff,
  emissiveIntensity: 0.5,
  transparent: true,
});

const GEO = {
  tile: new THREE.BoxGeometry(1, 0.3, 1),
  sphere: new THREE.SphereGeometry(1, 20, 14),
  cylinder: new THREE.CylinderGeometry(1, 1, 1, 24),
  cap: new THREE.CylinderGeometry(0.7, 1, 1, 40),
  ring: new THREE.TorusGeometry(1, 0.07, 10, 48).rotateX(Math.PI / 2),
  skirt: new THREE.CylinderGeometry(0.35, 1, 1, 24, 1, true),
  hoop: new THREE.TorusGeometry(1, 0.012, 6, 64).rotateX(Math.PI / 2),
};

const glowTexture = (() => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
})();
const glow = new THREE.Sprite(
  new THREE.SpriteMaterial({ map: glowTexture, transparent: true, depthWrite: false, opacity: 0 })
);
scene.add(glow);

// Permukaan halus lampion dengan parameter yang sama seperti posisi ubin:
// u = kolom QR (melingkar), v = baris QR (atas ke bawah).
function makeSkinGeometry(profile) {
  const segU = 96;
  const segV = 48;
  const positions = [];
  const normals = [];
  const uvs = [];
  const index = [];
  for (let j = 0; j <= segV; j++) {
    const v = j / segV;
    const { r, y, dr, dy } = sampleProfile(profile, v);
    for (let i = 0; i <= segU; i++) {
      const u = i / segU;
      const theta = (u - 0.5) * Math.PI * 2;
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);
      // Sedikit di luar ubin (0.2) agar kulit menutupinya saat memudar masuk.
      positions.push((r - dy * 0.2) * sinT, y + dr * 0.2, (r - dy * 0.2) * cosT);
      normals.push(-dy * sinT, dr, -dy * cosT);
      uvs.push(u, 1 - v);
    }
  }
  const row = segU + 1;
  for (let j = 0; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const q = j * row + i;
      index.push(q, q + row, q + 1, q + 1, q + row, q + row + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(index);
  return geo;
}

// Satu rusuk tegak yang mengikuti lekuk badan lampion dari atas ke bawah.
function makeRibGeometry(profile, G) {
  const points = [];
  for (let j = 0; j <= 24; j++) {
    const { r, y, dr, dy } = sampleProfile(profile, j / 24);
    points.push(new THREE.Vector3(0, y + dr * 0.3, r - dy * 0.3));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 48, G * 0.0035, 5);
}

// Lampion utuh, digantung dari titik pangkal tali supaya bisa berayun:
// lantern (ayunan) > body (putaran) > kulit + perlengkapan, dan rumbai yang berayun sendiri.
function makeLantern(style, profile, G) {
  const [topR, topY] = profile(0);
  const [bottomR, bottomY] = profile(1);
  const hang = topY + G * 0.14; // jarak pusat lampion ke pangkal tali
  const lantern = new THREE.Group();
  const body = new THREE.Group();
  body.position.y = -hang;
  lantern.add(body);

  const owned = [makeSkinGeometry(profile)]; // geometri yang dibuang saat lampion diganti
  const skin = new THREE.Mesh(owned[0], skinMat);
  skin.castShadow = true;
  body.add(skin);

  const trim = new THREE.Group();
  body.add(trim);
  const tassel = new THREE.Group();
  tassel.position.y = bottomY - hang;
  lantern.add(tassel);

  const add = (parent, geo, mat, sx, sy, sz, y) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.set(sx, sy, sz);
    mesh.position.y = y;
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const thin = G * 0.004;

  if (style.sky) {
    // Atas tertutup kertas, bawah terbuka dengan gelang bambu dan nyala api.
    add(trim, GEO.sphere, paperMat, topR * 1.1, G * 0.04, topR * 1.1, topY);
    add(trim, GEO.ring, trimMat, bottomR * 1.03, bottomR * 0.5, bottomR * 1.03, bottomY);
    add(tassel, GEO.sphere, flameMat, G * 0.035, G * 0.06, G * 0.035, G * 0.01).castShadow = false;
  } else {
    const capH = G * 0.05;
    add(trim, GEO.cap, trimMat, topR * 1.08, capH, topR * 1.08, topY + capH * 0.35);
    add(trim, GEO.cap, trimMat, bottomR * 1.08, capH, bottomR * 1.08, bottomY - capH * 0.35).rotation.x = Math.PI;
    add(trim, GEO.ring, trimMat, topR * 1.08, topR * 1.08, topR * 1.08, topY);
    add(trim, GEO.ring, trimMat, bottomR * 1.08, bottomR * 1.08, bottomR * 1.08, bottomY);
    add(trim, GEO.cylinder, trimMat, thin, hang - topY, thin, (hang + topY) / 2);

    add(tassel, GEO.cylinder, trimMat, thin, G * 0.07, thin, -G * 0.035);
    add(tassel, GEO.sphere, trimMat, G * 0.022, G * 0.022, G * 0.022, -G * 0.075);
    add(tassel, GEO.cylinder, trimMat, G * 0.014, G * 0.02, G * 0.014, -G * 0.105);
    add(tassel, GEO.skirt, paperMat, G * 0.031, G * 0.18, G * 0.031, -G * 0.2);
  }

  if (style.ribs) {
    const ribGeo = makeRibGeometry(profile, G);
    owned.push(ribGeo);
    for (let i = 0; i < style.ribs; i++) {
      const rib = add(trim, ribGeo, trimMat, 1, 1, 1, 0);
      rib.rotation.y = (i / style.ribs) * Math.PI * 2;
      rib.castShadow = false;
    }
  }
  for (let i = 1; i < (style.hoops || 0); i++) {
    const { r, y, dr, dy } = sampleProfile(profile, i / style.hoops);
    const radius = r - dy * 0.28;
    add(trim, GEO.hoop, trimMat, radius, radius, radius, y + dr * 0.28).castShadow = false;
  }

  return { lantern, body, skin, trim, tassel, hang, owned };
}

function canvasTexture(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

// Tekstur kulit lampion dari warna ubin, plus garis lipatan kertas; versi pendarnya
// lebih terang di tengah, seperti lampion yang diterangi dari dalam.
function paintSkin(colorOf) {
  const px = 16;
  const size = grid * px;
  const base = document.createElement('canvas');
  base.width = base.height = size;
  const ctx = base.getContext('2d');
  cells.forEach((cell, i) => {
    ctx.fillStyle = `#${colorOf(cell).getHexString()}`;
    ctx.fillRect((i % grid) * px, Math.floor(i / grid) * px, px, px);
  });
  ctx.fillStyle = 'rgba(60, 30, 10, 0.1)';
  for (let row = 1; row < grid; row++) ctx.fillRect(0, row * px - 1, size, 2);

  const lit = document.createElement('canvas');
  lit.width = lit.height = size;
  const ltx = lit.getContext('2d');
  ltx.drawImage(base, 0, 0);
  const g = ltx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, '#6b5a48');
  g.addColorStop(0.55, '#ffffff');
  g.addColorStop(1, '#7a6650');
  ltx.globalCompositeOperation = 'multiply';
  ltx.fillStyle = g;
  ltx.fillRect(0, 0, size, size);

  skinMat.map?.dispose();
  skinMat.emissiveMap?.dispose();
  skinMat.map = canvasTexture(base);
  skinMat.emissiveMap = canvasTexture(lit);
  skinMat.needsUpdate = true;
}

// ---------- State ----------

let themeKey = 'imlek';
let grid = 0; // sel per sisi, termasuk BORDER
let cells = []; // per ubin: warna, posisi datar, dan posisi di permukaan lampion
let tiles = null;
let slab = null;
let parts = null; // bagian-bagian lampion dari makeLantern
let shape = { cy: 1, topY: 1, width: 1 }; // tinggi pusat, puncak, dan lebar lampion

let qrMode = false;
let show = 0; // 0 = QR datar, 1 = lampion; mulai dari 0 agar lampion terbentuk saat dibuka
let spin = 0;
const view = { az: Math.PI / 4, el: 0.6, freeAz: Math.PI / 4, freeEl: 0.6, span: 20, targetY: 0 };

const clock = new THREE.Clock();
const dummy = new THREE.Object3D();
const tint = new THREE.Color();
const vN = new THREE.Vector3();
const vDown = new THREE.Vector3();
const vX = new THREE.Vector3();
const basis = new THREE.Matrix4();
const qLantern = new THREE.Quaternion();
const FLAT = new THREE.Quaternion();

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- QR ----------

qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];

function makeMatrix(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return { n, isDark: (r, c) => qr.isDark(r, c) };
}

function build() {
  const text = ui.text.value.trim();
  if (!text) {
    setStatus('Isi dulu teks atau tautannya.', 'warn');
    return;
  }
  let matrix;
  try {
    matrix = makeMatrix(text);
  } catch {
    setStatus('Teks terlalu panjang untuk satu kode QR. Coba persingkat.', 'warn');
    return;
  }

  clearScene();
  const { n, isDark } = matrix;
  grid = n + BORDER * 2;
  const half = (grid - 1) / 2;
  const random = seeded(n * 7919 + text.length);

  const style = STYLES[themeKey];
  const profile = style.profile(grid);
  const bottomY = profile(1)[1];
  // Pusat lampion cukup tinggi agar rumbai (atau nyala api) tidak menyentuh alas.
  const cy = -bottomY + grid * (style.sky ? 0.3 : 0.4);
  let maxR = 0;

  cells = [];
  for (let row = 0; row < grid; row++) {
    const at = sampleProfile(profile, (row + 0.5) / grid);
    maxR = Math.max(maxR, at.r);
    for (let col = 0; col < grid; col++) {
      const r = row - BORDER;
      const c = col - BORDER;
      const u = (col + 0.5) / grid;
      const rand = random();
      cells.push({
        dark: r >= 0 && r < n && c >= 0 && c < n && isDark(r, c),
        rand,
        x: col - half,
        z: row - half,
        theta: (u - 0.5) * Math.PI * 2,
        r: at.r,
        y: at.y,
        dr: at.dr,
        dy: at.dy,
        // Ukuran ubin agar tepat menutupi permukaan lampion tanpa celah.
        sx: ((Math.PI * 2 * at.r) / grid) * 1.04,
        sz: (at.len / grid) * 1.06,
        stagger: Math.abs(u - 0.5) * 1.4 + rand * 0.3,
      });
    }
  }

  tiles = new THREE.InstancedMesh(GEO.tile, tileMat, cells.length);
  tiles.castShadow = true;
  tiles.frustumCulled = false;
  scene.add(tiles);

  slab = new THREE.Mesh(new THREE.BoxGeometry(grid, 0.8, grid), slabMat);
  slab.position.y = -0.55;
  slab.receiveShadow = true;
  scene.add(slab);

  parts = makeLantern(style, profile, grid);
  scene.add(parts.lantern);
  shape = { cy, topY: cy + parts.hang, width: maxR * 2 };
  glow.scale.setScalar(Math.max(maxR, -bottomY) * 4.4);
  glow.position.set(0, cy, 0);
  warmth.position.set(0, cy + bottomY - grid * 0.22, 0);
  warmth.distance = grid * 1.3;

  sun.position.set(-grid * 0.6, grid * 1.6, grid * 0.35);
  const s = sun.shadow.camera;
  s.left = s.bottom = -grid * 0.9;
  s.right = s.top = grid * 0.9;
  s.far = grid * 4;
  s.updateProjectionMatrix();

  applyTheme(themeKey);
  writeTiles(show);
  verify(text);
}

function clearScene() {
  if (tiles) {
    scene.remove(tiles);
    tiles.dispose();
  }
  if (slab) {
    scene.remove(slab);
    slab.geometry.dispose();
  }
  if (parts) {
    scene.remove(parts.lantern);
    parts.owned.forEach((geo) => geo.dispose());
  }
}

function applyTheme(key) {
  themeKey = key;
  const theme = STYLES[key];
  paperMat.color.set(theme.paper);
  paperMat.emissive.set(theme.paper);
  trimMat.color.set(theme.trim);
  glow.material.color.set(theme.paper).lerp(new THREE.Color('#ffd9a0'), 0.4);
  warmth.color.copy(glow.material.color);
  if (!tiles) return;
  const dark = new THREE.Color(theme.dark);
  const dark2 = new THREE.Color(theme.dark2);
  const colorOf = (cell) =>
    cell.dark
      ? tint.copy(dark).lerp(dark2, cell.rand)
      : tint.copy(LIGHT_TILE).multiplyScalar(0.95 + cell.rand * 0.05);
  cells.forEach((cell, i) => tiles.setColorAt(i, colorOf(cell)));
  tiles.instanceColor.needsUpdate = true;
  paintSkin(colorOf);
}

function verify(expected) {
  const image = captureTop(512);
  const result = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
  if (result && result.data === expected) setStatus('✓ Kode QR terbaca', 'ok');
  else setStatus('Kode ini sulit dipindai. Coba teks yang lebih pendek.', 'warn');
}

// ---------- Kamera ----------

function setQrMode(on) {
  qrMode = on;
  ui.toggle.textContent = on ? 'Ketuk untuk melihat lampion' : 'Ketuk lampion untuk melihat kode QR';
  if (on) {
    view.freeAz = view.az;
    view.freeEl = view.el;
  }
}

function updateCamera(dt) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const ease = 1 - Math.exp(-dt * 5);

  // Tampak atas: azimut 0 agar baris pertama QR berada di atas layar.
  const turns = Math.round(view.az / (Math.PI * 2)) * Math.PI * 2;
  const azGoal = qrMode ? turns : view.freeAz;
  const elGoal = qrMode ? Math.PI / 2 - 0.004 : view.freeEl;
  view.az += (azGoal - view.az) * ease;
  view.el += (elGoal - view.el) * ease;

  // Sisakan ruang untuk kontrol di bawah: diorama dipusatkan di area yang tersisa.
  const dockPx = ui.dock.getBoundingClientRect().height + 36;
  const freeH = Math.max(h - dockPx - 40, 160);
  const need = qrMode
    ? { w: grid * 1.1, h: grid * 1.1 }
    : { w: Math.max(grid * 1.05, shape.width * 1.35), h: shape.topY * 1.21 };
  const spanGoal = Math.max((need.h / 2) * (h / freeH), need.w / 2 / (w / h));
  view.span += (spanGoal - view.span) * ease;
  view.targetY += ((qrMode ? 0 : shape.topY * 0.34) - view.targetY) * ease;

  const shift = ((dockPx - 40) / 2) * ((2 * view.span) / h);
  camera.left = (-view.span * w) / h;
  camera.right = (view.span * w) / h;
  camera.top = view.span - shift;
  camera.bottom = -view.span - shift;
  camera.updateProjectionMatrix();

  const d = 200;
  camera.position.set(
    Math.sin(view.az) * Math.cos(view.el) * d,
    view.targetY + Math.sin(view.el) * d,
    Math.cos(view.az) * Math.cos(view.el) * d
  );
  camera.lookAt(0, view.targetY, 0);
}

// ---------- Animasi ----------

const smooth = (k) => k * k * (3 - 2 * k);
const SPREAD = 0.8; // seberapa jauh ubin bergerak tidak serempak

// Menempatkan setiap ubin di antara posisi datar (m = 0) dan permukaan lampion (m = 1).
function writeTiles(m) {
  const cy = shape.cy;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const k = smooth(THREE.MathUtils.clamp(m * (1 + SPREAD) - c.stagger * SPREAD, 0, 1));
    const theta = c.theta + spin;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);

    vN.set(-c.dy * sinT, c.dr, -c.dy * cosT); // arah keluar
    vDown.set(c.dr * sinT, c.dy, c.dr * cosT); // arah baris QR
    vX.crossVectors(vN, vDown); // arah kolom QR
    qLantern.setFromRotationMatrix(basis.makeBasis(vX, vN, vDown));

    dummy.position.set(
      THREE.MathUtils.lerp(c.x, c.r * sinT, k),
      THREE.MathUtils.lerp(0, cy + c.y, k) + Math.sin(k * Math.PI) * grid * 0.12,
      THREE.MathUtils.lerp(c.z, c.r * cosT, k)
    );
    dummy.quaternion.copy(FLAT).slerp(qLantern, k);
    dummy.scale.set(THREE.MathUtils.lerp(1, c.sx, k), 1, THREE.MathUtils.lerp(1, c.sz, k));
    dummy.updateMatrix();
    tiles.setMatrixAt(i, dummy.matrix);
  }
  tiles.instanceMatrix.needsUpdate = true;
}

function animate(t, dt) {
  if (!tiles) return;
  // Lampion berputar pelan; saat dibentangkan, putaran kembali ke posisi lurus.
  if (qrMode) spin += (Math.round(spin / (Math.PI * 2)) * Math.PI * 2 - spin) * (1 - Math.exp(-dt * 6));
  else spin += dt * 0.25 * show;

  const { lantern, body, skin, trim, tassel, hang } = parts;
  const bob = Math.sin(t * 0.9) * grid * 0.012 * show;
  const cy = shape.cy;
  shape.cy = cy + bob;
  writeTiles(show);
  shape.cy = cy;

  // Setelah ubin menempel, kulit halus memudar masuk dan menggantikan ubin.
  const fade = smooth(THREE.MathUtils.clamp((show - 0.86) / 0.14, 0, 1));
  skin.visible = fade > 0.001;
  skinMat.opacity = fade;
  skinMat.transparent = fade < 1;
  tiles.visible = fade < 1;

  // Perlengkapan lampion baru muncul setelah ubin hampir selesai menggulung.
  const fit = smooth(THREE.MathUtils.clamp((show - 0.6) / 0.4, 0, 1));
  trim.visible = tassel.visible = fit > 0.001;
  trim.scale.setScalar(Math.max(fit, 0.001));
  tassel.scale.setScalar(Math.max(fit, 0.001));

  // Ayunan pelan seperti lampion yang tergantung; rumbai menyusul sedikit terlambat.
  lantern.position.y = cy + hang + bob;
  lantern.rotation.z = Math.sin(t * 0.7) * 0.045 * fade;
  lantern.rotation.x = Math.sin(t * 0.53 + 1) * 0.03 * fade;
  body.rotation.y = spin;
  tassel.rotation.z = Math.sin(t * 0.7 - 0.9) * 0.16 * fade;
  tassel.rotation.x = Math.sin(t * 0.53 + 0.1) * 0.11 * fade;

  glow.material.opacity = 0.42 * fade;
  warmth.intensity = grid * grid * 0.1 * fade;

  const base = THREE.MathUtils.lerp(1, 0.55, smooth(show));
  slab.scale.set(base, 1, base);
}

function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.getElapsedTime();
  show += THREE.MathUtils.clamp((qrMode ? 0 : 1) - show, -dt / 1.4, dt / 1.4);
  animate(t, dt);
  updateCamera(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

// ---------- Tampak atas: verifikasi & unduhan ----------

// Merender ubin QR dalam keadaan datar, tegak lurus dari atas.
function captureTop(size) {
  const span = grid / 2 + 2; // tepi terang 2 modul + BORDER = quiet zone
  const top = new THREE.OrthographicCamera(-span, span, span, -span, 0.1, 100);
  top.position.set(0, 50, 0);
  top.up.set(0, 0, -1);
  top.lookAt(0, 0, 0);

  const savedSpin = spin;
  spin = 0;
  writeTiles(0);
  spin = savedSpin;
  const saved = [tiles.visible, glow.visible, warmth.intensity];
  tiles.visible = true;
  parts.lantern.visible = glow.visible = false;
  warmth.intensity = 0;

  const target = new THREE.WebGLRenderTarget(size, size);
  const pixels = new Uint8Array(size * size * 4);
  renderer.setRenderTarget(target);
  renderer.render(scene, top);
  renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
  renderer.setRenderTarget(null);
  target.dispose();

  [tiles.visible, glow.visible, warmth.intensity] = saved;
  parts.lantern.visible = true;

  // Render target berisi warna linear dan terbalik secara vertikal.
  const out = new Uint8ClampedArray(pixels.length);
  const rowBytes = size * 4;
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * rowBytes;
    const dst = y * rowBytes;
    for (let i = 0; i < rowBytes; i += 4) {
      out[dst + i] = SRGB[pixels[src + i]];
      out[dst + i + 1] = SRGB[pixels[src + i + 1]];
      out[dst + i + 2] = SRGB[pixels[src + i + 2]];
      out[dst + i + 3] = 255;
    }
  }
  return new ImageData(out, size, size);
}

const SRGB = Uint8Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);
});

function downloadPng() {
  if (!tiles) return;
  const image = captureTop(1024);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = image.width;
  canvas.getContext('2d').putImageData(image, 0, 0);
  canvas.toBlob((blob) => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'lampion-qr.png';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
}

// ---------- UI ----------

function setStatus(message, kind = '') {
  ui.status.textContent = message;
  ui.status.className = `status ${kind}`;
}

for (const [key, theme] of Object.entries(STYLES)) {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('role', 'radio');
  button.setAttribute('aria-checked', String(key === themeKey));
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = theme.dark2;
  button.append(dot, theme.label);
  button.addEventListener('click', () => {
    themeKey = key;
    if (!qrMode) show = Math.min(show, 0.4); // ubin menyusun ulang ke bentuk baru
    build();
    for (const b of ui.themes.children) b.setAttribute('aria-checked', String(b === button));
  });
  ui.themes.append(button);
}

let debounce;
ui.text.addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(build, 350);
});
ui.toggle.addEventListener('click', () => setQrMode(!qrMode));
ui.download.addEventListener('click', downloadPng);

// Ketuk kanvas = ganti mode; seret = putar diorama.
let drag = null;
ui.canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, moved: 0 };
  ui.canvas.setPointerCapture(e.pointerId);
});
ui.canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (qrMode || drag.moved < 6) return;
  view.freeAz -= dx * 0.008;
  view.freeEl = THREE.MathUtils.clamp(view.freeEl + dy * 0.005, 0.3, 1.15);
});
ui.canvas.addEventListener('pointerup', () => {
  if (drag && drag.moved < 6) setQrMode(!qrMode);
  drag = null;
});
ui.canvas.addEventListener('pointercancel', () => (drag = null));

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
}
window.addEventListener('resize', resize);

resize();
build();
view.span = grid;
tick();
window.__lampionReady = true;
