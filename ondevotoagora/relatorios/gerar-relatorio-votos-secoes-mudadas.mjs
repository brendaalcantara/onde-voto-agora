import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { Transform } from "node:stream";
import { normalizeNumber, normalizeText, validateCsv } from "../csv-utils.mjs";

const siteDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportsDirectory = dirname(fileURLToPath(import.meta.url));
const [zipArgument, ...options] = process.argv.slice(2);
const zipPath = zipArgument ? resolve(zipArgument) : "";
const valueFor = (name, fallback) => options.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const suffix = options.find((argument) => argument.startsWith("--suffix="))?.slice("--suffix=".length) ?? "";
const csvOnly = options.includes("--csv-only");
const outputDirectory = resolve(options.find((argument) => argument.startsWith("--output-dir="))?.slice("--output-dir=".length) ?? reportsDirectory);
const localCsvPath = resolve(valueFor("list", join(siteDirectory, "dados", "secoes.csv")));
const metadataPath = resolve(valueFor("metadata", join(siteDirectory, "dados", "meta.json")));
const suffixPattern = /^\d{4}-\d{2}-\d{2}(?:-\d{4})?(?:-[a-f0-9]{8})?$/i;
const csvOutputPath = join(outputDirectory, `votos-1o-turno-por-secao-candidatos-${suffix}.csv`);
const metadataOutputPath = join(outputDirectory, `votos-1o-turno-por-secao-candidatos-${suffix}.meta.json`);
const reportOutputPath = join(outputDirectory, `relatorio-votos-secoes-realocadas-1o-turno-${suffix}.md`);
const resultZipUrl = "https://cdn.tse.jus.br/estatistica/sead/odsele/votacao_secao/votacao_secao_2026_BR.zip";
const resultResourceId = "01ea4ccd-f443-469c-9f29-c69ff97f7d4c";
const expectedZipBytes = 161616519;
const expectedZipSha256 = "2d42006d0f6c6e00bad83f5c23cd3d78cd3e3182dbc1ad6718222b6b132c23e1";

if (!zipPath || !suffixPattern.test(suffix)) {
	throw new Error("Uso: node ondevotoagora/relatorios/gerar-relatorio-votos-secoes-mudadas.mjs /caminho/para/votacao_secao_2026_BR.zip --suffix=AAAA-MM-DD-HHMM [--output-dir=/caminho] [--csv-only]");
}
await access(zipPath);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(path) {
	return new Promise((resolveHash, rejectHash) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", rejectHash);
		stream.on("end", () => resolveHash(hash.digest("hex")));
	});
}

for (const outputPath of [csvOutputPath, metadataOutputPath, ...(csvOnly ? [] : [reportOutputPath])]) {
	await access(outputPath).then(
		() => { throw new Error(`O arquivo já existe e não será sobrescrito: ${outputPath}`); },
		(error) => { if (error.code !== "ENOENT") throw error; },
	);
}

const zipStat = await stat(zipPath);
if (zipStat.size !== expectedZipBytes) throw new Error(`Tamanho do ZIP inesperado: ${zipStat.size} bytes.`);
const zipHash = await sha256File(zipPath);
if (zipHash !== expectedZipSha256) throw new Error(`SHA-256 do ZIP não confere: ${zipHash}.`);

function normalizeCode(value) {
  return normalizeNumber(String(value ?? "").trim());
}

function normalizeTownName(value) {
  return normalizeText(value).replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function townKey(uf, municipality) {
  return normalizeText(uf) + "\u0000" + normalizeTownName(municipality);
}

function targetSectionKey(town, zone, section) {
  return town + "\u0000" + normalizeCode(zone) + "\u0000" + normalizeCode(section);
}

function officialSectionKey(uf, municipalityCode, zone, section) {
  return normalizeText(uf) + "\u0000" + normalizeCode(municipalityCode) + "\u0000" + normalizeCode(zone) + "\u0000" + normalizeCode(section);
}

function parseSemicolonRecord(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
      }
    } else if (character === '"' && cell.length === 0) {
      quoted = true;
    } else if (character === ";") {
      cells.push(cell);
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error("Registro da votação terminou dentro de um campo entre aspas.");
  cells.push(cell);
  return cells;
}

