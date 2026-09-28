import { deflateSync } from 'node:zlib';
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit=0; bit<8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type); const result = Buffer.alloc(data.length+12);
  result.writeUInt32BE(data.length,0); name.copy(result,4); data.copy(result,8);
  result.writeUInt32BE(crc32(Buffer.concat([name,data])), data.length+8); return result;
}
export function png(width, height, rgba) {
  if (rgba.length !== width*height*4) throw new Error('RGBA dimensions do not match');
  const header = Buffer.alloc(13); header.writeUInt32BE(width,0); header.writeUInt32BE(height,4);
  header[8]=8; header[9]=6;
  const scanlines=Buffer.alloc(height*(width*4+1));
  for(let y=0;y<height;y++) Buffer.from(rgba.subarray(y*width*4,(y+1)*width*4)).copy(scanlines,y*(width*4+1)+1);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(scanlines)),chunk('IEND',Buffer.alloc(0))]);
}
