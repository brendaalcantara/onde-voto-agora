import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, readFile, rename, rm, stat, writeFile, appendFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareCaptureToVersion, EXPECTED_FILTERS, validateTseArchiveUrl, validateTseCsv } from "./tse-automation-utils.mjs";

const siteDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const captureDirectory = resolve(process.argv.find((argument) => argument.startsWith("--capture-dir="))?.slice("--capture-dir=".length) ?? "");
const resultsZipPath = process.argv.find((argument) => argument.startsWith("--results-zip="))?.slice("--results-zip=".length);
const checkOnly = process.argv.includes("--check-only");
const dataDirectory = join(siteDirectory, "dados");
const catalogPath = join(dataDirectory, "versoes.json");
const activeMetadataPath = join(dataDirectory, "meta.json");
const activeCsvPath = join(dataDirectory, "secoes.csv");
const activeComparisonPath = join(dataDirectory, "comparacao-lula-flavio-1t.json");
const resultsZipBytesExpected = 161_616_519;
const resultsZipSha256Expected = "2d42006d0f6c6e00bad83f5c23cd3d78cd3e3182dbc1ad6718222b6b132c23e1";

if (captureDirectory === resolve(".")) throw new Error("Informe --capture-dir com os arquivos da coleta do TSE.");
const capturePath = join(captureDirectory, "captura.json");
const originZipPath = join(captureDirectory, "origem.zip");
const sourceCsvPath = join(captureDirectory, "secoes.csv");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function assertSafeCapture(capture, csvBytes, zipBytes, validation) {
  assert.equal(capture.source, "https://sig.tse.jus.br/ords/dwapr/r/seai/sig-eleicao-eleitorado/se%C3%A7%C3%B5es-alteradas");
  assert.equal(capture.archiveName, "secoes_eleitorais_alteradas_2t-pais_2026.csv.zip");
  validateTseArchiveUrl(capture.archiveUrl);
  assert.deepEqual(capture.filters, EXPECTED_FILTERS, "A captura precisa conter todos os filtros nacionais esperados.");
  assert.equal(capture.validation?.errors, 0);
  assert.equal(capture.validation?.duplicateKeys, 0);
  assert.equal(capture.validation?.rows, validation.rows);
  assert.equal(capture.expectedRows, validation.rows);
  assert.equal(capture.csvSha256, sha256(csvBytes), "O hash do CSV extraído não confere com a captura.");
  assert.equal(capture.zipSha256, sha256(zipBytes), "O hash do ZIP não confere com a captura.");
  assert.equal(capture.zipBytes, zipBytes.length, "O tamanho do ZIP não confere com a captura.");
  assert.ok(Number.isFinite(Date.parse(capture.panelUpdatedAt)), "A captura não tem horário válido informado pelo TSE.");
  assert.ok(Number.isFinite(Date.parse(capture.capturedAt)), "A captura não tem horário de consulta válido.");
}

function runNode(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: "inherit", timeout: 30 * 60 * 1000 });
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) throw new Error(`${script} falhou${result.signal ? ` (${result.signal})` : ` (código ${result.status})`}.`);
}

function isoToBrt(value) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Bahia", day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(value)).replace(",", " às").replace(":", "h");
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function writeAtomically(path, bytes) {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, bytes, { flag: "wx" });
  await rename(temporaryPath, path);
}

async function setWorkflowOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
  await appendFile(process.env.GITHUB_OUTPUT, lines, "utf8");
}

