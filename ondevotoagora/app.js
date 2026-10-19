import { filterRecords, validateCsv } from "./csv-utils.mjs";

const NUMBER_FORMAT = new Intl.NumberFormat("pt-BR");
const PAGE_SIZE = 20;
const ui = {
  city: document.querySelector("#cidade"),
  clearButton: document.querySelector("#clear-button"),
  coverageNote: document.querySelector("#coverage-note"),
  dataStatus: document.querySelector("#data-status"),
  form: document.querySelector("#lookup-form"),
  localOld: document.querySelector("#local-antigo"),
  nextPage: document.querySelector("#next-page"),
  pageStatus: document.querySelector("#page-status"),
  pagination: document.querySelector("#pagination"),
  previousPage: document.querySelector("#previous-page"),
  resultList: document.querySelector("#result-list"),
  resultStatus: document.querySelector("#result-status"),
  searchButton: document.querySelector("#search-button"),
  section: document.querySelector("#secao"),
  state: document.querySelector("#estado"),
  versionNote: document.querySelector("#version-note"),
  versionSelect: document.querySelector("#version-select"),
};

let records = [];
let lastMatches = [];
let currentPage = 1;
let catalog;

function setDataStatus(message, state = "") {
  ui.dataStatus.className = `data-status${state ? ` data-status--${state}` : ""}`;
  ui.dataStatus.textContent = message;
  ui.dataStatus.hidden = false;
}

function setResultStatus(message, state = "") {
  ui.resultStatus.className = `result-status${state ? ` result-status--${state}` : ""}`;
  ui.resultStatus.textContent = message;
  ui.resultList.replaceChildren();
  ui.pagination.hidden = true;
}

function renderMetadata(version) {
  const formatDateTime = (value) => {
    if (!value || !Number.isFinite(Date.parse(value))) return "data não informada";
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
  };
  ui.coverageNote.textContent = `${NUMBER_FORMAT.format(version.records)} seções · ${version.panelUpdatedAt
    ? `Fonte: TSE em ${formatDateTime(version.panelUpdatedAt)}.`
    : "Fonte: TSE; data da atualização não informada."}`;

  const isCurrent = version.id === catalog.currentVersionId;
  ui.versionNote.textContent = isCurrent
    ? "Você está consultando a versão mais recente registrada aqui."
    : "Você está consultando uma lista anterior. Se não encontrar sua seção, isso não confirma que o local permaneceu igual.";
  ui.versionNote.classList.toggle("version-note--older", !isCurrent);
  if (isCurrent) {
    const currentUrl = new URL(window.location.href);
    if (currentUrl.searchParams.get("versao") !== version.id) {
      currentUrl.searchParams.set("versao", version.id);
      window.history.replaceState({}, "", currentUrl);
    }
  }
}

function validateCatalog(value) {
  if (!value || !Array.isArray(value.versions) || typeof value.currentVersionId !== "string") {
    throw new Error("O histórico de versões está incompleto.");
  }
  const seen = new Set();
  for (const version of value.versions) {
    if (!/^[a-z0-9-]+$/.test(version.id) || seen.has(version.id)) throw new Error("Há uma identificação de versão inválida ou repetida.");
    if (version.csv !== `dados/versoes/${version.id}/secoes.csv` || version.comparison !== `dados/versoes/${version.id}/comparacao.json`) {
      throw new Error(`Os arquivos da versão ${version.id} não correspondem à pasta esperada.`);
    }
    if (!Number.isInteger(version.records) || version.records < 1 || typeof version.label !== "string") {
      throw new Error(`Os dados da versão ${version.id} estão incompletos.`);
    }
    seen.add(version.id);
  }
  if (!seen.has(value.currentVersionId)) throw new Error("A versão atual não consta no histórico.");
  return value;
}

function populateStates() {
  const states = [...new Set(records.map((record) => record.uf.toUpperCase()))].sort();
  const options = [new Option("Selecione um estado", ""), ...states.map((state) => new Option(state, state))];
  ui.state.replaceChildren(...options);
  ui.state.disabled = false;
}

function createDetail(label, value, className = "") {
  const wrapper = document.createElement("div");
  if (className) wrapper.className = className;
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  detail.textContent = value;
  wrapper.append(term, detail);
  return wrapper;
}

function createResultCard(record) {
  const item = document.createElement("li");
  item.className = "result-card";
  const heading = document.createElement("h3");
  heading.textContent = `${record.municipio} (${record.uf})`;
  const details = document.createElement("dl");
  const voters = Number(record.eleitores);
  details.append(
    createDetail("Zona e seção eleitoral", `Zona ${record.zona} · Seção ${record.secao}`),
    createDetail("Eleitorado", `${NUMBER_FORMAT.format(voters)} eleitores`),
    createDetail("Local anterior (1º turno)", record.localInicial, "location-old"),
    createDetail("Novo local (2º turno)", record.localFinal, "location-new"),
  );
  item.append(heading, details);
  return item;
}

