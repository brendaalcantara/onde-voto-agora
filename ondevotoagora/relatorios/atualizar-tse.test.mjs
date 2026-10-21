import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createVersionId,
  compareCaptureToVersion,
  EXPECTED_FILTERS,
  parsePanelSnapshot,
  validateTseArchiveUrl,
  validateTseCsv,
} from "./tse-automation-utils.mjs";

const siteDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");

test("reconhece timestamp, filtros nacionais e contagem do painel", () => {
  const snapshot = parsePanelSnapshot(`
    Seções eleitorais alteradas no segundo turno
    Última atualização: 19.10.2026 - 11:27   \\   Próxima atualização: 19.10.2026 - 15:25
    Ano: 2026 País: Todos Região: Todas UF: Todas Município: Todos Zona: Todas Local de votação: Todos
    linha(s) 1 - 20 de 554
  `);
  assert.equal(snapshot.panelUpdatedAt, "2026-10-19T11:27:00-03:00");
  assert.equal(snapshot.expectedRows, 554);
  assert.equal(snapshot.filters.country, "Todos");
  assert.equal(snapshot.filters.state, "Todas");
});
test("preserva País Brasil quando esse é o filtro efetivamente exibido no painel", () => {
  const snapshot = parsePanelSnapshot(`
    Seções eleitorais alteradas no segundo turno
    Última atualização: 19.10.2026 - 11:27
    Ano: 2026 País: Brasil Região: Todas UF: Todas Município: Todos Zona: Todas Local de votação: Todos
    linha(s) 1 - 20 de 554
  `);
  assert.equal(snapshot.filters.country, "Brasil");
});
test("recusa painel que não esteja em escopo nacional ou ano esperado", () => {
  assert.throws(() => parsePanelSnapshot(`
    Seções eleitorais alteradas no segundo turno
    Última atualização: 19.10.2026 - 11:27
    Ano: 2026 País: Todos Região: Todas UF: BA Município: Todos Zona: Todas Local de votação: Todos
    linha(s) 1 - 20 de 554
  `), /filtro nacional/);
});

test("aceita somente URL HTTPS do ZIP público esperado no CDN do TSE", () => {
  const url = "https://cdn.tse.jus.br/estatistica/sead/odsele/arquivos_gerados/eleitorado_eleicao_2026/20261019_112700/abc123/secoes_eleitorais_alteradas_2t-pais_2026.csv.zip";
  assert.equal(validateTseArchiveUrl(url), url);
  assert.throws(() => validateTseArchiveUrl(url.replace("cdn.tse.jus.br", "cdn.tse.jus.br.attacker.invalid")), /link do arquivo/);
  assert.throws(() => validateTseArchiveUrl(url.replace("https:", "http:")), /link do arquivo/);
});

test("valida a lista versionada atual contra contagem e estrutura esperadas", async () => {
  const csv = await readFile(join(siteDirectory, "dados/versoes/2026-10-19-1127/secoes.csv"));
  const text = new TextDecoder("windows-1252", { fatal: true }).decode(csv);
  const result = validateTseCsv(text, 554);
  assert.equal(result.rows, 554);
  assert.equal(result.duplicateKeys, 0);
  assert.equal(result.statesWithRows, 22);
  assert.throws(() => validateTseCsv(text, 553), /painel informa 553/);
});

test("identifica cada versão pelo horário oficial e hash dos dados", () => {
  assert.equal(
    createVersionId("2026-10-19T11:27:00-03:00", "a".repeat(64)),
    "2026-10-19-1127-aaaaaaaa",
  );
});

test("distingue atualização do painel de mudança na lista", () => {
  const current = { csvSha256: "a".repeat(64), panelUpdatedAt: "2026-10-19T11:27:00-03:00" };
  assert.deepEqual(compareCaptureToVersion("a".repeat(64), current.panelUpdatedAt, current), {
    needsUpdate: false, needsResultsZip: false, listChanged: false, panelUpdateChanged: false,
  });
  assert.deepEqual(compareCaptureToVersion("a".repeat(64), "2026-10-19T15:27:00-03:00", current), {
    needsUpdate: true, needsResultsZip: false, listChanged: false, panelUpdateChanged: true,
  });
  assert.deepEqual(compareCaptureToVersion("b".repeat(64), current.panelUpdatedAt, current), {
    needsUpdate: true, needsResultsZip: true, listChanged: true, panelUpdateChanged: false,
  });
});