for (const path of [capturePath, originZipPath, sourceCsvPath, catalogPath, activeMetadataPath, activeCsvPath]) await access(path);
const [captureBytes, zipBytes, csvBytes, catalog, activeMetadata] = await Promise.all([
  readFile(capturePath), readFile(originZipPath), readFile(sourceCsvPath),
  readFile(catalogPath, "utf8").then(JSON.parse), readFile(activeMetadataPath, "utf8").then(JSON.parse),
]);
const capture = JSON.parse(captureBytes.toString("utf8"));
const csvText = new TextDecoder("windows-1252", { fatal: true }).decode(csvBytes);
const validation = validateTseCsv(csvText, capture.expectedRows);
assertSafeCapture(capture, csvBytes, zipBytes, validation);
if (capture.archiveEntry !== "secoes_eleitorais_alteradas_2t-pais_2026.csv") {
  throw new Error("O ZIP não identifica o CSV nacional oficial esperado.");
}
const zipCheck = spawnSync("unzip", ["-t", originZipPath], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
if (zipCheck.error) throw zipCheck.error;
if (zipCheck.status !== 0) throw new Error(`O ZIP da fonte oficial está corrompido: ${zipCheck.stderr.trim()}`);
const extractedCsv = spawnSync("unzip", ["-p", originZipPath, capture.archiveEntry], { maxBuffer: 50 * 1024 * 1024 });
if (extractedCsv.error) throw extractedCsv.error;
if (extractedCsv.status !== 0 || !extractedCsv.stdout.equals(csvBytes)) {
  throw new Error("O CSV entregue à rotina não corresponde aos bytes do CSV dentro do ZIP oficial.");
}

const currentVersion = catalog.versions?.find((version) => version.id === catalog.currentVersionId);
if (!currentVersion) throw new Error("O catálogo não identifica uma versão atual válida.");
const currentVersionCsv = join(siteDirectory, currentVersion.csv);
const currentBytes = await readFile(currentVersionCsv);
const currentHash = sha256(currentBytes);
if (currentVersion.csvSha256 && currentVersion.csvSha256 !== currentHash) {
  throw new Error("O hash da versão atualmente publicada não confere com o catálogo; atualização interrompida.");
}

const csvSha256 = sha256(csvBytes);
const difference = compareCaptureToVersion(csvSha256, capture.panelUpdatedAt, {
  csvSha256: currentHash,
  panelUpdatedAt: currentVersion.panelUpdatedAt,
});
if (!difference.needsUpdate) {
  console.log(JSON.stringify({ status: "unchanged", currentVersionId: currentVersion.id, rows: validation.rows, csvSha256 }, null, 2));
  await setWorkflowOutputs({ changed: "false", needs_update: "false", needs_results_zip: "false", version_id: currentVersion.id });
  process.exit(0);
}

if (checkOnly) {
  console.log(JSON.stringify({ status: "new-capture", rows: validation.rows, csvSha256, ...difference }, null, 2));
  await setWorkflowOutputs({ needs_update: "true", needs_results_zip: difference.needsResultsZip ? "true" : "false" });
  process.exit(0);
}

if (difference.needsResultsZip) {
  if (!resultsZipPath) throw new Error("A lista mudou; informe --results-zip com o ZIP oficial dos resultados do 1º turno.");
  const resultZipStat = await stat(resultsZipPath);
  if (resultZipStat.size !== resultsZipBytesExpected) throw new Error(`O ZIP de resultados do 1º turno tem tamanho inesperado: ${resultZipStat.size}.`);
  if (await sha256File(resultsZipPath) !== resultsZipSha256Expected) throw new Error("O SHA-256 do ZIP de resultados do 1º turno diverge do arquivo oficial validado.");
}

const panelDate = new Date(capture.panelUpdatedAt);
const panelIdParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Bahia", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).formatToParts(panelDate);
const partMap = Object.fromEntries(panelIdParts.map(({ type, value }) => [type, value]));
const versionId = `${partMap.year}-${partMap.month}-${partMap.day}-${partMap.hour}${partMap.minute}-${csvSha256.slice(0, 8)}`;
if (!/^[a-z0-9-]+$/.test(versionId) || catalog.versions.some((version) => version.id === versionId)) {
  throw new Error("A nova identificação da versão é inválida ou já existe; nenhuma versão será sobrescrita.");
}

const versionsDirectory = join(dataDirectory, "versoes");
const stagingDirectory = join(versionsDirectory, `.staging-${versionId}`);
const versionDirectory = join(versionsDirectory, versionId);
await mkdir(stagingDirectory, { recursive: false });
let archivePromoted = false;
try {
  const versionCsvPath = join(stagingDirectory, "secoes.csv");
  const versionZipPath = join(stagingDirectory, "origem.zip");
  const sourceCapturePath = join(stagingDirectory, "fonte-tse.json");
  const versionMetadataPath = join(stagingDirectory, "metadados.json");
  await writeFile(versionCsvPath, csvBytes, { flag: "wx" });
  await copyFile(originZipPath, versionZipPath);

  const capturedSource = {
    source: capture.source,
    panel: "https://sig.tse.jus.br/ords/dwapr/r/seai/sig-eleicao-eleitorado/painel-capilaridade",
    panelUpdatedAt: capture.panelUpdatedAt,
    captureAt: capture.capturedAt,
    archiveFileTimestamp: capture.archiveFileTimestamp ?? null,
    captureMethod: "ZIP integral solicitado ao painel oficial do TSE e validado localmente no workflow.",
    archiveName: capture.archiveName,
    archiveEntry: capture.archiveEntry,
    archiveUrl: capture.archiveUrl,
    filters: capture.filters,
    expectedRows: capture.expectedRows,
    validation: capture.validation,
    csvSha256,
    zipSha256: capture.zipSha256,
    zipBytes: capture.zipBytes,
  };
  await writeJson(sourceCapturePath, capturedSource);
  const sourceCaptureHash = await sha256File(sourceCapturePath);
  const relativeCsvPath = `dados/versoes/${versionId}/secoes.csv`;
  const relativeZipPath = `dados/versoes/${versionId}/origem.zip`;
  const relativeSourcePath = `dados/versoes/${versionId}/fonte-tse.json`;
  const sourceMetadata = {
    url: capture.source,
    arquivoCaptura: relativeSourcePath,
    sha256ArquivoCaptura: sourceCaptureHash,
    sha256ArquivoZip: capture.zipSha256,
    sha256Csv: csvSha256,
    formato: "CSV oficial integral baixado do recurso Arquivos gerados do painel de Capilaridade do TSE",
    capturadaEm: capture.capturedAt,
    painelAtualizacaoInformada: capture.panelUpdatedAt,
    painelRegistrosInformados: capture.expectedRows,
    registros: capture.expectedRows,
    paginasConferidas: null,
    filtros: capture.filters,
    metodo: `Arquivo ZIP oficial: ${validation.rows} linhas válidas, 0 erros estruturais e 0 chaves duplicadas; ${validation.statesWithRows} UFs com registros.`,
  };
  const sourceMetadataForSite = {
    id: versionId,
    eleicao: 2026,
    turnoInicial: 1,
    turnoFinal: 2,
    siteAtualizadoEm: capture.panelUpdatedAt.slice(0, 10),
    dadosConsultadosEm: capture.capturedAt,
    registrosBase: validation.rows,
    arquivoFonte: relativeCsvPath,
    dataArquivoNoZip: capture.archiveFileTimestamp ?? null,
    sha256ArquivoCsv: csvSha256,
    sha256ArquivoZip: capture.zipSha256,
    arquivoZip: relativeZipPath,
    fonteOficialAtual: sourceMetadata,
    fonte: {
      nome: "TSE — Estatísticas do eleitorado — Capilaridade — Seções alteradas",
      url: capture.source,
      painel: capturedSource.panel,
      noticiaUrl: activeMetadata.fonte?.noticiaUrl,
    },
    mensagemParaEleitor: `Lista do TSE: ${validation.rows} seções. Painel atualizado em ${isoToBrt(capture.panelUpdatedAt)}; consulta feita em ${isoToBrt(capture.capturedAt)}.`,
    observacao: "A lista foi extraída do ZIP oficial integral do TSE. Cada atualização válida é preservada como versão, sem interpretar ausências entre capturas como cancelamentos.",
  };
  await writeJson(versionMetadataPath, sourceMetadataForSite);

  const versionComparisonPath = join(stagingDirectory, "comparacao.json");
  if (difference.listChanged) {
    const generatorPath = join(siteDirectory, "relatorios", "gerar-relatorio-votos-secoes-mudadas.mjs");
    const comparisonGeneratorPath = join(siteDirectory, "relatorios", "gerar-dados-comparacao-1turno.mjs");
    runNode(generatorPath, [
      resultsZipPath,
      `--suffix=${versionId}`,
      `--output-dir=${stagingDirectory}`,
      "--csv-only",
      `--list=${versionCsvPath}`,
      `--metadata=${versionMetadataPath}`,
    ]);

    const detailCsvPath = join(stagingDirectory, `votos-1o-turno-por-secao-candidatos-${versionId}.csv`);
    const detailMetadataPath = join(stagingDirectory, `votos-1o-turno-por-secao-candidatos-${versionId}.meta.json`);
    runNode(comparisonGeneratorPath, [
      detailCsvPath,
      `--list=${versionCsvPath}`,
      `--metadata=${versionMetadataPath}`,
      `--source-meta=${detailMetadataPath}`,
      `--version-id=${versionId}`,
      `--output=${versionComparisonPath}`,
    ]);
  } else {
    const currentVersionDirectory = dirname(currentVersionCsv);
    const currentComparisonPath = join(siteDirectory, currentVersion.comparison);
    const currentComparison = JSON.parse(await readFile(currentComparisonPath, "utf8"));
    assert.equal(currentComparison.listaMudancas?.sha256, currentHash, "A comparação atual não corresponde ao CSV sem alterações.");
    assert.equal(currentComparison.linhas?.length, validation.rows);
    const detailBase = `votos-1o-turno-por-secao-candidatos-${currentVersion.id}`;
    await copyFile(join(currentVersionDirectory, `${detailBase}.csv`), join(stagingDirectory, `votos-1o-turno-por-secao-candidatos-${versionId}.csv`));
    await copyFile(join(currentVersionDirectory, `${detailBase}.meta.json`), join(stagingDirectory, `votos-1o-turno-por-secao-candidatos-${versionId}.meta.json`));
    const reusedComparison = {
      ...currentComparison,
      versaoListaId: versionId,
      geradoEm: capture.capturedAt,
      listaMudancas: {
        ...currentComparison.listaMudancas,
        arquivo: `dados/versoes/${versionId}/secoes.csv`,
        arquivoMarcadoEm: capture.archiveFileTimestamp ?? null,
        painelAtualizacaoInformada: capture.panelUpdatedAt,
        capturadaEm: capture.capturedAt,
        registros: validation.rows,
        sha256: csvSha256,
      },
    };
    await writeJson(versionComparisonPath, reusedComparison);
  }
  const comparison = JSON.parse(await readFile(versionComparisonPath, "utf8"));
  assert.equal(comparison.versaoListaId, versionId);
  assert.equal(comparison.linhas.length, validation.rows);
  assert.equal(comparison.listaMudancas.sha256, csvSha256);
  assert.equal(comparison.cobertura.registrosNaCopia, validation.rows);
  assert.equal(comparison.cobertura.zerosInferidosLula, 0);
  assert.equal(comparison.cobertura.zerosInferidosFlavioBolsonaro, 0);

  const reconciliationName = `reconciliacao-${currentVersion.id}.json`;
  const reconciliationPath = join(stagingDirectory, reconciliationName);
  runNode(join(siteDirectory, "relatorios", "reconciliar-versoes-secoes.mjs"), [
    `--previous=${currentVersionCsv}`,
    `--current=${versionCsvPath}`,
    `--output=${reconciliationPath}`,
  ]);
  const reconciliation = JSON.parse(await readFile(reconciliationPath, "utf8"));
  reconciliation.versaoAtual.arquivo = relativeCsvPath;
  await writeFile(reconciliationPath, `${JSON.stringify(reconciliation, null, 2)}\n`, "utf8");

  const fileTimestamp = capturedSource.archiveFileTimestamp;
  const versionLabel = `TSE · ${isoToBrt(capture.panelUpdatedAt).replace(" às ", " às ")} · ${validation.rows.toLocaleString("pt-BR")} seções`;
  const newVersion = {
    id: versionId,
    label: versionLabel,
    records: validation.rows,
    csv: relativeCsvPath,
    comparison: `dados/versoes/${versionId}/comparacao.json`,
    sourceCapture: relativeSourcePath,
    sourceArchive: relativeZipPath,
    reconciliation: `dados/versoes/${versionId}/${reconciliationName}`,
    reconcilesWith: currentVersion.id,
    panelUpdatedAt: capture.panelUpdatedAt,
    capturedAt: capture.capturedAt,
    fileTimestamp,
    sourceUrl: capture.source,
    sourceSha256: sourceCaptureHash,
    csvSha256,
    sourceZipSha256: capture.zipSha256,
    resultsZipSha256: comparison.resultados.sha256ZipAnalisado,
    note: "Exportação integral oficial do TSE. Ausências entre versões são diferenças entre capturas, não confirmação de cancelamento.",
  };

  await rename(stagingDirectory, versionDirectory);
  archivePromoted = true;

  const catalogNext = {
    ...catalog,
    currentVersionId: versionId,
    versions: [newVersion, ...catalog.versions],
  };
  const finalMetadata = { ...sourceMetadataForSite };
  const metaBytes = Buffer.from(`${JSON.stringify(finalMetadata, null, 2)}\n`, "utf8");
  const catalogBytes = Buffer.from(`${JSON.stringify(catalogNext, null, 2)}\n`, "utf8");
  const comparisonBytes = await readFile(join(versionDirectory, "comparacao.json"));
  await writeAtomically(activeCsvPath, csvBytes);
  await writeAtomically(activeMetadataPath, metaBytes);
  await writeAtomically(activeComparisonPath, comparisonBytes);
  await writeAtomically(catalogPath, catalogBytes);

  console.log(JSON.stringify({ status: "updated", versionId, rows: validation.rows, csvSha256, resultsFound: comparison.cobertura.resultadosEncontrados, resultsUnavailable: comparison.cobertura.resultadosIndisponiveis, reconciliation: reconciliation.reconciliacao }, null, 2));
  await setWorkflowOutputs({ changed: "true", version_id: versionId });
} catch (error) {
  if (archivePromoted) await rm(versionDirectory, { recursive: true, force: true });
  throw error;
} finally {
  await rm(stagingDirectory, { recursive: true, force: true });
}
