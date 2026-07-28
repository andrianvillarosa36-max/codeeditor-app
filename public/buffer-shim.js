/* ============================================================
   buffer-shim.js — a minimal Buffer polyfill for isomorphic-git's
   internal hashing/encoding needs.

   Buffer doesn't exist in browsers at all; Node code (and libraries
   built for Node, like isomorphic-git's dependencies) normally get it
   from a bundler's auto-polyfill. We're not running a bundler, and
   after CDN path drift, an AMD-loader conflict, AND likely ES-module
   strictness all tripped up *external* attempts to provide this in
   this exact app, this is hand-written instead: zero dependencies,
   zero network requests, loaded the same proven way as our own code.

   Buffer is fundamentally a Uint8Array with extra convenience methods,
   so it's implemented as a real subclass — `instanceof Uint8Array`
   checks elsewhere in the git library still pass correctly.
   ============================================================ */
(function () {
  if (window.Buffer) return; // already provided somehow — don't override

  class Buffer extends Uint8Array {
    static from(data, encoding) {
      if (typeof data === 'string') return Buffer.fromString(data, encoding || 'utf8');
      if (data instanceof ArrayBuffer) return new Buffer(data);
      if (Array.isArray(data) || data instanceof Uint8Array) {
        const buf = new Buffer(data.length);
        buf.set(data);
        return buf;
      }
      if (data && data.buffer instanceof ArrayBuffer) {
        return Buffer.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      }
      throw new TypeError('Unsupported data type for Buffer.from');
    }

    static fromString(str, encoding) {
      encoding = (encoding || 'utf8').toLowerCase();
      if (encoding === 'utf8' || encoding === 'utf-8') {
        const bytes = new TextEncoder().encode(str);
        const buf = new Buffer(bytes.length);
        buf.set(bytes);
        return buf;
      }
      if (encoding === 'hex') {
        const len = Math.floor(str.length / 2);
        const buf = new Buffer(len);
        for (let i = 0; i < len; i++) buf[i] = parseInt(str.substr(i * 2, 2), 16);
        return buf;
      }
      if (encoding === 'base64') {
        const bin = atob(str);
        const buf = new Buffer(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        return buf;
      }
      if (encoding === 'latin1' || encoding === 'binary' || encoding === 'ascii') {
        const buf = new Buffer(str.length);
        for (let i = 0; i < str.length; i++) buf[i] = str.charCodeAt(i) & 0xff;
        return buf;
      }
      throw new TypeError('Unsupported encoding: ' + encoding);
    }

    static alloc(size, fill) {
      const buf = new Buffer(size);
      if (fill !== undefined) buf.fill(fill);
      return buf;
    }

    static allocUnsafe(size) { return new Buffer(size); }

    static concat(list, totalLength) {
      const length = totalLength !== undefined ? totalLength : list.reduce((sum, b) => sum + b.length, 0);
      const buf = new Buffer(length);
      let offset = 0;
      for (const item of list) { buf.set(item, offset); offset += item.length; }
      return buf;
    }

    static isBuffer(obj) { return obj instanceof Buffer; }

    static byteLength(str, encoding) { return Buffer.fromString(String(str), encoding).length; }

    toString(encoding, start, end) {
      encoding = (encoding || 'utf8').toLowerCase();
      const slice = (start !== undefined || end !== undefined)
        ? this.subarray(start || 0, end !== undefined ? end : this.length) : this;
      if (encoding === 'utf8' || encoding === 'utf-8') return new TextDecoder().decode(slice);
      if (encoding === 'hex') return Array.from(slice).map((b) => b.toString(16).padStart(2, '0')).join('');
      if (encoding === 'base64') {
        let bin = '';
        for (let i = 0; i < slice.length; i++) bin += String.fromCharCode(slice[i]);
        return btoa(bin);
      }
      if (encoding === 'latin1' || encoding === 'binary' || encoding === 'ascii') {
        let s = '';
        for (let i = 0; i < slice.length; i++) s += String.fromCharCode(slice[i]);
        return s;
      }
      throw new TypeError('Unsupported encoding: ' + encoding);
    }

    slice(start, end) { return Buffer.from(this.subarray(start, end)); }

    equals(other) {
      if (this.length !== other.length) return false;
      for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
      return true;
    }

    compare(other) {
      const len = Math.min(this.length, other.length);
      for (let i = 0; i < len; i++) if (this[i] !== other[i]) return this[i] < other[i] ? -1 : 1;
      if (this.length === other.length) return 0;
      return this.length < other.length ? -1 : 1;
    }
  }

  window.Buffer = Buffer;
})();
