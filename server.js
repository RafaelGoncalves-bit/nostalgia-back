import express from "express";
import fs from "node:fs";
import path from "node:path";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const GAMES_DIR = path.resolve(process.env.GAMES_DIR || "/games");
const MAX_RANGE_BYTES = Math.max(
  64 * 1024,
  Number(process.env.MAX_RANGE_BYTES || 2 * 1024 * 1024)
);

const ISO_SECTOR = 2048;
const ISO_PVD_OFFSET = 16 * ISO_SECTOR;
const DVD_LAYER_MAX_BLOCKS = 2295104;
const DL_SCAN_CHUNK_SECTORS = 8192; // 16 MiB por leitura
const dvdLayerCache = new Map();

app.disable("x-powered-by");

function safeGameId(value) {
  return /^[a-zA-Z0-9_-]+$/.test(value);
}

function getCatalog() {
  const catalogPath = path.join(GAMES_DIR, "catalog.json");
  if (!fs.existsSync(catalogPath)) return { games: [] };

  try {
    const parsed = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    return Array.isArray(parsed?.games) ? parsed : { games: [] };
  } catch (error) {
    console.error("catalog.json inválido:", error);
    return { games: [] };
  }
}

function findGame(id) {
  if (!safeGameId(id)) return null;
  return getCatalog().games.find((game) => game.id === id) || null;
}

function resolveGameFile(game, relativeFile) {
  if (!game || !safeGameId(game.id) || typeof relativeFile !== "string") return null;
  const gameDir = path.resolve(GAMES_DIR, game.id);
  const filePath = path.resolve(gameDir, relativeFile);
  if (!filePath.startsWith(gameDir + path.sep)) return null;
  return filePath;
}

function resolveDisc(game) {
  return resolveGameFile(game, game?.disc);
}

function gameDescriptor(game) {
  const discPath = resolveDisc(game);
  const available = Boolean(discPath && fs.existsSync(discPath) && fs.statSync(discPath).isFile());
  const extension = path.extname(game?.disc || "game.iso").replace(/^\./, "").toLowerCase() || "iso";

  return {
    id: game.id,
    name: game.name,
    platform: game.platform || "PS2",
    description: game.description || null,
    available,
    size: available ? fs.statSync(discPath).size : null,
    extension,
    discFile: available ? game.disc : null,
    streamUrl: `/games/${game.id}/disc`,
    diagnosticUrl: `/api/games/${game.id}/diagnostic`
  };
}

function readExact(fd, position, length) {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const count = fs.readSync(fd, buffer, done, length - done, position + done);
    if (count <= 0) break;
    done += count;
  }
  return buffer.subarray(0, done);
}


function hasIsoPvdMagic(buffer, offset = 0) {
  return (
    buffer.length >= offset + 6 &&
    buffer[offset] === 0x01 &&
    buffer.subarray(offset + 1, offset + 6).toString("ascii") === "CD001"
  );
}

function detectDvdLayer(fd, discPath, fileSize) {
  const stat = fs.fstatSync(fd);
  const cacheKey = `${discPath}:${fileSize}:${stat.mtimeMs}`;
  const cached = dvdLayerCache.get(cacheKey);
  if (cached) return cached;

  const imageBlockCount = Math.floor(fileSize / ISO_SECTOR);
  if (imageBlockCount < DVD_LAYER_MAX_BLOCKS) {
    const result = {
      dualLayer: false,
      imageBlockCount,
      secondLayerStart: 0,
      secondLayerStartBytes: 0,
      layerDetection: "single-layer-size"
    };
    dvdLayerCache.set(cacheKey, result);
    return result;
  }

  // DVD9. Antes de fazer a mesma varredura linear do Play!, teste o meio do
  // disco. Muitos dumps PS2 DVD9 (inclusive God of War SCUS-97399 intacto)
  // têm o segundo PVD exatamente na metade da imagem.
  const quickCandidates = [
    Math.floor(imageBlockCount / 2),
    Math.ceil(imageBlockCount / 2),
  ];

  for (const lba of [...new Set(quickCandidates)]) {
    const header = readExact(fd, lba * ISO_SECTOR, 6);
    if (hasIsoPvdMagic(header)) {
      const result = {
        dualLayer: true,
        imageBlockCount,
        secondLayerStart: lba,
        secondLayerStartBytes: lba * ISO_SECTOR,
        layerDetection: "midpoint"
      };
      dvdLayerCache.set(cacheKey, result);
      return result;
    }
  }

  // Fallback equivalente à heurística do Play!, mas executada localmente no
  // servidor e em blocos grandes. Assim o navegador não faz centenas de
  // milhares de HTTP Range requests de 6 bytes.
  const searchStartLba = Math.floor(imageBlockCount * 7 / 20);
  const chunkBytes = DL_SCAN_CHUNK_SECTORS * ISO_SECTOR;

  for (let baseLba = searchStartLba; baseLba < imageBlockCount; baseLba += DL_SCAN_CHUNK_SECTORS) {
    const sectorCount = Math.min(DL_SCAN_CHUNK_SECTORS, imageBlockCount - baseLba);
    const buffer = readExact(fd, baseLba * ISO_SECTOR, sectorCount * ISO_SECTOR);

    for (let sector = 0; sector < sectorCount; sector += 1) {
      const offset = sector * ISO_SECTOR;
      if (hasIsoPvdMagic(buffer, offset)) {
        const lba = baseLba + sector;
        const result = {
          dualLayer: true,
          imageBlockCount,
          secondLayerStart: lba,
          secondLayerStartBytes: lba * ISO_SECTOR,
          layerDetection: "server-scan"
        };
        dvdLayerCache.set(cacheKey, result);
        return result;
      }
    }
  }

  const result = {
    dualLayer: true,
    imageBlockCount,
    secondLayerStart: 0,
    secondLayerStartBytes: 0,
    layerDetection: "not-found"
  };
  dvdLayerCache.set(cacheKey, result);
  return result;
}

