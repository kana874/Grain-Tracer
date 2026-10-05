function mask(width, height) {
  return new Uint8Array(width * height);
}

function setPixel(target, width, x, y) {
  if (x < 0 || y < 0 || x >= width || y >= target.length / width) return;
  target[y * width + x] = 1;
}

function line(target, width, x0, y0, x1, y1) {
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  while (true) {
    setPixel(target, width, x, y);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

function makeFixture(name, draw, evidence = {}) {
  const width = 48;
  const height = 48;
  const expectedBoundary = mask(width, height);
  draw(expectedBoundary, width, height);
  return {
    name,
    width,
    height,
    expectedBoundary,
    evidence: {
      dark: evidence.dark ?? 0,
      ridge: evidence.ridge ?? 0,
      color: evidence.color ?? 0,
      dendrite: evidence.dendrite ?? 0,
    },
  };
}

export function createBoundaryFixtures() {
  return [
    makeFixture("straight-boundary", (m, w) => line(m, w, 8, 24, 39, 24), { ridge: 1, color: 1 }),
    makeFixture("diagonal-boundary", (m, w) => line(m, w, 8, 8, 39, 39), { ridge: 1, color: 1 }),
    makeFixture("curved-boundary", (m, w) => {
      for (let x = 7; x <= 40; x += 1) {
        const y = Math.round(13 + ((x - 24) ** 2) / 55);
        setPixel(m, w, x, y);
      }
    }, { ridge: 1, color: 1 }),
    makeFixture("dark-only", (m, w) => line(m, w, 8, 18, 39, 18), { dark: 1 }),
    makeFixture("color-only", (m, w) => line(m, w, 8, 20, 39, 20), { color: 1 }),
    makeFixture("ridge-only", (m, w) => line(m, w, 8, 22, 39, 22), { ridge: 1 }),
    makeFixture("parallel-intragranular-dendrites", (m, w) => {
      for (const y of [14, 18, 22, 26, 30, 34]) line(m, w, 8, y, 39, y);
    }, { ridge: 1, dendrite: 0 }),
    makeFixture("black-dot", (m, w) => {
      setPixel(m, w, 24, 24);
      setPixel(m, w, 25, 24);
      setPixel(m, w, 24, 25);
      setPixel(m, w, 25, 25);
    }, { dark: 1, ridge: 0.3 }),
    makeFixture("polishing-scratch", (m, w) => line(m, w, 3, 10, 44, 10), { dark: 0.5, ridge: 1, color: 0.1 }),
    makeFixture("short-false-line", (m, w) => line(m, w, 22, 24, 26, 24), { ridge: 1 }),
    makeFixture("t-junction", (m, w) => {
      line(m, w, 8, 18, 39, 18);
      line(m, w, 24, 18, 24, 39);
    }, { ridge: 1, color: 1 }),
    makeFixture("y-junction", (m, w) => {
      line(m, w, 24, 24, 24, 40);
      line(m, w, 24, 24, 10, 10);
      line(m, w, 24, 24, 38, 10);
    }, { ridge: 1, color: 1 }),
  ];
}

export const REQUIRED_BOUNDARY_FIXTURE_NAMES = Object.freeze([
  "straight-boundary",
  "diagonal-boundary",
  "curved-boundary",
  "dark-only",
  "color-only",
  "ridge-only",
  "parallel-intragranular-dendrites",
  "black-dot",
  "polishing-scratch",
  "short-false-line",
  "t-junction",
  "y-junction",
]);
