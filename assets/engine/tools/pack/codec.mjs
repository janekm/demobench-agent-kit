// DBLZ: literal bits + LZ matches, interlaced Elias-gamma lengths and
// Rice-like distances (gamma high part + k low bits). No runtime tables.
const gammaCost = n => 2 * (31 - Math.clz32(n)) + 1;

class Bits {
  bytes = []; value = 0; used = 0; count = 0;
  bit(n) {
    this.value |= (n & 1) << this.used++; this.count++;
    if (this.used === 8) { this.bytes.push(this.value); this.value = this.used = 0; }
  }
  bits(n, count) { for (let i = count - 1; i >= 0; i--) this.bit(n >>> i); }
  gamma(n) {
    for (let i = 30 - Math.clz32(n); i >= 0; i--) { this.bit(1); this.bit(n >>> i); }
    this.bit(0);
  }
  finish() { if (this.used) this.bytes.push(this.value); return Uint8Array.from(this.bytes); }
}

// Nearest-first hash chains; a farther match is useful only if it is longer.
// Cached equality endpoints make long periodic runs linear rather than quadratic.
function matches(data, chainLimit) {
  const head = new Int32Array(65536).fill(-1), prev = new Int32Array(data.length).fill(-1);
  const equalEnd = new Uint32Array(data.length + 1), result = Array(data.length);
  for (let i = 0; i + 1 < data.length; i++) {
    const key = data[i] * 256 + data[i + 1], list = [];
    let best = 1, p = head[key], tries = 0;
    while (p >= 0 && tries++ < chainLimit) {
      const distance = i - p;
      let len = Math.max(2, equalEnd[distance] - i);
      while (i + len < data.length && data[i + len] === data[p + len]) len++;
      equalEnd[distance] = i + len;
      if (len > best) { list.push([len, distance]); best = len; }
      if (i + best === data.length) break;
      p = prev[p];
    }
    prev[i] = head[key]; head[key] = i; result[i] = list;
  }
  return result;
}

// A range-minimum tree chooses the cheapest suffix inside each gamma cost tier.
// This is optimal parsing over the discovered matches, including shorter matches.
function parse(data, found, k) {
  const n = data.length, cost = new Uint32Array(n + 1).fill(0x3fffffff);
  let size = 1; while (size < n + 1) size *= 2;
  const tree = new Int32Array(size * 2).fill(n + 1);
  const value = index => index > n ? 0x3fffffff : cost[index];
  const better = (a, b) => value(a) < value(b) ? a : b;
  const put = index => {
    let p = size + index; tree[p] = index;
    while ((p >>= 1)) tree[p] = better(tree[p * 2], tree[p * 2 + 1]);
  };
  const query = (a, b) => {
    let answer = n + 1;
    for (a += size, b += size + 1; a < b; a >>= 1, b >>= 1) {
      if (a & 1) answer = better(answer, tree[a++]);
      if (b & 1) answer = better(answer, tree[--b]);
    }
    return answer;
  };
  const lengths = new Uint32Array(n), distances = new Uint32Array(n);
  cost[n] = 0; put(n);
  for (let i = n - 1; i >= 0; i--) {
    cost[i] = 9 + cost[i + 1]; lengths[i] = 1;
    let min = 2;
    for (const [max, distance] of found[i] ?? []) {
      const fixed = 1 + gammaCost(((distance - 1) >>> k) + 1) + k;
      for (let power = 1; power + 1 <= max; power *= 2) {
        const lo = Math.max(min, power + 1), hi = Math.min(max, power * 2);
        if (lo > hi) continue;
        const next = query(i + lo, i + hi);
        const candidate = fixed + gammaCost(power) + cost[next];
        if (candidate < cost[i]) {
          cost[i] = candidate; lengths[i] = next - i; distances[i] = distance;
        }
      }
      min = max + 1;
    }
    put(i);
  }
  const bits = new Bits(); let literals = 0, matchCount = 0;
  for (let i = 0; i < n;) {
    const len = lengths[i], distance = distances[i];
    bits.bit(distance ? 1 : 0);
    if (!distance) { bits.bits(data[i], 8); literals++; }
    else {
      bits.gamma(len - 1); bits.gamma(((distance - 1) >>> k) + 1);
      bits.bits(distance - 1, k); matchCount++;
    }
    i += len;
  }
  return { bytes: bits.finish(), bits: bits.count, k, literals, matches: matchCount };
}

export function compressCandidates(data, { chainLimit = 256 } = {}) {
  if (!data.length || data.length > 131072) throw new Error('Image must contain 1..131072 bytes');
  const found = matches(data, chainLimit);
  return Array.from({ length: 9 }, (_, k) => parse(data, found, k));
}

export function decompress(bytes, length, k) {
  if (!Number.isInteger(length) || length < 1 || length > 131072 || !Number.isInteger(k) || k < 0 || k > 8)
    throw new Error('Invalid DBLZ parameters');
  let at = 0, out = 0; const result = new Uint8Array(length);
  const bit = () => { if (at >= bytes.length * 8) throw new Error('Truncated DBLZ stream'); return (bytes[at >>> 3] >>> (at++ & 7)) & 1; };
  const gamma = () => { let n = 1; while (bit()) { n = n * 2 + bit(); if (n > 131072) throw new Error('Invalid DBLZ gamma'); } return n; };
  while (out < length) {
    if (!bit()) { let byte = 0; for (let i = 0; i < 8; i++) byte = byte * 2 + bit(); result[out++] = byte; }
    else {
      const len = gamma() + 1; let distance = gamma() - 1;
      for (let i = 0; i < k; i++) distance = distance * 2 + bit();
      distance++;
      if (distance > out || out + len > length) throw new Error('Invalid DBLZ match');
      for (let i = 0; i < len; i++) { result[out] = result[out - distance]; out++; }
    }
  }
  return result;
}

export function shuffle4(data) {
  const result = new Uint8Array(Math.ceil(data.length / 4) * 4), words = result.length / 4;
  for (let i = 0; i < data.length; i++) result[(i % 4) * words + (i >>> 2)] = data[i];
  return result;
}

export function unshuffle4(data) {
  if (data.length % 4) throw new Error('Invalid shuffled image size');
  const result = new Uint8Array(data.length), words = data.length / 4;
  for (let i = 0; i < data.length; i++) result[i] = data[(i % 4) * words + (i >>> 2)];
  return result;
}
