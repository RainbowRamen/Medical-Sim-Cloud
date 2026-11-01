/*
 * Sweep renderer: draws an engine channel onto a canvas like a patient monitor.
 *  - Speed is real time (mm/s, at the CSS standard of 96 px per inch), so it is the same
 *    at 30, 60 or 120 frames per second.
 *  - The trace is written left to right with an erase bar ahead of the pen.
 *  - Canvases are scaled for high-density phone and tablet screens.
 */
(function (root) {
    'use strict';
    var PX_PER_MM = 96 / 25.4;
    var ERASE_PX = 18;

    /**
     * @param canvas  canvas element
     * @param engine  SimEngine.Engine
     * @param opts    { channel, mmPerSec, color: string|function, map: function(v, h) -> y,
     *                  fill: bool (shade under the trace, capnogram), baseline: function(h) -> y }
     */
    function SweepChannel(canvas, engine, opts) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.engine = engine;
        this.ch = opts.channel;
        this.mmPerSec = opts.mmPerSec || 25;
        this.color = opts.color || '#30d158';
        this.map = opts.map;
        this.fill = !!opts.fill;
        this.baseline = opts.baseline;
        this.lineWidth = opts.lineWidth || 2;
        this.lastIdx = -1;
        this.lastX = 0; this.lastY = null; this.lastCol = -1;
        this.resize();
    }

    SweepChannel.prototype.resize = function () {
        var dpr = window.devicePixelRatio || 1;
        var w = Math.max(1, this.canvas.clientWidth), h = Math.max(1, this.canvas.clientHeight);
        if (this.w === w && this.h === h && this.dpr === dpr) return;
        this.w = w; this.h = h; this.dpr = dpr;
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.clear();
    };

    SweepChannel.prototype.clear = function () {
        this.ctx.clearRect(0, 0, this.w, this.h);
        this.lastY = null; this.lastCol = -1;
    };

    // Forget drawing position (after reset); next draw starts fresh from the current sample
    SweepChannel.prototype.reset = function () {
        this.clear();
        this.lastIdx = this.engine.sampleCount - 1;
    };

    SweepChannel.prototype._clearRange = function (x0, x1) {
        // clear [x0, x1) with wrap-around
        if (x1 - x0 >= this.w) { this.ctx.clearRect(0, 0, this.w, this.h); return; }
        var a = x0 % this.w, b = x1 % this.w;
        if (a <= b) this.ctx.clearRect(a, 0, b - a, this.h);
        else { this.ctx.clearRect(a, 0, this.w - a, this.h); this.ctx.clearRect(0, 0, b, this.h); }
    };

    /** Draw everything computed since the last call. If `enabled` is false the canvas is left blank. */
    SweepChannel.prototype.draw = function (enabled) {
        var eng = this.engine, end = eng.sampleCount - 1;
        if (end <= this.lastIdx) return;
        var start = Math.max(this.lastIdx + 1, eng.oldestSample());
        if (start > this.lastIdx + 1) this.lastY = null; // fell behind (tab hidden): don't join across the gap
        if (!enabled) {
            if (!this.blank) { this.clear(); this.blank = true; }
            this.lastIdx = end; return;
        }
        if (this.blank) { this.blank = false; this.lastY = null; }

        var ctx = this.ctx, h = this.h;
        var step = (root.SimEngine && root.SimEngine.STEP) || 4; // ms per sample
        var pxPerSample = this.mmPerSec * PX_PER_MM * step / 1000;
        var xStartAbs = start * pxPerSample, xEndAbs = end * pxPerSample;
        // start one pixel past the last drawn column so the previous frame's edge isn't nicked
        this._clearRange(Math.floor(xStartAbs) + 1, xEndAbs + ERASE_PX);

        var color = typeof this.color === 'function' ? this.color() : this.color;
        var base = this.fill ? this.baseline(h) : 0;
        if (this.fill) { ctx.fillStyle = color; ctx.globalAlpha = 0.22; }
        var path = [];
        var prevX = this.lastY == null ? null : this.lastX, prevY = this.lastY;
        for (var i = start; i <= end; i++) {
            var x = (i * pxPerSample) % this.w;
            var y = this.map(eng.get(this.ch, i), h);
            y = y < 1 ? 1 : y > h - 1 ? h - 1 : y;
            if (prevX != null && x < prevX) { path.push(null); prevX = null; } // wrapped: break the line
            if (prevX == null) path.push([x, y, true]); else path.push([x, y, false]);
            if (this.fill) {
                var col = Math.floor(x);
                if (col !== this.lastCol) { ctx.fillRect(col, Math.min(y, base), 1, Math.abs(base - y)); this.lastCol = col; }
            }
            prevX = x; prevY = y;
        }
        ctx.globalAlpha = 1;
        // stroke
        ctx.strokeStyle = color; ctx.lineWidth = this.lineWidth; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.beginPath();
        var first = true;
        if (this.lastY != null) { ctx.moveTo(this.lastX, this.lastY); first = false; }
        for (var k = 0; k < path.length; k++) {
            var pt = path[k];
            if (pt === null) { first = true; continue; }
            if (first || pt[2]) { ctx.moveTo(pt[0], pt[1]); first = false; }
            else ctx.lineTo(pt[0], pt[1]);
        }
        ctx.stroke();
        this.lastIdx = end; this.lastX = prevX; this.lastY = prevY;
    };

    root.SweepChannel = SweepChannel;
}(typeof self !== 'undefined' ? self : this));
