import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeText, normalizeNumber, validateCsv, recordKey } from "../csv-utils.mjs";

const siteDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const valueFor = (name) => args.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const previousPath = resolve(valueFor("previous") ?? "");
const currentPath = resolve(valueFor("current") ?? "");
const outputPath = resolve(valueFor("output") ?? "");

function assertInsideSite(path, label) {
  const pathFromSite = relative(siteDirectory, path);
  if (!path || pathFromSite === ".." || pathFromSite.startsWith(`..${sep}`) || isAbsolute(pathFromSite)) {
    throw new Error(`${label} precisa ficar dentro de ondevotoagora/.`);
  }
}

for (const [path, label] of [[previousPath, "A versão anterior"], [currentPath, "A versão atual"], [outputPath, "O relatório"]]) {
  if (!path) throw new Error("Uso: node reconciliar-versoes-secoes.mjs --previous=CSV --current=CSV --output=JSON");
  assertInsideSite(path, label);
}

async function loadCsv(path) {
  const bytes = await readFile(path);
  const parsed = validateCsv(new TextDecoder("windows-1252").decode(bytes), path);
  if (parsed.errors.length > 0) {
    throw new Error(`${path}: ${parsed.errors.length} erro(s) de estrutura; exemplo: ${parsed.errors[0].message}`);
  }
  return { bytes, parsed };
}

function key(record) {
  return recordKey(record);
}

const [previous, current] = await Promise.all([loadCsv(previousPath), loadCsv(currentPath)]);
const previousByKey = new Map(previous.parsed.records.map((record) => [key(record), record]));
const currentByKey = new Map(current.parsed.records.map((record) => [key(record), record]));
const fields = ["pais", "uf", "municipio", "zona", "localInicial", "secao", "localFinal", "eleitores"];
const labels = {
  pais: "país", uf: "UF", municipio: "município", zona: "zona", localInicial: "local anterior",
  secao: "seção", localFinal: "local novo", eleitores: "eleitorado",
};
const sharedKeys = [...currentByKey.keys()].filter((keyValue) => previousByKey.has(keyValue));
const onlyPrevious = [...previousByKey.entries()].filter(([keyValue]) => !currentByKey.has(keyValue)).map(([, record]) => record);
const onlyCurrent = [...currentByKey.entries()].filter(([keyValue]) => !previousByKey.has(keyValue)).map(([, record]) => record);
const changedShared = [];
const fieldCounts = Object.fromEntries(fields.map((field) => [labels[field], 0]));

for (const keyValue of sharedKeys) {
  const oldRecord = previousByKey.get(keyValue);
  const currentRecord = currentByKey.get(keyValue);
  const differences = fields
    .filter((field) => String(oldRecord[field] ?? "").trim() !== String(currentRecord[field] ?? "").trim())
    .map((field) => {
      fieldCounts[labels[field]] += 1;
      return { campo: labels[field], anterior: oldRecord[field], atual: currentRecord[field] };
    });
  if (differences.length > 0) {
    changedShared.push({
      chave: [normalizeText(currentRecord.uf), normalizeText(currentRecord.municipio), normalizeNumber(currentRecord.zona), normalizeNumber(currentRecord.secao)].join("/"),
      municipio: currentRecord.municipio,
      uf: currentRecord.uf,
      zona: currentRecord.zona,
      secao: currentRecord.secao,
      campos: differences,
    });
  }
}

const report = {
  geradoEm: new Date().toISOString(),
  chaveDeComparacao: "eleição + UF + município normalizado + zona + seção",
  versaoAnterior: {
    arquivo: relative(siteDirectory, previousPath),
    registros: previous.parsed.totalDataRows,
    sha256: createHash("sha256").update(previous.bytes).digest("hex"),
  },
  versaoAtual: {
    arquivo: relative(siteDirectory, currentPath),
    registros: current.parsed.totalDataRows,
    sha256: createHash("sha256").update(current.bytes).digest("hex"),
  },
  reconciliacao: {
    chavesCompartilhadas: sharedKeys.length,
    apenasNaVersaoAnterior: onlyPrevious.length,
    apenasNaVersaoAtual: onlyCurrent.length,
    registrosCompartilhadosComCamposAlterados: changedShared.length,
    totalCamposDiferentesNosRegistrosCompartilhados: changedShared.reduce((sum, record) => sum + record.campos.length, 0),
    camposDiferentesPorTipo: fieldCounts,
    observacao: "Diferenças entre duas exportações não provam exclusão ou cancelamento de seções. Ausência em uma captura significa apenas que a chave não aparece naquela versão.",
  },
  apenasNaVersaoAnterior: onlyPrevious.map((record) => ({ uf: record.uf, municipio: record.municipio, zona: record.zona, secao: record.secao })),
  apenasNaVersaoAtual: onlyCurrent.map((record) => ({ uf: record.uf, municipio: record.municipio, zona: record.zona, secao: record.secao })),
  registrosCompartilhadosComCamposAlterados: changedShared,
};

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ arquivo: outputPath, ...report.reconciliacao }, null, 2));
