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
  assert.equal(snapshot.filters.state, "Todas");
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
  const csvPath = join(tempDirectory, "secoes.csv");
  const capturePath = join(tempDirectory, "captura.json");
  const outputPath = join(tempDirectory, "github-output.txt");
  try {
    await Promise.all([
      copyFile(join(siteDirectory, currentVersion.sourceArchive), zipPath),
      copyFile(join(siteDirectory, currentVersion.csv), csvPath),
    ]);
    const [zipBytes, csvBytes] = await Promise.all([readFile(zipPath), readFile(csvPath)]);
    const hash = (value) => createHash("sha256").update(value).digest("hex");
    const validation = validateTseCsv(new TextDecoder("windows-1252", { fatal: true }).decode(csvBytes), currentVersion.records);
    const archiveTimestamp = `${currentVersion.panelUpdatedAt.slice(0, 10).replaceAll("-", "")}_${currentVersion.panelUpdatedAt.slice(11, 19).replaceAll(":", "")}`;
    const capture = {
      source: "https://sig.tse.jus.br/ords/dwapr/r/seai/sig-eleicao-eleitorado/se%C3%A7%C3%B5es-alteradas",
      archiveUrl: `https://cdn.tse.jus.br/estatistica/sead/odsele/arquivos_gerados/eleitorado_eleicao_2026/${archiveTimestamp}/abc123/secoes_eleitorais_alteradas_2t-pais_2026.csv.zip`,
      archiveName: "secoes_eleitorais_alteradas_2t-pais_2026.csv.zip",
      archiveEntry: "secoes_eleitorais_alteradas_2t-pais_2026.csv",
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
