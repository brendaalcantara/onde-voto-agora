import { normalizeNumber, normalizeText, validateCsv } from "./csv-utils.mjs";
import { comparisonSectionKey, filterComparisonSections, sortComparisonSections, visibleComparisonSections } from "./comparacao-utils.mjs";

const NUMBER_FORMAT = new Intl.NumberFormat("pt-BR");
const PERCENT_FORMAT = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const PAGE_SIZE = 20;
const ui = {
  clearButton: document.querySelector("#clear-button"),
  city: document.querySelector("#filter-city"),
  coverageDetail: document.querySelector("#coverage-detail"),
  coverageSummary: document.querySelector("#coverage-summary"),
  comparisonVersion: document.querySelector("#comparison-version"),
  comparisonVersionNote: document.querySelector("#comparison-version-note"),
  form: document.querySelector("#comparison-form"),
  list: document.querySelector("#comparison-list"),
  local: document.querySelector("#filter-place"),
  moreWrap: document.querySelector("#more-wrap"),
  section: document.querySelector("#filter-section"),
  showMore: document.querySelector("#show-more"),
  sourceListDate: document.querySelector("#source-list-date"),
  sourceResultsDate: document.querySelector("#source-results-date"),
  state: document.querySelector("#filter-state"),
  status: document.querySelector("#comparison-status"),
  unavailableNote: document.querySelector("#unavailable-note"),
  zeroMethod: document.querySelector("#zero-method"),
};

let sections = [];
let matches = [];
let shownCount = PAGE_SIZE;
let catalog;

function setStatus(message, isError = false) {
  ui.status.className = `comparison-status${isError ? " comparison-status--error" : ""}`;
  ui.status.textContent = message;
}

function makeLocation(label, value, variant) {
  const wrapper = document.createElement("div");
  wrapper.className = `section-location section-location--${variant}`;
  const term = document.createElement("dt");
  term.textContent = label;
  const description = document.createElement("dd");
  description.textContent = value;
  wrapper.append(term, description);
  return wrapper;
}

function makeCandidateRow(label, votes, share, variant, inferred) {
  const row = document.createElement("div");
  row.className = "candidate-vote";

  const name = document.createElement("span");
  name.className = "candidate-name";
  name.textContent = label;
  const value = document.createElement("span");
  value.className = "candidate-value";
  value.textContent = `${NUMBER_FORMAT.format(votes)} votos · ${PERCENT_FORMAT.format(share)}%`;

  const track = document.createElement("div");
  track.className = "candidate-bar";
  track.setAttribute("aria-hidden", "true");
  const fill = document.createElement("div");
  fill.className = `candidate-bar-fill candidate-bar-fill--${variant}`;
  fill.style.width = `${Math.max(0, Math.min(100, share))}%`;
  track.append(fill);
  row.append(name, value, track);
  return { row, inferred };
}