function guessContainer(header) {
  if (header.length >= 8 && header.subarray(0, 8).toString("ascii") === "MComprHD") return "CHD";
  if (header.length >= 4 && header.subarray(0, 4).toString("ascii") === "CISO") return "CSO";
  if (header.length >= 4 && header.subarray(0, 4).toString("ascii") === "Rar!") return "RAR";
  if (header.length >= 4 && header[0] === 0x50 && header[1] === 0x4B) return "ZIP";
  if (header.length >= 6 && header.subarray(0, 6).equals(Buffer.from([0x37,0x7A,0xBC,0xAF,0x27,0x1C]))) return "7Z";
  if (header.length >= 2 && header[0] === 0x1F && header[1] === 0x8B) return "GZIP";
  return "desconhecido/ISO bruto";
}

function cleanIsoText(buffer) {
  return buffer.toString("ascii").replace(/\0/g, "").trim();
}

function parseRootDirectory(fd, pvd, fileSize) {
  // ISO9660 Primary Volume Descriptor: root dir record começa no byte 156.
  if (pvd.length < 190) return { systemCnfFound: false, reason: "PVD curto" };

  const recordLength = pvd[156];
  if (recordLength < 34) return { systemCnfFound: false, reason: "Root directory record inválido" };

  const rootExtent = pvd.readUInt32LE(158);
  const rootSize = pvd.readUInt32LE(166);
  const rootOffset = rootExtent * ISO_SECTOR;

  if (rootExtent <= 0 || rootSize <= 0 || rootOffset >= fileSize) {
    return { systemCnfFound: false, rootExtent, rootSize, reason: "Root directory fora da imagem" };
  }

  const safeSize = Math.min(rootSize, 16 * 1024 * 1024, fileSize - rootOffset);
  const root = readExact(fd, rootOffset, safeSize);

  let pos = 0;
  while (pos < root.length) {
    const len = root[pos];
    if (len === 0) {
      pos = (Math.floor(pos / ISO_SECTOR) + 1) * ISO_SECTOR;
      continue;
    }
    if (pos + len > root.length || len < 34) break;

    const extent = root.readUInt32LE(pos + 2);
    const dataLength = root.readUInt32LE(pos + 10);
    const nameLength = root[pos + 32];
    const nameStart = pos + 33;
    const nameEnd = nameStart + nameLength;

    if (nameEnd <= pos + len) {
      const rawName = root.subarray(nameStart, nameEnd).toString("ascii");
      const normalized = rawName.replace(/;\d+$/, "").toUpperCase();

      if (normalized === "SYSTEM.CNF") {
        const fileOffset = extent * ISO_SECTOR;
        const readLength = Math.min(dataLength, 64 * 1024, Math.max(0, fileSize - fileOffset));
        const contents = readLength > 0 ? readExact(fd, fileOffset, readLength).toString("ascii") : "";
        const bootMatch = contents.match(/BOOT2?\s*=\s*cdrom0:\\([^;\r\n]+)/i);
        return {
          systemCnfFound: true,
          systemCnfName: rawName,
          systemCnfExtent: extent,
          systemCnfSize: dataLength,
          systemCnfPreview: contents.slice(0, 512),
          bootElf: bootMatch?.[1]?.trim() || null,
          rootExtent,
          rootSize
        };
      }
    }

    pos += len;
  }

  return { systemCnfFound: false, rootExtent, rootSize };
}

