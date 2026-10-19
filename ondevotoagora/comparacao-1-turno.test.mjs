import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateCsv } from "./csv-utils.mjs";
import { comparisonSectionKey, filterComparisonSections, sortComparisonSections, visibleComparisonSections } from "./comparacao-utils.mjs";

const root = new URL(".", import.meta.url);
const [localBytes, data] = await Promise.all([
  readFile(new URL("./dados/secoes.csv", root)),
  readFile(new URL("./dados/comparacao-lula-flavio-1t.json", root), "utf8").then(JSON.parse),
]);
const local = validateCsv(new TextDecoder("windows-1252").decode(localBytes), "dados/secoes.csv");
assert.equal(local.errors.length, 0);
const voteRows = new Map(data.linhas.map((row) => [comparisonSectionKey(row[0], row[1], row[2], row[3]), row]));
const sections = local.records.map((record) => {
  const row = voteRows.get(comparisonSectionKey(record.uf, record.municipio, record.zona, record.secao));
  assert(row, `Sem dados para ${record.uf}/${record.municipio}/${record.secao}`);
  return {
    uf: record.uf,
    cidade: record.municipio,
    zona: Number(record.zona),
    secao: Number(record.secao),
    localAnterior: record.localInicial,
    localNovo: record.localFinal,
    resultadoDisponivel: row[4] !== null,
    votosLula: row[4],
    votosFlavio: row[5],
  };
});

test("mantém as 4.288 seções e reconhece Ararendá/CE sem resultado", () => {
  assert.equal(sections.length, 4288);
  const results = filterComparisonSections(sections, { uf: "ce", cidade: "Ararenda", secao: "0209", local: "ASSOCIAÇÃO" });
  assert.equal(results.length, 1);
  assert.equal(results[0].resultadoDisponivel, false);
  assert.equal(results[0].votosLula, null);
  assert.equal(results[0].votosFlavio, null);
});

test("busca por local antigo ou novo e por município não depende de acentos/caixa", () => {
  const result = filterComparisonSections(sections, { uf: "AL", cidade: "campo grande", secao: "125", local: "ginásio do colégio" });
  assert.equal(result.length, 1);
  assert.equal(result[0].votosLula, 182);
  assert.equal(result[0].votosFlavio, 49);
});

test("ordena por estado, cidade, zona e número da seção", () => {
  const sorted = sortComparisonSections(sections);
  assert.equal(sorted.length, sections.length);
  assert.deepEqual(sorted.slice(0, 3).map((section) => section.secao), [125, 126, 128]);
  for (let index = 1; index < sorted.length; index += 1) {
    const [previous, current] = [sorted[index - 1], sorted[index]];
    const order = previous.uf.localeCompare(current.uf, "pt-BR") ||
      previous.cidade.localeCompare(current.cidade, "pt-BR") ||
      previous.zona - current.zona ||
      previous.secao - current.secao;
    assert(order <= 0, `Ordem incorreta na posição ${index}.`);
  }
});

test("calcula percentuais somente sobre os votos dos dois nomes", () => {
  const section = sections.find((item) => item.uf === "AL" && item.cidade === "CAMPO GRANDE" && item.secao === 125);
  const denominator = section.votosLula + section.votosFlavio;
  assert.equal(denominator, 231);
  assert.equal(section.votosLula / denominator * 100 + section.votosFlavio / denominator * 100, 100);
});

test("mostra 20 seções e acrescenta a próxima parte", () => {
  const sorted = sortComparisonSections(sections);
  assert.equal(visibleComparisonSections(sorted, 20).length, 20);
  assert.equal(visibleComparisonSections(sorted, 40).length, 40);
});
