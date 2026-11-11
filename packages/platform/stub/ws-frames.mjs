// Minimal RFC 6455 framing shared by the stub instance server and the e2e WebSocket client.
// Text, binary, ping, pong and close frames; fragmented messages are reassembled. No extensions.
import { createHash, randomBytes } from 'node:crypto';

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const OP = { cont: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

export function acceptKey(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** Encodes one frame. Clients must mask (RFC 6455 5.3); servers must not. */
export function encodeFrame(opcode, payload = Buffer.alloc(0), { mask = false } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  if (!mask) return Buffer.concat([header, data]);
  header[1] |= 0x80;
  const key = randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ key[i & 3];
  return Buffer.concat([header, key, masked]);
}

export function closePayload(code, reason = '') {
  const r = Buffer.from(reason);
  const b = Buffer.alloc(2 + r.length);
  b.writeUInt16BE(code, 0);
  r.copy(b, 2);
  return b;
}

export function parseClose(payload) {
  if (payload.length < 2) return { code: 1005, reason: '' };
  return { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString('utf8') };
}

/**
 * Feeds socket data in, calls onMessage({ opcode, payload }) for every complete message and
 * every control frame. Returns a function to push chunks.
 */
export function createFrameReader(onMessage) {
  let buf = Buffer.alloc(0);
  let fragments = null; // { opcode, parts }
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      let payload = buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const key = buf.subarray(off, off + 4);
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ key[i & 3];
        payload = out;
      } else {
        payload = Buffer.from(payload);
      }
      buf = buf.subarray(off + maskLen + len);
      if (opcode >= 0x8) {
        onMessage({ opcode, payload, masked });
      } else if (opcode === OP.cont) {
        if (!fragments) continue;
        fragments.parts.push(payload);
        if (fin) {
          onMessage({ opcode: fragments.opcode, payload: Buffer.concat(fragments.parts), masked });
          fragments = null;
        }
      } else if (!fin) {
        fragments = { opcode, parts: [payload] };
      } else {
        onMessage({ opcode, payload, masked });
      }
    }
  };
}
