import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXPECTED_HEADERS, reconcileRecords, recordKey, validateCsv } from "../csv-utils.mjs";

const siteDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportsDirectory = dirname(fileURLToPath(import.meta.url));
const sourceArgument = process.argv.slice(2).find((argument) => argument.startsWith("--source="))?.slice("--source=".length);
const apply = process.argv.includes("--apply");
const sourcePath = sourceArgument ? resolve(sourceArgument) : join(reportsDirectory, "fonte-oficial-secoes-tse-2026-10-19-1050.json");
const sourceVersion = /^fonte-oficial-secoes-tse-(\d{4}-\d{2}-\d{2}-\d{4})\.json$/.exec(basename(sourcePath))?.[1];
if (!sourceVersion) throw new Error("O arquivo da captura deve se chamar fonte-oficial-secoes-tse-AAAA-MM-DD-HHMM.json.");
const basePath = join(siteDirectory, "dados", "secoes.csv");
const metadataPath = join(siteDirectory, "dados", "meta.json");
const reportPath = join(reportsDirectory, `reconciliacao-secoes-tse-${sourceVersion}.json`);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function formatBrtDateTime(value) {
  const date = new Date(value);
  const datePart = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Bahia",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
  const timePart = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Bahia",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date).replace(":", "h");
  return `${datePart} às ${timePart}`;
}

const windows1252Extended = new Map([
  [0x20ac, 0x80], [0x0081, 0x81], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89],
  [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x008d, 0x8d], [0x017d, 0x8e],
  [0x008f, 0x8f], [0x0090, 0x90], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98],
  [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c], [0x009d, 0x9d],
  [0x017e, 0x9e], [0x0178, 0x9f],
]);

function encodeWindows1252(value) {
  const bytes = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x7f || (codePoint >= 0xa0 && codePoint <= 0xff)) bytes.push(codePoint);
    else if (windows1252Extended.has(codePoint)) bytes.push(windows1252Extended.get(codePoint));
    else throw new Error(`Caractere U+${codePoint.toString(16).toUpperCase()} não pode ser representado em Windows-1252.`);
  }
  return Uint8Array.from(bytes);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function validatePageRanges(source) {
  if (!Array.isArray(source.pageRanges) || source.pageRanges.length === 0) {
    throw new Error("A captura precisa registrar os intervalos das páginas conferidas.");
  }
  let nextExpected = 1;
  for (const [index, page] of source.pageRanges.entries()) {
    const match = /^(\d+)-(\d+)$/.exec(String(page.range ?? ""));
    if (!match) throw new Error(`Intervalo inválido na página ${index + 1}.`);
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (page.page !== index + 1 || start !== nextExpected || end < start || page.count !== end - start + 1) {
      throw new Error(`Lacuna, sobreposição ou contagem incorreta no intervalo da página ${index + 1}.`);
    }
    nextExpected = end + 1;
  }
  const lastRange = /^\d+-(\d+)$/.exec(String(source.pageRanges.at(-1)?.range ?? ""));
  if (nextExpected - 1 !== source.rows.length || !lastRange || Number(lastRange[1]) !== source.rows.length) {
    throw new Error("Os intervalos paginados não cobrem exatamente todas as linhas da captura.");
  }
}

const sourceBytes = await readFile(sourcePath);
const sourceHash = sha256(sourceBytes);
const source = JSON.parse(sourceBytes.toString("utf8"));
if (!Array.isArray(source.rows) || !Number.isInteger(source.expectedRows) || source.expectedRows < 1 || source.rows.length !== source.expectedRows) {
  throw new Error("A contagem de linhas da captura não corresponde à contagem informada no painel.");
}
if (createHash("sha256").update(JSON.stringify(source.rows)).digest("hex") !== source.rowsSha256) {
  throw new Error("O SHA-256 das linhas não corresponde ao hash registrado na captura.");
}
if (!Number.isFinite(Date.parse(source.lastUpdatedByTse)) || !Number.isFinite(Date.parse(source.consultedAt))) {
  throw new Error("A captura não tem timestamps válidos do painel e da consulta.");
}
if (source.filters?.electionYear !== 2026 || !["Todos", "Todas"].includes(source.filters?.country) ||
    !["Todos", "Todas"].includes(source.filters?.region) || !["Todos", "Todas"].includes(source.filters?.state) ||
    !["Todos", "Todas"].includes(source.filters?.municipality) || !["Todos", "Todas"].includes(source.filters?.zone) ||
    !["Todos", "Todas"].includes(source.filters?.votingPlace)) {
  throw new Error("Os filtros da captura não indicam o escopo nacional integral de 2026.");
}
validatePageRanges(source);

const rows = source.rows.map((row, index) => {
  if (!Array.isArray(row) || row.length !== 8) throw new Error(`Linha ${index + 1} não contém os oito campos capturados.`);
  const [eleicao, uf, municipio, zona, localInicial, localFinal, secao, eleitores] = row.map((value) => String(value ?? "").trim());
  if (eleicao !== "2026" || !/^[A-Z]{2}$/.test(uf) || !municipio || !/^\d+$/.test(zona) ||
      !localInicial || !localFinal || !/^\d+$/.test(secao) || !/^\d+$/.test(eleitores)) {
    throw new Error(`Campos ausentes ou inválidos na linha ${index + 1} da captura.`);
  }
  return { eleicao, pais: "Brasil", uf, municipio, zona, localInicial, secao, localFinal, eleitores };
});

