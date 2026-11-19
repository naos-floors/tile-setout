/* Drawing reading: shared prompt, JSON import, optional online API call */
(function () {
  'use strict';
  const PROMPT = `You are reading a construction drawing (floor plan, elevations or a sketch) for a tiling set-out app.
Extract every floor area and every wall elevation that is shown, and return ONLY a JSON object in this exact format (no other text):

{
  "rooms": [
    {
      "name": "Kitchen",
      "surfaces": [
        {
          "name": "Kitchen floor",
          "kind": "floor",
          "outline": [[0,0],[4200,0],[4200,3600],[0,3600]],
          "openings": [
            {"type": "unit", "name": "Base units", "x": 0, "y": 3000, "w": 4200, "h": 600, "tiled_under": true},
            {"type": "unit", "name": "Island", "x": 1500, "y": 1200, "w": 1800, "h": 900, "tiled_under": true}
          ],
          "doorways": [
            {"name": "Door to hall", "x1": 0, "y1": 800, "x2": 0, "y2": 1700}
          ]
        },
        {
          "name": "Wall A",
          "kind": "wall",
          "outline": [[0,0],[2400,0],[2400,2400],[0,2400]],
          "openings": [
            {"type": "window", "name": "Window", "x": 800, "y": 1000, "w": 900, "h": 1000}
          ]
        }
      ]
    }
  ],
  "notes": "Any assumptions, unclear dimensions or things to check on site."
}

Rules:
- All values in millimetres, rounded to the nearest mm.
- "kind" is "wall" or "floor".
- FLOORS: plan view as drawn, x to the right and y up the page. Use ONE shared coordinate system for every floor area on the same plan (origin at the bottom-left of the whole plan) so neighbouring rooms line up exactly where they meet. List outline corners in order going anticlockwise. Any shape is allowed.
- DOORWAYS (floors only): every gap in the walls where you walk through — doors, archways, openings into the next room. Give the two ends of the gap (x1,y1 and x2,y2), which must lie on the outline of that floor. Name them by where they lead (e.g. "Door to hall").
- WALLS: draw each elevation as if standing facing it. Origin [0,0] is its bottom-left corner at finished floor level, x to the right, y up. Sloped ceilings or boxing become extra outline points. List a room's walls in order going round the room (A, B, C, D…).
- "openings" are rectangles given by their bottom-left corner x,y plus width w and height h, in the same coordinates as their surface. Type must be one of: door, window, niche, bath, tray, unit, other.
- Kitchen units, islands and fitted furniture on a floor are type "unit". Set "tiled_under": true if the floor is likely tiled under them (normal for kitchens unless the drawing says otherwise), false if they are not tiled under. Doors, windows, baths and shower trays are never tiled under.
- Use the written dimensions on the drawing first. Only scale from the drawing if a dimension is missing, and say so in notes.
- Do not invent surfaces or openings that are not on the drawing. If something is unclear, make your best reading and list it in notes.`;

  const TYPES = ['door', 'window', 'niche', 'bath', 'tray', 'unit', 'other'];

  function extractJSON(text) {
    const s = text.indexOf('{'), e = text.lastIndexOf('}');
    if (s < 0 || e < 0) throw new Error('No JSON found in the text.');
    return JSON.parse(text.slice(s, e + 1));
  }

  /* Convert parsed data into rooms for a job. Returns {rooms, notes, warnings} */
  function toRooms(data, tileId) {
    const warnings = [];
    if (!data || !Array.isArray(data.rooms)) throw new Error('Missing "rooms" list.');
    const rooms = data.rooms.map((r, ri) => {
      const room = Store.newRoom(String(r.name || `Room ${ri + 1}`));
      (r.surfaces || []).forEach((s, si) => {
        const kind = s.kind === 'floor' ? 'floor' : 'wall';
        let pts = (s.outline || []).map(p => [+p[0], +p[1]]).filter(p => isFinite(p[0]) && isFinite(p[1]));
        if (pts.length < 3) { warnings.push(`${room.name} / ${s.name || 'surface ' + (si + 1)}: outline had fewer than 3 points, skipped.`); return; }
        const n = Geo.normaliseOutline(pts);
        const surf = Store.newSurface(kind, { name: String(s.name || (kind === 'wall' ? `Wall ${si + 1}` : 'Floor')), outline: n.pts, tileId });
        if (kind === 'floor') surf.place = { x: -n.dx, y: -n.dy };
        surf.openings = (s.openings || []).map((o, oi) => {
          const type = TYPES.includes(o.type) ? o.type : 'other';
          return { id: Store.uid(), type, name: String(o.name || o.type || `Opening ${oi + 1}`),
            x: Math.round(+o.x + n.dx), y: Math.round(+o.y + n.dy), w: Math.round(+o.w), h: Math.round(+o.h),
            tiled: type === 'unit' ? o.tiled_under !== false : o.tiled_under === true && !['door', 'window', 'bath', 'tray'].includes(type) };
        }).filter(o => o.w > 0 && o.h > 0);
        surf.doorways = (kind === 'floor' ? (s.doorways || []) : []).map((d, di) => {
          const p1 = [+d.x1 + n.dx, +d.y1 + n.dy], p2 = [+d.x2 + n.dx, +d.y2 + n.dy];
          if (![...p1, ...p2].every(isFinite)) return null;
          const m = Geo.pointToDoorway(n.pts, p1, p2); if (!m || m.w < 100) return null;
          if (m.dd > 300) warnings.push(`${s.name || 'Floor'}: "${d.name || 'doorway'}" is not on the outline, placed on the nearest wall.`);
          return { id: Store.uid(), name: String(d.name || `Doorway ${di + 1}`), edge: m.edge, pos: m.pos, w: m.w };
        }).filter(Boolean);
        room.surfaces.push(surf);
      });
      return room;
    }).filter(r => r.surfaces.length);
    // walls of a room go into one unfolded view with level courses
    const groups = [];
    rooms.forEach(r => { const walls = r.surfaces.filter(s => s.kind === 'wall'); if (walls.length > 1) groups.push(Store.newGroup(`${r.name} — walls`, 'strip', walls.map(w => w.id), tileId, walls[0].pattern)); });
    return { rooms, groups, notes: data.notes || '', warnings };
  }

  async function readWithApi(dataUrl, settings, extra = '') {
    if (!navigator.onLine) throw new Error('No signal — use the paste-in option or trace the drawing.');
    if (!settings.apiKey) throw new Error('Add your Anthropic API key in Settings first.');
    const m = /^data:(image\/(png|jpeg|webp|gif));base64,(.*)$/.exec(dataUrl);
    if (!m) throw new Error('Drawing must be an image.');
    const body = {
      model: settings.model || 'claude-sonnet-5-5', max_tokens: 8000,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: m[1], data: m[3] } },
        { type: 'text', text: PROMPT + (extra ? `\n\nExtra information from the user: ${extra}` : '') },
      ] }],
    };
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || `API error ${r.status}`);
    const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    return extractJSON(text);
  }

  window.AI = { PROMPT, extractJSON, toRooms, readWithApi };
})();
