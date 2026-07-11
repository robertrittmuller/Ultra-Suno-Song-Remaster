const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const yauzl = require('yauzl');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.aac', '.m4a', '.mp4']);
const MAX_STEM_COUNT = 32;
const MAX_STEM_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

function isAudioEntry(entry) {
  return !entry.fileName.endsWith('/') &&
    AUDIO_EXTENSIONS.has(path.extname(entry.fileName).toLowerCase());
}

function getSafeFileName(entryName, usedNames) {
  const baseName = path.basename(entryName.replace(/\\/g, '/'))
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .trim() || 'stem.wav';
  const extension = path.extname(baseName);
  const name = path.basename(baseName, extension);
  let candidate = baseName;
  let duplicate = 2;

  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${name} (${duplicate++})${extension}`;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

class ZipReader extends yauzl.RandomAccessReader {
  constructor(fd, patches) {
    super();
    this.fd = fd;
    this.patches = patches;
  }

  _readStreamForRange(start, end) {
    let position = start;
    const reader = this;
    return new Readable({
      read() {
        if (position >= end) {
          this.push(null);
          return;
        }
        const readStart = position;
        const length = Math.min(64 * 1024, end - readStart);
        const chunk = Buffer.allocUnsafe(length);
        position += length;
        fs.read(reader.fd, chunk, 0, length, readStart, (error, bytesRead) => {
          if (error) return this.destroy(error);
          if (bytesRead !== length) return this.destroy(new Error('Unexpected end of ZIP file'));
          for (const patch of reader.patches) {
            const index = patch.position - readStart;
            if (index >= 0 && index < bytesRead) chunk[index] = patch.value;
          }
          this.push(chunk);
        });
      }
    });
  }

  close(callback) {
    fs.close(this.fd, callback);
  }
}

function findEndOfCentralDirectory(fd, size, callback) {
  const length = Math.min(size, 22 + 0xffff);
  const start = size - length;
  const buffer = Buffer.alloc(length);
  fs.read(fd, buffer, 0, length, start, (error, bytesRead) => {
    if (error) return callback(error);
    for (let index = bytesRead - 22; index >= 0; index--) {
      if (buffer.readUInt32LE(index) !== 0x06054b50) continue;
      const commentLength = buffer.readUInt16LE(index + 20);
      if (commentLength === bytesRead - index - 22) return callback(null, start + index, buffer);
    }
    callback(new Error('End of central directory record not found'));
  });
}

function openArchive(archivePath, options, callback) {
  fs.open(archivePath, 'r', (openError, fd) => {
    if (openError) return callback(openError);
    fs.fstat(fd, (statError, stats) => {
      if (statError) {
        fs.close(fd, () => callback(statError));
        return;
      }
      findEndOfCentralDirectory(fd, stats.size, (directoryError, directoryOffset, buffer) => {
        if (directoryError) {
          fs.close(fd, () => callback(directoryError));
          return;
        }

        // Suno's ZIP64 exports use the ZIP64 sentinel (0xffff) for this
        // field. Older yauzl releases reject it as a multi-disk archive
        // before reaching their ZIP64 parser, so present it as disk zero.
        const diskNumber = buffer.readUInt16LE(directoryOffset - (stats.size - buffer.length) + 4);
        const patches = diskNumber === 0xffff
          ? [{ position: directoryOffset + 4, value: 0 }, { position: directoryOffset + 5, value: 0 }]
          : [];
        const reader = new ZipReader(fd, patches);
        yauzl.fromRandomAccessReader(reader, stats.size, options, (zipError, zipfile) => {
          if (zipError) {
            reader.close(() => callback(zipError));
            return;
          }
          callback(null, zipfile);
        });
      });
    });
  });
}

function extractSunoStems(archivePath, temporaryRoot) {
  return new Promise((resolve, reject) => {
    let archive;
    let destination;
    let settled = false;
    let totalBytes = 0;
    const stems = [];
    const usedNames = new Set();

    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (archive) archive.close();
      if (destination) fs.rm(destination, { recursive: true, force: true }, () => reject(error));
      else reject(error);
    };

    try {
      destination = fs.mkdtempSync(path.join(temporaryRoot, 'suno-stems-'));
    } catch (error) {
      reject(new Error(`Could not create a temporary folder for stems: ${error.message}`));
      return;
    }

    openArchive(archivePath, { lazyEntries: true, autoClose: true }, (openError, zipfile) => {
      if (openError) {
        fail(new Error(`Could not open the stems ZIP: ${openError.message}`));
        return;
      }

      archive = zipfile;
      archive.on('error', (error) => fail(new Error(`Could not read the stems ZIP: ${error.message}`)));
      archive.on('entry', (entry) => {
        if (settled) return;

        if (!isAudioEntry(entry)) {
          archive.readEntry();
          return;
        }

        if (stems.length >= MAX_STEM_COUNT) {
          fail(new Error(`The ZIP contains more than ${MAX_STEM_COUNT} audio stems.`));
          return;
        }
        if (entry.uncompressedSize > MAX_STEM_BYTES || totalBytes + entry.uncompressedSize > MAX_TOTAL_BYTES) {
          fail(new Error('The stems ZIP is too large to extract safely.'));
          return;
        }
        totalBytes += entry.uncompressedSize;

        const name = getSafeFileName(entry.fileName, usedNames);
        const outputPath = path.join(destination, name);
        archive.openReadStream(entry, (streamError, readStream) => {
          if (streamError) {
            fail(new Error(`Could not extract ${name}: ${streamError.message}`));
            return;
          }

          const writeStream = fs.createWriteStream(outputPath, { flags: 'wx' });
          readStream.on('error', (error) => fail(new Error(`Could not extract ${name}: ${error.message}`)));
          writeStream.on('error', (error) => fail(new Error(`Could not save ${name}: ${error.message}`)));
          writeStream.on('finish', () => {
            if (settled) return;
            stems.push({ name, path: outputPath });
            archive.readEntry();
          });
          readStream.pipe(writeStream);
        });
      });
      archive.on('end', () => {
        if (settled) return;
        if (stems.length === 0) {
          fail(new Error('No supported audio stems were found in this ZIP.'));
          return;
        }
        settled = true;
        resolve(stems);
      });
      archive.readEntry();
    });
  });
}

module.exports = { AUDIO_EXTENSIONS, extractSunoStems };