function diagnoseIso(discPath) {
  const stat = fs.statSync(discPath);
  const fileSize = stat.size;
  const fd = fs.openSync(discPath, "r");

  try {
    const header = readExact(fd, 0, Math.min(64, fileSize));
    const pvd = fileSize >= ISO_PVD_OFFSET + ISO_SECTOR
      ? readExact(fd, ISO_PVD_OFFSET, ISO_SECTOR)
      : Buffer.alloc(0);

    const pvdType = pvd.length > 0 ? pvd[0] : null;
    const pvdMagic = pvd.length >= 6 ? pvd.subarray(1, 6).toString("ascii") : "";
    const pvdVersion = pvd.length >= 7 ? pvd[6] : null;
    const validIso9660 = pvdType === 1 && pvdMagic === "CD001" && pvdVersion === 1;

    const layerInfo = detectDvdLayer(fd, discPath, fileSize);

    const base = {
      fileSize,
      headerHex: header.toString("hex"),
      containerGuess: guessContainer(header),
      pvdOffset: ISO_PVD_OFFSET,
      pvdType,
      pvdMagic,
      pvdVersion,
      validIso9660,
      pvdFirst64Hex: pvd.subarray(0, 64).toString("hex"),
      volumeId: validIso9660 && pvd.length >= 72 ? cleanIsoText(pvd.subarray(40, 72)) : null,
      ...layerInfo,
    };

    if (!validIso9660) return { ...base, systemCnfFound: false };
    return { ...base, ...parseRootDirectory(fd, pvd, fileSize) };
  } finally {
    fs.closeSync(fd);
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, rangeLimit: MAX_RANGE_BYTES });
});

app.get("/api/games", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ games: getCatalog().games.map(gameDescriptor) });
});

app.get("/api/games/:id/diagnostic", (req, res) => {
  const game = findGame(req.params.id);
  const discPath = resolveDisc(game);

  res.setHeader("Cache-Control", "no-store");

  if (!discPath || !fs.existsSync(discPath) || !fs.statSync(discPath).isFile()) {
    return res.status(404).json({ error: "Imagem de disco não encontrada." });
  }

  try {
    res.json(diagnoseIso(discPath));
  } catch (error) {
    console.error(`Falha diagnosticando ${game?.id}:`, error);
    res.status(500).json({ error: "Falha ao analisar a imagem.", detail: error.message });
  }
});

app.head("/games/:id/disc", (req, res) => {
  const game = findGame(req.params.id);
  const discPath = resolveDisc(game);

  if (!discPath || !fs.existsSync(discPath)) return res.sendStatus(404);

  const stat = fs.statSync(discPath);
  if (!stat.isFile()) return res.sendStatus(404);

  res.set({
    "Accept-Ranges": "bytes",
    "Content-Length": String(stat.size),
    "Content-Type": "application/octet-stream",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.status(200).end();
});

app.get("/games/:id/disc", (req, res) => {
  const game = findGame(req.params.id);
  const discPath = resolveDisc(game);

  if (!discPath || !fs.existsSync(discPath)) {
    return res.status(404).json({ error: "Imagem de disco não encontrada." });
  }

  const stat = fs.statSync(discPath);
  if (!stat.isFile()) return res.sendStatus(404);

  const fileSize = stat.size;
  const range = req.headers.range;

  res.set({
    "Accept-Ranges": "bytes",
    "Content-Type": "application/octet-stream",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });

  if (!range) {
    res.setHeader("Content-Range", `bytes */${fileSize}`);
    return res.status(416).json({
      error: "A imagem de disco só pode ser lida por HTTP Range.",
      size: fileSize
    });
  }

  const match = /^bytes=(\d+)-(\d*)$/.exec(range.trim());
  if (!match) {
    res.setHeader("Content-Range", `bytes */${fileSize}`);
    return res.sendStatus(416);
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : start + MAX_RANGE_BYTES - 1;
  const end = Math.min(requestedEnd, fileSize - 1);

  if (
    !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
    start < 0 || start >= fileSize || end < start
  ) {
    res.setHeader("Content-Range", `bytes */${fileSize}`);
    return res.sendStatus(416);
  }

  const chunkSize = end - start + 1;
  if (chunkSize > MAX_RANGE_BYTES) {
    res.setHeader("Content-Range", `bytes */${fileSize}`);
    return res.status(416).json({ error: `Range máximo: ${MAX_RANGE_BYTES} bytes.` });
  }

  res.status(206);
  res.set({
    "Content-Range": `bytes ${start}-${end}/${fileSize}`,
    "Content-Length": String(chunkSize)
  });

  const stream = fs.createReadStream(discPath, { start, end });
  stream.on("error", (error) => {
    console.error(`Erro lendo ${game.id} ${start}-${end}:`, error);
    res.destroy(error);
  });
  stream.pipe(res);
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (!res.headersSent) res.status(500).json({ error: "Erro interno." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Game Server API em 0.0.0.0:${PORT}`);
  console.log(`Diretório dos jogos: ${GAMES_DIR}`);
  console.log(`Range máximo: ${MAX_RANGE_BYTES} bytes`);
});
