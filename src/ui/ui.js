// HUD and menus (DOM overlay).
import * as THREE from 'three';
import { WORLD } from '../world/layout.js';

const HEART = 'M12 21s-9-5.6-9-12.2C3 5.2 5.4 3 8 3c1.7 0 3.2.9 4 2.3C12.8 3.9 14.3 3 16 3c2.6 0 5 2.2 5 5.8C21 15.4 12 21 12 21z';
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const _v = new THREE.Vector3();

const DEFAULT_SETTINGS = { quality: 2, scale: 1, sens: 1, invertY: false, master: 0.8, music: 0.7, sfx: 0.9, ambience: 0.8 };

export class UI {
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('ui');
    this.settings = { ...DEFAULT_SETTINGS };
    try { Object.assign(this.settings, JSON.parse(localStorage.getItem('aetheria.settings') || '{}')); } catch (e) { /* ignore */ }
    this.floats = [];
    this.bars = new Map();
    this.dialogQ = null;
    this.modal = null;       // 'pause' | 'map' | 'title' | 'gameover' | 'credits'
    this._build();
    this._lastHearts = ''; this._lastCounters = ''; this._lastQuest = '';
    window.addEventListener('keydown', (e) => this._key(e));
  }

  _build() {
    const r = this.root;
    r.innerHTML = '';
    const hud = this.hud = el('div', 'hud hidden');
    hud.innerHTML = `
      <div class="hud-tl"><div class="hearts"></div>
        <div class="counters"></div></div>
      <div class="quest" style="opacity:0"><div class="quest-title"></div><div class="quest-obj"></div><div class="quest-dist"></div></div>
      <div class="minimap"><canvas width="344" height="344"></canvas><div class="mm-n">N</div></div>
      <div class="clock"></div>
      <div class="toasts"></div>
      <div class="skills">
        <div class="skill small" id="sk-eat"><span>🍎</span><div class="n">0</div><div class="k key">R</div></div>
        <div class="skill" id="sk-q"><span>🌀</span><div class="cd"></div><div class="k key">Q</div></div>
      </div>
      <svg class="stamina" viewBox="0 0 54 54"><circle cx="27" cy="27" r="21" fill="rgba(10,14,24,0.45)" stroke="rgba(0,0,0,0.5)" stroke-width="9"/><circle class="st-arc" cx="27" cy="27" r="21" fill="none" stroke="#7dff7a" stroke-width="6" stroke-linecap="round" transform="rotate(-90 27 27)" stroke-dasharray="132 132"/></svg>
      <div class="prompt"><span class="key">E</span><span class="ptxt"></span></div>
      <div class="qmark"><div class="qm-dia"></div><div class="qm-d"></div></div>
      <div class="boss"><div class="nm"></div><div class="bar"><div class="fill"></div></div></div>
      <div class="crosshint"></div>
      <div class="lowhp"></div><div class="vignette"></div>`;
    r.appendChild(hud);
    this.layer = el('div'); this.layer.style.cssText = 'position:absolute;inset:0'; r.appendChild(this.layer);
    this.card = el('div', 'card', '<div class="card-name"></div><div class="card-line"></div><div class="card-sub"></div>'); r.appendChild(this.card);
    this.itemEl = el('div', 'itemget', '<div class="t"></div><div class="d"></div>'); r.appendChild(this.itemEl);
    this.dlg = el('div', 'dialog', '<div class="who"></div><div class="txt"></div><div class="next"><span class="key">E</span> continue</div>'); r.appendChild(this.dlg);
    this.fader = el('div', 'fader'); r.appendChild(this.fader);

    // title
    this.titleEl = el('div', 'screen title-screen', `
      <div class="logo">AETHERIA</div><div class="logo-sub">Echoes of the Dawn</div>
      <div class="menu"><button class="btn" data-a="continue">Continue</button><button class="btn" data-a="new">New Journey</button><button class="btn" data-a="settings">Settings</button></div>
      <div class="foot">WASD move · Mouse look · Space jump / glide · Shift sprint · Click attack — best with headphones</div>`);
    r.appendChild(this.titleEl);
    // pause / settings
    this.pauseEl = el('div', 'screen pause'); r.appendChild(this.pauseEl);
    // map
    this.mapEl = el('div', 'screen mapscreen', '<div class="mapwrap"><canvas width="1024" height="1024"></canvas></div><div class="maphint">Click an activated waypoint to travel · <span class="key">M</span> close</div>');
    r.appendChild(this.mapEl);
    this.overEl = el('div', 'screen gameover', '<div class="big">YOU FELL</div><div class="menu"><button class="btn" data-a="respawn">Rise Again</button></div>'); r.appendChild(this.overEl);
    this.creditsEl = el('div', 'screen credits'); r.appendChild(this.creditsEl);

    r.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]');
      if (b) { this.game.audio && this.game.audio.sfx('uiClick'); this._action(b.dataset.a, b); }
    });
    r.addEventListener('mouseover', (e) => { if (e.target.closest('.btn')) this.game.audio && this.game.audio.sfx('uiHover'); });
    this.q = (s) => hud.querySelector(s);
    this.mm = this.q('.minimap canvas').getContext('2d');
    this.stArc = this.q('.st-arc'); this.stEl = this.q('.stamina');
    this.promptEl = this.q('.prompt');
    this.qm = this.q('.qmark'); this.qmD = this.q('.qm-d'); this.qmDia = this.q('.qm-dia');
    this.setHints(true);
  }

  setHints(on) {
    this.q('.crosshint').innerHTML = on ? '<span><span class="key">WASD</span>Move</span><span><span class="key">Space</span>Jump · Glide</span><span><span class="key">Shift</span>Sprint</span><span><span class="key">LMB</span>Attack</span><span><span class="key">RMB</span>Guard</span><span><span class="key">C</span>Dodge</span><span><span class="key">M</span>Map</span>' : '';
  }

  initMap(world) {
    const n = world.data.MAPN;
    const cv = document.createElement('canvas'); cv.width = cv.height = n;
    cv.getContext('2d').putImageData(new ImageData(world.data.mapImg, n, n), 0, 0);
    this.mapCanvas = cv;
  }

  saveSettings() { try { localStorage.setItem('aetheria.settings', JSON.stringify(this.settings)); } catch (e) { /* ignore */ } }

  // ---------------------------------------------------------------- actions / keys
  _action(a, b) {
    const g = this.game;
    if (a === 'new') g.startGame(true);
    else if (a === 'continue') g.startGame(false);
    else if (a === 'settings') this.showPause(true);
    else if (a === 'resume') this.closeModal();
    else if (a === 'back') { if (this.modalPrev === 'title') { this.pauseEl.classList.remove('show'); this.modal = 'title'; this.titleEl.classList.add('show'); } else this.closeModal(); }
    else if (a === 'totitle') { g.saveGame && g.saveGame(); location.reload(); }
    else if (a === 'respawn') { this.overEl.classList.remove('show'); this.modal = null; g.respawn(); g.input.lock(); }
    else if (a === 'endcredits') { this.creditsEl.classList.remove('show'); this.modal = null; g.input.lock(); }
    else if (a === 'wp') g.travelTo(b.dataset.id);
  }

  _key(e) {
    const g = this.game;
    if (this.dialogQ && (e.code === 'KeyE' || e.code === 'Space' || e.code === 'Enter')) { e.preventDefault(); this._advanceDialog(); return; }
    if (g.state !== 'play') return;
    if (e.code === 'KeyM' && !this.dialogQ) { if (this.modal === 'map') { this.closeModal(); g.input.lock(); } else if (!this.modal) this.showMap(); }
    else if (e.code === 'Escape') { if (this.modal === 'map' || this.modal === 'pause') this.closeModal(); else if (!this.modal) this.showPause(false); }
    else if (e.code === 'KeyP' && !this.modal) this.showPause(false);
    else if (e.code === 'KeyH') { this.hud.classList.toggle('hidden'); }
  }

  closeModal() {
    for (const s of [this.pauseEl, this.mapEl]) s.classList.remove('show');
    if (this.modal === 'pause' || this.modal === 'map') this.modal = null;
    this.game.paused = false;
  }

  // ---------------------------------------------------------------- title / pause / map
  showTitle(hasSave) {
    this.modal = 'title';
    this.titleEl.classList.add('show');
    this.titleEl.querySelector('[data-a=continue]').classList.toggle('dim', !hasSave);
    this.hud.classList.add('hidden');
  }
  hideTitle() { this.titleEl.classList.remove('show'); if (this.modal === 'title') this.modal = null; }

  showPause(fromTitle) {
    const s = this.settings, g = this.game;
    this.modalPrev = fromTitle ? 'title' : null;
    if (fromTitle) this.titleEl.classList.remove('show'); else { g.paused = true; g.input.unlock(); g.saveGame(); }
    this.modal = 'pause';
    const K = (k, t) => `<div><span>${t}</span><span class="key">${k}</span></div>`;
    this.pauseEl.innerHTML = `<div class="panel click">
      <h2>${fromTitle ? 'SETTINGS' : 'PAUSED'}</h2>
      <div class="cols"><div>
      <h3>Graphics</h3>
      <div class="row"><span>Quality <small>(reloads)</small></span><select data-s="quality"><option value="0">Low</option><option value="1">Medium</option><option value="2">High</option><option value="3">Ultra</option></select></div>
      <div class="row"><span>Resolution scale</span><input type="range" min="0.5" max="1" step="0.05" data-s="scale"></div>
      <h3>Controls</h3>
      <div class="row"><span>Mouse sensitivity</span><input type="range" min="0.3" max="2.5" step="0.05" data-s="sens"></div>
      <div class="row"><span>Invert Y</span><input type="checkbox" data-s="invertY"></div>
      <h3>Audio</h3>
      <div class="row"><span>Master</span><input type="range" min="0" max="1" step="0.02" data-s="master"></div>
      <div class="row"><span>Music</span><input type="range" min="0" max="1" step="0.02" data-s="music"></div>
      <div class="row"><span>Effects</span><input type="range" min="0" max="1" step="0.02" data-s="sfx"></div>
      </div><div>
      <h3>How to play</h3>
      <div class="keys">${K('WASD', 'Move')}${K('Mouse', 'Look')}${K('Space', 'Jump · glide · climb leap')}${K('Shift', 'Sprint / fast swim')}${K('LMB', 'Sword combo')}${K('RMB', 'Raise shield')}${K('C', 'Dodge roll / let go of wall')}${K('Q', 'Gale Burst (makes an updraft)')}${K('E', 'Interact')}${K('R', 'Eat an apple')}${K('M', 'Map & fast travel')}${K('H', 'Hide HUD (photo mode)')}</div>
      <p class="tip">Walk into any cliff or wall to climb it. Stamina (the green ring) limits climbing, gliding, sprinting and swimming.</p>
      </div></div>
      <div class="btns"><button class="btn" data-a="${fromTitle ? 'back' : 'resume'}">${fromTitle ? 'Back' : 'Resume'}</button>${fromTitle ? '' : '<button class="btn" data-a="totitle">Save &amp; Quit</button>'}</div>
    </div>`;
    this.pauseEl.querySelectorAll('[data-s]').forEach((inp) => {
      const k = inp.dataset.s;
      if (inp.type === 'checkbox') inp.checked = !!s[k]; else inp.value = s[k];
      inp.addEventListener('input', () => {
        s[k] = inp.type === 'checkbox' ? inp.checked : Number(inp.value);
        this.saveSettings(); g.applySettings(k);
      });
    });
    this.pauseEl.classList.add('show');
  }

  showMap() {
    const g = this.game;
    this.modal = 'map'; g.paused = true; g.input.unlock();
    const wrap = this.mapEl.querySelector('.mapwrap');
    const cv = wrap.querySelector('canvas');
    const ctx = cv.getContext('2d');
    // crop to the island
    const half = 1900;
    const n = this.mapCanvas.width, s0 = (WORLD.half - half) / WORLD.size * n, sw = (half * 2) / WORLD.size * n;
    ctx.drawImage(this.mapCanvas, s0, s0, sw, sw, 0, 0, cv.width, cv.height);
    // parchment tint + vignette
    ctx.fillStyle = 'rgba(255, 236, 190, 0.10)'; ctx.fillRect(0, 0, cv.width, cv.height);
    const gr = ctx.createRadialGradient(512, 512, 380, 512, 512, 740); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(10,20,40,0.55)');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, cv.width, cv.height);
    wrap.querySelectorAll('.mapicon').forEach((e) => e.remove());
    const toPct = (x, z) => [((x + half) / (half * 2)) * 100, ((z + half) / (half * 2)) * 100];
    for (const w of g.waypoints) {
      const [px, pz] = toPct(w.pos.x, w.pos.z);
      const d = el('div', 'mapicon' + (w.active ? '' : ' locked'), `<div class="dot"></div><div class="lbl">${w.active ? w.name : '???'}</div>`);
      d.style.left = px + '%'; d.style.top = pz + '%';
      if (w.active) { d.dataset.a = 'wp'; d.dataset.id = w.id; }
      wrap.appendChild(d);
    }
    if (g.quests && g.quests.target) {
      const t = g.quests.target; const [px, pz] = toPct(t.x, t.z);
      const d = el('div', 'mapicon qicon', '<div class="dot"></div>'); d.style.left = px + '%'; d.style.top = pz + '%'; wrap.appendChild(d);
    }
    const [mx, mz] = toPct(g.player.pos.x, g.player.pos.z);
    const me = el('div', 'mapicon me', '<div class="dot"></div>'); me.style.left = mx + '%'; me.style.top = mz + '%'; wrap.appendChild(me);
    this.mapEl.classList.add('show');
    g.audio && g.audio.sfx('uiOpen');
  }

  showGameOver() { this.modal = 'gameover'; this.overEl.classList.add('show'); this.game.input.unlock(); }

  showCredits(stats) {
    this.modal = 'credits'; this.game.input.unlock();
    this.creditsEl.innerHTML = `<div class="big">THE DAWN RETURNS</div><div class="card-line"></div>
      <p>The Colossus sleeps once more and light pours back across Aetheria.<br>Thank you for playing.</p>
      <p style="font-size:13px;color:#9fb6d6">Spirit orbs found: ${stats.orbs} · Chests opened: ${stats.chests} · Time: ${stats.time}</p>
      <p style="font-size:12px;color:#8094b3">Avatars: VRoid sample characters by pixiv (CC0 / free use) · Animation, buildings, wildlife, raiders &amp; chests: Quaternius (CC0) · Extra clips: KayKit by Kay Lousberg (CC0) · three.js, three-vrm · Everything else is procedural.</p>
      <div class="menu"><button class="btn" data-a="endcredits">Keep Exploring</button></div>`;
    this.creditsEl.classList.add('show');
  }

  // ---------------------------------------------------------------- transient elements
  regionCard(name, sub) {
    this.card.querySelector('.card-name').textContent = name.toUpperCase();
    this.card.querySelector('.card-sub').textContent = sub || '';
    this.card.classList.add('show');
    clearTimeout(this._cardT);
    this._cardT = setTimeout(() => this.card.classList.remove('show'), 3800);
  }
  notify(html) {
    const t = el('div', 'toast', html);
    const box = this.q('.toasts'); box.appendChild(t);
    while (box.children.length > 5) box.firstChild.remove();
    setTimeout(() => t.remove(), 4200);
  }
  itemGet(title, desc, hold = 3200) {
    this.itemEl.querySelector('.t').textContent = title;
    this.itemEl.querySelector('.d').innerHTML = desc || '';
    this.itemEl.classList.add('show');
    clearTimeout(this._itemT);
    this._itemT = setTimeout(() => this.itemEl.classList.remove('show'), hold);
  }
  setPrompt(text, key = 'E') {
    if (text === this._prompt) return;
    this._prompt = text;
    if (text) { this.promptEl.querySelector('.ptxt').textContent = text; this.promptEl.querySelector('.key').textContent = key; this.promptEl.classList.add('show'); }
    else this.promptEl.classList.remove('show');
  }
  damageVignette() { const v = this.q('.vignette'); v.style.transition = 'none'; v.style.opacity = 1; requestAnimationFrame(() => { v.style.transition = 'opacity 0.7s'; v.style.opacity = 0; }); }
  fade(to, dur = 0.8, white = false) {
    this.fader.classList.toggle('white', white);
    this.fader.style.transitionDuration = dur + 's';
    this.fader.style.opacity = to;
    return new Promise((res) => setTimeout(res, dur * 1000));
  }
  bossBar(name, frac) {
    const b = this.q('.boss');
    if (name === null) { b.classList.remove('show'); return; }
    b.classList.add('show'); b.querySelector('.nm').textContent = name; b.querySelector('.fill').style.width = Math.max(0, frac * 100) + '%';
  }
  floatText(pos, text, cls = '') {
    const d = el('div', 'ftext ' + cls, text);
    this.layer.appendChild(d);
    const f = { el: d, pos: pos.clone(), t: 0, ox: (Math.random() - 0.5) * 40 };
    this.floats.push(f);
    this._place(f.el, f.pos, f.ox, 0);
  }

  // ---------------------------------------------------------------- dialog
  dialog(lines, done) {
    this.dialogQ = { lines, i: 0, done, t: 0, shown: 0 };
    this.game.inDialog = true;
    this.dlg.classList.add('show');
    this.setPrompt(null);
    this._showLine();
  }
  _showLine() {
    const q = this.dialogQ, l = q.lines[q.i];
    this.dlg.querySelector('.who').textContent = l.who || '';
    this.dlg.querySelector('.who').style.display = l.who ? '' : 'none';
    q.t = 0; q.shown = 0; q.text = l.text;
    this.dlg.querySelector('.txt').textContent = '';
    this.game.audio && this.game.audio.sfx('dialog');
  }
  _advanceDialog() {
    const q = this.dialogQ;
    if (!q) return;
    if (q.shown < q.text.length) { q.shown = q.text.length; this.dlg.querySelector('.txt').textContent = q.text; return; }
    q.i++;
    if (q.i >= q.lines.length) {
      this.dialogQ = null; this.dlg.classList.remove('show'); this.game.inDialog = false;
      this.game.dialogCooldown = 0.3;
      if (this.game.onDialogEnd) { const f = this.game.onDialogEnd; this.game.onDialogEnd = null; f(); }
      if (q.done) q.done();
    } else this._showLine();
  }

  _place(e, pos, ox, oy) {
    _v.copy(pos).project(this.game.gfx.camera);
    if (_v.z > 1 || _v.z < -1) { e.style.display = 'none'; return false; }
    e.style.display = '';
    e.style.left = ((_v.x * 0.5 + 0.5) * window.innerWidth + ox) + 'px';
    e.style.top = ((-_v.y * 0.5 + 0.5) * window.innerHeight + oy) + 'px';
    return true;
  }

  // ---------------------------------------------------------------- per-frame
  update(dt) {
    const g = this.game, p = g.player;
    if (this.dialogQ) {
      const q = this.dialogQ;
      if (q.shown < q.text.length) { q.t += dt * 46; const n = Math.min(q.text.length, Math.floor(q.t)); if (n !== q.shown) { q.shown = n; this.dlg.querySelector('.txt').textContent = q.text.slice(0, n); } }
    }
    for (let i = this.floats.length - 1; i >= 0; i--) {
      const f = this.floats[i]; f.t += dt;
      if (f.t > 0.9) { f.el.remove(); this.floats.splice(i, 1); } else this._place(f.el, f.pos, f.ox, 0);
    }
    if (g.state !== 'play') return;

    // hearts
    const hk = p.hp + '/' + p.maxHearts;
    if (hk !== this._lastHearts) {
      this._lastHearts = hk;
      let h = '';
      for (let i = 0; i < p.maxHearts; i++) {
        const f = Math.max(0, Math.min(4, p.hp - i * 4)) / 4;
        h += `<svg viewBox="0 0 24 24"><path d="${HEART}" fill="#2b0d14" stroke="#fff" stroke-opacity="0.85" stroke-width="1.3"/><path d="${HEART}" fill="#ff4a5e" style="clip-path: inset(0 ${(1 - f) * 100}% 0 0)"/></svg>`;
      }
      this.q('.hearts').innerHTML = h;
      this.q('.lowhp').style.opacity = p.hp > 0 && p.hp <= 4 ? 1 : 0;
    }
    const inv = g.inv;
    const sig = Object.values(inv.sigils).filter(Boolean).length;
    const ck = inv.orbs + '/' + inv.coins + '/' + inv.apples + '/' + sig;
    if (ck !== this._lastCounters) {
      this._lastCounters = ck;
      this.q('.counters').innerHTML = `<div class="counter"><i class="ic-orb"></i>${inv.orbs}</div><div class="counter"><i class="ic-coin"></i>${inv.coins}</div>${sig ? `<div class="counter"><i class="ic-sigil"></i>${sig}/3</div>` : ''}`;
      this.q('#sk-eat .n').textContent = inv.apples;
    }
    // quest
    const qs = g.quests;
    if (qs) {
      const key = qs.title + '|' + qs.objective;
      if (key !== this._lastQuest) {
        this._lastQuest = key;
        const qe = this.q('.quest');
        qe.style.opacity = qs.title ? 1 : 0;
        qe.querySelector('.quest-title').textContent = qs.title || '';
        qe.querySelector('.quest-obj').textContent = qs.objective || '';
      }
      this._questMarker(qs.target, p);
      const de = this.q('.quest-dist');
      if (qs.target) { const d = Math.hypot(qs.target.x - p.pos.x, qs.target.z - p.pos.z); de.textContent = d > 12 ? Math.round(d) + ' m' : ''; } else de.textContent = '';
    }
    // skill cooldown
    const sk = this.q('#sk-q');
    sk.querySelector('.cd').style.setProperty('--cd', (p.skillCd / 9 * 100) + '%');
    sk.classList.toggle('ready', p.skillCd <= 0);
    // stamina wheel next to the hero
    const show = p.stamina < p.maxStamina - 0.5;
    this.stEl.classList.toggle('show', show);
    if (show) {
      const c = 132 * (p.stamina / p.maxStamina);
      this.stArc.setAttribute('stroke-dasharray', `${c} 132`);
      this.stArc.setAttribute('stroke', p.exhausted ? '#ff4a3d' : (p.stamina < 25 ? '#ffb13d' : '#7dff7a'));
      _v.copy(p.pos); _v.y += 1.5;
      this._place(this.stEl, _v, 64, -20);
    }
    // clock
    const t = g.sky.time, hh = Math.floor(t), mm = Math.floor((t - hh) * 60 / 10) * 10;
    const ck2 = hh + ':' + mm + (g.regionName || '');
    if (ck2 !== this._clock) { this._clock = ck2; this.q('.clock').innerHTML = `<b>${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}</b>${g.regionName ? ' · ' + g.regionName : ''}`; }
    this._minimap();
    this._enemyBars();
  }

  // floating objective marker: sits on the target, or slides along the screen edge pointing toward it
  _questMarker(target, p) {
    const m = this.qm;
    if (!target || this.dialogQ) { m.style.opacity = 0; return; }
    const cam = this.game.gfx.camera, W = window.innerWidth, H = window.innerHeight;
    const d = Math.hypot(target.x - p.pos.x, target.z - p.pos.z);
    if (d < 6) { m.style.opacity = 0; return; }
    _v.set(target.x, target.y + 2.6, target.z).project(cam);
    let x = _v.x, y = _v.y;
    const behind = _v.z > 1;
    if (behind) { x = -x; y = -y; }
    const off = behind || Math.abs(x) > 0.9 || Math.abs(y) > 0.82;
    if (off) {
      // slide to the screen edge along the direction from the centre
      const k = 1 / Math.max(Math.abs(x) / 0.9, Math.abs(y) / 0.8, 1e-3);
      x *= k; y *= k;
    }
    m.style.opacity = 1;
    m.style.left = ((x * 0.5 + 0.5) * W) + 'px';
    m.style.top = ((-y * 0.5 + 0.5) * H) + 'px';
    m.classList.toggle('edge', off);
    const txt = d >= 1000 ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m';
    if (txt !== this._qmTxt) { this._qmTxt = txt; this.qmD.textContent = txt; }
  }

  _minimap() {
    const g = this.game, p = g.player, ctx = this.mm;
    this._mmT = (this._mmT || 0) + 1;
    if (this._mmT % 2) return;
    const S = 344, R = 210;      // world radius shown
    const n = this.mapCanvas.width, k = n / WORLD.size;
    ctx.save();
    ctx.clearRect(0, 0, S, S);
    const sx = (p.pos.x + WORLD.half - R) * k, sz = (p.pos.z + WORLD.half - R) * k;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.mapCanvas, sx, sz, R * 2 * k, R * 2 * k, 0, 0, S, S);
    const toMap = (x, z) => [(x - p.pos.x) / R * S / 2 + S / 2, (z - p.pos.z) / R * S / 2 + S / 2];
    const icon = (x, z, color, shape, clamp) => {
      let [mx, mz] = toMap(x, z);
      const dx = mx - S / 2, dz = mz - S / 2, d = Math.hypot(dx, dz), lim = S / 2 - 16;
      if (d > lim) { if (!clamp) return; mx = S / 2 + dx / d * lim; mz = S / 2 + dz / d * lim; }
      ctx.fillStyle = color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5;
      ctx.beginPath();
      if (shape === 'diamond') { ctx.moveTo(mx, mz - 10); ctx.lineTo(mx + 8, mz); ctx.lineTo(mx, mz + 10); ctx.lineTo(mx - 8, mz); ctx.closePath(); }
      else ctx.arc(mx, mz, 7, 0, 7);
      ctx.fill(); ctx.stroke();
    };
    for (const w of g.waypoints) icon(w.pos.x, w.pos.z, w.active ? '#49c7ff' : '#7a8496', 'diamond', false);
    if (g.quests && g.quests.target) icon(g.quests.target.x, g.quests.target.z, '#ff9a3d', 'dot', true);
    // camera view cone
    const yaw = g.cam.yaw;
    ctx.translate(S / 2, S / 2);
    ctx.save(); ctx.rotate(-yaw);
    const gr = ctx.createRadialGradient(0, 0, 4, 0, 0, 90); gr.addColorStop(0, 'rgba(255,255,255,0.4)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gr; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 90, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5); ctx.closePath(); ctx.fill();
    ctx.restore();
    // player arrow
    ctx.rotate(Math.PI - p.yaw);
    ctx.fillStyle = '#ffd84d'; ctx.strokeStyle = '#1b1405'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, -15); ctx.lineTo(11, 12); ctx.lineTo(0, 6); ctx.lineTo(-11, 12); ctx.closePath(); ctx.stroke(); ctx.fill();
    ctx.restore();
  }

  _enemyBars() {
    const g = this.game;
    const seen = new Set();
    if (g.enemies) for (const e of g.enemies.list) {
      if (!(e.barT > 0) || e.dead || e.isBoss) continue;
      let b = this.bars.get(e);
      if (!b) { b = el('div', 'ebar', '<i></i>'); this.layer.appendChild(b); this.bars.set(e, b); }
      _v.copy(e.pos); _v.y += e.height + 0.35;
      if (this._place(b, _v, 0, 0)) b.firstChild.style.width = Math.max(0, e.hp / e.maxHp * 100) + '%';
      seen.add(e);
    }
    for (const [e, b] of this.bars) if (!seen.has(e)) { b.remove(); this.bars.delete(e); }
  }
}
