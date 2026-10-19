import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeNumber, normalizeText, parseSemicolonCsv, validateCsv } from "../csv-utils.mjs";

const siteDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const detailCsvPath = resolve(args.find((arg) => !arg.startsWith("--")) ?? join(siteDirectory, "relatorios", "votos-1o-turno-por-secao-candidatos.csv"));
const valueFor = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const versionId = valueFor("version-id", "");
const listCsvPath = resolve(valueFor("list", join(siteDirectory, "dados", "secoes.csv")));
const metadataPath = resolve(valueFor("metadata", join(siteDirectory, "dados", "meta.json")));
const outputPath = resolve(valueFor("output", versionId
  ? join(siteDirectory, "dados", "versoes", versionId, "votos.json")
  : join(siteDirectory, "dados", "comparacao-lula-flavio-1t.json")));
const sourceMetadataPath = resolve(valueFor("source-meta", detailCsvPath.replace(/\.csv$/i, ".meta.json")));

if (versionId && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(versionId)) throw new Error("Identificador de versão inválido.");
for (const path of [detailCsvPath, listCsvPath, metadataPath, sourceMetadataPath]) await access(path);

const detailHeaders = [
  "situacao_correspondencia", "sg_uf", "cd_municipio_tse", "nm_municipio", "nr_zona", "nr_secao",
  "local_1o_turno", "local_2o_turno", "eleitorado_na_lista", "nr_votavel", "nm_candidato",
  "votos_candidato", "votos_lula_e_flavio_na_secao", "percentual_sobre_lula_e_flavio",
  "vencedor_da_secao", "empate", "votos_brancos_secao", "votos_nulos_secao",
  "votos_anulados_apurados_separado_secao", "linha_do_candidato_na_fonte",
];
const candidates = new Map([
  ["13", { field: "lula", name: "LUIZ INACIO LULA DA SILVA", label: "Lula" }],
  ["22", { field: "flavio", name: "FLAVIO NANTES BOLSONARO", label: "Flávio Bolsonaro" }],
]);