function classifyVote(codeValue, nameValue) {
  const code = normalizeCode(codeValue);
  const name = normalizeText(nameValue);
  if (code === "95" || name.includes("VOTO BRANCO") || name === "BRANCO") return "brancos";
  if (code === "96" || name.includes("VOTO NULO") || name === "NULO") return "nulos";
  if (/ANULAD|INDEFINID|SUB JUDICE/.test(name) || code === "97" || code === "98") return "outros";
  return "candidato";
}

function numberValue(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[;"\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

function percentPt(value, denominator) {
  if (!Number.isInteger(denominator) || denominator <= 0 || !Number.isInteger(value)) return "";
  return (value / denominator * 100).toFixed(4).replace(".", ",");
}

function brtTimestamp(date) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Bahia",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(date) + " (BRT)";
}

function fmtNumber(value) {
  return new Intl.NumberFormat("pt-BR").format(value);
}

function addMapSet(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

const localBytes = await readFile(localCsvPath);
const localHash = sha256(localBytes);
const localText = new TextDecoder("windows-1252").decode(localBytes);
const localValidation = validateCsv(localText, "dados/secoes.csv");
if (localValidation.errors.length > 0) {
  throw new Error("A cópia local de seções tem erros; análise interrompida: " + JSON.stringify(localValidation.errors.slice(0, 5)));
}
const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
if (metadata.registrosBase !== localValidation.totalDataRows || metadata.fonteOficialAtual?.registros !== localValidation.totalDataRows) {
	throw new Error("A lista de seções não confere com os metadados atuais.");
}
if (metadata.sha256ArquivoCsv !== localHash || metadata.fonteOficialAtual?.sha256Csv !== localHash) {
	throw new Error("O hash da lista atual não confere com os metadados; extração interrompida.");
}

const localByTown = new Map();
const localByTownAndSection = new Map();
for (const record of localValidation.records) {
  const cityKey = townKey(record.uf, record.municipio);
  const sectionKey = targetSectionKey(cityKey, record.zona, record.secao);
  if (!localByTown.has(cityKey)) localByTown.set(cityKey, []);
  if (!localByTownAndSection.has(sectionKey)) localByTownAndSection.set(sectionKey, []);
  localByTown.get(cityKey).push(record);
  localByTownAndSection.get(sectionKey).push(record);
}

const municipalityCodesByTown = new Map();
const resultByOfficialKey = new Map();
const candidateUniverse = new Map();
const sourceGenerationTimes = new Set();
const otherVoteNames = new Set();
let sourceDataRows = 0;
let presidentialFirstTurnRows = 0;
let candidateVoteRows = 0;
let zeroCandidateVoteRows = 0;
let invalidCandidateVoteRows = 0;
let relevantLocalTownRows = 0;
let malformedRows = 0;
let invalidVoteCounts = 0;
let duplicateResultRows = 0;
let archiveHeader = null;
let columns = null;

const unzip = spawn("unzip", ["-p", zipPath, "votacao_secao_2026_BR.csv"], { stdio: ["ignore", "pipe", "pipe"] });
let unzipError = "";
unzip.stderr.on("data", (chunk) => {
  if (unzipError.length < 12000) unzipError += chunk.toString("utf8");
});
const unzipClosed = new Promise((resolveClose, rejectClose) => {
  unzip.once("error", rejectClose);
  unzip.once("close", (code, signal) => resolveClose({ code, signal }));
});
const decoder = new TextDecoder("windows-1252");
const decodedStream = new Transform({
  transform(chunk, encoding, callback) {
    try {
      this.push(decoder.decode(chunk, { stream: true }));
      callback();
    } catch (error) {
      callback(error);
    }
  },
  flush(callback) {
    try {
      this.push(decoder.decode());
      callback();
    } catch (error) {
      callback(error);
    }
  },
});
unzip.stdout.pipe(decodedStream);
const lines = createInterface({ input: decodedStream, crlfDelay: Infinity });

for await (const line of lines) {
  if (!archiveHeader) {
    archiveHeader = parseSemicolonRecord(line).map((cell) => cell.replace(/^\uFEFF/, "").trim());
    columns = new Map(archiveHeader.map((name, index) => [name, index]));
    const required = [
      "DT_GERACAO", "HH_GERACAO", "ANO_ELEICAO", "NR_TURNO", "SG_UF",
      "CD_MUNICIPIO", "NM_MUNICIPIO", "NR_ZONA", "NR_SECAO", "DS_CARGO",
      "NR_VOTAVEL", "NM_VOTAVEL", "QT_VOTOS",
    ];
    const missing = required.filter((name) => !columns.has(name));
    if (missing.length > 0) throw new Error("Cabeçalho oficial sem colunas necessárias: " + missing.join(", "));
    continue;
  }
  if (!line) continue;
  sourceDataRows += 1;
  let row;
  try {
    row = parseSemicolonRecord(line);
  } catch {
    malformedRows += 1;
    continue;
  }
  if (row.length !== archiveHeader.length) {
    malformedRows += 1;
    continue;
  }
  const value = (name) => String(row[columns.get(name)] ?? "").trim();
  if (value("ANO_ELEICAO") !== "2026" || value("NR_TURNO") !== "1" || normalizeText(value("DS_CARGO")) !== "PRESIDENTE") continue;

  presidentialFirstTurnRows += 1;
  sourceGenerationTimes.add(value("DT_GERACAO") + " " + value("HH_GERACAO"));

  const voteCode = normalizeCode(value("NR_VOTAVEL"));
  const voteName = value("NM_VOTAVEL");
  const voteType = classifyVote(voteCode, voteName);
  if (voteType === "candidato") {
    candidateVoteRows += 1;
    const candidateVotes = numberValue(value("QT_VOTOS"));
    if (candidateVotes === null) invalidCandidateVoteRows += 1;
    else if (candidateVotes === 0) zeroCandidateVoteRows += 1;
    const previous = candidateUniverse.get(voteCode);
    if (previous && normalizeText(previous.name) !== normalizeText(voteName)) {
      throw new Error("Código de candidato associado a mais de um nome no arquivo oficial: " + voteCode);
    }
    candidateUniverse.set(voteCode, { code: voteCode, name: voteName });
  } else if (voteType === "outros") {
    otherVoteNames.add(voteCode + " " + voteName);
  }

  const uf = value("SG_UF");
  const municipality = value("NM_MUNICIPIO");
  const cityKey = townKey(uf, municipality);
  if (!localByTown.has(cityKey)) continue;
  relevantLocalTownRows += 1;

  const municipalityCode = normalizeCode(value("CD_MUNICIPIO"));
  if (!municipalityCode) continue;
  addMapSet(municipalityCodesByTown, cityKey, municipalityCode);
  const sectionKey = targetSectionKey(cityKey, value("NR_ZONA"), value("NR_SECAO"));
  if (!localByTownAndSection.has(sectionKey)) continue;

  const key = officialSectionKey(uf, municipalityCode, value("NR_ZONA"), value("NR_SECAO"));
  if (!resultByOfficialKey.has(key)) {
    resultByOfficialKey.set(key, {
      uf,
      municipalityCode,
      municipality,
      zone: value("NR_ZONA"),
      section: value("NR_SECAO"),
      candidates: new Map(),
      brancos: null,
      nulos: null,
      outros: [],
      sourceRows: 0,
      duplicateCandidateCodes: new Set(),
    });
  }
  const sectionResult = resultByOfficialKey.get(key);
  sectionResult.sourceRows += 1;
  const votes = numberValue(value("QT_VOTOS"));
  if (votes === null) {
    invalidVoteCounts += 1;
    continue;
  }
  if (voteType === "candidato") {
    if (sectionResult.candidates.has(voteCode)) {
      sectionResult.duplicateCandidateCodes.add(voteCode);
      duplicateResultRows += 1;
    } else {
      sectionResult.candidates.set(voteCode, { code: voteCode, name: voteName, votes });
    }
  } else if (voteType === "brancos") {
    sectionResult.brancos = sectionResult.brancos === null ? votes : sectionResult.brancos + votes;
  } else if (voteType === "nulos") {
    sectionResult.nulos = sectionResult.nulos === null ? votes : sectionResult.nulos + votes;
  } else {
    sectionResult.outros.push({ code: voteCode, name: voteName, votes });
  }
}

const closeResult = await unzipClosed;
if (closeResult.code !== 0) {
  throw new Error("Não foi possível ler o CSV de dentro do ZIP (unzip " + closeResult.code + "): " + unzipError);
}
if (!archiveHeader) throw new Error("O arquivo ZIP não contém votacao_secao_2026_BR.csv.");

const comparisonCandidateCodes = new Set(["13", "22"]);
const candidateList = [...candidateUniverse.values()]
  .filter((candidate) => comparisonCandidateCodes.has(candidate.code))
  .sort((a, b) => Number(a.code) - Number(b.code));
if (candidateList.length !== comparisonCandidateCodes.size) {
	throw new Error("O arquivo oficial não contém as duas candidaturas esperadas para a comparação (códigos 13 e 22).");
}
const expectedCandidateNames = new Map([
	["13", "LUIZ INACIO LULA DA SILVA"],
	["22", "FLAVIO NANTES BOLSONARO"],
]);
for (const candidate of candidateList) {
	if (normalizeText(candidate.name) !== expectedCandidateNames.get(candidate.code)) {
		throw new Error(`Nome inesperado para a candidatura ${candidate.code}: ${candidate.name}`);
	}
}
const cityCodeAmbiguities = [];
const sections = [];
for (const record of localValidation.records) {
  const cityKey = townKey(record.uf, record.municipio);
  const codes = [...(municipalityCodesByTown.get(cityKey) ?? [])];
  let status = "sem_resultado";
  let result = null;
  let code = "";
  if (codes.length === 1) {
    code = codes[0];
    result = resultByOfficialKey.get(officialSectionKey(record.uf, code, record.zona, record.secao)) ?? null;
    if (result) status = "com_resultado";
  } else if (codes.length > 1) {
    status = "codigo_municipal_ambiguo";
    cityCodeAmbiguities.push({ uf: record.uf, municipio: record.municipio, codigos: codes });
  } else {
    status = "codigo_municipal_nao_resolvido";
  }
  sections.push({ record, code, result, status });
}

const matchedSections = sections.filter((section) => section.result);
const completeSections = [];
const winnerCounts = new Map();
const candidateTotals = new Map(candidateList.map((candidate) => [candidate.code, 0]));
let tiesCount = 0;
let incompleteCandidateSections = 0;
let sectionsWithoutValidVotes = 0;
let validVotesComplete = 0;
let completePercentageMaxError = 0;
const missingCandidateRows = new Map(candidateList.map((candidate) => [candidate.code, 0]));
let duplicateComparisonCandidateSections = 0;
const csvLines = [[
  "situacao_correspondencia", "sg_uf", "cd_municipio_tse", "nm_municipio", "nr_zona", "nr_secao",
  "local_1o_turno", "local_2o_turno", "eleitorado_na_lista", "nr_votavel", "nm_candidato",
  "votos_candidato", "votos_lula_e_flavio_na_secao", "percentual_sobre_lula_e_flavio",
  "vencedor_da_secao", "empate", "votos_brancos_secao", "votos_nulos_secao",
  "votos_anulados_apurados_separado_secao",
  "linha_do_candidato_na_fonte",
].join(";")];

for (const section of sections) {
  const record = section.record;
  const result = section.result;
  if (!result) {
    csvLines.push([
      section.status, record.uf, section.code, record.municipio, record.zona, record.secao,
      record.localInicial, record.localFinal, record.eleitores, "", "", "", "", "", "", "",
      "", "", "", "sem_dado",
    ].map(csvCell).join(";"));
    continue;
  }

  const foundCandidateCodes = new Set(result.candidates.keys());
  const missingCandidates = candidateList.filter((candidate) => !foundCandidateCodes.has(candidate.code));
  const duplicateCandidates = candidateList.filter((candidate) => result.duplicateCandidateCodes.has(candidate.code));
  const candidateComplete = missingCandidates.length === 0 && duplicateCandidates.length === 0;
  if (!candidateComplete) incompleteCandidateSections += 1;
  for (const candidate of missingCandidates) {
    missingCandidateRows.set(candidate.code, (missingCandidateRows.get(candidate.code) ?? 0) + 1);
  }
  if (duplicateCandidates.length > 0) duplicateComparisonCandidateSections += 1;
  let comparisonVotes = 0;
  if (candidateComplete) {
    for (const candidate of candidateList) {
      const votes = result.candidates.get(candidate.code).votes;
      comparisonVotes += votes;
      candidateTotals.set(candidate.code, (candidateTotals.get(candidate.code) ?? 0) + votes);
    }
    completeSections.push(section);
  }
  const percentSum = candidateComplete && comparisonVotes > 0
    ? candidateList.reduce((sum, candidate) => sum + result.candidates.get(candidate.code).votes / comparisonVotes * 100, 0)
    : null;
  if (percentSum !== null) completePercentageMaxError = Math.max(completePercentageMaxError, Math.abs(percentSum - 100));

  let winnerNames = [];
  if (candidateComplete && comparisonVotes > 0) {
    const maxVotes = Math.max(...candidateList.map((candidate) => result.candidates.get(candidate.code).votes));
    winnerNames = candidateList.filter((candidate) => result.candidates.get(candidate.code).votes === maxVotes).map((candidate) => candidate.name);
    validVotesComplete += comparisonVotes;
    if (winnerNames.length > 1) tiesCount += 1;
    else {
      const winnerCode = candidateList.find((candidate) => result.candidates.get(candidate.code).votes === maxVotes)?.code;
      winnerCounts.set(winnerCode, (winnerCounts.get(winnerCode) ?? 0) + 1);
    }
  } else if (candidateComplete && comparisonVotes === 0) {
    sectionsWithoutValidVotes += 1;
  }

  const winner = candidateComplete && winnerNames.length > 0 ? winnerNames.join(" / ") : "";
  const tie = candidateComplete && winnerNames.length > 1 ? "sim" : (candidateComplete ? "não" : "");
  const denominator = candidateComplete && comparisonVotes > 0 ? comparisonVotes : "";
  const annulledSeparateVotes = result.outros
    .filter((vote) => vote.code === "97")
    .reduce((total, vote) => total + vote.votes, 0);
  for (const candidate of candidateList) {
    const vote = result.candidates.get(candidate.code);
    const candidateLineStatus = vote ? "presente" : "sem_linha_na_fonte";
    const candidateVotes = vote ? vote.votes : "";
    csvLines.push([
      candidateComplete ? "comparacao_disponivel" : "comparacao_indisponivel",
      record.uf, result.municipalityCode, result.municipality, record.zona, record.secao,
      record.localInicial, record.localFinal, record.eleitores,
      candidate.code, candidate.name,
      candidateVotes,
      denominator,
      candidateComplete && denominator !== "" ? percentPt(candidateVotes, comparisonVotes) : "",
      winner, tie,
      result.brancos === null ? "" : result.brancos,
      result.nulos === null ? "" : result.nulos,
      result.outros.length > 0 ? annulledSeparateVotes : "",
      candidateLineStatus,
    ].map(csvCell).join(";"));
  }
  if (duplicateCandidates.length > 0) {
    for (const { code } of duplicateCandidates) {
      csvLines.push([
        "duplicata_na_fonte", record.uf, result.municipalityCode, result.municipality, record.zona, record.secao,
        record.localInicial, record.localFinal, record.eleitores, code, "", "", "", "", "", "",
        result.brancos ?? "", result.nulos ?? "", annulledSeparateVotes, "duplicada",
      ].map(csvCell).join(";"));
    }
  }
}

const localByUf = new Map();
for (const record of localValidation.records) localByUf.set(record.uf, (localByUf.get(record.uf) ?? 0) + 1);
const winnerSummary = candidateList
  .map((candidate) => ({
    candidate,
    votes: candidateTotals.get(candidate.code) ?? 0,
    share: validVotesComplete > 0 ? (candidateTotals.get(candidate.code) ?? 0) / validVotesComplete * 100 : null,
    wins: winnerCounts.get(candidate.code) ?? 0,
  }))
  .sort((a, b) => b.votes - a.votes || Number(a.candidate.code) - Number(b.candidate.code));

const reportGeneratedAt = new Date();
const missingResultCount = sections.length - completeSections.length;
const unresolvedSectionDetails = sections
  .filter((section) => !section.result)
  .map(({ record, status }) => record.uf + ";" + record.municipio + ";zona " + record.zona + ";seção " + record.secao + " (" + status + ")")
  .join("; ") || "nenhuma";
const ambiguousMunicipalityDetails = cityCodeAmbiguities
  .map(({ uf, municipio, codigos }) => uf + ";" + municipio + " → " + codigos.join(", "))
  .join("; ") || "nenhum município ambíguo";

const sourceList = metadata.fonteOficialAtual;
const summaryLines = [
  "# Votos do 1º turno nas seções da lista atual do TSE",
  "",
  "> Esta página compara resultados do 1º turno; ela não mostra resultado nem previsão do 2º turno.",
  "",
  "## Cobertura",
  "",
  "- Seções na lista oficial atual: **" + fmtNumber(localValidation.totalDataRows) + "**.",
  "- Seções com resultados presidenciais correspondentes no ZIP oficial: **" + fmtNumber(matchedSections.length) + "**.",
  "- Seções com uma linha oficial válida para Lula (13) e Flávio Bolsonaro (22): **" + fmtNumber(completeSections.length) + "**.",
  "- Comparações indisponíveis: **" + fmtNumber(missingResultCount) + "**.",
  "- Linhas de Lula ausentes: **" + fmtNumber(missingCandidateRows.get("13")) + "**; linhas de Flávio Bolsonaro ausentes: **" + fmtNumber(missingCandidateRows.get("22")) + "**; seções com duplicidade de linha desses candidatos: **" + fmtNumber(duplicateComparisonCandidateSections) + "**.",
  "- Linha ausente nunca foi convertida em zero. Um zero só aparece se constar explicitamente como linha válida no arquivo.",
  "- Ambiguidades ao mapear município para código TSE: **" + fmtNumber(cityCodeAmbiguities.length) + "** (" + ambiguousMunicipalityDetails + ").",
  "",
  "## Fontes",
  "",
  "- Lista: " + sourceList.url + ". Painel atualizado em " + brtTimestamp(new Date(sourceList.painelAtualizacaoInformada)) + "; consultado em " + brtTimestamp(new Date(sourceList.capturadaEm)) + ". " + fmtNumber(sourceList.registros) + " linhas em " + fmtNumber(sourceList.paginasConferidas) + " páginas. SHA-256 do CSV local: " + localHash + ".",
  "- Resultados presidenciais por seção, eleição 2026, 1º turno: " + resultZipUrl + ". Resource TSE " + resultResourceId + "; SHA-256 do ZIP: " + zipHash + "; tamanho: " + fmtNumber(zipStat.size) + " bytes.",
  "- Instantes de geração observados no arquivo de resultados: " + [...sourceGenerationTimes].sort().join("; ") + ".",
  "",
  "## Método e validações",
  "",
  "- Cruzamento por UF, nome normalizado do município, zona e seção; o nome da escola não determina o resultado. Nenhum dado agregado por município ou zona foi usado.",
  "- Percentual na comparação da página = votos de Lula ou Flávio Bolsonaro ÷ soma dos votos dessas duas candidaturas × 100. Os demais candidatos, brancos e nulos não entram nesse denominador.",
  "- Uma comparação só é exibida quando as duas linhas estão presentes e válidas. Se faltar qualquer uma, a seção fica indisponível; a falta de linha não foi convertida em zero.",
  "- O CSV contém " + fmtNumber(sourceDataRows) + " linhas; " + fmtNumber(presidentialFirstTurnRows) + " linhas são da eleição 2026, turno 1, cargo Presidente. Linhas malformadas: " + fmtNumber(malformedRows) + "; contagens inválidas: " + fmtNumber(invalidVoteCounts) + "; duplicatas de candidatura/seção: " + fmtNumber(duplicateResultRows) + ".",
  "- Base local: " + fmtNumber(localValidation.totalDataRows) + " linhas, " + fmtNumber(localValidation.errors.length) + " erro(s) estruturais e " + fmtNumber(localValidation.duplicateKeys.length) + " duplicata(s). O ZIP passou pela conferência de integridade; SHA-256 " + zipHash + ".",
  "",
  "A mudança do local de votação não demonstra que a votação da seção mudou. Este arquivo é apenas uma descrição dos resultados oficiais do 1º turno nas seções da lista atual.",
  "",
  "Extraído em " + brtTimestamp(reportGeneratedAt) + ". CSV detalhado: " + csvOutputPath.split("/").at(-1) + ".",
].join("\n");

const archiveMetadata = {
  geradoEm: reportGeneratedAt.toISOString(),
  urlArquivo: resultZipUrl,
  resourceId: resultResourceId,
  sha256Zip: zipHash,
  tamanhoZipBytes: zipStat.size,
  datasGeracao: [...new Set([...sourceGenerationTimes].map((value) => value.split(" ")[0]))].sort(),
  instantesGeracao: [...sourceGenerationTimes].sort(),
  linhasCsv: sourceDataRows,
  linhasPresidentePrimeiroTurno: presidentialFirstTurnRows,
  secoesNaLista: localValidation.totalDataRows,
  candidaturasComparadas: candidateList,
  coberturaComparacao: {
		resultadosDisponiveis: completeSections.length,
		resultadosIndisponiveis: missingResultCount,
		linhasLulaAusentes: missingCandidateRows.get("13"),
		linhasFlavioAusentes: missingCandidateRows.get("22"),
		secoesComDuplicidadeDosCandidatosComparados: duplicateComparisonCandidateSections,
		secoesSemCorrespondenciaDeResultado: sections.filter((section) => !section.result).length,
		secoesComResultadoMasComparacaoIncompleta: incompleteCandidateSections,
		zeroInferidoPorAusencia: false,
	},
};

await writeFile(csvOutputPath, csvLines.join("\n") + "\n", { encoding: "utf8", flag: "wx" });
await writeFile(metadataOutputPath, `${JSON.stringify(archiveMetadata, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
if (!csvOnly) await writeFile(reportOutputPath, summaryLines + "\n", { encoding: "utf8", flag: "wx" });

console.log(JSON.stringify({
  report: reportOutputPath,
  detailCsv: csvOutputPath,
  detailMetadata: metadataOutputPath,
  localSections: localValidation.totalDataRows,
  matchedSections: matchedSections.length,
  completeSections: completeSections.length,
  comparisonsUnavailable: missingResultCount,
  incompleteCandidateSections,
  candidateVoteRows,
  zeroCandidateVoteRows,
  invalidCandidateVoteRows,
  missingCandidateRows: Object.fromEntries(missingCandidateRows),
  duplicateComparisonCandidateSections,
  ties: tiesCount,
  candidatesCompared: candidateList.map(({ code, name }) => ({ code, name })),
  sourceDataRows,
  presidentialFirstTurnRows,
  resultZipSha256: zipHash,
  generatedAtBrt: brtTimestamp(reportGeneratedAt),
}, null, 2));
