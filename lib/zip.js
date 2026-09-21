const zlib = require("zlib");

// CRC32 lookup table
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[i] = c >>> 0;
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function toDosDateTime(d) {
  const date = d || new Date();
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xFFFF;
  return { time, date: dosDate };
}

/**
 * Creates a standard ZIP archive buffer from a list of files.
 * @param {Array<{ name: string, data: Buffer|string }>} files
 * @returns {Buffer} ZIP file buffer
 */
function createZip(files) {
  const localChunks = [];
  const cdChunks = [];
  let offset = 0;
  const dos = toDosDateTime();

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const rawData = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data || "", "utf8");
    const compressedData = zlib.deflateRawSync(rawData, { level: 9 });
    const crc = crc32(rawData);
    const uncompressedSize = rawData.length;
    const compressedSize = compressedData.length;

    // Local file header (30 bytes)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4);          // version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6);      // flags (UTF-8 bit)
    localHeader.writeUInt16LE(8, 8);           // compression method (deflate)
    localHeader.writeUInt16LE(dos.time, 10);
    localHeader.writeUInt16LE(dos.date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);          // extra field length

    localChunks.push(localHeader, nameBuf, compressedData);

    // Central directory header (46 bytes)
    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0);   // signature
    cdHeader.writeUInt16LE(20, 4);           // version made by
    cdHeader.writeUInt16LE(20, 6);           // version needed
    cdHeader.writeUInt16LE(0x0800, 8);       // flags
    cdHeader.writeUInt16LE(8, 10);           // compression method
    cdHeader.writeUInt16LE(dos.time, 12);
    cdHeader.writeUInt16LE(dos.date, 14);
    cdHeader.writeUInt32LE(crc, 16);
    cdHeader.writeUInt32LE(compressedSize, 20);
    cdHeader.writeUInt32LE(uncompressedSize, 24);
    cdHeader.writeUInt16LE(nameBuf.length, 28);
    cdHeader.writeUInt16LE(0, 30);           // extra field length
    cdHeader.writeUInt16LE(0, 32);           // comment length
    cdHeader.writeUInt16LE(0, 34);           // disk number
    cdHeader.writeUInt16LE(0, 36);           // internal attributes
    cdHeader.writeUInt32LE(0, 38);           // external attributes
    cdHeader.writeUInt32LE(offset, 42);      // local header offset

    cdChunks.push(cdHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + compressedData.length;
  }

  const cdOffset = offset;
  const cdBuf = Buffer.concat(cdChunks);
  const cdSize = cdBuf.length;

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, cdBuf, eocd]);
}

module.exports = { createZip };