function normalizeTown(value) {
  return normalizeText(value).replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function sectionKey(uf, city, zone, section) {
  return [normalizeText(uf), normalizeTown(city), normalizeNumber(zone), normalizeNumber(section)].join("\u0000");
}

function safeInteger(value, context) {
  const text = String(value ?? "").trim();
  assert(/^\d+$/.test(text), `${context}: voto ausente ou inválido (${value}).`);
  const number = Number(text);
  assert(Number.isSafeInteger(number), `${context}: contagem fora do intervalo seguro.`);
  return number;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const [listBytes, metadata, detailText, sourceMetadata] = await Promise.all([
  readFile(listCsvPath),
  readFile(metadataPath, "utf8").then(JSON.parse),
  readFile(detailCsvPath, "utf8"),
  readFile(sourceMetadataPath, "utf8").then(JSON.parse),
]);
const listHash = sha256(listBytes);
const list = validateCsv(new TextDecoder("windows-1252").decode(listBytes), listCsvPath.split("/").at(-1));
assert.equal(list.errors.length, 0, "A lista de mudanças deve passar na validação estrutural.");
assert.equal(list.totalDataRows, metadata.registrosBase, "A contagem da lista deve coincidir com os metadados.");
assert.equal(metadata.sha256ArquivoCsv ?? metadata.fonteOficialAtual?.sha256Csv, listHash, "O hash da lista não confere com os metadados.");
assert.equal(sourceMetadata.secoesNaLista, list.totalDataRows, "O relatório de extração não corresponde a esta lista.");

const detailRows = parseSemicolonCsv(detailText);
const headers = detailRows.shift() ?? [];
assert.deepEqual(headers, detailHeaders, "O CSV de origem precisa ter o cabeçalho gerado pelo extrator TSE.");
const detailColumns = Object.fromEntries(headers.map((header, index) => [header, index]));
const sourceBySection = new Map();

for (const [index, row] of detailRows.entries()) {
  assert.equal(row.length, headers.length, `Linha ${index + 2} do CSV detalhado tem número inesperado de colunas.`);
  const key = sectionKey(row[detailColumns.sg_uf], row[detailColumns.nm_municipio], row[detailColumns.nr_zona], row[detailColumns.nr_secao]);
  const entry = sourceBySection.get(key) ?? { candidates: new Map(), status: "", reasons: new Set() };
  const correspondence = row[detailColumns.situacao_correspondencia];
  if (correspondence) entry.status = correspondence;
  const code = normalizeNumber(row[detailColumns.nr_votavel]);
  if (!candidates.has(code)) {
    if (correspondence && correspondence !== "comparacao_disponivel") entry.reasons.add(correspondence);
    sourceBySection.set(key, entry);
    continue;
  }

  const candidate = candidates.get(code);
  assert.equal(normalizeText(row[detailColumns.nm_candidato]), candidate.name, `Nome inesperado para o código ${code}.`);
  const sourceStatus = row[detailColumns.linha_do_candidato_na_fonte];
  if (sourceStatus === "presente") {
    const votes = safeInteger(row[detailColumns.votos_candidato], `Linha ${index + 2}`);
    const values = entry.candidates.get(candidate.field) ?? [];
    values.push(votes);
    entry.candidates.set(candidate.field, values);
  } else if (sourceStatus === "duplicada") {
    entry.reasons.add(`linha_duplicada_${candidate.field}`);
  } else if (sourceStatus === "ausente_interpretada_como_zero") {
    throw new Error(`A linha ${index + 2} contém zero inferido; a regra atual proíbe converter ausência em zero.`);
  } else {
    entry.reasons.add(`linha_ausente_${candidate.field}`);
  }
  sourceBySection.set(key, entry);
}

const unavailableReasons = {
  sem_resultado: "Não foi localizada linha de resultado correspondente no arquivo oficial de votos.",
  codigo_municipal_ambiguo: "O município corresponde a mais de um código no arquivo oficial; o vínculo não foi presumido.",
  codigo_municipal_nao_resolvido: "Não foi possível vincular o município ao código usado no arquivo oficial.",
  linha_ausente_lula: "Não há linha válida de votos para Lula no arquivo consultado; ausência não foi tratada como zero.",
  linha_ausente_flavio: "Não há linha válida de votos para Flávio Bolsonaro no arquivo consultado; ausência não foi tratada como zero.",
  linha_duplicada_lula: "Há mais de uma linha para Lula nesta seção; comparação indisponível.",
  linha_duplicada_flavio: "Há mais de uma linha para Flávio Bolsonaro nesta seção; comparação indisponível.",
};

const sections = list.records.map((record) => {
  const key = sectionKey(record.uf, record.municipio, record.zona, record.secao);
  const source = sourceBySection.get(key);
  const lulaRows = source?.candidates.get("lula") ?? [];
  const flavioRows = source?.candidates.get("flavio") ?? [];
  const complete = lulaRows.length === 1 && flavioRows.length === 1 && source?.reasons.size === 0;
  const reasonCodes = complete ? [] : [...(source?.reasons ?? [])];
  if (lulaRows.length === 0 && !reasonCodes.some((reason) => reason.includes("lula"))) reasonCodes.push("linha_ausente_lula");
  if (flavioRows.length === 0 && !reasonCodes.some((reason) => reason.includes("flavio"))) reasonCodes.push("linha_ausente_flavio");
  if (!source && reasonCodes.length === 0) reasonCodes.push("sem_resultado");
  const reason = reasonCodes.map((code) => unavailableReasons[code] ?? unavailableReasons[code.split(":")[0]] ?? "A correspondência não pôde ser validada no arquivo oficial.");
  return {
    uf: record.uf.toUpperCase(),
    cidade: record.municipio,
    zona: Number(normalizeNumber(record.zona)),
    secao: Number(normalizeNumber(record.secao)),
    localAnterior: record.localInicial,
    localNovo: record.localFinal,
    resultadoDisponivel: complete,
    votosLula: complete ? lulaRows[0] : null,
    votosFlavio: complete ? flavioRows[0] : null,
    lulaZeroInferido: false,
    flavioZeroInferido: false,
    motivosIndisponibilidade: complete ? [] : [...new Set(reason)],
    codigosIndisponibilidade: complete ? [] : [...new Set(reasonCodes)],
  };
});

sections.sort((a, b) => a.uf.localeCompare(b.uf, "pt-BR") || a.cidade.localeCompare(b.cidade, "pt-BR") || a.zona - b.zona || a.secao - b.secao);
const keySet = new Set(sections.map((section) => sectionKey(section.uf, section.cidade, section.zona, section.secao)));
assert.equal(keySet.size, sections.length, "A lista possui chaves de seção duplicadas.");
const available = sections.filter((section) => section.resultadoDisponivel);
const unavailable = sections.filter((section) => !section.resultadoDisponivel);
const lulaTotal = available.reduce((sum, section) => sum + section.votosLula, 0);
const flavioTotal = available.reduce((sum, section) => sum + section.votosFlavio, 0);
const listSource = metadata.fonteOficialAtual ?? {};
const comparisonLines = sections.map((section) => [
  section.uf, normalizeTown(section.cidade), section.zona, section.secao,
  section.votosLula, section.votosFlavio, false, false,
]);
const output = {
  versao: 2,
  versaoListaId: versionId || metadata.id || null,
  geradoEm: new Date().toISOString(),
  campos: ["uf", "municipio_normalizado", "zona", "secao", "votos_lula", "votos_flavio_bolsonaro", "zero_lula_inferido", "zero_flavio_inferido"],
  listaMudancas: {
    url: listSource.url ?? metadata.fonte?.url,
    arquivo: metadata.arquivoFonte,
    arquivoMarcadoEm: metadata.dataArquivoNoZip ?? null,
    painelAtualizacaoInformada: listSource.painelAtualizacaoInformada ?? null,
    capturadaEm: listSource.capturadaEm ?? null,
    registros: sections.length,
    sha256: listHash,
  },
  resultados: {
    urlCatalogo: "https://dadosabertos.tse.jus.br/pt_BR/dataset/resultados-2026",
    urlArquivo: sourceMetadata.urlArquivo,
    arquivoGeradoEm: sourceMetadata.datasGeracao?.join(", ") ?? null,
    sha256ZipAnalisado: sourceMetadata.sha256Zip,
    linhasCsvFonte: sourceMetadata.linhasCsv,
  },
  metodologia: {
    candidatos: ["LUIZ INÁCIO LULA DA SILVA", "FLÁVIO NANTES BOLSONARO"],
    denominador: "Soma dos votos explicitamente presentes nas linhas de Lula (13) e Flávio Bolsonaro (22). Outros candidatos, brancos e nulos não entram.",
    ausencia: "Se faltar qualquer uma das duas linhas válidas, ou houver duplicidade, a comparação fica indisponível. Ausência nunca é convertida em zero.",
  },
  cobertura: {
    registrosNaCopia: sections.length,
    resultadosEncontrados: available.length,
    resultadosIndisponiveis: unavailable.length,
    zerosInferidosLula: 0,
    zerosInferidosFlavioBolsonaro: 0,
    listaReconciliada: true,
    secoesIndisponiveis: unavailable.map((section) => ({
      uf: section.uf, cidade: section.cidade, zona: section.zona, secao: section.secao,
      codigos: section.codigosIndisponibilidade, motivos: section.motivosIndisponibilidade,
    })),
    totaisVotosNasComparacoesDisponiveis: { lula: lulaTotal, flavioBolsonaro: flavioTotal },
    estatisticasExtracao: sourceMetadata.coberturaComparacao,
  },
  linhas: comparisonLines,
};

await writeFile(outputPath, `${JSON.stringify(output)}\n`, { encoding: "utf8", flag: "wx" });
const saved = JSON.parse(await readFile(outputPath, "utf8"));
assert.equal(saved.linhas.length, list.totalDataRows, "O JSON precisa ter uma linha por seção da lista escolhida.");
assert.equal(saved.linhas.filter((line) => line[4] !== null && line[5] !== null).length, available.length);
assert.equal(saved.linhas.filter((line) => line[4] === null && line[5] === null).length, unavailable.length);
assert.equal(saved.listaMudancas.sha256, listHash);

console.log(JSON.stringify({
  arquivo: outputPath,
  versaoListaId: output.versaoListaId,
  secoes: saved.linhas.length,
  resultadosEncontrados: available.length,
  resultadosIndisponiveis: unavailable.length,
  votosLula: lulaTotal,
  votosFlavioBolsonaro: flavioTotal,
  indisponiveis: unavailable.map(({ uf, cidade, zona, secao, codigosIndisponibilidade }) => ({ uf, cidade, zona, secao, codigos: codigosIndisponibilidade })),
  zerosInferidos: 0,
}, null, 2));
