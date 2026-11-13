// Keyboard / mouse / gamepad input with per-frame edge detection.
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = {};
    this.pressed = {};      // went down this frame
    this.released = {};
    this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0;
    this.buttons = {}; this.bPressed = {}; this.bReleased = {};
    this.locked = false;
    this.enabled = true;
    this.sens = 1;
    this.invertY = false;
    this.pad = { x: 0, y: 0, lx: 0, ly: 0, btn: {}, btnPressed: {} };

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      this.keys[e.code] = true; this.pressed[e.code] = true;
    });
    window.addEventListener('keyup', (e) => { this.keys[e.code] = false; this.released[e.code] = true; });
    window.addEventListener('blur', () => { this.keys = {}; this.buttons = {}; });
    canvas.addEventListener('mousedown', (e) => { this.buttons[e.button] = true; this.bPressed[e.button] = true; });
    window.addEventListener('mouseup', (e) => { this.buttons[e.button] = false; this.bReleased[e.button] = true; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      // without pointer lock, dragging with a mouse button held still turns the camera
      if (!this.locked && !(this.buttons[0] || this.buttons[2] || this.buttons[1])) return;
      // some browsers report huge spikes when the pointer warps
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.mouseDX += e.movementX; this.mouseDY += e.movementY;
    });
    canvas.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (this.onLockChange) this.onLockChange(this.locked);
    });
  }

  lock() { if (!this.locked && this.canvas.requestPointerLock) { try { const p = this.canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ } } }
  unlock() { if (this.locked) document.exitPointerLock(); }

  down(code) { return this.enabled && !!this.keys[code]; }
  hit(code) { return this.enabled && !!this.pressed[code]; }
  up(code) { return this.enabled && !!this.released[code]; }
  mouse(b) { return this.enabled && !!this.buttons[b]; }
  mouseHit(b) { return this.enabled && !!this.bPressed[b]; }
  mouseUp(b) { return this.enabled && !!this.bReleased[b]; }
  padHit(i) { return this.enabled && !!this.pad.btnPressed[i]; }
  padDown(i) { return this.enabled && !!this.pad.btn[i]; }

  // movement axis: x right, y forward
  axis() {
    if (!this.enabled) return { x: 0, y: 0 };
    let x = (this.keys.KeyD || this.keys.ArrowRight ? 1 : 0) - (this.keys.KeyA || this.keys.ArrowLeft ? 1 : 0);
    let y = (this.keys.KeyW || this.keys.ArrowUp ? 1 : 0) - (this.keys.KeyS || this.keys.ArrowDown ? 1 : 0);
    if (Math.abs(this.pad.lx) > 0.18 || Math.abs(this.pad.ly) > 0.18) { x += this.pad.lx; y -= this.pad.ly; }
    const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    return { x, y };
  }

  pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const p = pads && pads[0];
    this.pad.btnPressed = {};
    if (!p) { this.pad.lx = this.pad.ly = this.pad.x = this.pad.y = 0; return; }
    this.pad.lx = p.axes[0] || 0; this.pad.ly = p.axes[1] || 0;
    this.pad.x = Math.abs(p.axes[2]) > 0.15 ? p.axes[2] : 0; this.pad.y = Math.abs(p.axes[3]) > 0.15 ? p.axes[3] : 0;
    p.buttons.forEach((b, i) => { const d = b.pressed; if (d && !this.pad.btn[i]) this.pad.btnPressed[i] = true; this.pad.btn[i] = d; });
  }

  endFrame() {
    this.pressed = {}; this.released = {}; this.bPressed = {}; this.bReleased = {};
    this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0;
  }
}
