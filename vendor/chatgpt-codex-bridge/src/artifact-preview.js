import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

const TEXT_PREVIEW_LIMIT = 120_000;
const LARGE_FILE_PREVIEW_LIMIT = 20_000_000;

function artifactExtension(artifact = {}) {
  return (artifact.filename || "").split(".").pop()?.toLowerCase() || "";
}

function xmlDecode(value = "") {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripXml(value = "") {
  return xmlDecode(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function attr(source = "", name) {
  const match = source.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return match ? xmlDecode(match[1]) : "";
}

function tagPattern(tagName) {
  const localName = tagName.split(":").pop();
  return `(?:[A-Za-z0-9_-]+:)?${localName}`;
}

function extractTagTexts(xml = "", tagName) {
  const texts = [];
  const tag = tagPattern(tagName);
  const regex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  let match;
  while ((match = regex.exec(xml))) {
    const text = stripXml(match[1]);
    if (text) texts.push(text);
  }
  return texts;
}

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 22 - 0xffff);
  for (let index = buffer.length - 22; index >= minOffset; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      return index;
    }
  }
  throw new Error("ZIP central directory not found");
}

function readZipEntries(buffer) {
  const records = readZipEntryRecords(buffer);
  const entries = new Map();

  for (const record of records) {
    if (record.data) {
      entries.set(record.name, record.data);
    }
  }

  return entries;
}

function readZipEntryRecords(buffer) {
  const endOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  let cursor = buffer.readUInt32LE(endOffset + 16);
  const records = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("Invalid ZIP central directory entry");
    }

    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const filenameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const filename = buffer
      .subarray(cursor + 46, cursor + 46 + filenameLength)
      .toString("utf8")
      .replaceAll("\\", "/");
    const directory = filename.endsWith("/");

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error("Invalid ZIP local entry");
    }

    const localFilenameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localFilenameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let data = null;
    if (method === 0) {
      data = compressed;
    } else if (method === 8) {
      data = inflateRawSync(compressed);
    }

    records.push({
      name: filename,
      method,
      compressedSize,
      size,
      directory,
      data
    });

    cursor += 46 + filenameLength + extraLength + commentLength;
  }

  return records;
}

function columnIndex(cellRef = "", fallback) {
  const letters = cellRef.match(/^[A-Z]+/i)?.[0] || "";
  if (!letters) return fallback;
  return [...letters.toUpperCase()].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function sharedStringsFromWorkbook(entries) {
  const sharedXml = entries.get("xl/sharedStrings.xml")?.toString("utf8") || "";
  if (!sharedXml) return [];
  return [...sharedXml.matchAll(/<(?:[A-Za-z0-9_-]+:)?si\b[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?si>/gi)].map((match) =>
    extractTagTexts(match[0], "t").join("")
  );
}

function cellValue(cellXml, cellAttrs, sharedStrings) {
  const type = attr(cellAttrs, "t");
  if (type === "inlineStr") {
    return extractTagTexts(cellXml, "t").join("");
  }

  const rawValue = cellXml.match(/<(?:[A-Za-z0-9_-]+:)?v\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?v>/i)?.[1] || "";
  const value = stripXml(rawValue);
  if (type === "s") {
    return sharedStrings[Number.parseInt(value, 10)] ?? value;
  }
  return value;
}

function previewLimit(options, compactLimit, fullLimit) {
  return options?.full ? fullLimit : compactLimit;
}

function parseSpreadsheet(entries, options = {}) {
  const sheetName = [...entries.keys()].find((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name));
  const sheetXml = sheetName ? entries.get(sheetName).toString("utf8") : "";
  const sharedStrings = sharedStringsFromWorkbook(entries);
  const rows = [];

  for (const rowMatch of sheetXml.matchAll(
    /<(?:[A-Za-z0-9_-]+:)?row\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?row>/gi
  )) {
    const row = [];
    let fallbackColumn = 0;
    for (const cellMatch of rowMatch[1].matchAll(
      /<(?:[A-Za-z0-9_-]+:)?c\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?c>/gi
    )) {
      const cellAttrs = cellMatch[1] || "";
      const column = columnIndex(attr(cellAttrs, "r"), fallbackColumn);
      row[column] = cellValue(cellMatch[2], cellAttrs, sharedStrings);
      fallbackColumn = column + 1;
    }

    while (row.length && !row.at(-1)) row.pop();
    if (row.some((cell) => String(cell || "").trim())) {
      rows.push(row.map((cell) => String(cell ?? "")));
    }
  }

  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const rowLimit = previewLimit(options, 10, 100);
  const columnLimit = previewLimit(options, 8, 32);
  const previewRows = rows.slice(0, rowLimit).map((row) => row.slice(0, columnLimit));
  return {
    rowCount: rows.length,
    columnCount,
    rows: previewRows,
    truncated: rows.length > previewRows.length || columnCount > columnLimit
  };
}

function slideIndex(filename) {
  return Number.parseInt(filename.match(/slide(\d+)\.xml$/i)?.[1] || "0", 10);
}

function parsePresentation(entries, options = {}) {
  const slideFiles = [...entries.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => slideIndex(a) - slideIndex(b));

  const slides = slideFiles.map((filename, index) => {
    const texts = extractTagTexts(entries.get(filename).toString("utf8"), "a:t");
    return {
      index: index + 1,
      title: texts[0] || `第 ${index + 1} 页`,
      body: texts.slice(1).join(" ")
    };
  });

  const slideLimit = previewLimit(options, 8, 60);
  return {
    slideCount: slides.length,
    slides: slides.slice(0, slideLimit),
    truncated: slides.length > slideLimit
  };
}

function parseDocument(entries, options = {}) {
  const documentXml = entries.get("word/document.xml")?.toString("utf8") || "";
  const paragraphs = [];
  const paragraphRegex =
    /<(?:[A-Za-z0-9_-]+:)?p\b[^>]*>[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?p>/gi;

  for (const match of documentXml.matchAll(paragraphRegex)) {
    const text = extractTagTexts(match[0], "w:t").join("").trim();
    if (text) paragraphs.push(text);
  }

  if (paragraphs.length === 0) {
    const fallback = extractTagTexts(documentXml, "w:t").join("\n").trim();
    if (fallback) paragraphs.push(fallback);
  }

  const paragraphLimit = previewLimit(options, 12, 240);
  return {
    paragraphCount: paragraphs.length,
    paragraphs: paragraphs.slice(0, paragraphLimit),
    truncated: paragraphs.length > paragraphLimit
  };
}

function parseArchive(records, options = {}) {
  const entryLimit = previewLimit(options, 50, 500);
  return {
    entryCount: records.length,
    entries: records.slice(0, entryLimit).map((entry) => ({
      name: entry.name,
      size: entry.size,
      compressedSize: entry.compressedSize,
      directory: entry.directory
    })),
    truncated: records.length > entryLimit
  };
}

function parsePdf(buffer) {
  const text = buffer.toString("latin1");
  const pageCount = (text.match(/\/Type\s*\/Page\b/g) || []).length;
  return {
    pageCount,
    canInlinePreview: true
  };
}

function parsePsd(buffer) {
  const colorModes = {
    0: "Bitmap",
    1: "Grayscale",
    2: "Indexed",
    3: "RGB",
    4: "CMYK",
    7: "Multichannel",
    8: "Duotone",
    9: "Lab"
  };

  if (buffer.length < 26 || buffer.subarray(0, 4).toString("ascii") !== "8BPS") {
    return {
      readable: false,
      message: "PSD 头信息无法读取。"
    };
  }

  const colorModeCode = buffer.readUInt16BE(24);
  return {
    readable: true,
    version: buffer.readUInt16BE(4),
    channels: buffer.readUInt16BE(12),
    height: buffer.readUInt32BE(14),
    width: buffer.readUInt32BE(18),
    depth: buffer.readUInt16BE(22),
    colorModeCode,
    colorMode: colorModes[colorModeCode] || `Mode ${colorModeCode}`
  };
}

function parseCsv(text, options = {}) {
  const rows = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, "")));
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const rowLimit = previewLimit(options, 10, 100);
  const columnLimit = previewLimit(options, 8, 32);
  const previewRows = rows.slice(0, rowLimit).map((row) => row.slice(0, columnLimit));
  return {
    rowCount: rows.length,
    columnCount,
    rows: previewRows,
    truncated: rows.length > previewRows.length || columnCount > columnLimit
  };
}

