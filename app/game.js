(function () {
  "use strict";
  const cvs = document.getElementById("game");
  const ctx = cvs.getContext("2d");
  const W = cvs.width, H = cvs.height;

  // ---------- state ----------
  let state = "title"; // title | playing | waveclear | gameover
  let score = 0, wave = 1, lives = 3, hi = 0;
  try { hi = parseInt(localStorage.getItem("verminvaders-hi") || "0", 10) || 0; } catch (e) {}

  const CAT_Y = H - 64;
  let catX = W / 2, catTarget = null, pointerDown = false;
  let invuln = 0, flipT = 0, blinkSeed = Math.random() * 10;
  let mouthT = 0; // >0: the cat just spat a furball, mouth slightly open
  let furballs = [], crumbs = [], parts = [], rods = [], shields = [], roomba = null;
  let gx = 52, gy = 84, dir = 1, bob = false, marchT = 0, fireT = 1, roombaT = 9;
  let paused = false, msgT = 0, overMsg = "", last = 0, time = 0;

  const SX = 44, SY = 36; // rodent formation spacing
  const keys = {};

  // qbit design system (dark theme) - canvas UI palette.
  // Mirrors the RGB-triplet tokens from style.css; sprites keep their own colors.
  const QBIT = {
    bg: "#050810",        // --color-bg
    text: "#eef3fa",      // --color-text
    muted: "#96a2b5",     // --color-text-muted
    primary: "#409cff",   // --color-primary
    secondary: "#b27aff", // --color-secondary
    error: "#ef4444"      // $color-error
  };

  // stars background
  const stars = [];
  for (let i = 0; i < 70; i++) stars.push({ x: Math.random() * W, y: Math.random() * (H - 120), r: Math.random() * 1.6 + 0.4, p: Math.random() * 6, c: Math.random() < 0.22 ? QBIT.secondary : QBIT.primary });

  // ---------- shield types (the furniture defense line) ----------
  const SHIELD_TYPES = [
    { grid: ["11111", "10001", "10001", "11111"], c1: "#c9a06a", c2: "#8a6f4d", name: "box" },
    { grid: ["011110", "111111", "111111", "111111"], c1: "#e8a0b4", c2: "#c97b93", name: "bed" },
    { grid: ["111111", "000000", "111111"], c1: "#8b5e3c", c2: "#6d4429", name: "shelf" },
    { grid: ["10101", "11111", "11111"], c1: "#aab2c2", c2: "#848da0", name: "books" }
  ];
  const CS = 10; // shield cell size

  function buildShields() {
    shields = [];
    const n = 4;
    for (let i = 0; i < n; i++) {
      const t = SHIELD_TYPES[Math.floor(Math.random() * SHIELD_TYPES.length)];
      const slotW = W / n;
      const x = Math.floor(i * slotW + 18 + Math.random() * (slotW - 36 - t.grid[0].length * CS));
      const cells = t.grid.map(function (row) {
        return row.split("").map(function (c) { return c === "1" ? 1 : 0; });
      });
      shields.push({ x: x, y: H - 208, cells: cells, c1: t.c1, c2: t.c2, w: t.grid[0].length * CS, h: t.grid.length * CS });
    }
  }

  function chew(sh, px, py, rad) {
    const col = Math.floor((px - sh.x) / CS);
    const row = Math.floor((py - sh.y) / CS);
    if (row < 0 || row >= sh.cells.length || col < 0 || col >= sh.cells[row].length) return false;
    if (!sh.cells[row][col]) return false;
    let hit = false;
    for (let r = 0; r < sh.cells.length; r++) {
      for (let c = 0; c < sh.cells[r].length; c++) {
        if (sh.cells[r][c]) {
          const d = Math.hypot(r - row, c - col);
          if (d <= rad) {
            sh.cells[r][c] = 0;
            hit = true;
            if (Math.random() < 0.6) spawnParts(sh.x + c * CS + CS / 2, sh.y + r * CS + CS / 2, 2, sh.c1);
          }
        }
      }
    }
    return hit;
  }

  // ---------- rodents ----------
  function buildRods() {
    rods = [];
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 8; c++) {
        const rat = r < 2;
        rods.push({ col: c, row: r, rat: rat, alive: true, w: rat ? 36 : 30, h: rat ? 30 : 24 });
      }
    }
    gx = 52; gy = 84 + Math.min(wave - 1, 4) * 8; dir = 1;
  }

  function aliveRods() { return rods.filter(function (r) { return r.alive; }); }

  function marchInterval() {
    const alive = aliveRods().length, total = rods.length;
    const waveFactor = Math.max(0.55, 1 - 0.06 * (wave - 1));
    return Math.max(0.06, 0.5 * (alive / total)) * waveFactor;
  }

  function marchStep() {
    const alive = aliveRods();
    if (!alive.length) return;
    let minX = 1e9, maxX = -1e9;
    alive.forEach(function (r) {
      const rx = gx + r.col * SX;
      minX = Math.min(minX, rx);
      maxX = Math.max(maxX, rx + r.w);
    });
    let drop = false;
    if (dir > 0 && maxX + 10 >= W - 8) { dir = -1; drop = true; }
    else if (dir < 0 && minX - 10 <= 8) { dir = 1; drop = true; }
    if (drop) gy += 16; else gx += 12 * dir;
    bob = !bob;
  }

  // ---------- flow ----------
  function startGame() {
    score = 0; wave = 1; lives = 3; state = "playing";
    // the strategy panel stays up: the last plan remains visible until the
    // next consultation overwrites it
    newWave();
  }

  function newWave() {
    buildRods(); buildShields();
    furballs = []; crumbs = []; roomba = null;
    fireT = 1; roombaT = 8 + Math.random() * 6;
    invuln = 0; flipT = 0;
  }

  function gameOver(msg) {
    state = "gameover"; overMsg = msg;
    if (score > hi) {
      hi = score;
      try { localStorage.setItem("verminvaders-hi", String(hi)); } catch (e) {}
    }
  }

  function shoot() {
    if (furballs.length >= 1) return; // classic: one furball at a time
    furballs.push({ x: catX + 18, y: CAT_Y - 16, vy: -430, r: 4 });
    mouthT = 0.18; // brief open-mouth beat as the furball leaves the muzzle
  }

  // ---------- particles ----------
  function spawnParts(x, y, n, color) {
    for (let i = 0; i < n; i++) {
      parts.push({
        x: x, y: y,
        vx: (Math.random() - 0.5) * 160,
        vy: (Math.random() - 0.7) * 160,
        life: 0.5 + Math.random() * 0.4, t: 0,
        color: color, size: 1.5 + Math.random() * 2.5
      });
    }
  }

  // ---------- update ----------
  function update(dt) {
    time += dt;
    // particles always animate
    parts = parts.filter(function (p) {
      p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 260 * dt;
      return p.t < p.life;
    });

    if (state === "waveclear") {
      msgT -= dt;
      if (msgT <= 0) { wave++; newWave(); state = "playing"; }
      return;
    }
    if (state !== "playing") return;

    // cat movement
    const speed = 230;
    if (pointerDown && catTarget !== null) {
      const d = catTarget - catX;
      catX += Math.max(-speed * dt * 1.4, Math.min(speed * dt * 1.4, d));
    }
    if (keys.left) catX -= speed * dt;
    if (keys.right) catX += speed * dt;
    catX = Math.max(36, Math.min(W - 36, catX));

    invuln = Math.max(0, invuln - dt);
    flipT = Math.max(0, flipT - dt);
    mouthT = Math.max(0, mouthT - dt);

    // furballs
    furballs = furballs.filter(function (b) {
      b.y += b.vy * dt;
      return b.y > -20;
    });

    // crumbs (rodent ammo)
    crumbs = crumbs.filter(function (c) {
      c.y += c.vy * dt; c.rot += dt * 6;
      return c.y < H;
    });

    // march
    marchT += dt;
    if (marchT >= marchInterval()) { marchT = 0; marchStep(); }

    // roomba
    roombaT -= dt;
    if (!roomba && roombaT <= 0) {
      const fromLeft = Math.random() < 0.5;
      roomba = { x: fromLeft ? -40 : W + 40, y: 52, vx: (fromLeft ? 1 : -1) * 95 };
    }
    if (roomba) {
      roomba.x += roomba.vx * dt;
      if (roomba.x < -50 || roomba.x > W + 50) { roomba = null; roombaT = 9 + Math.random() * 8; }
    }

    // rodent fire
    fireT -= dt;
    if (fireT <= 0) {
      fireT = Math.max(0.28, 1.15 - 0.07 * (wave - 1)) * (0.4 + 0.7 * Math.random());
      const alive = aliveRods();
      if (alive.length) {
        // shoot from the lowest rodent of a random column
        const col = alive[Math.floor(Math.random() * alive.length)].col;
        const colRods = alive.filter(function (r) { return r.col === col; }).sort(function (a, b) { return b.row - a.row; });
        const s = colRods[0];
        crumbs.push({ x: gx + s.col * SX + s.w / 2 - 5, y: gy + s.row * SY + s.h, w: 10, h: 10, vy: 130 + wave * 14, rot: 0 });
      }
    }

    // --- collisions: furball vs rodents ---
    for (let i = furballs.length - 1; i >= 0; i--) {
      const b = furballs[i];
      let consumed = false;

      // roomba (with rat general on top)
      if (roomba && Math.abs(b.x - roomba.x) < 20 && b.y < roomba.y + 16 && b.y > roomba.y - 21) {
        score += 200;
        spawnParts(roomba.x, roomba.y, 26, "#8a6f4d");
        spawnParts(roomba.x, roomba.y, 18, "#4a4d66");
        roomba = null; roombaT = 9 + Math.random() * 8;
        consumed = true;
      }

      if (!consumed) {
        for (const r of rods) {
          if (!r.alive) continue;
          const rx = gx + r.col * SX, ry = gy + r.row * SY;
          if (b.x + b.r > rx && b.x - b.r < rx + r.w && b.y - b.r < ry + r.h && b.y + b.r > ry) {
            r.alive = false;
            score += r.rat ? 30 : (r.row === 2 ? 20 : 10);
            spawnParts(rx + r.w / 2, ry + r.h / 2, 14, r.rat ? "#8a6f4d" : "#a8b0bd");
            consumed = true;
            break;
          }
        }
      }

      if (!consumed) {
        for (const sh of shields) {
          if (chew(sh, b.x, b.y, 1.5)) { consumed = true; break; }
        }
      }

      if (consumed) furballs.splice(i, 1);
    }

    // --- collisions: crumbs vs shields & cat ---
    for (let i = crumbs.length - 1; i >= 0; i--) {
      const c = crumbs[i];
      let consumed = false;
      for (const sh of shields) {
        if (chew(sh, c.x + c.w / 2, c.y + c.h, 1.1)) { consumed = true; break; }
      }
      if (!consumed && invuln <= 0) {
        if (c.x + c.w > catX - 30 && c.x < catX + 30 && c.y + c.h > CAT_Y - 34 && c.y < CAT_Y) {
          consumed = true;
          lives--;
          invuln = 2; flipT = 0.9;
          spawnParts(catX, CAT_Y - 24, 20, "#e8933a");
          if (lives <= 0) { gameOver("The cat has run out of dignity... and lives."); return; }
        }
      }
      if (consumed) crumbs.splice(i, 1);
    }

    // rodents reach the lasagna line
    const alive = aliveRods();
    for (const r of alive) {
      if (gy + r.row * SY + r.h >= CAT_Y - 26) {
        gameOver("A rodent got the lasagna slice.");
        return;
      }
    }

    // wave cleared
    if (!alive.length) {
      state = "waveclear"; msgT = 2.2;
      furballs = [];
    }
  }

  // ---------- pixel sprites ----------
  const RODENT_PAL = { "#": "#a8b0bd", "P": "#e3a7b2", "o": "#222", "p": "#e3a7b2" };
  const RAT_PAL = { "#": "#8a6f4d", "P": "#c49a86", "o": "#e63946", "p": "#d9a5a5" };
  const MOUSE_A = [
    ".#P....P#.",
    ".##....##.",
    "..######..",
    "..#o##o#..",
    "..######..",
    "...#pp#...",
    "##########",
    ".#..##..#."
  ];
  const MOUSE_B = [
    ".#P....P#.",
    ".##....##.",
    "..######..",
    "..#o##o#..",
    "..######..",
    "...#pp#...",
    "##########",
    "#..#..#..#"
  ];
  const RAT_A = [
    ".##......##.",
    ".#P#....#P#.",
    ".##########.",
    ".#oo.##.oo#.",
    ".##########.",
    ".##########.",
    "..########..",
    "..#PPPPPP#..",
    "############",
    ".#..#..#..#."
  ];
  const RAT_B = [
    ".##......##.",
    ".#P#....#P#.",
    ".##########.",
    ".#oo.##.oo#.",
    ".##########.",
    ".##########.",
    "..########..",
    "..#PPPPPP#..",
    "############",
    "#..#..#..#.."
  ];
  const ROOMBA_SPR = [
    "...#######...",
    ".###########.",
    "#############",
    "ddddddddddddd",
    ".ddddddddddd."
  ];
  const ROOMBA_PAL = { "#": "#3d4053", "d": "#23252f" };
  const RATMINI_SPR = [
    ".#..#.",
    ".####.",
    "#o##o#",
    ".####.",
    ".#pp#.",
    ".####.",
    ".####."
  ];
  // official Vibe "Petit Chat" silhouette: 22x12 dot grid, front-facing head,
  // long curling tail swaying through the official RIGHT / MID / LEFT positions.
  // Filled tabby-style: warm Mistral hues with slightly varied shade per pixel
  // (O base orange, D dark stripes, L highlights, C/W cream chest and muzzle,
  //  rodent-style face: black K eyes on a cream band, black nose)
  const CAT_A = [ // tail right
    "......................",
    "......OO.......Y...Y..",
    ".....OOOO.....YYY.YYY.",
    "....OOOO......YDLYLDY.",
    "...OOO....OOO.OODLDOO.",
    "...OOO...ODOODOCKCKCO.",
    "...OOO..OODOLOOLCKCLOO",
    "...OOOOOOODODOCCCWCCC.",
    "....OOOOOODOOLOCWODOL.",
    "......OOOLODOOOLOWODO.",
    "......ODOOLDOLDOLDOLD.",
    "......................"
  ];
  const CAT_B = [ // tail mid
    "......................",
    "....O..........Y...Y..",
    "...OOO........YYY.YYY.",
    "...OOO........YDLYLDY.",
    "...OOO....OOO.OODLDOO.",
    "...OOO...ODOODOCKCKCO.",
    "...OOO..OODOLOOLCKCLOO",
    "...OOOOOOODODOCCCWCCC.",
    "...OOOOOOODOOLOCWODOL.",
    "....OOOOOLODOOOLOWODO.",
    "......ODOOLDOLDOLDOLD.",
    "......................"
  ];
  const CAT_C = [ // tail left
    "......................",
    ".OO............Y...Y..",
    "OOOO..........YYY.YYY.",
    ".OOOO.........YDLYLDY.",
    "...OOO....OOO.OODLDOO.",
    "...OOO...ODOODOCKCKCO.",
    "...OOO..OODOLOOLCKCLOO",
    "...OOOOOOODODOCCCWCCC.",
    "....OOOOOODOOLOCWODOL.",
    "......OOOLODOOOLOWODO.",
    "......ODOOLDOLDOLDOLD.",
    "......................"
  ];
  const CAT_PAL = {
    "Y": "#ffd800", "O": "#fa520f", "D": "#e0430b", "L": "#ff7a35",
    "C": "#fff4e6", "W": "#ffe3c2", "K": "#1a1a1a"
  };
  function spr(rows, pal, x, y, s) {
    for (let r = 0; r < rows.length; r++) {
      const line = rows[r];
      for (let c = 0; c < line.length; c++) {
        const col = pal[line[c]];
        if (col) { ctx.fillStyle = col; ctx.fillRect(x + c * s, y + r * s, s, s); }
      }
    }
  }

  // ---------- drawing ----------
  function drawStars() {
    for (const s of stars) {
      const tw = 0.4 + 0.6 * Math.abs(Math.sin(time * 1.4 + s.p));
      ctx.globalAlpha = tw;
      ctx.fillStyle = s.c;
      ctx.fillRect(s.x, s.y, s.r, s.r);
    }
    ctx.globalAlpha = 1;
  }

  function drawLasagna() {
    // rug
    ctx.fillStyle = "#2c2140";
    ctx.fillRect(0, H - 42, W, 42);
    ctx.fillStyle = "#3a2b52";
    for (let x = 8; x < W; x += 24) ctx.fillRect(x, H - 42, 2, 4);

    // plate
    ctx.fillStyle = "#d9dde3";
    ctx.beginPath();
    ctx.ellipse(W / 2, H - 22, 62, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    // layers
    const lx = W / 2 - 46, ly = H - 40;
    const layers = ["#e8c06a", "#c0392b", "#f6d365", "#b03a2e", "#e8c06a"];
    for (let i = 0; i < layers.length; i++) {
      ctx.fillStyle = layers[i];
      ctx.fillRect(lx, ly + i * 3.6, 92, 3.6);
    }
    // steam (blocky)
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    for (let i = 0; i < 2; i++) {
      const bx = lx + 20 + i * 50;
      const ph = Math.floor(time * 2 + i) % 2;
      ctx.fillRect(bx + (ph ? 3 : -1), ly - 8, 3, 3);
      ctx.fillRect(bx + (ph ? -2 : 4), ly - 14, 3, 3);
    }
  }

  function drawCat() {
    const x = catX, y = CAT_Y;
    ctx.save();
    if (flipT > 0) {
      ctx.translate(x, y - 18);
      ctx.rotate(Math.PI + Math.sin(flipT * 18) * 0.15);
      ctx.translate(-x, -(y - 18));
    }
    if (invuln > 0 && Math.floor(time * 18) % 2 === 0) ctx.globalAlpha = 0.35;
    // official tail sway: right -> mid -> left -> mid
    const seq = [CAT_A, CAT_B, CAT_C, CAT_B];
    let f = seq[Math.floor(time * 2) % 4];
    // occasional blink: the black eye dots in row 5 go orange for a beat
    if (((time + blinkSeed) % 3.7) < 0.16) {
      f = f.map(function (row, i) { return i === 5 ? row.replace(/K/g, "O") : row; });
    }
    // open mouth on spit: two black pixels in the muzzle row (cols 16-17,
    // right where the furball leaves the face), just under the nose
    if (mouthT > 0) {
      f = f.map(function (row, i) {
        return i === 7 ? row.slice(0, 16) + "KK" + row.slice(18) : row;
      });
    }
    spr(f, CAT_PAL, x - 33, y - 36, 3);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function drawMouse(r) {
    spr(bob ? MOUSE_B : MOUSE_A, RODENT_PAL, gx + r.col * SX, gy + r.row * SY, 3);
  }

  function drawRat(r) {
    spr(bob ? RAT_B : RAT_A, RAT_PAL, gx + r.col * SX, gy + r.row * SY, 3);
  }

  function drawRoomba() {
    if (!roomba) return;
    const x = roomba.x, y = roomba.y;
    spr(ROOMBA_SPR, ROOMBA_PAL, x - 19, y, 3);
    // bumper pixel at the front edge
    ctx.fillStyle = roomba.vx > 0 ? "#6ee7ff" : "#ff8fa3";
    ctx.fillRect(roomba.vx > 0 ? x + 16 : x - 19, y + 6, 3, 3);
    // rat general riding on top
    spr(RATMINI_SPR, RAT_PAL, x - 9, y - 19, 3);
  }

  function drawShields() {
    for (const sh of shields) {
      for (let r = 0; r < sh.cells.length; r++) {
        for (let c = 0; c < sh.cells[r].length; c++) {
          if (!sh.cells[r][c]) continue;
          ctx.fillStyle = (r + c) % 4 === 0 ? sh.c2 : sh.c1;
          ctx.fillRect(sh.x + c * CS, sh.y + r * CS, CS, CS);
        }
      }
    }
  }

  function drawBullets() {
    // furball: blocky fuzz
    for (const b of furballs) {
      ctx.fillStyle = "#e2e6ee";
      ctx.fillRect(b.x - 4, b.y - 3, 8, 6);
      ctx.fillStyle = "#b9c0cc";
      ctx.fillRect(b.x - 4, b.y - 4, 3, 3);
      ctx.fillRect(b.x + 2, b.y - 4, 3, 3);
      ctx.fillRect(b.x - 1, b.y + 3, 4, 2);
    }
    // crumbs: pixel cheese
    for (const c of crumbs) {
      ctx.fillStyle = "#f6d365";
      ctx.fillRect(c.x, c.y + 2, 10, 6);
      ctx.fillRect(c.x + 2, c.y, 6, 2);
      ctx.fillStyle = "#c99f3d";
      ctx.fillRect(c.x + 2, c.y + 4, 2, 2);
      ctx.fillRect(c.x + 6, c.y + 2, 2, 2);
    }
  }

  function drawParts() {
    for (const p of parts) {
      ctx.globalAlpha = Math.max(0, 1 - p.t / p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawHUD() {
    drawText("SCORE " + String(score).padStart(5, "0"), 12, 22, 2, QBIT.text, "left");
    drawText("WAVE " + wave, W / 2, 22, 2, QBIT.text, "center");
    drawText("HI " + String(hi).padStart(5, "0"), W - 12, 22, 2, QBIT.text, "right");
    // lives as pixel cat heads (Mistral style)
    for (let i = 0; i < lives; i++) {
      const x = 20 + i * 26, y = H - 18;
      ctx.fillStyle = "#ffd800";
      ctx.fillRect(x - 6, y - 10, 3, 4);            // ear L (yellow)
      ctx.fillRect(x + 3, y - 10, 3, 4);           // ear R
      ctx.fillStyle = "#fa520f";
      ctx.fillRect(x - 6, y - 6, 12, 10);          // head (orange)
      ctx.fillStyle = "#fff4e6";
      ctx.fillRect(x - 3, y, 6, 4);                 // cream muzzle
      ctx.fillStyle = "#1a1a1a";
      ctx.fillRect(x - 4, y - 3, 2, 2);             // eye L
      ctx.fillRect(x + 2, y - 3, 2, 2);             // eye R
      ctx.fillRect(x - 1, y + 1, 2, 2);             // nose
    }
  }

  function overlay(alpha) {
    ctx.fillStyle = "rgba(5,8,16," + alpha + ")";
    ctx.fillRect(0, 0, W, H);
  }

  // ---------- retro arcade font (5x5 bitmap glyphs, all-caps) ----------
  const FONT = {
    " ": ".....|.....|.....|.....|.....",
    "A": ".###.|#...#|#####|#...#|#...#",
    "B": "####.|#...#|####.|#...#|####.",
    "C": ".####|#....|#....|#....|.####",
    "D": "####.|#...#|#...#|#...#|####.",
    "E": "#####|#....|####.|#....|#####",
    "F": "#####|#....|####.|#....|#....",
    "G": ".####|#....|#..##|#...#|.###.",
    "H": "#...#|#...#|#####|#...#|#...#",
    "I": "#####|..#..|..#..|..#..|#####",
    "J": "....#|....#|....#|#...#|.###.",
    "K": "#...#|#..#.|###..|#..#.|#...#",
    "L": "#....|#....|#....|#....|#####",
    "M": "#...#|##.##|#.#.#|#...#|#...#",
    "N": "#...#|##..#|#.#.#|#..##|#...#",
    "O": ".###.|#...#|#...#|#...#|.###.",
    "P": "####.|#...#|####.|#....|#....",
    "Q": ".###.|#...#|#.#.#|#..#.|.##.#",
    "R": "####.|#...#|####.|#..#.|#...#",
    "S": ".####|#....|.###.|....#|####.",
    "T": "#####|..#..|..#..|..#..|..#..",
    "U": "#...#|#...#|#...#|#...#|.###.",
    "V": "#...#|#...#|#...#|.#.#.|..#..",
    "W": "#...#|#...#|#.#.#|##.##|#...#",
    "X": "#...#|.#.#.|..#..|.#.#.|#...#",
    "Y": "#...#|.#.#.|..#..|..#..|..#..",
    "Z": "#####|...#.|..#..|.#...|#####",
    "0": ".###.|#..##|#.#.#|##..#|.###.",
    "1": "..#..|.##..|..#..|..#..|#####",
    "2": ".###.|#...#|..##.|.#...|#####",
    "3": "####.|....#|.###.|....#|####.",
    "4": "#...#|#...#|#####|....#|....#",
    "5": "#####|#....|####.|....#|####.",
    "6": ".###.|#....|####.|#...#|.###.",
    "7": "#####|....#|...#.|..#..|..#..",
    "8": ".###.|#...#|.###.|#...#|.###.",
    "9": ".###.|#...#|.####|....#|.###.",
    ".": ".....|.....|.....|.....|..#..",
    ",": ".....|.....|.....|..#..|.#...",
    ":": ".....|..#..|.....|..#..|.....",
    "!": "..#..|..#..|..#..|.....|..#..",
    "?": ".###.|#...#|..#..|.....|..#..",
    "-": ".....|.....|#####|.....|.....",
    ">": "#....|.#...|..#..|.#...|#....",
    "<": "....#|...#.|..#..|...#.|....#",
    "(": "..#..|.#...|.#...|.#...|..#..",
    ")": "..#..|...#.|...#.|...#.|..#..",
    "'": "..#..|..#..|.....|.....|.....",
    "/": "....#|...#.|..#..|.#...|#....",
    "+": ".....|..#..|#####|..#..|.....",
    "=": ".....|#####|.....|#####|....."
  };
  // blocky bitmap text: s = pixel scale, glyph bottom sits on the y baseline
  // color "gradient" paints the qbit primary -> secondary emphasis (45deg)
  function drawText(txt, x, y, s, color, align) {
    txt = String(txt).toUpperCase();
    const w = txt.length * 6 * s - s;
    if (align === "center") x -= w / 2;
    else if (align === "right") x -= w;
    if (color === "gradient") {
      const g = ctx.createLinearGradient(x, y - 5 * s, x + w, y);
      g.addColorStop(0, QBIT.primary);
      g.addColorStop(1, QBIT.secondary);
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = color;
    }
    for (let i = 0; i < txt.length; i++) {
      const rows = (FONT[txt[i]] || FONT[" "]).split("|");
      const gx = Math.round(x + i * 6 * s);
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
          if (rows[r][c] === "#") ctx.fillRect(gx + c * s, y - 5 * s + r * s, s, s);
        }
      }
    }
  }
  function centerText(txt, y, size, color, bold) {
    const t = String(txt).toUpperCase();
    let s = Math.max(1, Math.round(size / 7));
    while (s > 1 && t.length * 6 * s - s > W - 16) s--; // auto-fit long lines
    drawText(t, W / 2, y, s, color, "center");
  }

  function draw() {
    ctx.fillStyle = QBIT.bg;
    ctx.fillRect(0, 0, W, H);
    drawStars();
    drawLasagna();
    if (state !== "title") {
      drawShields();
      rods.forEach(function (r) { if (r.alive) { r.rat ? drawRat(r) : drawMouse(r); } });
      drawRoomba();
      drawBullets();
      drawCat();
    } else {
      drawCat();
    }
    drawParts();
    drawHUD();

    if (state === "title") {
      overlay(0.55);
      centerText("VERMINVADERS", 190, 42, "gradient", true);
      centerText("The rodents march for the lasagna.", 225, 14, QBIT.text);
      centerText("Spit furballs. Guard the furniture.", 247, 14, QBIT.text);
      centerText("<-  ->  or A/D   move", 320, 13, QBIT.muted);
      centerText("SPACE   spit a furball", 342, 13, QBIT.muted);
      centerText("P   pause   (mouse: move + click)", 364, 13, QBIT.muted);
      centerText("AI harness: window.verminvaders", 386, 13, "rgba(150,162,181,0.55)");
      if (Math.floor(time * 2) % 2 === 0) centerText("PRESS SPACE OR TAP TO START", 430, 16, QBIT.primary, true);
    } else if (state === "waveclear") {
      centerText("WAVE " + wave + " CLEARED", 250, 24, QBIT.secondary, true);
      centerText("The rodents retreat to regroup...", 280, 13, QBIT.text);
    } else if (state === "gameover") {
      overlay(0.5);
      centerText("THE LASAGNA IS LOST", 220, 28, QBIT.error, true);
      centerText(overMsg, 252, 13, QBIT.text);
      centerText("Score: " + score, 290, 16, QBIT.secondary, true);
      if (Math.floor(time * 2) % 2 === 0) centerText("PRESS SPACE TO TRY AGAIN", 340, 15, QBIT.primary);
    }
    if (paused && state === "playing") {
      centerText("PAUSED (cat nap)", 290, 24, QBIT.text, true);
    }
  }

  // ---------- input ----------
  function pressStart() {
    if (state === "title" || state === "gameover") startGame();
    else if (state === "playing") shoot();
  }

  window.addEventListener("keydown", function (e) {
    if (["ArrowLeft", "ArrowRight", " ", "Spacebar"].indexOf(e.key) >= 0) e.preventDefault();
    if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") keys.left = true;
    if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") keys.right = true;
    if (e.key === " " || e.key === "Spacebar") pressStart();
    if ((e.key === "p" || e.key === "P") && state === "playing") paused = !paused;
  });
  window.addEventListener("keyup", function (e) {
    if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") keys.left = false;
    if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") keys.right = false;
  });

  function canvasX(e) {
    const rect = cvs.getBoundingClientRect();
    return (e.clientX - rect.left) * (W / rect.width);
  }
  cvs.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    if (state === "title" || state === "gameover") { pressStart(); return; }
    pointerDown = true;
    catTarget = canvasX(e);
    shoot();
  });
  cvs.addEventListener("pointermove", function (e) {
    if (pointerDown) catTarget = canvasX(e);
  });
  window.addEventListener("pointerup", function () {
    pointerDown = false; catTarget = null;
  });

  // ---------- AI harness bridge (window.verminvaders) ----------
  // Read the world with verminvaders.state(), act with the controls below.
  // pause()/resume() are optional: freeze the simulation while thinking,
  // the cat holds its position and inputs apply on resume.
  function rodPoints(r) { return r.rat ? 30 : (r.row === 2 ? 20 : 10); }

  // ---------- strategy feed panel (right of the canvas) ----------
  // The harness streams the strategist's reasoning into this DOM panel
  // while the game is paused for a consultation; live=1 shows the pulsing
  // status and the blinking cursor, live=0 settles the text. The status
  // line rotates through the cat's stream of consciousness while it thinks.
  const stratPanel = document.getElementById("strategy-panel");
  const stratBody = document.getElementById("strategy-body");
  const stratStatusText = stratPanel ? stratPanel.querySelector(".strategy__status-text") : null;
  let stratLiveTimer = 0;
  let stratThoughtTimer = 0;
  const STRAT_THOUGHTS = [
    "Thinking about tuna",
    "Playing with yarn",
    "Spitting out furballs",
    "Chasing the red dot",
    "Napping on the keyboard",
    "Judging the rodents",
    "Kneading the lasagna",
    "Begging for snacks",
    "Plotting world domination",
    "Sharpening the claws",
  ];

  function nextThought() {
    if (!stratStatusText) return;
    stratStatusText.textContent = STRAT_THOUGHTS[Math.floor(Math.random() * STRAT_THOUGHTS.length)];
  }

  function settleStrategyStatus() {
    clearInterval(stratThoughtTimer);
    stratThoughtTimer = 0;
  }

  function setStrategy(text, live) {
    if (!stratPanel || !stratBody) return false;
    stratBody.textContent = String(text == null ? "" : text);
    stratPanel.hidden = false;
    if (live) {
      clearTimeout(stratLiveTimer);
      if (stratPanel.dataset.live !== "1") {
        nextThought(); // fresh consultation, fresh thought
        stratThoughtTimer = setInterval(nextThought, 2500);
      }
      stratPanel.dataset.live = "1";
    } else {
      settleStrategyStatus();
      stratPanel.dataset.live = "0";
    }
    stratBody.scrollTop = stratBody.scrollHeight;
    return true;
  }

  function clearStrategy() {
    if (!stratPanel) return false;
    clearTimeout(stratLiveTimer);
    settleStrategyStatus();
    stratPanel.hidden = true;
    stratPanel.dataset.live = "0";
    if (stratBody) stratBody.textContent = "";
    return true;
  }

  // ---------- reasoning feed panel (right of the strategy panel) ----------
  // The model's raw thinking chain streams here while it reasons; it stays
  // until the next consultation replaces it. Only the tail is kept.
  const thinkPanel = document.getElementById("thinking-panel");
  const thinkBody = document.getElementById("thinking-body");

  function setThinking(text, live) {
    if (!thinkPanel || !thinkBody) return false;
    var t = String(text == null ? "" : text);
    if (!t) return clearThinking();
    thinkBody.textContent = t.slice(-8000);
    thinkPanel.hidden = false;
    thinkPanel.dataset.live = live ? "1" : "0";
    thinkBody.scrollTop = thinkBody.scrollHeight;
    return true;
  }

  function clearThinking() {
    if (!thinkPanel) return false;
    thinkPanel.hidden = true;
    thinkPanel.dataset.live = "0";
    if (thinkBody) thinkBody.textContent = "";
    return true;
  }

  window.verminvaders = {
    version: 1,
    canvas: { w: W, h: H, catY: CAT_Y },
    state: function () {
      return {
        phase: state, // title | playing | waveclear | gameover
        paused: paused,
        score: score, hi: hi, wave: wave, lives: lives,
        invuln: invuln, // >0: cat is briefly untargetable
        time: time,
        cat: { x: catX, y: CAT_Y, minX: 36, maxX: W - 36, speed: 230 },
        // classic rules: max one furball in flight (null = may shoot)
        furball: furballs.length ? { x: furballs[0].x, y: furballs[0].y, vy: furballs[0].vy } : null,
        crumbs: crumbs.map(function (c) { return { x: c.x, y: c.y, w: c.w, h: c.h, vy: c.vy }; }),
        rods: rods.filter(function (r) { return r.alive; }).map(function (r) {
          return { x: gx + r.col * SX, y: gy + r.row * SY, w: r.w, h: r.h,
                   row: r.row, col: r.col, rat: r.rat, points: rodPoints(r) };
        }),
        formation: { x: gx, y: gy, dir: dir, cols: 8, rows: 5, stepX: SX, stepY: SY,
                     nextMarchIn: Math.max(0, marchInterval() - marchT) },
        roomba: roomba ? { x: roomba.x, y: roomba.y, vx: roomba.vx, points: 200 } : null,
        shields: shields.map(function (sh) {
          let cellsLeft = 0;
          sh.cells.forEach(function (row) { row.forEach(function (c) { if (c) cellsLeft++; }); });
          return { x: sh.x, y: sh.y, w: sh.w, h: sh.h, cellsLeft: cellsLeft };
        })
      };
    },
    // --- controls (all return true/false for success/no-op) ---
    start: function () {
      if (state === "title" || state === "gameover") { startGame(); return true; }
      return false;
    },
    shoot: function () {
      if (state !== "playing" || paused || furballs.length) return false;
      shoot();
      return true;
    },
    moveLeft: function (on) { keys.left = !!on; return true; },
    moveRight: function (on) { keys.right = !!on; return true; },
    // glide to an x position (clamped to the movement range)
    moveTo: function (x) {
      x = Number(x);
      if (isNaN(x)) return false;
      catTarget = Math.max(36, Math.min(W - 36, x));
      pointerDown = true;
      return true;
    },
    stop: function () { keys.left = false; keys.right = false; pointerDown = false; catTarget = null; return true; },
    // --- strategy feed (the model's own words, streamed live) ---
    showStrategy: function (text, live) {
      return setStrategy(text, !!live);
    },
    clearStrategy: function () {
      return clearStrategy();
    },
    // --- reasoning feed (the model's raw thinking chain, streamed live) ---
    showThinking: function (text, live) {
      return setThinking(text, !!live);
    },
    clearThinking: function () {
      return clearThinking();
    },
    // --- optional thinking pause ---
    pause: function () { paused = true; return true; },
    resume: function () {
      paused = false;
      // the streamed strategy stays live for a short moment once play continues
      if (stratPanel && stratPanel.dataset.live === "1") {
        clearTimeout(stratLiveTimer);
        stratLiveTimer = setTimeout(function () {
          settleStrategyStatus();
          stratPanel.dataset.live = "0";
        }, 6000);
      }
      return true;
    },
    togglePause: function () { paused = !paused; return true; }
  };

  // ---------- loop ----------
  function loop(ts) {
    const dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
    last = ts;
    if (!paused) update(dt);
    draw();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
