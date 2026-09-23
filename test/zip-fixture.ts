import { crc32, deflateRawSync } from 'node:zlib';

// Independent minimal fixture writer: permits invalid names/headers that a
// production ZIP writer correctly refuses to emit.
export interface Member { name: string | Buffer; data?: Buffer; size?: number; mode?: number; flags?: number; crc?: number; deflate?: boolean; localName?: string }
export function fixture(members: Member[]): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const m of members) {
    const name = Buffer.from(m.name); const localName = m.localName ? Buffer.from(m.localName) : name;
    const data = m.data ?? Buffer.from('hello'); const packed = m.deflate ? deflateRawSync(data) : data;
    const crc = m.crc ?? crc32(data); const size = m.size ?? data.length;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(m.flags ?? 0x800, 6);
    local.writeUInt16LE(m.deflate ? 8 : 0, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(localName.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50); cd.writeUInt16LE(0x314, 4);
    local.copy(cd, 6, 4, 26); cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(((m.mode ?? 0o100644) * 65536) >>> 0, 38); cd.writeUInt32LE(offset, 42);
    locals.push(local, localName, packed); central.push(cd, name); offset += local.length + localName.length + packed.length;
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(Buffer.concat(central).length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}
