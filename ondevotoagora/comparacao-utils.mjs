import { normalizeNumber, normalizeText } from "./csv-utils.mjs";

function normalizeTown(value) {
  return normalizeText(value).replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
}

export function comparisonSectionKey(uf, city, zone, section) {
  return [normalizeText(uf), normalizeTown(city), normalizeNumber(zone), normalizeNumber(section)].join("\u0000");
}

export function sortComparisonSections(sections) {
  return [...sections].sort((a, b) =>
    a.uf.localeCompare(b.uf, "pt-BR") ||
    a.cidade.localeCompare(b.cidade, "pt-BR") ||
    a.zona - b.zona ||
    a.secao - b.secao
  );
}

export function filterComparisonSections(sections, filters) {
  const state = normalizeText(filters.uf);
  const city = normalizeText(filters.cidade);
  const section = normalizeNumber(filters.secao);
  const place = normalizeText(filters.local);

  return sections.filter((record) =>
    (!state || normalizeText(record.uf) === state) &&
    (!city || normalizeText(record.cidade).includes(city)) &&
    (!section || normalizeNumber(record.secao) === section) &&
    (!place || normalizeText(`${record.localAnterior} ${record.localNovo}`).includes(place))
  );
}

export function visibleComparisonSections(sections, limit) {
  return sections.slice(0, Math.max(0, limit));
}