function createSectionCard(section) {
  const item = document.createElement("li");
  item.className = "comparison-card";

  const heading = document.createElement("h3");
  heading.textContent = `${section.cidade} (${section.uf}) · Zona ${section.zona} · Seção ${section.secao}`;
  const locations = document.createElement("dl");
  locations.className = "section-locations";
  locations.append(
    makeLocation("Local no 1º turno", section.localAnterior, "old"),
    makeLocation("Local previsto no 2º turno", section.localNovo, "new"),
  );
  item.append(heading, locations);

  if (!section.resultadoDisponivel) {
    const unavailable = document.createElement("p");
    unavailable.className = "section-unavailable";
    unavailable.textContent = "Sem registro correspondente no arquivo oficial de votos do 1º turno; por isso, o gráfico não está disponível. Ausência de registro não significa zero voto.";
    item.append(unavailable);
    return item;
  }

  const total = section.votosLula + section.votosFlavio;
  const comparison = document.createElement("div");
  comparison.className = "vote-comparison";
  comparison.setAttribute("aria-label", "Comparação entre os votos destes dois candidatos no primeiro turno");

  if (total <= 0) {
    const unavailable = document.createElement("p");
    unavailable.className = "section-unavailable";
    unavailable.textContent = "Não há votos registrados para estes dois candidatos nesta seção; não é possível calcular percentuais.";
    comparison.append(unavailable);
    item.append(comparison);
    return item;
  }

  const denominator = document.createElement("p");
  denominator.className = "vote-denominator";
  denominator.textContent = `Percentuais sobre ${NUMBER_FORMAT.format(total)} votos para estes dois candidatos.`;
  comparison.append(denominator);

  const lulaShare = section.votosLula / total * 100;
  const flavioShare = section.votosFlavio / total * 100;
  const lula = makeCandidateRow("Lula", section.votosLula, lulaShare, "lula", section.lulaZeroInferido);
  const flavio = makeCandidateRow("Flávio Bolsonaro", section.votosFlavio, flavioShare, "flavio", section.flavioZeroInferido);
  comparison.append(lula.row, flavio.row);

  const winner = document.createElement("p");
  winner.className = "candidate-winner";
  if (section.votosLula === section.votosFlavio) {
    winner.textContent = "Entre esses dois, houve empate no 1º turno.";
  } else {
    winner.textContent = `Mais votado entre esses dois no 1º turno: ${section.votosLula > section.votosFlavio ? "Lula" : "Flávio Bolsonaro"}.`;
  }
  comparison.append(winner);

  const inferredNames = [];
  if (lula.inferred) inferredNames.push("Lula");
  if (flavio.inferred) inferredNames.push("Flávio Bolsonaro");
  if (inferredNames.length > 0) {
    const note = document.createElement("p");
    note.className = "inferred-zero";
    note.textContent = `Zero inferido no arquivo consultado para: ${inferredNames.join(" e ")}. Veja a metodologia acima.`;
    comparison.append(note);
  }

  item.append(comparison);
  return item;
}

function renderVisible() {
  const visible = visibleComparisonSections(matches, shownCount);
  ui.list.replaceChildren(...visible.map(createSectionCard));
  ui.moreWrap.hidden = shownCount >= matches.length;

  if (matches.length === 0) {
    setStatus("Nenhuma seção desta lista corresponde aos filtros informados.");
    return;
  }
  setStatus(`Exibindo ${NUMBER_FORMAT.format(visible.length)} de ${NUMBER_FORMAT.format(matches.length)} seções desta lista.`);
}

function applyFilters() {
  const state = normalizeText(ui.state.value);
  const city = normalizeText(ui.city.value);
  const section = normalizeNumber(ui.section.value);
  const local = normalizeText(ui.local.value);

  if (ui.section.value.trim() && !/^\d+$/.test(ui.section.value.trim())) {
    setStatus("Digite apenas números no campo da seção.", true);
    ui.section.focus();
    return;
  }

  matches = filterComparisonSections(sections, { uf: state, cidade: city, secao: section, local });
  shownCount = PAGE_SIZE;
  renderVisible();
}

function populateStates() {
  const states = [...new Set(sections.map((section) => section.uf))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const options = [new Option("Todos os estados", ""), ...states.map((state) => new Option(state, state))];
  ui.state.replaceChildren(...options);
}

function validateCatalog(value) {
  if (!value || !Array.isArray(value.versions) || typeof value.currentVersionId !== "string") {
    throw new Error("O histórico de versões está incompleto.");
  }
  const seen = new Set();
  for (const version of value.versions) {
    if (!/^[a-z0-9-]+$/.test(version.id) || seen.has(version.id)) throw new Error("Há uma versão inválida ou repetida.");
    if (version.csv !== `dados/versoes/${version.id}/secoes.csv` || version.comparison !== `dados/versoes/${version.id}/comparacao.json`) {
      throw new Error(`Os arquivos da versão ${version.id} não correspondem à pasta esperada.`);
    }
    if (!Number.isInteger(version.records) || version.records < 1) throw new Error(`A contagem da versão ${version.id} é inválida.`);
    seen.add(version.id);
  }
  if (!seen.has(value.currentVersionId)) throw new Error("A versão atual não consta no histórico.");
  return value;
}

function formatDate(value) {
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (isoDate) return `${isoDate[3]}/${isoDate[2]}/${isoDate[1]}`;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "data não informada";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Bahia", day: "2-digit", month: "2-digit", year: "numeric",
  }).format(date);
}

function formatDateTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "data não informada";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Bahia", day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(date).replace(",", " às").replace(":", "h");
}

