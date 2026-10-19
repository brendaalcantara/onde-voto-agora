const NUMBER_FORMAT = new Intl.NumberFormat("pt-BR");
const versionList = document.querySelector("#version-list");
const observationList = document.querySelector("#observation-list");

function formatDateTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "data não informada";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Bahia",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date).replace(":", "h");
}

function formatFileTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(value ?? ""));
  return match ? `${match[3]}/${match[2]}/${match[1]} às ${match[4]}h${match[5]}` : "data não informada";
}

function validateCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.versions) || !Array.isArray(catalog.observedCounts)) {
    throw new Error("O histórico está incompleto.");
  }
  const seen = new Set();
  for (const version of catalog.versions) {
    if (!/^[a-z0-9-]+$/.test(version.id) || seen.has(version.id)) throw new Error("Há uma versão inválida ou repetida.");
    if (version.csv !== `dados/versoes/${version.id}/secoes.csv` || version.comparison !== `dados/versoes/${version.id}/comparacao.json`) {
      throw new Error(`Os arquivos da versão ${version.id} não correspondem à pasta esperada.`);
    }
    if (version.sourceCapture && version.sourceCapture !== `dados/versoes/${version.id}/fonte-tse.json`) {
      throw new Error(`A captura da versão ${version.id} aponta para um caminho inesperado.`);
    }
    if (version.sourceArchive && version.sourceArchive !== `dados/versoes/${version.id}/origem.zip`) {
      throw new Error(`O arquivo de origem da versão ${version.id} aponta para um caminho inesperado.`);
    }
    if (version.reconciliation &&
      (!/^dados\/versoes\/[a-z0-9-]+\/reconciliacao-[a-z0-9-]+\.json$/.test(version.reconciliation) ||
        !version.reconciliation.startsWith(`dados/versoes/${version.id}/`))) {
      throw new Error(`A reconciliação da versão ${version.id} aponta para um caminho inesperado.`);
    }
    if (!Number.isInteger(version.records) || version.records < 1 || typeof version.label !== "string") {
      throw new Error(`Os dados da versão ${version.id} estão incompletos.`);
    }
    seen.add(version.id);
  }
  if (!seen.has(catalog.currentVersionId)) throw new Error("A versão atual não consta no histórico.");
  return catalog;
}

function createLink(label, path, download = false) {
  if (!path) return null;
  const link = document.createElement("a");
  link.href = `./${path}`;
  link.textContent = label;
  if (download) link.download = "";
  else {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  return link;
}

function renderVersion(version, currentVersionId) {
  const item = document.createElement("li");
  item.className = "version-card";
  const heading = document.createElement("h3");
  heading.textContent = version.label;
  const count = document.createElement("p");
  count.className = "version-count";
  count.textContent = `${NUMBER_FORMAT.format(version.records)} seções na lista.`;
  const details = document.createElement("p");
  details.className = "version-dates";
  details.textContent = version.panelUpdatedAt
    ? `Atualização informada pelo TSE: ${formatDateTime(version.panelUpdatedAt)}.${version.capturedAt
      ? ` Captura da tabela: ${formatDateTime(version.capturedAt)}.`
      : version.fileTimestamp
        ? ` Carimbo interno do CSV no ZIP: ${formatFileTimestamp(version.fileTimestamp)}; não é o horário da atualização do painel.`
        : ""}`
    : `Data e hora gravadas no ZIP: ${formatFileTimestamp(version.fileTimestamp)}. Não confirma quando o painel do TSE foi atualizado.`;
  const note = document.createElement("p");
  note.textContent = version.note;
  const actions = document.createElement("div");
  actions.className = "version-actions";
  actions.append(
    createLink(version.id === currentVersionId ? "Consultar lista atual" : "Consultar esta lista", `index.html?versao=${encodeURIComponent(version.id)}`),
    createLink("Ver votos do 1º turno", `comparacao-1-turno.html?versao=${encodeURIComponent(version.id)}`),
    createLink("Baixar lista (CSV)", version.csv, true),
  );
  if (version.sourceCapture) actions.append(createLink("Ver metadados da fonte", version.sourceCapture));
  if (version.sourceArchive) actions.append(createLink("Baixar ZIP original do TSE", version.sourceArchive, true));
  if (version.reconciliation) actions.append(createLink("Ver diferenças com a versão anterior", version.reconciliation));
  item.append(heading, count, details, note, actions);
  return item;
}

function renderObservation(observation) {
  const item = document.createElement("li");
  const count = document.createElement("strong");
  const timestamp = observation.observedAt
    ? ` — ${formatDateTime(observation.observedAt)}`
    : observation.displayedPanelTimestamp
      ? ` — tela antiga com data exibida ${formatDateTime(observation.displayedPanelTimestamp)}`
      : " — horário não registrado";
  count.textContent = `${NUMBER_FORMAT.format(observation.records)} seções${timestamp}. `;
  const status = document.createElement("span");
  status.textContent = observation.status;
  item.append(count, status);
  return item;
}

async function loadHistory() {
  try {
    const response = await fetch("./dados/versoes.json");
    if (!response.ok) throw new Error(`Falha ao carregar o histórico (HTTP ${response.status}).`);
    const catalog = validateCatalog(await response.json());
    versionList.replaceChildren(...catalog.versions.map((version) => renderVersion(version, catalog.currentVersionId)));
    observationList.replaceChildren(...catalog.observedCounts.map(renderObservation));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Erro desconhecido.";
    versionList.replaceChildren();
    const item = document.createElement("li");
    item.textContent = `Não foi possível carregar o histórico. ${detail}`;
    versionList.append(item);
    observationList.replaceChildren();
  }
}

loadHistory();