const keys = rows.map(recordKey);
if (new Set(keys).size !== rows.length) throw new Error("A captura contém chaves de seção duplicadas.");
rows.sort((left, right) =>
  left.uf.localeCompare(right.uf, "pt-BR") ||
  left.municipio.localeCompare(right.municipio, "pt-BR") ||
  Number(left.zona) - Number(right.zona) ||
  Number(left.secao) - Number(right.secao)
);

const csvText = [EXPECTED_HEADERS, ...rows.map((record) => [
  record.eleicao, record.pais, record.uf, record.municipio, record.zona,
  record.localInicial, record.secao, record.localFinal, record.eleitores,
].map(csvCell))].map((row) => row.join(";")).join("\r\n") + "\r\n";
const csvBytes = encodeWindows1252(csvText);
const baseValidation = validateCsv(new TextDecoder("windows-1252").decode(csvBytes), "secoes.csv gerado");
if (baseValidation.errors.length || baseValidation.totalDataRows !== source.expectedRows) {
  throw new Error("O CSV CP1252 gerado não passou na validação estrutural.");
}

const oldBytes = await readFile(basePath);
const oldValidation = validateCsv(new TextDecoder("windows-1252").decode(oldBytes), "secoes.csv anterior");
if (oldValidation.errors.length) throw new Error("A base anterior tem erros; reconciliação interrompida.");
const reconciliation = reconcileRecords(oldValidation.records, baseValidation.records);
const changedFieldCounts = {};
for (const change of reconciliation.alteracoes) {
  for (const field of change.campos) changedFieldCounts[field.campo] = (changedFieldCounts[field.campo] ?? 0) + 1;
}

const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
const capture = {
  url: source.source,
  arquivoCaptura: sourcePath.startsWith(`${siteDirectory}/`) ? sourcePath.slice(siteDirectory.length + 1) : sourcePath,
  sha256ArquivoCaptura: sourceHash,
  sha256Linhas: source.rowsSha256,
  sha256Csv: sha256(csvBytes),
  formato: "Tabela oficial paginada do painel de Capilaridade do TSE",
  capturadaEm: source.consultedAt,
  painelAtualizacaoInformada: source.lastUpdatedByTse,
  painelRegistrosInformados: source.expectedRows,
  registros: source.expectedRows,
  paginasConferidas: source.pageRanges.length,
  intervalosConferidos: `${source.pageRanges[0].range} a ${source.pageRanges.at(-1).range}, sem lacunas; ${new Set(keys).size} chaves únicas`,
  filtros: source.filters,
  metodo: source.extraction.method,
  erroExportador: source.extraction.exportError,
};

const nextMetadata = {
  eleicao: 2026,
  turnoInicial: 1,
  turnoFinal: 2,
  siteAtualizadoEm: source.consultedAt.slice(0, 10),
  dadosConsultadosEm: source.consultedAt,
  registrosBase: source.expectedRows,
  arquivoFonte: capture.arquivoCaptura,
  sha256ArquivoCsv: capture.sha256Csv,
  fonteOficialAtual: capture,
  fonte: {
    nome: "TSE — Estatísticas do eleitorado — Capilaridade — Seções alteradas",
    url: source.source,
    painel: source.panel,
    noticiaUrl: metadata.fonte.noticiaUrl,
  },
  mensagemParaEleitor: `Lista do TSE: ${source.expectedRows} seções. Painel atualizado em ${formatBrtDateTime(source.lastUpdatedByTse)}; consulta feita em ${formatBrtDateTime(source.consultedAt)}.`,
  observacao: `A lista foi extraída da tabela oficial paginada do painel do TSE, com ${source.expectedRows} registros conferidos em ${source.pageRanges.length} páginas e sem lacunas. A captura local registra os intervalos, filtros, timestamps e hashes usados.`,
};

const report = {
  geradoEm: new Date().toISOString(),
  fonte: {
    arquivo: capture.arquivoCaptura,
    url: capture.url,
    sha256Arquivo: sourceHash,
    sha256Linhas: source.rowsSha256,
    timestampTse: capture.painelAtualizacaoInformada,
    capturadaEm: capture.capturadaEm,
    filtros: capture.filtros,
    paginasConferidas: capture.paginasConferidas,
    intervalos: capture.intervalosConferidos,
    linhas: source.rows.length,
    chavesUnicas: new Set(keys).size,
    errosEstruturais: baseValidation.errors.length,
    exportador: capture.erroExportador,
  },
  csvGerado: {
    arquivo: "dados/secoes.csv",
    codificacao: "Windows-1252",
    cabecalho: EXPECTED_HEADERS,
    sha256: capture.sha256Csv,
    linhas: baseValidation.totalDataRows,
  },
  comparacaoComBaseAnterior: {
    linhasAnteriores: oldValidation.totalDataRows,
    linhasAtuais: baseValidation.totalDataRows,
    faltantesNaBaseAnterior: reconciliation.inclusoesNaBase.length,
    linhasAnterioresAusentesDaListaAtual: reconciliation.ausentesNaFonteAtual.length,
    chavesSobrepostasComCamposAlterados: reconciliation.alteracoes.length,
    camposAlteradosPorRegistro: changedFieldCounts,
  },
};

if (apply) {
  await access(reportPath).then(
    () => { throw new Error(`Relatório já existe; não será sobrescrito: ${reportPath}`); },
    (error) => { if (error.code !== "ENOENT") throw error; },
  );
  await writeFile(basePath, csvBytes);
  await writeFile(metadataPath, `${JSON.stringify(nextMetadata, null, 2)}\n`, "utf8");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

console.log(JSON.stringify({ ...report, aplicado: apply, relatorio: apply ? reportPath : null }, null, 2));