function renderCoverage(data, version) {
  const available = data.cobertura.resultadosEncontrados;
  const unavailableCount = data.cobertura.resultadosIndisponiveis;
  const listStamp = version.panelUpdatedAt ?? version.fileTimestamp;
  ui.sourceListDate.dateTime = listStamp ?? "";
  ui.sourceListDate.textContent = version.panelUpdatedAt
    ? formatDate(version.panelUpdatedAt)
    : `${formatDate(version.fileTimestamp)} (data interna do arquivo)`;
  const brazilianDate = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(data.resultados.arquivoGeradoEm ?? ""));
  if (brazilianDate) {
    ui.sourceResultsDate.dateTime = `${brazilianDate[3]}-${brazilianDate[2]}-${brazilianDate[1]}`;
    ui.sourceResultsDate.textContent = `${brazilianDate[1]}/${brazilianDate[2]}/${brazilianDate[3]}`;
  } else {
    ui.sourceResultsDate.dateTime = data.resultados.arquivoGeradoEm;
    ui.sourceResultsDate.textContent = formatDate(data.resultados.arquivoGeradoEm);
  }
  const summary = [
    `${NUMBER_FORMAT.format(data.cobertura.registrosNaCopia)} seções`,
    `${NUMBER_FORMAT.format(available)} com resultado para os dois candidatos`,
  ];
  if (unavailableCount > 0) summary.push(`${NUMBER_FORMAT.format(unavailableCount)} sem comparação disponível`);
  ui.coverageSummary.textContent = `${summary.join(" · ")}.`;
  ui.coverageDetail.textContent = version.panelUpdatedAt
    ? `Fonte: TSE em ${formatDateTime(version.panelUpdatedAt)}.`
    : "Fonte: TSE; data da atualização não informada.";
  const isCurrentVersion = version.id === catalog.currentVersionId;
  ui.comparisonVersionNote.textContent = isCurrentVersion
    ? "Versão mais recente registrada neste site."
    : "Você está vendo uma versão anterior. A ausência de uma seção nela não confirma que o local permaneceu igual.";
  ui.comparisonVersionNote.classList.toggle("version-note--older", !isCurrentVersion);
  const inferredLula = data.cobertura.zerosInferidosLula;
  const inferredFlavio = data.cobertura.zerosInferidosFlavioBolsonaro;
  ui.zeroMethod.textContent = inferredLula + inferredFlavio === 0
    ? "Nenhum voto zero foi inferido."
    : `Zero inferido no arquivo para ${NUMBER_FORMAT.format(inferredLula)} seção(ões) de Lula e ${NUMBER_FORMAT.format(inferredFlavio)} de Flávio Bolsonaro.`;

  const missingSections = data.cobertura.secoesIndisponiveis ?? (data.cobertura.secaoSemResultado ? [data.cobertura.secaoSemResultado] : []);
  ui.unavailableNote.hidden = missingSections.length === 0;
  ui.unavailableNote.textContent = missingSections.length === 0
    ? ""
    : missingSections.map((section) => `${section.cidade} (${section.uf}), zona ${section.zona}, seção ${section.secao}: não há registro correspondente no arquivo oficial de votos do 1º turno. Ausência de registro não significa zero voto.`).join(" ");
}

