/* Drawing reading: shared prompt, JSON import, optional online API call */
(function () {
  'use strict';
  const PROMPT = `You are reading a construction drawing (floor plan, elevation or sketch) for a tiling set-out app.
Extract every floor area and every wall elevation that is shown and dimensioned, and return ONLY a JSON object in this exact format (no other text):

{
  "rooms": [
    {
      "name": "Bathroom",
      "surfaces": [
        {
          "name": "Wall A - window wall",
          "kind": "wall",
          "outline": [[0,0],[2400,0],[2400,2400],[0,2400]],
          "openings": [
            {"type": "window", "name": "Window", "x": 800, "y": 1000, "w": 900, "h": 1000}
          ]
        },
        {
          "name": "Floor",
          "kind": "floor",
          "outline": [[0,0],[2400,0],[2400,1800],[0,1800]],
          "openings": [
            {"type": "bath", "name": "Bath", "x": 0, "y": 0, "w": 1700, "h": 700}
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
- Walls: draw the elevation as if standing facing the wall. Origin [0,0] is the bottom-left corner at finished floor level; x runs to the right, y runs up. Sloped ceilings or boxing become extra outline points.
- Floors: plan view as drawn, origin at the bottom-left of the room's bounding box, x to the right, y up the page. Any shape is allowed: list the corners in order going anticlockwise.
- "outline" is the area to be tiled. "openings" are rectangles NOT tiled (doors, windows, niches, baths, shower trays, kitchen units, fixed furniture), each given by its bottom-left corner x,y and its width w and height h in the same coordinates as its surface.
- Opening "type" must be one of: door, window, niche, bath, tray, other.
- Use the written dimensions on the drawing first. Only scale from the drawing if a dimension is missing, and say so in notes.
- Do not invent surfaces or openings that are not on the drawing. If something is unclear, make your best reading and list it in notes.`;

  const TYPES = ['door', 'window', 'niche', 'bath', 'tray', 'other'];

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
        surf.openings = (s.openings || []).map((o, oi) => ({
          id: Store.uid(), type: TYPES.includes(o.type) ? o.type : 'other', name: String(o.name || o.type || `Opening ${oi + 1}`),
          x: Math.round(+o.x + n.dx), y: Math.round(+o.y + n.dy), w: Math.round(+o.w), h: Math.round(+o.h),
        })).filter(o => o.w > 0 && o.h > 0);
        room.surfaces.push(surf);
      });
      return room;
    }).filter(r => r.surfaces.length);
    return { rooms, notes: data.notes || '', warnings };
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