function renderPage() {
  const pageCount = Math.ceil(lastMatches.length / PAGE_SIZE);
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageRecords = lastMatches.slice(start, start + PAGE_SIZE);
  ui.resultList.replaceChildren(...pageRecords.map(createResultCard));

  const noun = lastMatches.length === 1 ? "mudança encontrada" : "mudanças encontradas";
  const shown = lastMatches.length > PAGE_SIZE ? ` Mostrando ${start + 1}–${Math.min(start + PAGE_SIZE, lastMatches.length)}.` : "";
  ui.resultStatus.className = "result-status result-status--success";
  ui.resultStatus.textContent = `${NUMBER_FORMAT.format(lastMatches.length)} ${noun}.${shown} Confirme seu local no TSE antes de sair para votar.`;
  ui.pagination.hidden = pageCount <= 1;
  ui.pageStatus.textContent = `Página ${currentPage} de ${pageCount}`;
  ui.previousPage.disabled = currentPage <= 1;
  ui.nextPage.disabled = currentPage >= pageCount;
}

function runSearch() {
  const filters = {
    estado: ui.state.value,
    cidade: ui.city.value,
    secao: ui.section.value,
    localAntigo: ui.localOld.value,
  };
  if (!filters.estado) {
    setResultStatus("Selecione um estado para fazer a busca.", "error");
    ui.state.focus();
    return;
  }
  if (filters.secao.trim() && !/^\d+$/.test(filters.secao.trim())) {
    setResultStatus("A seção eleitoral deve conter apenas números.", "error");
    ui.section.focus();
    return;
  }
  lastMatches = filterRecords(records, filters);
  currentPage = 1;
  if (lastMatches.length === 0) {
    setResultStatus("Nenhuma mudança de local foi encontrada. Esta lista mostra somente locais que mudaram do 1º para o 2º turno; portanto, não há mudança registrada para os filtros informados. Se você esperava encontrar sua seção, confirme no site oficial do TSE.", "warning");
    return;
  }
  renderPage();
}

ui.form.addEventListener("submit", (event) => {
  event.preventDefault();
  runSearch();
});

ui.form.addEventListener("reset", () => {
  lastMatches = [];
  currentPage = 1;
  setResultStatus("Selecione o estado e, se quiser, preencha outros campos.");
});

ui.previousPage.addEventListener("click", () => {
  if (currentPage > 1) {
    currentPage -= 1;
    renderPage();
  }
});

ui.nextPage.addEventListener("click", () => {
  const pageCount = Math.ceil(lastMatches.length / PAGE_SIZE);
  if (currentPage < pageCount) {
    currentPage += 1;
    renderPage();
  }
});

async function loadVersion(versionId) {
  try {
    const version = catalog.versions.find((item) => item.id === versionId);
    if (!version) throw new Error("Essa versão não está disponível.");
    setResultStatus("Carregando a versão selecionada…");
    ui.versionNote.textContent = "Carregando…";
    const csvResponse = await fetch(`./${version.csv}`);
    if (!csvResponse.ok) throw new Error(`Erro HTTP ${csvResponse.status} ao carregar o arquivo de dados.`);

    const csvBytes = await csvResponse.arrayBuffer();
    const csvText = new TextDecoder("windows-1252").decode(csvBytes);
    const validation = validateCsv(csvText, version.csv);
    if (validation.errors.length > 0) {
      const examples = validation.errors.slice(0, 3).map((item) => `linha ${item.line}: ${item.message}`).join(" ");
      throw new Error(`${validation.errors.length} problema(s) na base. ${examples}`);
    }
    records = validation.records;
    if (version.records !== records.length) {
      throw new Error(`A contagem dos dados (${NUMBER_FORMAT.format(records.length)}) não confere com a registrada (${version.records}).`);
    }

    renderMetadata(version);
    populateStates();
    for (const field of [ui.city, ui.section, ui.localOld]) field.disabled = false;
    ui.searchButton.disabled = false;
    ui.clearButton.disabled = false;
    setResultStatus("Selecione o estado e, se quiser, preencha outros campos.");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Erro desconhecido.";
    setDataStatus(`Não foi possível abrir a consulta. ${detail}`, "error");
    setResultStatus("Use o Autoatendimento Eleitoral ou o e-Título para confirmar seu local de votação.", "error");
  }
}

async function loadData() {
  try {
    const response = await fetch("./dados/versoes.json");
    if (!response.ok) throw new Error(`Erro HTTP ${response.status} ao carregar as versões.`);
    catalog = validateCatalog(await response.json());
    const options = catalog.versions.map((version) => new Option(version.label, version.id));
    ui.versionSelect.replaceChildren(...options);
    const requested = new URLSearchParams(window.location.search).get("versao");
    const versionId = catalog.versions.some((version) => version.id === requested) ? requested : catalog.currentVersionId;
    ui.versionSelect.value = versionId;
    ui.versionSelect.disabled = false;
    ui.versionSelect.addEventListener("change", async () => {
      ui.form.reset();
      await loadVersion(ui.versionSelect.value);
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set("versao", ui.versionSelect.value);
      window.history.replaceState({}, "", nextUrl);
    });
    await loadVersion(versionId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Erro desconhecido.";
    setDataStatus(`Não foi possível abrir o histórico de listas. ${detail}`, "error");
    setResultStatus("Use o Autoatendimento Eleitoral ou o e-Título para confirmar seu local de votação.", "error");
  }
}

loadData();
