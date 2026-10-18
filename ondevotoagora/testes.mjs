import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPECTED_HEADERS,
  filterRecords,
  reconcileRecords,
  validateCsv,
} from "./csv-utils.mjs";

function makeCsv(records) {
  const values = records.map((record) => [
    record.eleicao,
    record.pais,
    record.uf,
    record.municipio,
    record.zona,
    record.localInicial,
    record.secao,
    record.localFinal,
    record.eleitores,
  ]);
  return [EXPECTED_HEADERS, ...values].map((row) => row.join(";")).join("\r\n");
}

const saoPaulo = {
  eleicao: "2026",
  pais: "Brasil",
  uf: "SP",
  municipio: "SÃO PAULO",
  zona: "001",
  localInicial: "ESCOLA JOÃO DA SILVA",
  secao: "0084",
  localFinal: "CENTRO MUNICIPAL",
  eleitores: "00458",
};

test("valida todas as linhas, cabeçalho e chave de seção", () => {
  const validation = validateCsv(makeCsv([saoPaulo]), "amostra");
  assert.equal(validation.totalDataRows, 1);
  assert.equal(validation.records.length, 1);
  assert.deepEqual(validation.errors, []);
});

test("identifica linha incompleta e seção duplicada", () => {
  const duplicate = { ...saoPaulo };
  const invalid = { ...saoPaulo, municipio: "", secao: "x" };
  const validation = validateCsv(makeCsv([saoPaulo, duplicate, invalid]), "amostra");
  assert.equal(validation.totalDataRows, 3);
  assert.equal(validation.duplicateKeys.length, 1);
  assert.ok(validation.errors.some((item) => item.message.includes("duplicada")));
  assert.ok(validation.errors.some((item) => item.message.includes("município")));
  assert.ok(validation.errors.some((item) => item.message.includes("seção")));
});

test("busca ignora acentos, caixa e zeros à esquerda", () => {
  const matches = filterRecords([saoPaulo], {
    estado: "sp",
    cidade: "sao paulo",
    secao: "84",
    localAntigo: "joao da silva",
    eleitorado: "458",
  });
  assert.equal(matches.length, 1);
  assert.equal(filterRecords([saoPaulo], { secao: "00085" }).length, 0);
});

test("combina filtros opcionais de estado, cidade, seção, local antigo e eleitorado", () => {
  const other = { ...saoPaulo, municipio: "SANTOS", secao: "0084", localInicial: "OUTRA ESCOLA" };
  const matches = filterRecords([saoPaulo, other], {
    estado: "SP",
    cidade: "são paulo",
    secao: "00084",
    localAntigo: "ESCOLA JOÃO",
    eleitorado: "00458",
  });
  assert.deepEqual(matches, [saoPaulo]);
});

test("conciliação separa inclusões pendentes, alterações e ausências", () => {
  const updated = { ...saoPaulo, localFinal: "ESCOLA NOVA" };
  const stale = { ...saoPaulo, municipio: "CAMPINAS", secao: "0100" };
  const added = { ...saoPaulo, municipio: "SANTOS", secao: "0200" };
  const comparison = reconcileRecords([saoPaulo, stale], [updated, added]);
  assert.equal(comparison.reconciliada, false);
  assert.deepEqual(comparison.faltantesNaBase, [added]);
  assert.deepEqual(comparison.ausentesNaFonteAtual, [stale]);
  assert.equal(comparison.alteracoes.length, 1);
  assert.deepEqual(comparison.alteracoes[0].campos.map((item) => item.campo), ["local novo"]);
});
