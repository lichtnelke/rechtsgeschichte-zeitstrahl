'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const initialTemplate = window.TIMELINE_EXPORT_ASSETS?.template || '<!doctype html>\n' + document.documentElement.outerHTML;
  const base = window.TIMELINE_DATA;
  const online = window.TIMELINE_SERVER === true && !window.TIMELINE_EXPORT_ASSETS;
  const apiBase = window.TIMELINE_CONFIG?.apiUrl?.replace(/\/$/, '') || '';
  const imageBase = apiBase ? new URL(apiBase).origin + '/storage/v1/object/public/timeline-images/' : '';
  let editToken = '';
  const hostedImage = image => !!imageBase && image.startsWith(imageBase) && /^[a-f0-9]{64}\.(?:png|jpg|webp|gif)$/.test(image.slice(imageBase.length));
  let revision = 0, localDraft = null, saving = false, syncing = false, onlineReady = false;
  const state = { events: [], mode: 'horizontal', editing: false, selected: null, revealed: null, center: 1350, span: 700, min: 500, max: 1750, draft: null, image: '', relatedDraft: [], manualDraft: {}, restoring: false };
  let db, frame, statusTimer, searchTimer, drag, rendering = false, pendingPulse = null;
  let verticalAnchors = [], verticalNavFrame, verticalDrag = null;
  const measure = document.createElement('canvas').getContext('2d');
  const ns = 'http://www.w3.org/2000/svg';
  const element = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
  const year = value => value < 0 ? Math.abs(Math.round(value)) + ' v. Chr.' : String(Math.round(value));
  const dates = event => event.dateLabel || (event.type === 'period' ? year(event.start) + '–' + year(event.end) : year(event.start));
  const fullTrack = track => track === 'PRG' ? 'Privatrechtsgeschichte' : 'Verfassungsgeschichte';
  const trackColor = track => track === 'PRG' ? '#e65640' : '#005c99';
  const trackTint = track => track === 'PRG' ? '#e656400b' : '#005c9908';
  const normalizeSource = source => {
    const text = source.trim();
    if (/^(?:Lernstoff|Manual)\b/i.test(text) && /\bRz\s/.test(text)) return text.slice(text.indexOf('Rz'));
    return /^\d[\d\s,;.–—\-f]*$/.test(text) ? 'Rz ' + text : text;
  };
  const displayTitle = title => title
    .replace(/Reichskammergerichtsordnung/g, 'Reichs\u00adkammer\u00adgerichts\u00adordnung')
    .replace(/Stadtrechtsreformation/g, 'Stadtrechts\u00adreformation')
    .replace(/Erbfolgeordnung/g, 'Erbfolge\u00adordnung');
  const notify = message => { $('status').textContent = message; $('status').hidden = false; clearTimeout(statusTimer); statusTimer = setTimeout(() => { $('status').hidden = true; }, 6500); };
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(renderHorizontal); };
  const escapeScript = text => text.replace(/<\/script/gi, '<\\/script');
  const safeImage = image => !image || /^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=\r\n]+$/.test(image) || (online && hostedImage(image));

  function validate(raw) {
    if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.events) || raw.events.length > 3000) throw Error('Die Datei enthält keine gültigen Zeitstrahldaten.');
    const ids = new Set();
    return raw.events.map(item => {
      if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 100 || ids.has(item.id)) throw Error('Die Ereigniskennungen sind ungültig oder doppelt vorhanden.');
      ids.add(item.id);
      if (!['PRG', 'VfG'].includes(item.track) || !['point', 'period'].includes(item.type)) throw Error('Bereich oder Darstellung eines Ereignisses ist ungültig.');
      if (!Number.isInteger(item.start) || item.start < -3000 || item.start > 3000 || (item.type === 'period' && (!Number.isInteger(item.end) || item.end <= item.start || item.end > 3000))) throw Error('Ein Ereignis enthält ungültige Jahreszahlen.');
      if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 180) throw Error('Ein Ereignisname fehlt oder ist zu lang.');
      const result = { id: item.id, track: item.track, type: item.type, start: item.start, title: item.title.trim() };
      const defaultEvent = base.events.find(event => event.id === item.id);
      const defaultPriority = defaultEvent?.priority || 2;
      if (item.priority !== undefined && ![1,2,3].includes(item.priority)) throw Error('Die Relevanz eines Ereignisses ist ungültig.');
      result.priority = item.priority ?? defaultPriority;
      if (item.type === 'period') result.end = item.end;
      for (const [key, max] of Object.entries({ body: 12000, dateLabel: 80, source: 500, image: 16000000, imageAlt: 500, caption: 1000, imageSource: 2048, imageRights: 500, imageNotes: 4000 })) {
        if (item[key] !== undefined && (typeof item[key] !== 'string' || item[key].length > max)) throw Error('Ein Text- oder Bildfeld ist ungültig.');
        result[key] = item[key] || '';
      }
      // Add researched illustrations to older local records; retain custom images and saved removals.
      if (item.imageRevision === undefined && !result.image && defaultEvent?.image) {
        for (const key of ['image','imageAlt','caption','imageSource','imageRights','imageNotes']) result[key] = defaultEvent[key] || '';
      }
      const oldCaption = base.imageCaptionBaseline?.[item.id];
      if (oldCaption && result.image === defaultEvent?.image && result.caption === oldCaption) {
        result.caption = defaultEvent.caption;
        result.imageNotes ||= oldCaption;
      }
      result.imageRevision = 1;
      result.imageSource = result.imageSource.trim();
      if (result.imageSource) {
        try {
          const url = new URL(result.imageSource);
          if (url.protocol !== 'https:' || url.username || url.password) throw Error();
        } catch { throw Error('Für die Bildquelle eine vollständige HTTPS-Adresse eingeben.'); }
      }
      result.source = normalizeSource(result.source);
      const baseline = base.relationBaseline?.[item.id];
      const oldRelations = Array.isArray(item.related) ? item.related : [];
      const sameRelations = baseline && oldRelations.length === baseline.related.length && oldRelations.every(id => baseline.related.includes(id));
      const upgradeRelations = item.relationRevision !== 1 && baseline && sameRelations;
      if (item.relationRevision !== 1 && baseline && result.source === baseline.source) result.source = defaultEvent.source;
      const lectureCast = item.lectureCast === undefined ? (defaultEvent?.lectureCast || '') : item.lectureCast;
      if (typeof lectureCast !== 'string' || lectureCast.length > 2048) throw Error('Der Lecture-Cast-Link ist ungültig.');
      result.lectureCast = lectureCast.trim();
      if (result.lectureCast) {
        try {
          const url = new URL(result.lectureCast);
          if (url.protocol !== 'https:' || url.username || url.password) throw Error();
        } catch { throw Error('Für den Lecture Cast eine vollständige HTTPS-Adresse eingeben.'); }
      }
      if (!safeImage(result.image)) throw Error('Das Bildformat wird nicht unterstützt.');
      if (result.image) {
        const dimensions = item.imageWidth && item.imageHeight ? item : result.image === defaultEvent?.image ? defaultEvent : null;
        if (dimensions?.imageWidth && dimensions?.imageHeight) {
          if (![dimensions.imageWidth,dimensions.imageHeight].every(value => Number.isInteger(value) && value > 0 && value <= 50000)) throw Error('Die Bildabmessungen sind ungültig.');
          result.imageWidth = dimensions.imageWidth; result.imageHeight = dimensions.imageHeight;
        }
      }
      const related = upgradeRelations ? defaultEvent.related : item.related;
      result.related = [...new Set(Array.isArray(related) ? related.filter(id => typeof id === 'string' && id !== item.id) : [])].slice(0, 100);
      const references = upgradeRelations ? defaultEvent.manualRelated : item.manualRelated;
      result.manualRelated = {};
      for (const id of result.related) {
        if (references && Object.hasOwn(references, id)) {
          if (typeof references[id] !== 'string' || references[id].length > 200) throw Error('Eine Fundstelle der Verknüpfungen ist ungültig.');
          result.manualRelated[id] = references[id].trim();
        }
      }
      result.relationRevision = 1;
      return result;
    });
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('rechtsgeschichte-' + (base.storageKey || 'v1'), 1);
      request.onupgradeneeded = () => request.result.createObjectStore('document');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function api(path, options = {}) {
    let response;
    if (!apiBase) throw Error('Die Supabase-Verbindung ist noch nicht eingerichtet.');
    try { response = await fetch(apiBase + '/' + path, { credentials:'omit', cache:'no-store', ...options, headers:{ 'Content-Type':'application/json', ...(editToken ? { Authorization:'Bearer ' + editToken } : {}), ...options.headers } }); }
    catch { throw Error('Keine Verbindung zur gemeinsamen Speicherung. Bitte erneut versuchen.'); }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(result.error || 'Die Anfrage konnte nicht ausgeführt werden.');
    if (path === 'login') editToken = result.token;
    if (path === 'logout') editToken = '';
    return result;
  }
  async function syncDocument() {
    if (!online || state.editing || syncing || document.hidden) return;
    syncing = true;
    try {
      const result = await api('document' + (onlineReady ? '?revision=' + revision : ''));
      if (state.editing) return;
      if (!result.unchanged) { state.events = validate(result.document || base); revision = result.revision; refresh(); }
      onlineReady = true;
    } catch { /* Keep the loaded timeline visible during a temporary outage. */ }
    finally { syncing = false; }
  }
  async function persist(nextEvents = state.events) {
    if (saving) throw Error('Ein Speichervorgang läuft bereits.');
    saving = true;
    try {
      if (online) {
        if (!state.editing || !onlineReady) throw Error('Bitte den Bearbeitungsmodus erneut freischalten.');
        const result = await api('document', { method:'PUT', body:JSON.stringify({ revision, document:{ schemaVersion:1, events:nextEvents } }) });
        state.events = validate(result.document); revision = result.revision;
        return;
      }
      if (!db) throw Error('Lokale Speicherung ist nicht verfügbar. Daten über „Datei“ exportieren.');
      await new Promise((resolve, reject) => {
        const transaction = db.transaction('document', 'readwrite');
        transaction.objectStore('document').put({ schemaVersion: 1, events: nextEvents }, 'events');
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      state.events = nextEvents;
    } finally { saving = false; }
  }
  function updateBounds() {
    if (!state.events.length) { state.min = 1000; state.max = 1800; return; }
    const earliest = Math.min(...state.events.map(event => event.start));
    const latest = Math.max(...state.events.map(event => event.end || event.start));
    const pad = Math.max(15, (latest - earliest) * .035);
    state.min = Math.floor(earliest - pad); state.max = Math.ceil(latest + pad);
  }
  function constrain() {
    const full = state.max - state.min;
    state.span = Math.min(full, Math.max(Math.min(12, full), state.span));
    state.center = Math.max(state.min + state.span / 2, Math.min(state.max - state.span / 2, state.center));
  }
  function fit() {
    state.revealed = null;
    updateBounds(); state.span = state.max - state.min; state.center = (state.min + state.max) / 2;
    schedule();
    if (state.mode === 'vertical') $('vertical').scrollTo({ top: 0 });
  }
  function pan(fraction) { state.center += state.span * fraction; constrain(); schedule(); }
  function zoom(factor, anchor) {
    if (anchor === undefined) {
      const selected = state.events.find(event => event.id === state.selected);
      anchor = selected ? Math.max(0,Math.min(1,(selected.start - state.center) / state.span + .5)) : .5;
    }
    const anchorYear = state.center + (anchor - .5) * state.span;
    state.span *= factor; constrain();
    state.center = anchorYear - (anchor - .5) * state.span; constrain(); schedule();
  }
  function svg(tag, attrs, text) {
    const el = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function tickStep(span, width) {
    const desired = span / Math.max(2, width / 155);
    return [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find(value => value >= desired) || 2000;
  }
  function nearestGap(intervals, width, preferred, total) {
    const sorted = intervals.slice().sort((a,b) => a[0] - b[0]);
    let left = 12, best = null;
    for (const [a,b] of [...sorted, [total - 12, total]]) {
      if (a - left >= width) {
        const x = Math.max(left, Math.min(a - width, preferred));
        if (!best || Math.abs(x - preferred) < best.distance) best = { x, distance: Math.abs(x - preferred) };
      }
      left = Math.max(left, b + 12);
    }
    return best;
  }
  function labelMetrics(event, width, withImage) {
    measure.font = '600 20px Inter';
    const words = displayTitle(event.title).split(/\s+/);
    const longest = Math.max(...words.flatMap(word => word.split('\u00ad')).map(word => measure.measureText(word).width));
    const maxWidth = Math.min(width - 28, Math.max(230, Math.min(340, width * .3), longest + 12));
    const labelWidth = Math.ceil(Math.min(maxWidth, Math.max(140, measure.measureText(event.title).width + 16, withImage ? 220 : 0)));
    let lineWidth = 0, lines = 1;
    for (const word of words) {
      const wordWidth = measure.measureText(word.replaceAll('\u00ad','')).width;
      if (lineWidth && lineWidth + wordWidth + 7 > labelWidth - 8) { lines++; lineWidth = 0; }
      if (wordWidth > labelWidth - 8) {
        for (const segment of word.split('\u00ad')) {
          const segmentWidth = measure.measureText(segment + '–').width;
          if (lineWidth && lineWidth + segmentWidth > labelWidth - 8) { lines++; lineWidth = 0; }
          lineWidth += segmentWidth;
        }
      } else lineWidth += wordWidth + 7;
    }
    return { width:labelWidth, height:32 + lines * 25 + (withImage ? 114 : 0) };
  }
  function layoutTrack(events, xFor, width, rowCount, imageMode, pixelsPerYear) {
    const rows = Array.from({ length:rowCount }, () => []), placements = [];
    const candidates = events.filter(event => event.id === state.revealed || event.priority === 3 || pixelsPerYear >= (event.priority === 2 ? 1.8 : 4));
    candidates.sort((a,b) => Number(b.id === state.revealed) - Number(a.id === state.revealed) || b.priority - a.priority || a.start - b.start || a.id.localeCompare(b.id));
    for (const event of candidates) {
      const x = xFor(event.start), end = xFor(event.end || event.start);
      const withImage = Boolean(imageMode && event.image);
      const metrics = labelMetrics(event, width, withImage);
      const preferred = Math.max(14, Math.min(width - metrics.width - 14, x - metrics.width / 2));
      let choice;
      for (let row = 0; row < rows.length; row++) {
        const gap = nearestGap(rows[row], metrics.width, preferred, width);
        if (!gap || gap.distance > 85) continue;
        const reserved = [Math.min(gap.x, Math.max(14,x) - 5), Math.max(gap.x + metrics.width, Math.min(width - 14,end) + 5)];
        if (rows[row].some(([a,b]) => reserved[0] < b + 14 && reserved[1] > a - 14)) continue;
        if (!choice || gap.distance + row * 24 < choice.distance + choice.row * 24) choice = { ...gap, row, reserved };
      }
      if (!choice) continue;
      rows[choice.row].push(choice.reserved);
      placements.push({ event, x, end, left:choice.x, width:metrics.width, height:metrics.height, row:choice.row, withImage });
    }
    return placements;
  }
  function renderHorizontal() {
    if (state.mode !== 'horizontal' || rendering) return;
    rendering = true;
    try {
      constrain();
      $('horizontal').style.setProperty('--navigation-height', $('overview').parentElement.offsetHeight + 'px');
      const plot = $('plot'), width = plot.clientWidth;
      if (!width) return;
      const from = state.center - state.span / 2, to = from + state.span;
      const padding = 32, usable = Math.max(1, width - padding * 2);
      const xFor = value => padding + (value - from) / state.span * usable;
      const visible = state.events.filter(event => event.start <= to && (event.end || event.start) >= from);
      plot.style.minHeight = '460px'; $('horizontal').style.minHeight = '582px';
      const height = plot.clientHeight, middle = height / 2;
      $('detail').style.height = height + 'px';
      const pixelsPerYear = usable / state.span;
      const imageMode = state.span <= 100 && pixelsPerYear >= 8 && middle >= 270 && visible.some(event => event.image);
      const rowCount = imageMode || middle < 280 ? 1 : 2;
      const prg = layoutTrack(visible.filter(event => event.track === 'PRG'), xFor, width, rowCount, imageMode, pixelsPerYear);
      const vfg = layoutTrack(visible.filter(event => event.track === 'VfG'), xFor, width, rowCount, imageMode, pixelsPerYear);
      plot.dataset.rows = rowCount; plot.dataset.images = String(imageMode);
      const axis = $('axis'); axis.replaceChildren(); axis.setAttribute('viewBox', `0 0 ${width} ${height}`);
      const grid = svg('g', {}); axis.append(grid);
      grid.append(svg('rect', { x:0, y:0, width, height:middle - 26, fill:trackTint('PRG') }));
      grid.append(svg('rect', { x:0, y:middle + 26, width, height:middle - 26, fill:trackTint('VfG') }));
      grid.append(svg('line', { x1: 0, x2: width, y1: middle, y2: middle, stroke: '#9aa6af', 'stroke-width': 1 }));
      const step = tickStep(state.span, usable);
      for (let value = Math.ceil(from / step) * step; value <= to; value += step) {
        const x = xFor(value);
        grid.append(svg('rect', { x: x - 38, y: middle - 21, width: 76, height: 42, fill: 'white' }));
        grid.append(svg('text', { x, y: middle + 5, 'text-anchor': 'middle', fill: '#354d60', 'font-size': 15, 'font-family': 'Inter, sans-serif' }, year(value)));
      }
      const defs = svg('defs',{});
      const clearance = svg('mask',{ id:'event-clearance',maskUnits:'userSpaceOnUse',x:0,y:0,width,height });
      clearance.append(svg('rect',{ x:0,y:0,width,height,fill:'white' }));
      defs.append(clearance); axis.append(defs);
      const connections = svg('g',{ class:'event-connections',mask:'url(#event-clearance)' }); axis.append(connections);
      const layer = $('events'), existing = new Map([...layer.children].map(button => [button.dataset.event,button]));
      const plotBounds = plot.getBoundingClientRect();
      const retained = new Set();
      for (const [track, direction] of [[prg, -1], [vfg, 1]]) {
        for (const placement of track) {
          const { event, x, end, left, width: labelWidth, row, height:labelHeight, withImage } = placement;
          const level = middle + direction * (38 + row * 116);
          const pointX = Math.max(padding, Math.min(width - padding, x));
          const selected = event.id === state.selected;
          const color = trackColor(event.track);
          let button = existing.get(event.id);
          if (!button) { button = element('button'); button.dataset.event = event.id; layer.append(button); }
          retained.add(event.id);
          button.className = 'timeline-event' + (selected ? ' selected' : '') + (withImage ? ' with-image' : '');
          button.dataset.track = event.track; button.dataset.row = row; button.dataset.priority = event.priority;
          button.setAttribute('aria-pressed', String(selected));
          const contentKey = JSON.stringify([event.title,dates(event),withImage ? event.image : '',event.imageAlt]);
          if (button.dataset.content !== contentKey) {
            button.replaceChildren();
            if (withImage) { const img = element('img','timeline-image'); img.src = event.image; img.alt = event.imageAlt || ''; button.append(img); }
            button.append(element('span','timeline-date',dates(event)),element('span','timeline-title',displayTitle(event.title)));
            button.dataset.content = contentKey;
          }
          button.setAttribute('aria-label', `${event.title}, ${dates(event)}, ${fullTrack(event.track)}`);
          button.title = `${dates(event)} · ${event.title}`;
          button.style.left = left + 'px'; button.style.width = labelWidth + 'px';
          button.style.top = (direction === -1 ? level - labelHeight - 14 : level + 14) + 'px';
          button.getAnimations().forEach(animation => animation.cancel());
          const contentRects = [];
          for (const node of button.querySelectorAll('.timeline-date,.timeline-title,.timeline-image')) {
            const range = document.createRange(); range.selectNodeContents(node);
            const rects = node.tagName === 'IMG' ? [node.getBoundingClientRect()] : [...range.getClientRects()];
            for (const rect of rects) {
              if (!rect.width || !rect.height) continue;
              const box = { left:rect.left - plotBounds.left, right:rect.right - plotBounds.left, top:rect.top - plotBounds.top, bottom:rect.bottom - plotBounds.top };
              contentRects.push(box);
              clearance.append(svg('rect',{ x:box.left - 6,y:box.top - 6,width:rect.width + 12,height:rect.height + 12,fill:'black','data-label':event.id }));
            }
          }
          const nearest = contentRects.reduce((best,box) => !best || (direction === -1 ? box.bottom > best.bottom : box.top < best.top) ? box : best,null);
          const gap = event.type === 'period' ? 12 : 8;
          const endY = nearest ? (direction === -1 ? nearest.bottom + gap : nearest.top - gap) : level;
          const edge = nearest ? Math.max(nearest.left + 2,Math.min(nearest.right - 2,pointX)) : pointX;
          const markerY = middle + direction * 24;
          connections.append(svg('path', { d:`M ${pointX} ${markerY} V ${endY - direction * 6} Q ${pointX} ${endY} ${edge} ${endY}`, fill:'none', stroke:color, 'stroke-opacity':selected ? 1 : .5, 'stroke-width':selected ? 2 : 1.5 }));
          if (event.type === 'period') {
            const endX = Math.max(padding, Math.min(width - padding, end));
            const box = svg('rect', { x: Math.min(pointX,endX), y: endY - 4, width: Math.max(5, Math.abs(endX - pointX)), height: 8, fill: color + (selected ? '66' : '26'), stroke:color, 'stroke-width':1.5 });
            box.style.cursor = 'pointer'; box.addEventListener('click', () => selectEvent(event.id,true)); connections.append(box);
          } else {
            if (selected) connections.append(svg('circle', { cx:pointX,cy:markerY,r:11,fill:color+'18' }));
            connections.append(svg('circle', { cx:pointX,cy:markerY,r:selected ? 5 : 4,fill:selected ? color : 'white',stroke:color,'stroke-width':2 }));
          }
          button.onclick = () => selectEvent(event.id,true);
          if (pendingPulse === event.id) {
            if (!matchMedia('(prefers-reduced-motion: reduce)').matches) button.animate([{ transform:'translateY(0) scale(.98)' },{ transform:'translateY(-3px) scale(1.025)',offset:.55 },{ transform:'none' }],{ duration:260,easing:'ease-out' });
            pendingPulse = null;
          }
        }
      }
      for (const [id,button] of existing) if (!retained.has(id)) button.remove();
      $('date-range').value = `${year(from)} – ${year(to)}`;
      $('zoom-level').value = Math.round((state.max - state.min) / state.span * 100) + ' %';
      $('previous').disabled = from <= state.min + .01; $('next').disabled = to >= state.max - .01;
      $('zoom-out').disabled = state.span >= state.max - state.min - .01;
      $('zoom-in').disabled = state.span <= 12;
      renderOverview(from, to);
    } finally { rendering = false; }
  }
  function renderOverview(from, to) {
    const width = $('overview').clientWidth, total = state.max - state.min;
    const overview = $('overview-svg'); overview.setAttribute('viewBox', `0 0 ${width} 20`); overview.replaceChildren();
    overview.append(svg('line', { x1: 0, x2: width, y1: 10, y2: 10, stroke: '#cdd3d7' }));
    $('overview-window').style.left = (from - state.min) / total * 100 + '%';
    $('overview-window').style.width = state.span / total * 100 + '%';
    $('overview').setAttribute('aria-valuenow', String(Math.round((state.center - state.min) / total * 100)));
    $('overview').setAttribute('aria-valuetext', `${year(from)} bis ${year(to)}`);
    $('first-year').textContent = year(state.min); $('last-year').textContent = year(state.max);
  }

  function appendContent(parent, event, withHeading = true) {
    parent.append(element('span', 'event-date', dates(event)));
    if (withHeading) parent.append(element(parent.classList.contains('vertical-card') ? 'h3' : 'h2', '', displayTitle(event.title)));
    if (event.body) parent.append(element('p', 'event-text', event.body));
    if (event.lectureCast) {
      const paragraph = element('p', 'event-lecture'), link = element('a', '', 'Hier geht es zum Lecture Cast!');
      link.href = event.lectureCast; link.target = '_blank'; link.rel = 'noopener noreferrer';
      paragraph.append(link); parent.append(paragraph);
    }
    if (event.image) {
      const figure = element('figure', 'event-figure'), img = element('img');
      if (event.imageWidth && event.imageHeight) { img.width = event.imageWidth; img.height = event.imageHeight; }
      img.src = event.image; img.alt = event.imageAlt || ''; img.loading = 'lazy';
      img.addEventListener('load', () => { if (state.mode === 'vertical') positionPeriods(); });
      figure.append(img);
      if (event.caption || event.imageSource) {
        const caption = element('figcaption', '', event.caption || '');
        if (event.imageSource) {
          const source = element('a', 'image-source'), arrow = element('span', 'source-arrow', '↗');
          arrow.setAttribute('aria-hidden', 'true'); source.append(arrow);
          source.href = event.imageSource; source.target = '_blank'; source.rel = 'noopener noreferrer';
          source.setAttribute('aria-label', 'Bildquelle öffnen');
          if (event.caption) caption.append(document.createTextNode(' '));
          caption.append(source);
        }
        figure.append(caption);
      }
      parent.append(figure);
    }
    if (event.source) parent.append(element('p', 'event-source', event.source));
    if (state.editing) {
      const edit = element('button', 'text-button card-edit', 'Bearbeiten');
      edit.addEventListener('click', () => openEditor(event.id)); parent.append(edit);
    }
    const relatedEvents = (event.related || []).map(id => state.events.find(other => other.id === id)).filter(Boolean);
    if (relatedEvents.length) {
      const related = element('div', 'related'); related.setAttribute('aria-label', 'Verknüpfte Ereignisse');
      for (const other of relatedEvents) {
        const link = element('button', '', `${dates(other)} · ${displayTitle(other.title)} →`);
        link.dataset.track = other.track; link.dataset.target = other.id;
        link.addEventListener('click', () => focusEvent(other.id)); related.append(link);
      }
      parent.append(related);
    }
  }
  function selectEvent(id, animate = false) {
    const event = state.events.find(item => item.id === id); if (!event) return;
    state.selected = id;
    if (animate) pendingPulse = id;
    if (state.mode === 'vertical') { scrollToEvent(id); return; }
    const detail = $('detail'); detail.replaceChildren(); detail.hidden = false; detail.dataset.track = event.track;
    const close = element('button', 'icon-button detail-close', '×'); close.setAttribute('aria-label', 'Details schließen');
    close.addEventListener('click', closeDetail); detail.append(close);
    appendContent(detail, event); detail.scrollTop = 0; schedule();
  }
  function closeDetail() {
    const previous = state.selected; state.selected = null; $('detail').hidden = true; schedule();
    requestAnimationFrame(() => document.querySelector(`[data-event="${CSS.escape(previous || '')}"]`)?.focus({ preventScroll: true }));
  }
  function focusEvent(id) {
    const event = state.events.find(item => item.id === id); if (!event) return;
    $('search-results').hidden = true; $('search').value = '';
    if (state.mode === 'vertical') { scrollToEvent(id); return; }
    if (!document.querySelector(`[data-event="${CSS.escape(id)}"]`)) state.revealed = id;
    if (event.start < state.center - state.span / 2 || event.start > state.center + state.span / 2) state.center = event.start;
    constrain(); selectEvent(id);
  }
  function scrollToEvent(id) {
    const target = document.getElementById('card-' + id); if (!target) return;
    const container = $('vertical'), y = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 84;
    container.scrollTo({ top: Math.max(0, y), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    target.tabIndex = -1; target.focus({ preventScroll: true });
  }
  function renderVertical() {
    const content = $('vertical-content'); content.replaceChildren();
    content.append(element('div', 'vertical-line'));
    if (!state.events.length) { verticalAnchors = []; renderVerticalNavigation(); return; }
    const years = new Set(state.events.flatMap(event => event.end ? [event.start, event.end] : [event.start]));
    const min = Math.min(...years), max = Math.max(...years);
    const step = tickStep(max - min, 1200);
    for (let value = Math.ceil(min / step) * step; value < max; value += step) years.add(value);
    const sortedYears = [...years].sort((a,b) => a-b);
    for (const [index, value] of sortedYears.entries()) {
      const row = element('div', 'vertical-row'); row.dataset.year = value;
      if (index < sortedYears.length - 1) row.style.minHeight = Math.max(92, Math.min(240, (sortedYears[index + 1] - value) * 2)) + 'px';
      const left = element('div', 'vertical-side'), right = element('div', 'vertical-side');
      const label = element('div', 'vertical-year'); label.append(element('span', '', year(value)));
      for (const event of state.events.filter(item => item.start === value).sort((a,b) => a.title.localeCompare(b.title, 'de'))) {
        const card = element('article', 'vertical-card'); card.id = 'card-' + event.id; card.dataset.track = event.track;
        appendContent(card, event); (event.track === 'PRG' ? left : right).append(card);
      }
      row.append(left, label, right); content.append(row);
    }
    requestAnimationFrame(positionPeriods);
  }
  function positionPeriods() {
    if (state.mode !== 'vertical') return;
    const content = $('vertical-content'); content.querySelectorAll('.vertical-period').forEach(bar => bar.remove());
    const rows = new Map([...content.querySelectorAll('[data-year]')].map(row => [Number(row.dataset.year), row.offsetTop + 15]));
    const used = { PRG: [], VfG: [] };
    for (const event of state.events.filter(item => item.type === 'period').sort((a,b) => a.start - b.start)) {
      let lane = used[event.track].findIndex(end => end <= event.start);
      if (lane === -1) lane = used[event.track].length;
      used[event.track][lane] = event.end;
      const bar = element('button', 'vertical-period'); bar.title = `${dates(event)} · ${event.title}`; bar.style.borderColor = trackColor(event.track); bar.style.background = trackColor(event.track) + '18';
      bar.setAttribute('aria-label', bar.title); bar.style.top = rows.get(event.start) + 'px';
      bar.style.height = Math.max(8, rows.get(event.end) - rows.get(event.start)) + 'px';
      const distance = 13 + lane * 9;
      bar.style.left = `calc(50% ${event.track === 'PRG' ? '-' : '+'} ${distance + (event.track === 'PRG' ? 7 : 0)}px)`;
      bar.addEventListener('click', () => scrollToEvent(event.id)); content.append(bar);
    }
    verticalAnchors = [...content.querySelectorAll('[data-year]')].map(row => ({ year:Number(row.dataset.year), top:content.offsetTop + row.offsetTop + 15 }));
    renderVerticalNavigation();
  }
  function verticalYearAt(top) {
    if (!verticalAnchors.length) return 0;
    const after = verticalAnchors.findIndex(anchor => anchor.top > top);
    if (after === 0) return verticalAnchors[0].year;
    if (after < 0) return verticalAnchors.at(-1).year;
    const a = verticalAnchors[after - 1], b = verticalAnchors[after];
    return a.year + (b.year - a.year) * (top - a.top) / Math.max(1, b.top - a.top);
  }
  function visibleVerticalYears() {
    const container = $('vertical'), heading = container.querySelector('.vertical-headings').offsetHeight;
    return { from:verticalYearAt(container.scrollTop + heading), to:verticalYearAt(container.scrollTop + container.clientHeight) };
  }
  function updateVerticalNavigation() {
    if (state.mode !== 'vertical' || !verticalAnchors.length) return;
    const rail = $('vertical-overview'), thumb = $('vertical-overview-window'), height = rail.clientHeight;
    const container = $('vertical'), travel = container.scrollHeight - container.clientHeight;
    const { from, to } = visibleVerticalYears();
    const size = 2;
    const position = travel > 0 ? container.scrollTop / travel : 0;
    thumb.style.top = Math.max(0, Math.min(height - size, position * (height - size))) + 'px';
    thumb.style.height = size + 'px'; thumb.hidden = false;
    rail.setAttribute('aria-valuenow', String(Math.round(position * 100)));
    rail.setAttribute('aria-valuetext', `${year(from)} bis ${year(to)}`);
  }
  function scheduleVerticalNavigation() {
    cancelAnimationFrame(verticalNavFrame); verticalNavFrame = requestAnimationFrame(updateVerticalNavigation);
  }
  function renderVerticalNavigation() {
    if (state.mode !== 'vertical') return;
    const rail = $('vertical-overview');
    rail.setAttribute('aria-disabled', String(!verticalAnchors.length)); rail.tabIndex = verticalAnchors.length ? 0 : -1;
    if (!verticalAnchors.length) { $('vertical-overview-window').hidden = true; return; }
    updateVerticalNavigation();
  }
  function jumpToVerticalPosition(position) {
    if (!verticalAnchors.length) return;
    const container = $('vertical'), travel = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTo({ top:Math.max(0, Math.min(1, position)) * travel, behavior:'instant' });
    updateVerticalNavigation();
  }
  function setMode(mode) {
    if (mode === 'horizontal' && state.mode === 'vertical') {
      const cutoff = $('vertical').getBoundingClientRect().top + 110;
      const rows = [...$('vertical-content').querySelectorAll('[data-year]')];
      const row = rows.find(item => item.getBoundingClientRect().bottom > cutoff);
      if (row) { state.center = Number(row.dataset.year); constrain(); }
    }
    const priorSelected = state.selected; state.mode = mode;
    $('horizontal').hidden = mode !== 'horizontal'; $('vertical').hidden = mode !== 'vertical'; $('detail').hidden = true;
    $('vertical-navigation').hidden = mode !== 'vertical';
    $('horizontal-mode').setAttribute('aria-pressed', String(mode === 'horizontal'));
    $('vertical-mode').setAttribute('aria-pressed', String(mode === 'vertical'));
    if (mode === 'horizontal') { schedule(); if (priorSelected) selectEvent(priorSelected); }
    else {
      renderVertical();
      const nearest = state.events.slice().sort((a,b) => Math.abs(a.start - state.center) - Math.abs(b.start - state.center))[0];
      const target = priorSelected || nearest?.id;
      if (target) requestAnimationFrame(() => scrollToEvent(target));
    }
    updateWorkspaceHeight();
  }
  function updateWorkspaceHeight() {
    const offset = $('workspace').getBoundingClientRect().top;
    for (const id of ['horizontal', 'vertical']) $(id).style.height = `calc(100dvh - ${offset}px)`;
    $('detail').style.height = $('plot').clientHeight + 'px';
    if (state.mode === 'vertical') renderVerticalNavigation();
  }

  function refresh() {
    pruneRelations();
    updateBounds(); constrain();
    if (state.mode === 'vertical') { const scroll = $('vertical').scrollTop; renderVertical(); requestAnimationFrame(() => { $('vertical').scrollTop = scroll; }); }
    else { if (state.selected && state.events.some(event => event.id === state.selected)) selectEvent(state.selected); else { state.selected = null; $('detail').hidden = true; } schedule(); }
  }
  function setEditing(value) {
    state.editing = value;
    $('edit-mode').textContent = state.editing ? 'Fertig' : 'Bearbeiten'; $('edit-mode').setAttribute('aria-pressed', String(state.editing));
    $('author-actions').hidden = !state.editing; $('file-menu').hidden = true; $('files').setAttribute('aria-expanded', 'false');
    refresh(); updateWorkspaceHeight();
  }
  async function toggleEditing() {
    if (!online) { setEditing(!state.editing); return; }
    $('edit-mode').disabled = true;
    try {
      if (state.editing) { await api('logout', { method:'POST' }); setEditing(false); await syncDocument(); return; }
      // Reload the shared version before editing so a stale tab cannot overwrite newer work.
      const result = await api('document');
      state.events = validate(result.document || base); revision = result.revision; onlineReady = true; refresh();
      if ((await api('session')).authenticated) { setEditing(true); return; }
      $('login-form').reset(); $('login-error').hidden = true; $('login-dialog').showModal(); $('edit-password').focus();
    } catch (error) { notify(error.message); }
    finally { $('edit-mode').disabled = false; }
  }
  async function unlockEditing(event) {
    event.preventDefault(); $('login-submit').disabled = true; $('login-error').hidden = true;
    try {
      await api('login', { method:'POST', body:JSON.stringify({ password:$('edit-password').value }) });
      const result = await api('document'); state.events = validate(result.document || base); revision = result.revision; onlineReady = true;
      $('edit-password').value = ''; $('login-dialog').close(); setEditing(true);
    } catch (error) { $('login-error').textContent = error.message; $('login-error').hidden = false; }
    finally { $('login-submit').disabled = false; }
  }
  function openEditor(id) {
    if (!state.editing) return;
    const event = id ? state.events.find(item => item.id === id) : null;
    state.draft = event; state.image = event?.image || '';
    state.relatedDraft = [...(event?.related || [])]; state.manualDraft = { ...(event?.manualRelated || {}) };
    $('event-form').reset(); $('form-error').hidden = true; $('event-image').value = '';
    $('editor-title').textContent = event ? 'Ereignis bearbeiten' : 'Ereignis hinzufügen';
    for (const key of ['title','track','type','priority','start','end','body','dateLabel','source','lectureCast','imageAlt','caption','imageSource','imageRights','imageNotes']) {
      const field = $('event-form').elements.namedItem(key);
      field.value = event?.[key] ?? ({ track:'PRG', type:'point', priority:2, start:Math.round(state.center) }[key] ?? '');
    }
    $('delete-event').hidden = !event; updateType(); updateImagePreview(); renderRelatedEditor();
    $('editor').showModal(); $('event-title').focus();
  }
  function pruneRelations() {
    const ids = new Set(state.events.map(event => event.id));
    for (const event of state.events) {
      event.related = event.related.filter(id => ids.has(id) && id !== event.id);
      event.manualRelated = Object.fromEntries(Object.entries(event.manualRelated).filter(([id]) => event.related.includes(id)));
    }
  }
  function renderRelatedEditor() {
    const select = $('related-target'), list = $('related-list'); select.replaceChildren(); list.replaceChildren();
    select.append(element('option', '', 'Ereignis auswählen')); select.firstElementChild.value = '';
    for (const track of ['PRG','VfG']) {
      const group = element('optgroup'); group.label = fullTrack(track);
      for (const other of state.events.filter(item => item.track === track && item.id !== state.draft?.id && !state.relatedDraft.includes(item.id)).sort((a,b) => a.start - b.start || a.title.localeCompare(b.title, 'de'))) {
        const option = element('option', '', `${dates(other)} · ${other.title}`); option.value = other.id; group.append(option);
      }
      if (group.children.length) select.append(group);
    }
    $('add-related').disabled = true;
    for (const id of state.relatedDraft) {
      const other = state.events.find(item => item.id === id); if (!other) continue;
      const row = element('li', 'related-entry'); row.dataset.target = id;
      const top = element('div', 'related-entry-top'), name = element('span', 'related-target-name', `${dates(other)} · ${displayTitle(other.title)}`);
      name.dataset.track = other.track; top.append(name);
      const remove = element('button', 'text-button', 'Entfernen'); remove.type = 'button'; remove.setAttribute('aria-label', `Verknüpfung mit ${other.title} entfernen`);
      remove.onclick = () => { state.relatedDraft = state.relatedDraft.filter(item => item !== id); delete state.manualDraft[id]; renderRelatedEditor(); $('related-target').focus(); };
      top.append(remove); row.append(top);
      const kind = element('select'); kind.setAttribute('aria-label', `Art der Verknüpfung mit ${other.title}`);
      for (const [value,label] of [['context','Weiterer Zusammenhang'],['manual','Verweis im Manual']]) { const option = element('option','',label); option.value = value; kind.append(option); }
      kind.value = Object.hasOwn(state.manualDraft, id) ? 'manual' : 'context'; row.append(kind);
      const label = element('label', 'related-reference-field', 'Fundstelle (Rz)');
      const reference = element('input'); reference.type = 'text'; reference.maxLength = 200; reference.value = state.manualDraft[id] || '';
      reference.setAttribute('aria-label', `Fundstelle der Verknüpfung mit ${other.title}`); label.append(reference); label.hidden = kind.value !== 'manual'; row.append(label);
      kind.onchange = () => { label.hidden = kind.value !== 'manual'; if (kind.value === 'manual') state.manualDraft[id] = reference.value; else delete state.manualDraft[id]; };
      reference.oninput = () => { state.manualDraft[id] = reference.value; };
      list.append(row);
    }
  }
  function updateType() {
    const period = $('event-type').value === 'period'; $('end-field').hidden = !period; $('event-end').required = period;
    $('event-start').previousElementSibling.textContent = period ? 'Von' : 'Jahr';
  }
  function updateImagePreview() { $('image-preview').hidden = !state.image; $('preview-image').src = state.image || ''; }
  function clearImageMetadata() {
    for (const key of ['imageAlt','caption','imageSource','imageRights','imageNotes']) $('event-form').elements.namedItem(key).value = '';
  }
  async function saveEvent(event) {
    event.preventDefault();
    if (!state.editing || saving) return;
    const submit = $('event-form').querySelector('[type="submit"]'); submit.disabled = true;
    const fields = Object.fromEntries(new FormData($('event-form')));
    const candidate = { ...fields, priority:Number(fields.priority), start:Number(fields.start), end:fields.type === 'period' ? Number(fields.end) : undefined, id:state.draft?.id || ('e-' + crypto.randomUUID()), image:state.image, imageRevision:1, related:[...state.relatedDraft], manualRelated:{...state.manualDraft}, relationRevision:1 };
    try {
      if (candidate.image) {
        const image = new Image(); image.src = candidate.image; await image.decode();
        candidate.imageWidth = image.naturalWidth; candidate.imageHeight = image.naturalHeight;
      }
      const checked = validate({ schemaVersion:1, events:[candidate] })[0];
      const next = state.events.map(item => item.id === checked.id ? checked : item);
      if (!state.draft) next.push(checked);
      await persist(next);
      $('editor').close(); refresh();
      notify(online ? 'Online gespeichert.' : 'Lokal gespeichert.');
      focusEvent(checked.id);
    } catch (error) { $('form-error').textContent = error.message; $('form-error').hidden = false; }
    finally { submit.disabled = false; }
  }
  async function deleteEvent() {
    if (!state.draft || !state.editing || saving) return;
    $('delete-name').textContent = state.draft.title;
    const dialog = $('delete-dialog'); dialog.showModal();
    dialog.addEventListener('close', async () => {
      if (dialog.returnValue !== 'delete') return;
      try {
        const id = state.draft.id, next = structuredClone(state.events.filter(event => event.id !== id));
        for (const event of next) event.related = event.related.filter(related => related !== id);
        await persist(next);
        $('editor').close(); if (state.selected === id) state.selected = null;
        refresh(); notify('Ereignis gelöscht.');
      } catch (error) { $('form-error').textContent = error.message; $('form-error').hidden = false; }
    }, { once:true });
  }
  const documentData = () => ({ schemaVersion:1, title:'Rechtsgeschichte', exportedAt:new Date().toISOString(), events:state.events });
  async function portableDocument() {
    const data = structuredClone(documentData());
    for (const event of data.events) {
      if (!hostedImage(event.image)) continue;
      const response = await fetch(event.image); if (!response.ok) throw Error('Ein Bild konnte nicht exportiert werden.');
      const blob = await response.blob();
      event.image = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
    }
    return data;
  }
  function download(blob, filename) {
    const link = document.createElement('a'), url = URL.createObjectURL(blob);
    link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 3000);
  }
  async function exportHTML() {
    $('export-html').disabled = true;
    try {
      let assets = window.TIMELINE_EXPORT_ASSETS;
      if (!assets) {
        const fetchText = async path => { const result = await fetch(path); if (!result.ok) throw Error('Exportdateien konnten nicht geladen werden.'); return result.text(); };
        let [css, js, interLicense, serifLicense] = await Promise.all([fetchText('styles.css'), fetchText('app.js'), fetchText('assets/inter-LICENSE.txt'), fetchText('assets/source-serif-LICENSE.md')]);
        for (const file of ['inter-regular.woff2','inter-semibold.woff2','source-serif-4.woff2']) {
          const response = await fetch('assets/' + file); if (!response.ok) throw Error('Eine Schriftdatei konnte nicht geladen werden.');
          const bytes = new Uint8Array(await response.arrayBuffer());
          let binary = ''; for (const value of bytes) binary += String.fromCharCode(value);
          css = css.replace('assets/' + file, 'data:font/woff2;base64,' + btoa(binary));
        }
        assets = { css, js, template:initialTemplate, licenses:{ Inter:interLicense, SourceSerif4:serifLicense } };
      }
      const data = { ...await portableDocument(), storageKey:'export-' + Date.now() };
      const boot = 'window.TIMELINE_SERVER=false;window.TIMELINE_DATA=' + JSON.stringify(data).replace(/</g,'\\u003c') + ';window.TIMELINE_EXPORT_ASSETS=' + JSON.stringify(assets).replace(/</g,'\\u003c') + ';';
      const html = assets.template
        .replace(/<script\b[^>]*src="config\.js"[^>]*><\/script>/, '')
        .replace(/<link\b[^>]*href="styles\.css"[^>]*>/, () => '<style>' + assets.css + '</style>')
        .replace(/<script\b[^>]*src="data\.js"[^>]*><\/script>/, () => '<script>' + boot + '</script>')
        .replace(/<script\b[^>]*src="app\.js"[^>]*><\/script>/, () => '<script>document.addEventListener("DOMContentLoaded",()=>{' + escapeScript(assets.js) + '});</script>');
      download(new Blob([html], { type:'text/html;charset=utf-8' }), 'rechtsgeschichte.html');
      notify('HTML-Datei heruntergeladen.');
    } catch (error) { notify(error.message || 'Die HTML-Datei konnte nicht erstellt werden.'); }
    finally { $('export-html').disabled = false; }
  }
  async function importData(file) {
    if (!file || !state.editing || saving) return;
    try {
      if (file.size > 50000000) throw Error('Die Datei ist größer als 50 MB.');
      const incoming = validate(JSON.parse(await file.text()));
      $('import-summary').textContent = `${incoming.length} Ereignisse und Zeiträume.`;
      const dialog = $('import-dialog'); dialog.showModal();
      dialog.addEventListener('close', async () => {
        if (!['merge','replace'].includes(dialog.returnValue)) return;
        try {
          let next = incoming;
          if (dialog.returnValue !== 'replace') { const merged = new Map(state.events.map(event => [event.id,event])); incoming.forEach(event => merged.set(event.id,event)); next = [...merged.values()]; }
          await persist(next); state.selected = null; refresh(); fit(); notify(online ? 'Daten importiert und online gespeichert.' : 'Daten importiert und lokal gespeichert.');
        } catch (error) { notify(error.message); }
      }, { once:true });
    } catch (error) { notify(error.message || 'Die Datei konnte nicht importiert werden.'); }
    finally { $('import-file').value = ''; }
  }

  function runSearch() {
    const query = $('search').value.trim().toLocaleLowerCase('de'), results = $('search-results'); results.replaceChildren();
    if (!query) { results.hidden = true; return; }
    const matches = state.events.filter(event => `${event.title} ${event.body} ${event.source} ${dates(event)} ${event.track}`.toLocaleLowerCase('de').includes(query)).sort((a,b) => a.start - b.start).slice(0, 30);
    if (!matches.length) results.append(element('p', '', 'Keine Treffer.'));
    for (const event of matches) {
      const button = element('button', '', event.title); button.append(element('small', '', `${dates(event)} · ${event.track}`));
      button.addEventListener('click', () => focusEvent(event.id)); results.append(button);
    }
    results.hidden = false;
  }
  function setup() {
    $('horizontal-mode').onclick = () => setMode('horizontal'); $('vertical-mode').onclick = () => setMode('vertical');
    $('vertical').addEventListener('scroll', scheduleVerticalNavigation, { passive:true });
    const verticalRail = $('vertical-overview');
    verticalRail.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !verticalAnchors.length) return;
      event.preventDefault(); verticalRail.focus({ preventScroll:true }); verticalRail.setPointerCapture(event.pointerId);
      const bounds = verticalRail.getBoundingClientRect(), thumb = $('vertical-overview-window').getBoundingClientRect();
      const inside = event.clientY >= thumb.top - 5 && event.clientY <= thumb.bottom + 5;
      if (!inside) jumpToVerticalPosition((event.clientY - bounds.top - thumb.height / 2) / Math.max(1, bounds.height - thumb.height));
      const container = $('vertical'), travel = Math.max(0, container.scrollHeight - container.clientHeight);
      verticalDrag = { y:event.clientY, position:travel ? container.scrollTop / travel : 0, track:Math.max(1, bounds.height - thumb.height) };
      verticalRail.classList.add('dragging');
    });
    verticalRail.addEventListener('pointermove', event => {
      if (verticalDrag && verticalAnchors.length) jumpToVerticalPosition(verticalDrag.position + (event.clientY - verticalDrag.y) / verticalDrag.track);
    });
    const endVerticalDrag = () => { verticalDrag = null; verticalRail.classList.remove('dragging'); };
    verticalRail.addEventListener('pointerup', endVerticalDrag); verticalRail.addEventListener('pointercancel', endVerticalDrag); verticalRail.addEventListener('lostpointercapture', endVerticalDrag);
    verticalRail.addEventListener('keydown', event => {
      if (state.mode !== 'vertical' || !verticalAnchors.length) return;
      const container = $('vertical'), travel = Math.max(1, container.scrollHeight - container.clientHeight);
      const steps = { ArrowUp:-60, ArrowLeft:-60, ArrowDown:60, ArrowRight:60, PageUp:-container.clientHeight * .9, PageDown:container.clientHeight * .9 };
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : Object.hasOwn(steps, event.key) ? (container.scrollTop + steps[event.key]) / travel : undefined;
      if (target === undefined) return;
      event.preventDefault(); event.stopPropagation(); jumpToVerticalPosition(target);
    });
    $('fit').onclick = fit; $('previous').onclick = () => pan(-.22); $('next').onclick = () => pan(.22);
    $('zoom-in').onclick = () => zoom(.7); $('zoom-out').onclick = () => zoom(1 / .7);
    $('horizontal').addEventListener('wheel', event => {
      if (event.ctrlKey || event.metaKey) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      const width = Math.max(1,$('plot').clientWidth - 64);
      const pixels = delta * (event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? width : 1);
      pan(Math.max(-1,Math.min(1,pixels / width)));
    }, { passive:false });
    $('plot').addEventListener('contextmenu', event => event.preventDefault());
    $('plot').addEventListener('pointerdown', event => {
      if (event.button !== 2 && !(event.pointerType === 'touch' && !event.target.closest('button'))) return;
      event.preventDefault(); drag = { x:event.clientX, center:state.center, moved:false };
      $('plot').setPointerCapture(event.pointerId); $('plot').classList.add('dragging');
    });
    $('plot').addEventListener('pointermove', event => {
      if (!drag) return; const delta = event.clientX - drag.x;
      drag.moved ||= Math.abs(delta) > 3; state.center = drag.center - delta / Math.max(1,$('plot').clientWidth - 64) * state.span;
      constrain(); schedule();
    });
    const endDrag = () => { drag = null; $('plot').classList.remove('dragging'); };
    $('plot').addEventListener('pointerup', endDrag); $('plot').addEventListener('pointercancel', endDrag); $('plot').addEventListener('lostpointercapture', endDrag);
    let overviewDrag = false;
    const moveOverview = event => { const rect = $('overview').getBoundingClientRect(); state.center = state.min + Math.max(0,Math.min(1,(event.clientX - rect.left) / rect.width)) * (state.max - state.min); constrain(); schedule(); };
    $('overview').addEventListener('pointerdown', event => { if (event.button !== 0) return; event.preventDefault(); overviewDrag = true; $('overview').setPointerCapture(event.pointerId); moveOverview(event); });
    $('overview').addEventListener('pointermove', event => { if (overviewDrag) moveOverview(event); });
    $('overview').addEventListener('pointerup', () => { overviewDrag = false; }); $('overview').addEventListener('pointercancel', () => { overviewDrag = false; });
    document.addEventListener('keydown', event => {
      if ($('editor').open || $('login-dialog').open || $('delete-dialog').open || $('import-dialog').open || event.target.closest('input,textarea,select') || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Escape') { closeDetail(); $('search-results').hidden = true; $('file-menu').hidden = true; }
      if (state.mode !== 'horizontal') return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); pan((event.key === 'ArrowLeft' ? -.1 : .1) * (event.shiftKey ? 3 : 1)); }
      const zoomIn = ['+','='].includes(event.key) || event.code === 'NumpadAdd';
      const zoomOut = ['-','−'].includes(event.key) || event.code === 'NumpadSubtract';
      if (zoomIn || zoomOut) { event.preventDefault(); zoom(zoomOut ? 1 / .7 : .7); }
    });
    $('edit-mode').onclick = toggleEditing; $('add').onclick = () => openEditor();
    $('login-form').onsubmit = unlockEditing;
    $('login-close').onclick = $('login-cancel').onclick = () => $('login-dialog').close();
    $('login-dialog').addEventListener('close', () => { $('edit-password').value = ''; });
    $('event-type').onchange = updateType; $('event-form').onsubmit = saveEvent;
    $('related-target').onchange = () => { $('add-related').disabled = !$('related-target').value; };
    $('add-related').onclick = () => { const id = $('related-target').value; if (!id || state.relatedDraft.includes(id)) return; state.relatedDraft.push(id); renderRelatedEditor(); $('related-target').focus(); };
    $('cancel').onclick = $('cancel-x').onclick = () => $('editor').close(); $('delete-event').onclick = deleteEvent;
    $('event-image').onchange = async () => {
      const file = $('event-image').files[0]; if (!file) return;
      if (!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type) || file.size > 10000000) { $('event-image').value = ''; $('form-error').textContent = 'PNG, JPEG, WebP oder GIF bis 10 MB auswählen.'; $('form-error').hidden = false; return; }
      const read = new FileReader();
      read.onload = () => { clearImageMetadata(); state.image = read.result; updateImagePreview(); $('form-error').hidden = true; };
      read.onerror = () => { $('form-error').textContent = 'Das Bild konnte nicht gelesen werden.'; $('form-error').hidden = false; }; read.readAsDataURL(file);
    };
    $('remove-image').onclick = () => { state.image = ''; $('event-image').value = ''; clearImageMetadata(); updateImagePreview(); };
    $('files').onclick = () => { $('file-menu').hidden = !$('file-menu').hidden; $('files').setAttribute('aria-expanded', String(!$('file-menu').hidden)); };
    $('export-json').onclick = async () => { $('file-menu').hidden = true; try { download(new Blob([JSON.stringify(await portableDocument(),null,2)], { type:'application/json' }), 'rechtsgeschichte.json'); } catch (error) { notify(error.message); } };
    $('export-html').onclick = () => { $('file-menu').hidden = true; exportHTML(); };
    $('import-json').onclick = () => { $('file-menu').hidden = true; $('import-file').click(); }; $('import-file').onchange = () => importData($('import-file').files[0]);
    $('import-local').hidden = !localDraft;
    $('import-local').onclick = () => { $('file-menu').hidden = true; if (localDraft) importData(new File([JSON.stringify(localDraft)], 'browserstand.json', { type:'application/json' })); };
    $('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 120); });
    $('search').addEventListener('keydown', event => {
      if (event.key === 'Escape') { $('search-results').hidden = true; $('search').blur(); }
      if (event.key === 'ArrowDown') { event.preventDefault(); $('search-results').querySelector('button')?.focus(); }
      if (event.key === 'Enter') { event.preventDefault(); $('search-results').querySelector('button')?.click(); }
    });
    document.addEventListener('click', event => { if (!event.target.closest('.search-wrap')) $('search-results').hidden = true; if (!event.target.closest('.author-actions')) { $('file-menu').hidden = true; $('files').setAttribute('aria-expanded','false'); } });
    new ResizeObserver(() => { schedule(); updateWorkspaceHeight(); }).observe($('workspace'));
    new ResizeObserver(() => { if (state.mode === 'vertical') requestAnimationFrame(positionPeriods); }).observe($('vertical-content'));
    new ResizeObserver(() => { if (state.mode === 'vertical') renderVerticalNavigation(); }).observe(verticalRail);
    window.addEventListener('resize', () => { schedule(); updateWorkspaceHeight(); positionPeriods(); });
  }
  async function initialize() {
    try {
      state.events = validate(base);
      try {
        db = await openDatabase();
        const saved = await new Promise((resolve, reject) => { const request = db.transaction('document').objectStore('document').get('events'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        if (saved) { if (online) localDraft = { schemaVersion:1, events:validate(saved) }; else state.events = validate(saved); }
      } catch { db = null; }
      if (online) {
        try { const result = await api('document'); state.events = validate(result.document || base); revision = result.revision; onlineReady = true; }
        catch (error) { notify(error.message); }
      }
      pruneRelations(); setup(); fit();
      if (state.min < 1100 && state.max > 1400) { state.span = 300; state.center = 1250; schedule(); }
      updateWorkspaceHeight();
      if (matchMedia('(max-width: 740px)').matches) setMode('vertical');
      await document.fonts.ready; schedule();
      if (online) { setInterval(syncDocument, 30000); window.addEventListener('focus', syncDocument); document.addEventListener('visibilitychange', syncDocument); }
    } catch (error) { notify('Der Zeitstrahl konnte nicht geladen werden: ' + error.message); }
  }
  initialize();
})();
