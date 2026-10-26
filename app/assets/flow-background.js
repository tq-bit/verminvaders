/* FlowBackground - the moving-lines background of the qbit design system.
   Ported to plain JS for the static Verminvaders site. Drifting nodes linked
   by edges, with comet pulses travelling along them. Clicking empty
   background space connects two new nodes. Pauses on hidden tabs; renders a
   single static frame under prefers-reduced-motion. */
(function () {
  'use strict';

  var NODE_COUNT = 18;

  var container = null;
  var canvas = null;
  var canvasPrimary = '64, 156, 255';
  var canvasSecondary = '178, 122, 255';

  var nodes = [];
  var edges = [];
  var pulses = [];
  var pendingNodeIndex = null;

  var animationFrameId = null;
  var lastTimestamp = null;
  var width = 0;
  var height = 0;

  function random(min, max) { return min + Math.random() * (max - min); }

  function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function readThemeSettings() {
    var styles = getComputedStyle(document.documentElement);
    var primary = styles.getPropertyValue('--canvas-primary').trim();
    var secondary = styles.getPropertyValue('--canvas-secondary').trim();
    if (primary) canvasPrimary = primary;
    if (secondary) canvasSecondary = secondary;
  }

  function createPulse(edgeIndex) {
    return {
      edge: edgeIndex === undefined ? Math.floor(Math.random() * edges.length) : edgeIndex,
      t: Math.random(),
      speed: random(0.045, 0.12),
      size: random(1.4, 2.6),
      color: Math.random() > 0.3 ? canvasPrimary : canvasSecondary,
      direction: Math.random() > 0.5 ? 1 : -1
    };
  }

  function buildGraph() {
    nodes = []; edges = []; pulses = []; pendingNodeIndex = null;

    var nodeCount = Math.max(10, Math.min(NODE_COUNT, Math.floor(width / 80)));

    for (var i = 0; i < nodeCount; i++) {
      var x = random(0.04, 0.96) * width;
      var y = random(0.04, 0.96) * height;
      nodes.push({
        baseX: x, baseY: y, x: x, y: y,
        radius: random(1.8, 4),
        phase: random(0, Math.PI * 2),
        driftSpeed: random(0.1, 0.35)
      });
    }

    nodes.forEach(function (node, i) {
      var neighbours = nodes
        .map(function (other, j) {
          return {
            index: j,
            distance: Math.hypot(other.baseX - node.baseX, other.baseY - node.baseY)
          };
        })
        .filter(function (n) { return n.index !== i; })
        .sort(function (a, b) { return a.distance - b.distance; });

      for (var k = 0; k < 2 && k < neighbours.length; k++) {
        var target = neighbours[k].index;
        var exists = edges.some(function (edge) {
          return (edge.from === i && edge.to === target) ||
                 (edge.from === target && edge.to === i);
        });
        if (!exists) edges.push({ from: i, to: target });
      }
    });

    var pulseCount = Math.ceil(edges.length / 2);
    for (var p = 0; p < pulseCount; p++) pulses.push(createPulse());
  }

  function drawFrame(ctx, delta, time) {
    ctx.clearRect(0, 0, width, height);

    nodes.forEach(function (node) {
      node.x = node.baseX + Math.sin(time * node.driftSpeed + node.phase) * 12;
      node.y = node.baseY + Math.cos(time * node.driftSpeed * 0.7 + node.phase) * 9;
    });

    ctx.lineWidth = 1;
    edges.forEach(function (edge) {
      var from = nodes[edge.from], to = nodes[edge.to];
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.strokeStyle = 'rgba(' + canvasPrimary + ', 0.08)';
      ctx.stroke();
    });

    pulses.forEach(function (pulse, i) {
      var edge = edges[pulse.edge];
      if (!edge) { pulses[i] = createPulse(); return; }

      pulse.t += (pulse.speed * delta * pulse.direction) / 1000;
      if (pulse.t >= 1 || pulse.t <= 0) { pulses[i] = createPulse(); return; }

      var from = nodes[edge.from], to = nodes[edge.to];
      var color = pulse.color;

      var x = from.x + (to.x - from.x) * pulse.t;
      var y = from.y + (to.y - from.y) * pulse.t;

      var dx = to.x - from.x, dy = to.y - from.y;
      var length = Math.hypot(dx, dy) || 1;
      var trailLength = Math.min(34, length * 0.18);
      var tailX = x - (dx / length) * trailLength * pulse.direction;
      var tailY = y - (dy / length) * trailLength * pulse.direction;

      var trail = ctx.createLinearGradient(tailX, tailY, x, y);
      trail.addColorStop(0, 'rgba(' + color + ', 0)');
      trail.addColorStop(1, 'rgba(' + color + ', 0.35)');

      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(x, y);
      ctx.strokeStyle = trail;
      ctx.lineWidth = 1.6;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(x, y, pulse.size, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(' + color + ', 0.9)';
      ctx.shadowColor = 'rgba(' + color + ', 0.9)';
      ctx.shadowBlur = 10;
      ctx.fill();
      ctx.shadowBlur = 0;
    });

    nodes.forEach(function (node) {
      if (node.isPending) {
        var pulse = 2.5 + Math.sin(time * 4) * 2;
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(' + canvasSecondary + ', 0.5)';
        ctx.fill();

        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 3 + pulse, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(' + canvasSecondary + ', 0.5)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        return;
      }

      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(' + canvasPrimary + ', 0.3)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius + 2.5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(' + canvasPrimary + ', 0.16)';
      ctx.lineWidth = 1;
      ctx.stroke();
    });
  }

  function draw(timestamp) {
    var ctx = canvas ? canvas.getContext('2d') : null;
    if (!canvas || !ctx) return;

    if (lastTimestamp === null) lastTimestamp = timestamp;
    var delta = Math.min(50, timestamp - lastTimestamp);
    lastTimestamp = timestamp;

    drawFrame(ctx, delta, timestamp / 1000);

    animationFrameId = requestAnimationFrame(draw);
  }

  function renderStaticFrame() {
    var ctx = canvas ? canvas.getContext('2d') : null;
    if (ctx) drawFrame(ctx, 0, performance.now() / 1000);
  }

  function addNodeAt(x, y) {
    nodes.push({
      baseX: x, baseY: y, x: x, y: y,
      radius: 3,
      phase: random(0, Math.PI * 2),
      driftSpeed: 0.25,
      isPending: true
    });
    return nodes.length - 1;
  }

  function isInteractiveTarget(target) {
    return target instanceof Element &&
      target.closest('a, button, input, textarea, select, label, nav, footer, .toolbar') !== null;
  }

  function handleBackgroundClick(event) {
    if (event.button !== 0 || isInteractiveTarget(event.target)) return;

    if (pendingNodeIndex === null) {
      pendingNodeIndex = addNodeAt(event.clientX, event.clientY);
    } else {
      var fromIndex = pendingNodeIndex;
      pendingNodeIndex = null;
      nodes[fromIndex].isPending = false;

      var toIndex = addNodeAt(event.clientX, event.clientY);
      nodes[toIndex].isPending = false;

      var edgeIndex = edges.length;
      edges.push({ from: fromIndex, to: toIndex });
      pulses.push(createPulse(edgeIndex));
      pulses.push(createPulse(edgeIndex));
    }

    if (prefersReducedMotion()) renderStaticFrame();
  }

  function resize() {
    if (!canvas) return;

    var dpr = window.devicePixelRatio || 1;
    width = window.innerWidth;
    height = window.innerHeight;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';

    var ctx = canvas.getContext('2d');
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    buildGraph();

    if (prefersReducedMotion()) renderStaticFrame();
  }

  function start() {
    if (animationFrameId === null) {
      lastTimestamp = null;
      animationFrameId = requestAnimationFrame(draw);
    }
  }

  function stop() {
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
  }

  function updateAnimationState() {
    if (prefersReducedMotion()) {
      stop();
      renderStaticFrame();
    } else {
      start();
    }
  }

  function mount() {
    if (container) return;

    container = document.createElement('div');
    container.className = 'flow';
    container.setAttribute('aria-hidden', 'true');

    canvas = document.createElement('canvas');
    canvas.className = 'flow__canvas';

    var glowPrimary = document.createElement('div');
    glowPrimary.className = 'flow__glow flow__glow--primary';
    var glowSecondary = document.createElement('div');
    glowSecondary.className = 'flow__glow flow__glow--secondary';

    container.append(canvas, glowPrimary, glowSecondary);
    document.body.prepend(container);
  }

  function init() {
    mount();
    readThemeSettings();
    resize();

    window.addEventListener('resize', resize);
    window.addEventListener('click', handleBackgroundClick);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop();
      else updateAnimationState();
    });

    updateAnimationState();
  }

  window.FlowBackground = { init: init };
})();