async function loadVersion(versionId) {
  const version = catalog.versions.find((item) => item.id === versionId);
  if (!version) throw new Error("Essa versão não está disponível.");
  setStatus("Carregando a versão selecionada…");
  ui.list.replaceChildren();
  ui.moreWrap.hidden = true;
  const [votesResponse, localResponse] = await Promise.all([
    fetch(`./${version.comparison}`),
    fetch(`./${version.csv}`),
  ]);
  if (!votesResponse.ok) throw new Error(`Falha ao carregar os votos (HTTP ${votesResponse.status}).`);
  if (!localResponse.ok) throw new Error(`Falha ao carregar a lista (HTTP ${localResponse.status}).`);
  const [data, localBytes] = await Promise.all([votesResponse.json(), localResponse.arrayBuffer()]);
  const votesListHash = data.listaMudancas?.sha256;
  if (data.versaoListaId !== version.id && (!version.csvSha256 || votesListHash !== version.csvSha256)) {
    throw new Error("Os votos não pertencem à versão de lista selecionada.");
  }
  if (!Array.isArray(data.linhas) || data.linhas.length !== data.cobertura.registrosNaCopia || data.cobertura.registrosNaCopia !== version.records) {
    throw new Error("A contagem de votos por seção não confere com a lista selecionada.");
  }
  const localCsv = new TextDecoder("windows-1252").decode(localBytes);
  const localValidation = validateCsv(localCsv, version.csv);
  if (localValidation.errors.length > 0) throw new Error("A lista de seções não passou na conferência de formato.");
  if (localValidation.records.length !== version.records) throw new Error("A contagem da lista não confere com o histórico.");

  const votesBySection = new Map();
  for (const [index, row] of data.linhas.entries()) {
    if (!Array.isArray(row) || row.length !== data.campos.length) throw new Error(`Linha ${index + 1} do arquivo de votos está incompleta.`);
    const key = comparisonSectionKey(row[0], row[1], row[2], row[3]);
    if (votesBySection.has(key)) throw new Error("Há seção duplicada no arquivo de votos.");
    if ((row[4] === null) !== (row[5] === null)) throw new Error("A seção tem resultado incompleto para os dois candidatos.");
    votesBySection.set(key, row);
  }

  const nextSections = localValidation.records.map((record) => {
    const row = votesBySection.get(comparisonSectionKey(record.uf, record.municipio, record.zona, record.secao));
    if (!row) throw new Error(`Faltam dados de voto para ${record.uf}/${record.municipio}/${record.secao} nesta versão.`);
    return {
      uf: record.uf.toUpperCase(),
      cidade: record.municipio,
      zona: Number(normalizeNumber(record.zona)),
      secao: Number(normalizeNumber(record.secao)),
      localAnterior: record.localInicial,
      localNovo: record.localFinal,
      resultadoDisponivel: row[4] !== null,
      votosLula: row[4],
      votosFlavio: row[5],
      lulaZeroInferido: row[6],
      flavioZeroInferido: row[7],
    };
  });
  if (votesBySection.size !== nextSections.length) throw new Error("A quantidade de seções não confere entre lista e votos.");
  if (nextSections.filter((section) => section.resultadoDisponivel).length !== data.cobertura.resultadosEncontrados) {
    throw new Error("A quantidade de resultados disponíveis diverge dos metadados.");
  }
  sections = sortComparisonSections(nextSections);
  renderCoverage(data, version);
  populateStates();
  for (const field of [ui.state, ui.city, ui.section, ui.local]) field.disabled = false;
  document.querySelector("#search-button").disabled = false;
  ui.clearButton.disabled = false;
  matches = sections;
  renderVisible();
}

async function loadData() {
  try {
    const response = await fetch("./dados/versoes.json");
    if (!response.ok) throw new Error(`Falha ao carregar o histórico (HTTP ${response.status}).`);
    catalog = validateCatalog(await response.json());
    ui.comparisonVersion.replaceChildren(...catalog.versions.map((version) => new Option(version.label, version.id)));
    const requestedVersion = new URLSearchParams(window.location.search).get("versao");
    const selectedVersion = catalog.versions.some((version) => version.id === requestedVersion) ? requestedVersion : catalog.currentVersionId;
    ui.comparisonVersion.value = selectedVersion;
    ui.comparisonVersion.disabled = false;
    ui.comparisonVersion.addEventListener("change", async () => {
      ui.form.reset();
      try {
        await loadVersion(ui.comparisonVersion.value);
        const url = new URL(window.location.href);
        url.searchParams.set("versao", ui.comparisonVersion.value);
        window.history.replaceState({}, "", url);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Erro desconhecido.";
        setStatus(`Não foi possível carregar esta versão. ${detail}`, true);
      }
    });
    await loadVersion(selectedVersion);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Erro desconhecido.";
    ui.list.replaceChildren();
    ui.moreWrap.hidden = true;
    setStatus(`Não foi possível carregar a comparação. ${detail} Tente abrir a página novamente ou consulte os resultados no portal do TSE.`, true);
  }
}

ui.form.addEventListener("submit", (event) => {
  event.preventDefault();
  applyFilters();
});

ui.form.addEventListener("reset", () => {
  if (sections.length === 0) return;
  matches = sections;
  shownCount = PAGE_SIZE;
  renderVisible();
});

ui.showMore.addEventListener("click", () => {
  shownCount = Math.min(shownCount + PAGE_SIZE, matches.length);
  renderVisible();
});

loadData();
