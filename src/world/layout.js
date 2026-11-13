// Static world layout: constants, regions, water bodies, roads and points of interest.
// Pure data + tiny helpers; imported by the worldgen worker and by the game.
// Coordinates: metres, +x east, +z south (north is -z), y up, sea level y = 0.

export const WORLD = {
  size: 4096,          // metres across
  half: 2048,
  res: 2048,           // heightmap samples per side
  cell: 2,             // metres per sample
  seed: 20261113,
};

export const BIOME = { MEADOW: 0, FOREST: 1, SAKURA: 2, AUTUMN: 3, BEACH: 4, ALPINE: 5, PLATEAU: 6, MYSTIC: 7 };

// Mountains: additive ridged peaks
export const MOUNTAINS = [
  { x: -150, z: -1050, r: 820, h: 540, sharp: 1.55 },   // Frostcrown Peak
  { x: 480, z: -1180, r: 520, h: 300, sharp: 1.5 },
  { x: -820, z: -900, r: 560, h: 280, sharp: 1.5 },
  { x: 1050, z: -760, r: 480, h: 120, sharp: 1.2 },     // Emberleaf highlands
  { x: -1250, z: 520, r: 380, h: 110, sharp: 1.3 },     // west forest ridge
  { x: -350, z: 1250, r: 360, h: 90, sharp: 1.3 },      // south-west hills
];

// Small offshore islands
export const ISLETS = [
  { x: 1760, z: 760, r: 110, h: 26 },
  { x: 1480, z: 1560, r: 80, h: 14 },
  { x: -1840, z: -420, r: 120, h: 44 },
  { x: -1500, z: 1380, r: 90, h: 18 },
  { x: 560, z: 1800, r: 70, h: 12 },
  { x: 1500, z: -1320, r: 100, h: 36 },
  { x: -620, z: -1800, r: 80, h: 30 },
];

// The starting plateau
export const PLATEAU = { x: 250, z: 1010, r: 310, h: 92 };

// Lakes: flat water bodies above sea level
export const LAKES = [
  { name: 'Mirror Lake', x: 800, z: -40, r: 250, level: 24, depth: 11, wobble: 0.22, island: { x: 835, z: -60, r: 34, h: 4.5 } },
  { name: 'Mossy Pond', x: -700, z: 430, r: 62, level: 41, depth: 4, wobble: 0.25 },
  { name: 'Skywell Tarn', x: 215, z: 1085, r: 46, level: 90.5, depth: 3.5, wobble: 0.2 },
];

// Rivers: control points [x, z, surfaceElevation]; width in metres (full).
export const RIVERS = [
  {
    name: 'Silverrun', width: 11,
    pts: [
      [-60, -640, 178], [10, -560, 150], [80, -480, 124], [150, -400, 104], [205, -335, 92],
      [222, -316, 58], [300, -260, 50], [400, -215, 40], [500, -160, 30], [575, -110, 24],
    ],
  },
  {
    name: 'Eastfall', width: 13,
    pts: [
      [1030, 30, 24], [1120, 70, 22.5], [1220, 120, 21], [1330, 150, 19.5], [1440, 185, 18], [1500, 205, 17],
      [1522, 213, 0.2], [1560, 225, 0],
    ],
  },
];

// Roads / paths: polylines; terrain gets smoothed along them and grass is cleared.
export const ROADS = [
  { name: 'plateau-descent', width: 3.2, pts: [[250, 960], [300, 900], [380, 850], [470, 800], [560, 730], [600, 640], [610, 560], [620, 500]] },
  { name: 'village-lake', width: 3.2, pts: [[620, 500], [640, 400], [620, 300], [580, 220], [560, 130]] },
  { name: 'lake-north', width: 3.0, pts: [[560, 130], [500, 20], [460, -80], [440, -182], [400, -300], [330, -420], [260, -540]] },
  { name: 'village-tower', width: 3.0, pts: [[620, 500], [500, 470], [380, 420], [260, 340], [150, 270], [70, 215]] },
  { name: 'tower-forest', width: 2.8, pts: [[70, 215], [-60, 190], [-200, 210], [-360, 260], [-520, 250], [-680, 210], [-860, 215]] },
  { name: 'village-coast', width: 3.0, pts: [[620, 500], [720, 580], [820, 680], [930, 790], [1040, 900], [1140, 1000], [1230, 1060]] },
  { name: 'tower-temple', width: 2.8, pts: [[70, 215], [10, 100], [-80, -20], [-180, -130], [-260, -220]] },
  { name: 'lake-east', width: 2.8, pts: [[560, 130], [660, 200], [800, 250], [940, 230], [1060, 130], [1160, 80], [1260, 80]] },
  { name: 'ember-ridge', width: 2.6, pts: [[412, -268], [520, -340], [700, -440], [840, -540], [960, -640]] },
];

