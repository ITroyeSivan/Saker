// Parse scanner exports into normalized asset records.
//
// Supports the common shapes people actually have on disk: JSON, JSONL, CSV,
// httpx-style lines, nmap text reports and fscan/TScanPlus URL lists.

import { mergeAssets } from "dsh-saker/asset-inventory";

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return String(value).split(/[,;|]/).map((item) => item.trim()).filter(Boolean);
}

function recordToAsset(record, source) {
  if (!record || typeof record !== "object") return null;
  const target = record.target || record.url || record.host || record.input || record.domain;
  const ip = record.ip || record.host_ip || record.hostIp;
  const port = record.port || record.host_port;
  const tech = asList(record.tech || record.technologies || record.fingerprint || record.app || record.product);
  const sources = asList(record.sources || record.source || record.platform || source);
  const asset = {
    target: clean(target, 1000),
    host: clean(record.hostname || record.host || record.domain || record.url, 500),
    ip: clean(ip, 100),
    port: Number(port) || 0,
    protocol: clean(record.protocol || record.scheme, 30),
    title: clean(record.title || record.web_title || record.banner, 300),
    server: clean(record.server || record.web_server || record.service, 200),
    tech,
    tags: asList(record.tags || record.tag),
    sources,
  };
  if (!asset.target && !asset.host && !asset.ip) return null;
  return asset;
}

function recordsFromJson(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [value];
  for (const key of ["assets", "data", "results", "items", "list"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [value];
}

function splitCsvLine(line) {
  const out = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((item) => item.trim());
}

function recordsFromCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map((item) => item.toLowerCase().replace(/\s+/g, "_"));
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};
    headers.forEach((header, index) => { row[header] = cells[index] ?? ""; });
    return row;
  });
}

function recordsFromJsonl(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(JSON.parse(trimmed));
  }
  return out;
}

function recordsFromText(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  const urlRe = /https?:\/\/[^\s"'<>]+/gi;
  const hostPortRe = /\b((?:\d{1,3}\.){3}\d{1,3}|[A-Za-z0-9.-]+\.[A-Za-z]{2,}):(\d{1,5})\b/g;
  let lastHost = "";
  let lastIp = "";
  for (const line of lines) {
    const nmap = line.match(/^Nmap scan report for\s+(.+?)(?:\s+\(([^)]+)\))?\s*$/i);
    if (nmap) {
      lastHost = clean(nmap[1], 300);
      lastIp = clean(nmap[2] || "", 100);
      out.push({ target: lastHost, host: lastHost, ip: lastIp, source: "nmap" });
      continue;
    }
    const port = line.match(/^(\d{1,5})\/(tcp|udp)\s+open\s+(\S+)(?:\s+(.+))?/i);
    if (port && (lastHost || lastIp)) {
      out.push({
        target: lastHost || lastIp,
        host: lastHost,
        ip: lastIp,
        port: Number(port[1]),
        protocol: port[2].toLowerCase(),
        server: clean(port[3], 100),
        title: clean(port[4], 300),
        source: "nmap",
      });
      continue;
    }
    const urls = line.match(urlRe) || [];
    for (const url of urls) out.push({ target: url.replace(/[),.;]+$/, ""), source: "text" });
    for (const match of line.matchAll(hostPortRe)) {
      const token = match[0];
      if (urls.some((url) => url.includes(token))) continue;
      out.push({ target: token, host: match[1], port: Number(match[2]), source: "text" });
    }
  }
  return out;
}

export function detectFormat(text) {
  const trim = String(text || "").trim();
  if (!trim) return "text";
  if (trim.startsWith("{") || trim.startsWith("[")) {
    try { JSON.parse(trim); return "json"; } catch { /* try JSONL below */ }
  }
  const firstLine = trim.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("{") && firstLine.endsWith("}")) return "jsonl";
  if (firstLine.includes(",") && firstLine.split(",").length >= 3) return "csv";
  return "text";
}

export function parseAssetPayload(text, options = {}) {
  const format = options.format && options.format !== "auto" ? options.format : detectFormat(text);
  let records;
  if (format === "json") records = recordsFromJson(JSON.parse(String(text || "")));
  else if (format === "jsonl") records = recordsFromJsonl(String(text || ""));
  else if (format === "csv") records = recordsFromCsv(String(text || ""));
  else records = recordsFromText(String(text || ""));
  const assets = records.map((record) => recordToAsset(record, options.source)).filter(Boolean);
  const merged = mergeAssets({ schema: "saker.asset-inventory/1", updatedAt: new Date().toISOString(), assets: [] }, assets, {
    source: options.source,
  });
  return {
    format,
    totalRecords: records.length,
    assets: merged.inventory.assets,
    deduped: merged.merged,
    skipped: records.length - assets.length,
  };
}
