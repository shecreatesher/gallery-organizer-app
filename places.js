/* Gallery Organizer: where was each photo taken?
   Turns a GPS position into a place name like "Spain - Madrid", fully offline,
   using the city list in data/places.js (GeoNames, cities with 15,000+ people).
   - The biggest city whose "reach" covers the point wins, so a photo in a Kyoto ward says "Kyoto".
     Reach grows with population: Madrid (3.2M) ≈ 30 km, Lisbon (0.5M) ≈ 14 km, a 20k town ≈ 5 km.
   - Otherwise the nearest place, as long as it is within 150 km (else: no place).
   Cities sit in a 1°×1° grid so a lookup only checks the few nearby cells. */
(function () {
  "use strict";

  const MAX_KM = 150;
  const MAX_REACH = 45;
  const RAD = Math.PI / 180;
  const reach = pop => 3 + 1.5 * Math.sqrt(pop / 10000);

  let cities = null;
  function load() {
    if (cities) return cities;
    const text = window.GalleryPlaceData || "";
    const lines = text ? text.split("\n") : [];
    const n = lines.length;
    const c = { name: new Array(n), cc: new Array(n), lat: new Float32Array(n), lon: new Float32Array(n), pop: new Float64Array(n), grid: new Map() };
    for (let i = 0; i < n; i++) {
      const p = lines[i].split("\t");
      c.name[i] = p[0]; c.cc[i] = p[1]; c.lat[i] = +p[2]; c.lon[i] = +p[3]; c.pop[i] = +p[4] || 0;
      const key = Math.floor(c.lat[i]) + "," + Math.floor(c.lon[i]);
      let cell = c.grid.get(key);
      if (!cell) c.grid.set(key, cell = []);
      cell.push(i);
    }
    return (cities = c);
  }

  function km(lat1, lon1, lat2, lon2) {
    const a = Math.sin((lat2 - lat1) * RAD / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin((lon2 - lon1) * RAD / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(a));
  }

  function nearest(lat, lon) {
    const c = load(), la = Math.floor(lat), lo = Math.floor(lon);
    const kmPerCell = 111 * Math.max(Math.cos(Math.min(Math.abs(lat) + 1, 89) * RAD), 0.02);
    let best = -1, bestKm = Infinity, big = -1;
    for (let r = 0; r <= 25; r++) {
      for (let di = -r; di <= r; di++) {
        for (let dj = -r; dj <= r; dj++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          let cl = lo + dj; if (cl < -180) cl += 360; if (cl > 179) cl -= 360;
          for (const i of c.grid.get((la + di) + "," + cl) || []) {
            const d = km(lat, lon, c.lat[i], c.lon[i]);
            if (d < bestKm) { bestKm = d; best = i; }
            if (d <= reach(c.pop[i]) && (big < 0 || c.pop[i] > c.pop[big])) big = i;
          }
        }
      }
      // Every city in ring r+1 is at least r cells away: stop once none could be nearer or reach this point.
      if (best >= 0 && r * kmPerCell > Math.max(bestKm, MAX_REACH)) break;
      if (best < 0 && r * kmPerCell > MAX_KM) break;
    }
    const i = big >= 0 ? big : best;
    return i >= 0 && (big >= 0 || bestKm <= MAX_KM) ? i : -1;
  }

  let regions = null;
  function country(cc) {
    try { regions = regions || new Intl.DisplayNames(undefined, { type: "region" }); return regions.of(cc) || cc; }
    catch (err) { return cc; }
  }

  const cache = new Map();   // photos from one trip share positions: ~1 km cells
  /** "Spain - Madrid", or null when there is no town within 150 km (sea, desert, bad GPS). */
  function placeOf(lat, lon) {
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
    const key = lat.toFixed(2) + "," + lon.toFixed(2);
    if (cache.has(key)) return cache.get(key);
    const i = nearest(lat, lon);
    const c = cities;
    const label = i < 0 ? null : `${country(c.cc[i])} - ${c.name[i]}`;
    cache.set(key, label);
    return label;
  }

  window.GalleryPlaces = { placeOf, get available() { return !!window.GalleryPlaceData; } };
})();
