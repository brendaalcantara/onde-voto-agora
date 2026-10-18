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
};

let records = [];
let lastMatches = [];
let currentPage = 1;

function setDataStatus(message, state = "") {
  ui.dataStatus.className = `data-status${state ? ` data-status--${state}` : ""}`;
  ui.dataStatus.textContent = message;
}

function setResultStatus(message, state = "") {
  ui.resultStatus.className = `result-status${state ? ` result-status--${state}` : ""}`;
  ui.resultStatus.textContent = message;
  ui.resultList.replaceChildren();
  ui.pagination.hidden = true;
}

function renderMetadata(metadata) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(metadata.siteAtualizadoEm ?? ""));
  const date = match ? `${match[3]}/${match[2]}/${match[1]}` : "data não informada";
  ui.coverageNote.textContent = `Atualizado em ${date}.`;
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

async function loadData() {
  try {
    const [csvResponse, metadataResponse] = await Promise.all([
      fetch("./dados/secoes.csv"),
      fetch("./dados/meta.json"),
    ]);
    if (!csvResponse.ok) throw new Error(`Erro HTTP ${csvResponse.status} ao carregar o arquivo de dados.`);
    if (!metadataResponse.ok) throw new Error(`Erro HTTP ${metadataResponse.status} ao carregar a identificação da base.`);

    const [csvBytes, metadata] = await Promise.all([csvResponse.arrayBuffer(), metadataResponse.json()]);
    const csvText = new TextDecoder("windows-1252").decode(csvBytes);
    const validation = validateCsv(csvText, "dados/secoes.csv");
    if (validation.errors.length > 0) {
      const examples = validation.errors.slice(0, 3).map((item) => `linha ${item.line}: ${item.message}`).join(" ");
      throw new Error(`${validation.errors.length} problema(s) na base. ${examples}`);
    }
    records = validation.records;
    if (!Number.isInteger(metadata.registrosBase) || metadata.registrosBase !== records.length) {
      throw new Error(`A contagem dos dados (${NUMBER_FORMAT.format(records.length)}) não confere com a registrada (${metadata.registrosBase}).`);
    }

    renderMetadata(metadata);
    populateStates();
    for (const field of [ui.city, ui.section, ui.localOld]) field.disabled = false;
    ui.searchButton.disabled = false;
    ui.clearButton.disabled = false;
    setDataStatus("Consulta pronta neste aparelho.", "success");
    setResultStatus("Selecione o estado e, se quiser, preencha outros campos.");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Erro desconhecido.";
    setDataStatus(`Não foi possível abrir a consulta. ${detail}`, "error");
    setResultStatus("Use o Autoatendimento Eleitoral ou o e-Título para confirmar seu local de votação.", "error");
  }
}

loadData();
