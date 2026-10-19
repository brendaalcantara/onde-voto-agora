import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { Transform } from "node:stream";
import { join, resolve } from "node:path";
import {
  TSE_ARCHIVE_BASENAME,
  TSE_SECTIONS_URL,
  parsePanelSnapshot,
  validateTseArchiveUrl,
  validateTseCsv,
} from "./tse-automation-utils.mjs";

let chromium;
try {
  ({ chromium } = await import("../automation/node_modules/playwright/index.mjs"));
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  ({ chromium } = await import("playwright"));
}

const outputDirectory = resolve(process.argv.find((argument) => argument.startsWith("--output-dir="))?.slice("--output-dir=".length) ?? "");
if (outputDirectory === resolve(".")) throw new Error("Informe --output-dir com uma pasta temporária exclusiva.");
await mkdir(outputDirectory, { recursive: true });

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} terminou com código ${result.status}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function downloadZip(url, destination) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok || !response.body) throw new Error(`Download do TSE retornou HTTP ${response.status}.`);
      validateTseArchiveUrl(response.url);
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (declaredLength > 100 * 1024 * 1024) throw new Error("O ZIP do TSE ultrapassa o limite de 100 MB.");
      let received = 0;
      const limitedBody = new Transform({
        transform(chunk, encoding, callback) {
          received += chunk.length;
          if (received > 100 * 1024 * 1024) callback(new Error("O ZIP do TSE ultrapassa o limite de 100 MB."));
          else callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body), limitedBody, createWriteStream(destination, { flags: "wx" }));
      if (received === 0) throw new Error("O ZIP do TSE está vazio.");
      return;
    } catch (error) {
      lastError = error;
      await rm(destination, { force: true });
      if (attempt < 3) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 2_000));
    }
  }
  throw lastError;
}

async function locateGeneratedArchive(page) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const body = await frame.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
      if (!/Requisição processada/i.test(body)) continue;
      const hrefs = await frame.locator(`a[href*="${TSE_ARCHIVE_BASENAME}"]`).evaluateAll((links) => links.map((link) => link.href)).catch(() => []);
      for (const href of hrefs) {
        try {
          return validateTseArchiveUrl(href);
        } catch {
          // Links que não sejam a exportação oficial esperada são ignorados.
        }
      }
    }
    await page.waitForTimeout(1_500);
  }
  throw new Error("O TSE não disponibilizou o ZIP em até 3 minutos após solicitar a exportação.");
}

async function extractCsv(zipPath, destination) {
  const entries = requireCommand("unzip", ["-Z1", zipPath]).split(/\r?\n/).filter(Boolean);
  const csvEntries = entries.filter((entry) => entry.endsWith(".csv"));
  if (csvEntries.length !== 1 || csvEntries[0].split("/").at(-1) !== TSE_ARCHIVE_BASENAME.replace(/\.zip$/i, "")) {
    throw new Error("O ZIP do TSE não contém exatamente o CSV esperado.");
  }
  const child = spawn("unzip", ["-p", zipPath, csvEntries[0]], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { if (stderr.length < 8_000) stderr += chunk.toString("utf8"); });
  const closed = new Promise((resolveClose, rejectClose) => {
    child.once("error", rejectClose);
    child.once("close", (code) => resolveClose(code));
  });
  await pipeline(child.stdout, createWriteStream(destination, { flags: "wx" }));
  const code = await closed;
  if (code !== 0) throw new Error(`Falha ao extrair o CSV oficial (unzip ${code}): ${stderr.trim()}`);
  return csvEntries[0];
}

function archiveTimestamp(zipPath, entryName) {
  const listing = requireCommand("unzip", ["-l", zipPath]);
  const line = listing.split(/\r?\n/).find((value) => value.trim().endsWith(entryName));
  const match = /^\s*\d+\s+(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})\s+/.exec(line ?? "");
  return match ? `${match[3]}-${match[1]}-${match[2]}T${match[4]}:${match[5]}:00` : null;
}

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(TSE_SECTIONS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByRole("heading", { name: /Seções alteradas/i }).waitFor();
  await page.waitForFunction(() => /linhas?\(s\)\s*\d+\s*-\s*\d+\s+de\s+[\d.]+/i.test(document.body.innerText), { timeout: 60_000 });

  const panelText = await page.locator("body").innerText();
  const panel = parsePanelSnapshot(panelText);
  await page.getByRole("button", { name: "Gerar arquivos", exact: true }).click();
  const archiveUrl = await locateGeneratedArchive(page);
  const archivePath = join(outputDirectory, "origem.zip");
  await downloadZip(archiveUrl, archivePath);
  const archiveBytes = await readFile(archivePath);
  const csvPath = join(outputDirectory, "secoes.csv");
  const archiveEntry = await extractCsv(archivePath, csvPath);
  const csvBytes = await readFile(csvPath);
  const csvText = new TextDecoder("windows-1252", { fatal: true }).decode(csvBytes);
  const validation = validateTseCsv(csvText, panel.expectedRows);
  const capturedAt = new Date().toISOString();
  const capture = {
    source: TSE_SECTIONS_URL,
    panel: "https://sig.tse.jus.br/ords/dwapr/r/seai/sig-eleicao-eleitorado/painel-capilaridade",
    archiveUrl,
    archiveName: TSE_ARCHIVE_BASENAME,
    archiveEntry,
    archiveFileTimestamp: archiveTimestamp(archivePath, archiveEntry),
    panelUpdatedAt: panel.panelUpdatedAt,
    capturedAt,
    filters: panel.filters,
    expectedRows: panel.expectedRows,
    validation: {
      rows: validation.rows,
      errors: 0,
      duplicateKeys: validation.duplicateKeys,
      statesWithRows: validation.statesWithRows,
    },
    csvSha256: sha256(csvBytes),
    zipSha256: sha256(archiveBytes),
    zipBytes: (await stat(archivePath)).size,
  };
  await writeFile(join(outputDirectory, "captura.json"), `${JSON.stringify(capture, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ status: "captured", panelUpdatedAt: capture.panelUpdatedAt, capturedAt, rows: validation.rows, csvSha256: capture.csvSha256, zipBytes: capture.zipBytes }, null, 2));
} finally {
  await browser.close();
}