// Points of interest. flat = radius of terrain flatten stamp (0 = none).
export const POI = {
  spawn:        { x: 250, z: 1035, flat: 34, clear: 15, name: 'Shrine of Awakening', region: 'Dawn Plateau' },
  overlook:     { x: 262, z: 735, flat: 0 },
  village:      { x: 620, z: 500, flat: 95, clear: 15, name: 'Hearthvale', region: 'Hearthvale' },
  windmill:     { x: 500, z: 610, flat: 20, clear: 6 },
  skyTower:     { x: 70, z: 215, flat: 30, clear: 10, name: 'Skywatch Tower', region: 'Sunpetal Meadows' },
  elderTree:    { x: -900, z: 215, flat: 40, clear: 0, name: 'The Elder Tree', region: 'Whispering Woods' },
  temple:       { x: -290, z: -250, flat: 62, clear: 31, name: 'Sealed Sanctum', region: 'Sanctum Foothills' },
  shrineForest: { x: -1010, z: 470, flat: 22, clear: 8.5, name: 'Verdant Shrine', region: 'Whispering Woods' },
  shrineCoast:  { x: 1250, z: 1075, flat: 22, clear: 8.5, name: 'Tidal Shrine', region: 'Coral Coast' },
  shrinePeak:   { x: -95, z: -790, flat: 22, clear: 8.5, name: 'Frost Shrine', region: 'Frostcrown' },
  lakeIsle:     { x: 835, z: -60, flat: 0, name: 'Petal Isle', region: 'Mirror Lake' },
  emberCamp:    { x: 965, z: -650, flat: 26, clear: 9, name: 'Emberleaf Ridge', region: 'Emberleaf Ridge' },
  beachCamp:    { x: 1010, z: 1180, flat: 0 },
  ruinsMeadow:  { x: 250, z: 60, flat: 30, clear: 0, name: 'Sunpetal Ruins', region: 'Sunpetal Meadows' },
  ruinsWest:    { x: -520, z: 760, flat: 26, clear: 0, name: 'Old Watch', region: 'Southreach' },
  campNorth:    { x: 420, z: -460, flat: 20, clear: 9 },
  campForest:   { x: -560, z: 60, flat: 20, clear: 9 },
  campEast:     { x: 1240, z: -220, flat: 20, clear: 9 },
  bridgeSilver: { x: 430, z: -200, flat: 0 },
  bridgeEast:   { x: 1265, z: 133, flat: 0 },
};

// Village houses: [dx, dz (relative to the village centre), yaw, width, depth, roof colour index]
export const VILLAGE_HOUSES = [
  [-26, -15, 0.95, 8.5, 6.5, 0], [-9, -29, 0.2, 9.5, 7.0, 1], [15, -28, -0.35, 8.0, 6.2, 2], [29, -8, -1.3, 9.0, 6.6, 0],
  [27, 19, -2.2, 8.2, 6.4, 3], [-28, 12, 1.9, 9.2, 6.8, 1], [-10, 31, 2.95, 8.0, 6.0, 3], [45, -32, -0.8, 7.5, 6.0, 2],
];

// Ruined cottages (kit-built) beside the old ruins and along the roads: [x, z]; trees keep their distance.
export const RUIN_COTTAGES = [[270, 76], [-536, 746], [572, 168], [-136, 538], [914, 432], [-604, -246], [300, 905], [-380, 262], [1010, 906]];

// Named regions for title cards (nearest centre wins, within radius).
export const REGIONS = [
  { name: 'Dawn Plateau', sub: 'Where the world remembers you', x: 250, z: 1010, r: 330 },
  { name: 'Hearthvale', sub: 'A quiet village by the river road', x: 620, z: 500, r: 150 },
  { name: 'Sunpetal Meadows', sub: 'Fields that drink the morning light', x: 180, z: 300, r: 380 },
  { name: 'Mirror Lake', sub: 'The sky rests here', x: 800, z: -40, r: 330 },
  { name: 'Whispering Woods', sub: 'Old trees keep old secrets', x: -850, z: 200, r: 600 },
  { name: 'Sanctum Foothills', sub: 'Something sleeps beneath the stone', x: -290, z: -250, r: 260 },
  { name: 'Frostcrown', sub: 'The roof of the world', x: -150, z: -1000, r: 620 },
  { name: 'Emberleaf Ridge', sub: 'Autumn never leaves these hills', x: 1000, z: -700, r: 430 },
  { name: 'Coral Coast', sub: 'Warm sands and singing tides', x: 1180, z: 1050, r: 420 },
  { name: 'Southreach', sub: 'Windswept hills above the sea', x: -450, z: 1000, r: 480 },
];

// ---------- helpers ----------

// Catmull-Rom spline sampling of a polyline with arbitrary component count.
export function sampleSpline(pts, step) {
  const out = [];
  const n = pts.length;
  const dim = pts[0].length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(i + 2, n - 1)];
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const k = Math.max(1, Math.ceil(segLen / step));
    for (let j = 0; j < k; j++) {
      const t = j / k, t2 = t * t, t3 = t2 * t;
      const q = new Array(dim);
      for (let d = 0; d < dim; d++) {
        if (d < 2) {
          q[d] = 0.5 * ((2 * p1[d]) + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3);
        } else {
          // elevations: monotone (smoothstep) interpolation to avoid overshoot
          const s = t * t * (3 - 2 * t);
          q[d] = p1[d] + (p2[d] - p1[d]) * s;
        }
      }
      out.push(q);
    }
  }
  out.push(pts[n - 1].slice());
  return out;
}

export function regionAt(x, z) {
  let best = null, bestD = 1e9;
  for (const r of REGIONS) {
    const d = Math.hypot(x - r.x, z - r.z) / r.r;
    if (d < 1 && d < bestD) { bestD = d; best = r; }
  }
  return best;
}
