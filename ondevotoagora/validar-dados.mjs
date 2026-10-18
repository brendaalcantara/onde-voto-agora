import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reconcileRecords, validateCsv } from "./csv-utils.mjs";

const siteDirectory = dirname(fileURLToPath(import.meta.url));
const dataDirectory = join(siteDirectory, "dados");
const metadataPath = join(dataDirectory, "meta.json");
const basePath = join(dataDirectory, "secoes.csv");
const reportPath = join(dataDirectory, "relatorio-validacao.json");
const sourceArgument = process.argv.slice(2).find((value) => value.startsWith("--source="))?.slice("--source=".length);
const officialPath = sourceArgument
  ? (isAbsolute(sourceArgument) ? sourceArgument : resolve(siteDirectory, sourceArgument))
  : join(dataDirectory, "fonte-oficial.csv");
const officialRelativePath = officialPath.startsWith(`${siteDirectory}/`) ? officialPath.slice(siteDirectory.length + 1) : officialPath;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeAndValidate(bytes, name) {
  const csvText = new TextDecoder("windows-1252").decode(bytes);
  return validateCsv(csvText, name);
}

function summarizeValidation(validation) {
  return {
    linhasAnalisadas: validation.totalDataRows,
    registrosLidos: validation.records.length,
    erros: validation.errors,
    duplicatas: validation.duplicateKeys,
  };
}

const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
const baseBytes = await readFile(basePath);
const baseHash = sha256(baseBytes);
const baseValidation = decodeAndValidate(baseBytes, "secoes.csv");
const errors = [];

if (metadata.registrosBase !== baseValidation.totalDataRows) {
  errors.push(`Metadados declaram ${metadata.registrosBase} registros, mas o CSV contém ${baseValidation.totalDataRows} linhas de dados.`);
}
if (metadata.sha256ArquivoCsv !== baseHash) {
  errors.push("O SHA-256 do CSV local difere do registrado em meta.json.");
}
if (baseValidation.errors.length > 0) errors.push(`${baseValidation.errors.length} problema(s) de validação na base local.`);

let officialExists = true;
let officialBytes;
try {
  await access(officialPath);
  officialBytes = await readFile(officialPath);
} catch (error) {
  if (error?.code === "ENOENT") officialExists = false;
  else throw error;
}

let officialValidation = null;
let officialHash = null;
let comparison = null;
let provenanceErrors = [];

if (!officialExists) {
  errors.push(`Fonte oficial atual ausente: ${officialRelativePath}. Não é possível identificar inclusões, alterações ou ausências em relação à lista atual.`);
} else {
  officialHash = sha256(officialBytes);
  officialValidation = decodeAndValidate(officialBytes, officialRelativePath);
  if (officialValidation.errors.length > 0) errors.push(`${officialValidation.errors.length} problema(s) de validação na fonte oficial.`);

  const provenance = metadata.fonteOficialAtual;
  if (!provenance || typeof provenance !== "object") {
    provenanceErrors.push("Registre a data de captura, URL oficial, contagem e SHA-256 em fonteOficialAtual no meta.json.");
  } else {
    if (!/^https:\/\/sig\.tse\.jus\.br\//.test(provenance.url ?? "")) provenanceErrors.push("A URL da fonte atual precisa apontar para o painel oficial do TSE.");
    if (!provenance.capturadaEm || Number.isNaN(Date.parse(provenance.capturadaEm))) provenanceErrors.push("Data de captura da fonte oficial ausente ou inválida.");
    if (provenance.sha256Csv !== officialHash) provenanceErrors.push("O SHA-256 da fonte oficial difere do registrado em meta.json.");
    if (provenance.registros !== officialValidation.totalDataRows) provenanceErrors.push("A contagem da fonte oficial difere do registrado em meta.json.");
    if (!provenance.painelAtualizacaoInformada || Number.isNaN(Date.parse(provenance.painelAtualizacaoInformada))) provenanceErrors.push("Registre a data/hora de atualização informada no painel do TSE.");
    if (!Number.isInteger(provenance.painelRegistrosInformados)) provenanceErrors.push("Registre a quantidade informada no painel do TSE.");
  }
  errors.push(...provenanceErrors);

  if (baseValidation.errors.length === 0 && officialValidation.errors.length === 0) {
    comparison = reconcileRecords(baseValidation.records, officialValidation.records);
    if (!comparison.reconciliada) {
      errors.push(`Base divergente: ${comparison.inclusoesNaBase.length} inclusões pendentes, ${comparison.alteracoes.length} registros alterados e ${comparison.ausentesNaFonteAtual.length} registros ausentes da fonte atual.`);
    }
  }
}

const report = {
  geradoEm: new Date().toISOString(),
  fonteOficialAtual: {
    arquivo: officialRelativePath,
    encontrada: officialExists,
    sha256: officialHash,
    linhas: officialValidation?.totalDataRows ?? null,
    validacao: officialValidation ? summarizeValidation(officialValidation) : null,
    procedencia: metadata.fonteOficialAtual ?? null,
    errosProcedencia: provenanceErrors,
  },
  baseLocal: {
    arquivo: "dados/secoes.csv",
    sha256: baseHash,
    linhasDeclaradas: metadata.registrosBase,
    validacao: summarizeValidation(baseValidation),
  },
  comparacao: comparison
    ? {
        reconciliada: comparison.reconciliada,
        quantidadeFaltanteNaBase: comparison.inclusoesNaBase.length,
        registrosNovosNaFonteFaltantesNaBase: comparison.inclusoesNaBase,
        quantidadeAusenteDaFonteAtual: comparison.ausentesNaFonteAtual.length,
        registrosAusentesDaFonteAtual: comparison.ausentesNaFonteAtual,
        quantidadeAlterada: comparison.alteracoes.length,
        registrosAlterados: comparison.alteracoes,
      }
    : {
        reconciliada: false,
        status: officialExists ? "bloqueada_por_erros_de_validacao" : "bloqueada_fonte_oficial_atual_ausente",
        quantidadeFaltanteNaBase: null,
        registrosNovosNaFonteFaltantesNaBase: null,
        quantidadeAusenteDaFonteAtual: null,
        quantidadeAlterada: null,
        registrosAusentesDaFonteAtual: null,
        registrosAlterados: null,
      },
  aprovado: errors.length === 0 && comparison?.reconciliada === true,
  erros: errors,
};

await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(`Base local: ${baseValidation.totalDataRows} linhas analisadas uma a uma; ${baseValidation.errors.length} erro(s); SHA-256 ${baseHash}.`);
if (officialExists) {
  console.log(`Fonte oficial: ${officialValidation.totalDataRows} linhas; ${officialValidation.errors.length} erro(s); SHA-256 ${officialHash}.`);
  if (comparison) {
    console.log(`Comparação: ${comparison.inclusoesNaBase.length} registros da fonte faltantes na base, ${comparison.alteracoes.length} alterações e ${comparison.ausentesNaFonteAtual.length} registros locais ausentes da fonte atual.`);
  }
} else {
  console.log(`Fonte oficial atual: ausente (${officialRelativePath}).`);
  console.log("Comparação bloqueada; contagens de faltantes, alterações e ausências permanecem desconhecidas.");
}
console.log(`Relatório: ${reportPath}`);

if (!report.aprovado) {
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
}
