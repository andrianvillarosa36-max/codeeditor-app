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

    static compare(a, b) { return Buffer.from(a).compare(b); }

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

    write(string, offset, length, encoding) {
      // Node's write() is overloaded: write(string[, offset[, length]][, encoding])
      if (typeof offset === 'string') { encoding = offset; offset = 0; length = this.length; }
      else if (typeof length === 'string') { encoding = length; length = this.length - (offset || 0); }
      else {
        if (offset === undefined) offset = 0;
        if (length === undefined) length = this.length - offset;
      }
      encoding = (encoding || 'utf8').toLowerCase();
      const encoded = Buffer.fromString(string, encoding);
      const toWrite = Math.min(length, encoded.length, this.length - offset);
      for (let i = 0; i < toWrite; i++) this[offset + i] = encoded[i];
      return toWrite;
    }

    copy(target, targetStart, sourceStart, sourceEnd) {
      targetStart = targetStart || 0;
      sourceStart = sourceStart || 0;
      sourceEnd = sourceEnd === undefined ? this.length : sourceEnd;
      let count = 0;
      for (let i = sourceStart; i < sourceEnd; i++) { target[targetStart + count] = this[i]; count++; }
      return count;
    }

    readUInt8(offset) { return this[offset]; }
    readUInt16BE(offset) { return (this[offset] << 8) | this[offset + 1]; }
    readUInt16LE(offset) { return (this[offset + 1] << 8) | this[offset]; }
    readUInt32BE(offset) {
      return ((this[offset] << 24) | (this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3]) >>> 0;
    }
    readUInt32LE(offset) {
      return ((this[offset + 3] << 24) | (this[offset + 2] << 16) | (this[offset + 1] << 8) | this[offset]) >>> 0;
    }
    writeUInt8(value, offset) { this[offset] = value & 0xff; return offset + 1; }
    writeUInt16BE(value, offset) {
      this[offset] = (value >>> 8) & 0xff; this[offset + 1] = value & 0xff; return offset + 2;
    }
    writeUInt16LE(value, offset) {
      this[offset] = value & 0xff; this[offset + 1] = (value >>> 8) & 0xff; return offset + 2;
    }
    writeUInt32BE(value, offset) {
      this[offset] = (value >>> 24) & 0xff; this[offset + 1] = (value >>> 16) & 0xff;
      this[offset + 2] = (value >>> 8) & 0xff; this[offset + 3] = value & 0xff; return offset + 4;
    }
    writeUInt32LE(value, offset) {
      this[offset] = value & 0xff; this[offset + 1] = (value >>> 8) & 0xff;
      this[offset + 2] = (value >>> 16) & 0xff; this[offset + 3] = (value >>> 24) & 0xff; return offset + 4;
    }

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