export async function buildArtifactPreview(artifact, options = {}) {
  const extension = artifactExtension(artifact);
  const base = {
    artifact,
    title: artifact.filename || "未命名文件"
  };
  const sizeBytes = Number(artifact.sizeBytes || 0);
  if (sizeBytes > LARGE_FILE_PREVIEW_LIMIT) {
    return {
      ...base,
      kind: "file",
      preview: {
        large: true,
        sizeBytes,
        message: "文件较大，完整文件已交给 GPT。Bridge 只展示摘要；需要细看时请放大或下载查看。"
      }
    };
  }

  const buffer = await readFile(artifact.filePath);

  if (extension === "xlsx") {
    const entries = readZipEntries(buffer);
    return {
      ...base,
      kind: "spreadsheet",
      preview: parseSpreadsheet(entries, options)
    };
  }

  if (extension === "pptx") {
    const entries = readZipEntries(buffer);
    return {
      ...base,
      kind: "presentation",
      preview: parsePresentation(entries, options)
    };
  }

  if (extension === "docx") {
    const entries = readZipEntries(buffer);
    return {
      ...base,
      kind: "document",
      preview: parseDocument(entries, options)
    };
  }

  if (extension === "zip") {
    return {
      ...base,
      kind: "archive",
      preview: parseArchive(readZipEntryRecords(buffer), options)
    };
  }

  if (extension === "pdf" || (artifact.contentType || "").toLowerCase() === "application/pdf") {
    return {
      ...base,
      kind: "pdf",
      preview: parsePdf(buffer)
    };
  }

  if (extension === "psd") {
    return {
      ...base,
      kind: "psd",
      preview: parsePsd(buffer)
    };
  }

  if (extension === "csv") {
    return {
      ...base,
      kind: "spreadsheet",
      preview: parseCsv(buffer.toString("utf8"), options)
    };
  }

  if (
    (artifact.contentType || "").startsWith("text/") ||
    ["txt", "md", "json", "html", "css", "js", "ts", "py", "log", "xml", "yaml", "yml"].includes(extension)
  ) {
    const text = buffer.toString("utf8");
    return {
      ...base,
      kind: "text",
      preview: {
        text: text.slice(0, TEXT_PREVIEW_LIMIT),
        truncated: text.length > TEXT_PREVIEW_LIMIT,
        charCount: text.length,
        lineCount: text.split(/\r?\n/).length
      }
    };
  }

  return {
    ...base,
    kind: "file",
    preview: {
      message: "这个文件需要下载后打开，或交给 Codex 分析。"
    }
  };
}
