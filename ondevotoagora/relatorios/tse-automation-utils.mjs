import { parseSemicolonCsv, validateCsv } from "../csv-utils.mjs";

export const TSE_SECTIONS_URL = "https://sig.tse.jus.br/ords/dwapr/r/seai/sig-eleicao-eleitorado/se%C3%A7%C3%B5es-alteradas";
export const TSE_SOURCE_URL = "https://sig.tse.jus.br/ords/dwapr/r/seai/sig-eleicao-eleitorado/se%C3%A7%C3%B5es-alteradas";
export const TSE_ARCHIVE_BASENAME = "secoes_eleitorais_alteradas_2t-pais_2026.csv.zip";
export const EXPECTED_FILTERS = Object.freeze({
  electionYear: 2026,
  country: "Brasil",
  region: "Todas",
  state: "Todas",
  municipality: "Todos",
  zone: "Todas",
  votingPlace: "Todos",
});

function compactText(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function parsePanelSnapshot(bodyText) {
  const text = compactText(bodyText);
  const timestamp = /Última atualização:\s*(\d{2})\.(\d{2})\.(\d{4})\s*-\s*(\d{2}):(\d{2})/i.exec(text);
  const count = /linhas?\(s\)\s*(\d+)\s*-\s*(\d+)\s+de\s+([\d.]+)/i.exec(text);
  if (!timestamp) throw new Error("Não encontrei a data e hora de atualização do painel do TSE.");
  if (!count) throw new Error("Não encontrei a contagem total de seções no painel do TSE.");

  const [, day, month, year, hour, minute] = timestamp;
  const [first, last, total] = count.slice(1).map((value) => Number(value.replaceAll(".", "")));
  const updatedAt = `${year}-${month}-${day}T${hour}:${minute}:00-03:00`;
  if (!Number.isFinite(Date.parse(updatedAt)) || first !== 1 || last < first || total < last) {
    throw new Error("A data, hora ou contagem exibida pelo painel parece inválida.");
  }
  for (const filter of [
    "Ano: 2026", "País: Todos", "Região: Todas", "UF: Todas",
    "Município: Todos", "Zona: Todas", "Local de votação: Todos",
  ]) {
    if (!text.includes(filter)) throw new Error(`O painel não confirmou o filtro nacional esperado: ${filter}.`);
  }
  if (!/Seções eleitorais alteradas no segundo turno/i.test(text)) {
    throw new Error("A página aberta não parece ser o relatório nacional de seções alteradas.");
  }
  return {
    panelUpdatedAt: updatedAt,
    expectedRows: total,
    filters: { ...EXPECTED_FILTERS },
  };
}

export function validateTseArchiveUrl(value) {
  const url = new URL(String(value));
  if (url.protocol !== "https:" || url.hostname !== "cdn.tse.jus.br" || url.username || url.password ||
      !url.pathname.startsWith("/estatistica/sead/odsele/arquivos_gerados/eleitorado_eleicao_2026/") ||
      !url.pathname.endsWith(`/${TSE_ARCHIVE_BASENAME}`)) {
    throw new Error("O link do arquivo não corresponde ao ZIP público oficial do TSE esperado.");
  }
  return url.href;
}

export function validateTseCsv(csvText, expectedRows) {
  const parsed = validateCsv(String(csvText), "CSV oficial do TSE");
  if (parsed.errors.length) {
    throw new Error(`CSV do TSE inválido (${parsed.errors.length} erros): ${parsed.errors[0].message}`);
  }
  if (parsed.totalDataRows !== expectedRows) {
    throw new Error(`O painel informa ${expectedRows} linhas, mas o CSV tem ${parsed.totalDataRows}.`);
  }
  const stateCodes = new Set(parsed.records.map((record) => record.uf.toUpperCase()));
  if (stateCodes.size < 1 || parsed.records.some((record) => record.eleicao !== "2026" || record.pais !== "Brasil")) {
    throw new Error("A exportação não passou pela checagem de ano, país e cobertura nacional.");
  }
  return { records: parsed.records, rows: parsed.totalDataRows, statesWithRows: stateCodes.size, duplicateKeys: parsed.duplicateKeys.length };
}

export function createVersionId(panelUpdatedAt, csvSha256) {
  if (!/^[a-f0-9]{64}$/i.test(csvSha256)) throw new Error("Hash SHA-256 do CSV inválido.");
  const date = new Date(panelUpdatedAt);
  if (!Number.isFinite(date.getTime())) throw new Error("Data de atualização do TSE inválida.");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bahia",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${value.year}-${value.month}-${value.day}-${value.hour}${value.minute}-${csvSha256.slice(0, 8).toLowerCase()}`;
}

export function compareCaptureToVersion(csvSha256, panelUpdatedAt, version) {
  const listChanged = csvSha256 !== version.csvSha256;
  const panelUpdateChanged = String(panelUpdatedAt) !== String(version.panelUpdatedAt ?? "");
  return {
    needsUpdate: listChanged || panelUpdateChanged,
    needsResultsZip: listChanged,
    listChanged,
    panelUpdateChanged,
  };
}

export function parseTseCsvRows(csvText, expectedRows) {
  const validation = validateTseCsv(csvText, expectedRows);
  const rows = parseSemicolonCsv(csvText);
  rows.shift();
  return { ...validation, rows };
}