test("não cria outra versão quando a exportação é idêntica à atual", async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), "ondevotoagora-tse-test-"));
  const catalog = JSON.parse(await readFile(join(siteDirectory, "dados/versoes.json"), "utf8"));
  const currentVersion = catalog.versions.find((version) => version.id === catalog.currentVersionId);
  assert.ok(currentVersion, "o catálogo deve apontar para uma versão atual");
  const zipPath = join(tempDirectory, "origem.zip");
  const archiveEntry = "secoes_eleitorais_alteradas_2t-pais_2026.csv";
  const archiveCsvPath = join(tempDirectory, archiveEntry);
  const csvPath = join(tempDirectory, "secoes.csv");
  const capturePath = join(tempDirectory, "captura.json");
  const outputPath = join(tempDirectory, "github-output.txt");
  try {
    await copyFile(join(siteDirectory, currentVersion.csv), csvPath);
    await copyFile(csvPath, archiveCsvPath);
    const zipCreation = spawnSync("zip", ["-q", zipPath, archiveEntry], { cwd: tempDirectory, encoding: "utf8" });
    assert.equal(zipCreation.error, undefined, zipCreation.error?.message);
    assert.equal(zipCreation.status, 0, `${zipCreation.stdout}\n${zipCreation.stderr}`);
    const [zipBytes, csvBytes] = await Promise.all([readFile(zipPath), readFile(csvPath)]);
    const hash = (value) => createHash("sha256").update(value).digest("hex");
    const validation = validateTseCsv(new TextDecoder("windows-1252", { fatal: true }).decode(csvBytes), currentVersion.records);
    const archiveTimestamp = `${currentVersion.panelUpdatedAt.slice(0, 10).replaceAll("-", "")}_${currentVersion.panelUpdatedAt.slice(11, 19).replaceAll(":", "")}`;
    const capture = {
      source: "https://sig.tse.jus.br/ords/dwapr/r/seai/sig-eleicao-eleitorado/se%C3%A7%C3%B5es-alteradas",
      archiveUrl: `https://cdn.tse.jus.br/estatistica/sead/odsele/arquivos_gerados/eleitorado_eleicao_2026/${archiveTimestamp}/abc123/secoes_eleitorais_alteradas_2t-pais_2026.csv.zip`,
      archiveName: "secoes_eleitorais_alteradas_2t-pais_2026.csv.zip",
      archiveEntry,
      panelUpdatedAt: currentVersion.panelUpdatedAt,
      capturedAt: new Date(Date.parse(currentVersion.panelUpdatedAt) + 10 * 60_000).toISOString(),
      filters: EXPECTED_FILTERS,
      expectedRows: validation.rows,
      validation: { rows: validation.rows, errors: 0, duplicateKeys: validation.duplicateKeys, statesWithRows: validation.statesWithRows },
      csvSha256: hash(csvBytes),
      zipSha256: hash(zipBytes),
      zipBytes: zipBytes.length,
    };
    await writeFile(capturePath, `${JSON.stringify(capture)}\n`, "utf8");
    const result = spawnSync(process.execPath, [
      resolve(siteDirectory, "relatorios/publicar-atualizacao-tse.mjs"),
      `--capture-dir=${tempDirectory}`,
      "--check-only",
    ], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
      timeout: 30_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(await readFile(outputPath, "utf8"), /changed=false\nneeds_update=false/);
    assert.match(result.stdout, /"status": "unchanged"/);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("aceita CSV local explícito sem ZIP e confere nome, tamanho, hash e contagem", async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), "ondevotoagora-tse-local-csv-test-"));
  const catalog = JSON.parse(await readFile(join(siteDirectory, "dados/versoes.json"), "utf8"));
  const currentVersion = catalog.versions.find((version) => version.id === catalog.currentVersionId);
  assert.ok(currentVersion, "o catálogo deve apontar para uma versão atual");
  const csvPath = join(tempDirectory, "secoes.csv");
  const capturePath = join(tempDirectory, "captura.json");
  try {
    await copyFile(join(siteDirectory, currentVersion.csv), csvPath);
    const csvBytes = await readFile(csvPath);
    const hash = (value) => createHash("sha256").update(value).digest("hex");
    const validation = validateTseCsv(new TextDecoder("windows-1252", { fatal: true }).decode(csvBytes), currentVersion.records);
    const capture = {
      sourceMode: "local-csv",
      source: "https://sig.tse.jus.br/ords/dwapr/r/seai/sig-eleicao-eleitorado/se%C3%A7%C3%B5es-alteradas",
      sourceFileName: "secoes_eleitorais_alteradas_2t-pais_2026-2.csv",
      sourceFileBytes: csvBytes.length,
      sourceFileSha256: hash(csvBytes),
      panelUpdatedAt: currentVersion.panelUpdatedAt,
      capturedAt: new Date(Date.parse(currentVersion.panelUpdatedAt) + 10 * 60_000).toISOString(),
      filters: { ...EXPECTED_FILTERS, country: "Todos" },
      expectedRows: validation.rows,
      validation: { rows: validation.rows, errors: 0, duplicateKeys: validation.duplicateKeys, statesWithRows: validation.statesWithRows },
      csvSha256: hash(csvBytes),
    };
    const runCheckOnly = () => spawnSync(process.execPath, [
      resolve(siteDirectory, "relatorios/publicar-atualizacao-tse.mjs"),
      `--capture-dir=${tempDirectory}`,
      "--check-only",
    ], { encoding: "utf8", timeout: 30_000 });

    await writeFile(capturePath, `${JSON.stringify(capture)}\n`, "utf8");
    let result = runCheckOnly();
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /"status": "unchanged"/);

    await writeFile(capturePath, `${JSON.stringify({ ...capture, sourceFileSha256: "0".repeat(64) })}\n`, "utf8");
    result = runCheckOnly();
    assert.notEqual(result.status, 0, "hash informado incorretamente precisa interromper a publicação");
    assert.match(`${result.stdout}\n${result.stderr}`, /hash do CSV fornecido/);

    await writeFile(capturePath, `${JSON.stringify({ ...capture, expectedRows: validation.rows - 1 })}\n`, "utf8");
    result = runCheckOnly();
    assert.notEqual(result.status, 0, "contagem divergente do painel precisa interromper a publicação");
    assert.match(`${result.stdout}\n${result.stderr}`, /painel informa .* linhas, mas o CSV tem/);

    await writeFile(capturePath, `${JSON.stringify({ ...capture, expectedRows: validation.rows })}\n`, "utf8");
    const nonBrazilBytes = Buffer.from(csvBytes.toString("latin1").replace(";Brasil;", ";Exterior;"), "latin1");
    await writeFile(csvPath, nonBrazilBytes);
    result = runCheckOnly();
    assert.notEqual(result.status, 0, "País Todos só pode ser aceito quando todas as linhas forem do Brasil");
    assert.match(`${result.stdout}\n${result.stderr}`, /ano, país e cobertura nacional/);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
