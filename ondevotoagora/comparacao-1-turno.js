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

function renderCoverage(metadata) {
  const available = metadata.cobertura.resultadosEncontrados;
  const unavailable = metadata.cobertura.resultadosIndisponiveis;
  const snapshot = new Date(`${metadata.listaMudancas.arquivoMarcadoEm}T12:00:00`).toLocaleDateString("pt-BR", { timeZone: "America/Bahia" });
  const resultDate = new Date(`${metadata.resultados.arquivoGeradoEm}T12:00:00`).toLocaleDateString("pt-BR", { timeZone: "America/Bahia" });
  ui.sourceListDate.dateTime = metadata.listaMudancas.arquivoMarcadoEm;
  ui.sourceListDate.textContent = snapshot;
  ui.sourceResultsDate.dateTime = metadata.resultados.arquivoGeradoEm;
  ui.sourceResultsDate.textContent = resultDate;
  ui.coverageSummary.textContent = `${NUMBER_FORMAT.format(metadata.cobertura.registrosNaCopia)} seções na lista oficial consultada. ${NUMBER_FORMAT.format(available)} com resultado por seção; ${NUMBER_FORMAT.format(unavailable)} sem registro correspondente no arquivo oficial de votos.`;
  ui.coverageDetail.textContent = "Dados oficiais consultados no TSE. O Portal de Dados Abertos informa que os resultados por seção são atualizados ao final de cada turno; as datas consultadas estão nas fontes abaixo.";
  const inferredLula = metadata.cobertura.zerosInferidosLula;
  const inferredFlavio = metadata.cobertura.zerosInferidosFlavioBolsonaro;
  if (inferredLula + inferredFlavio === 0) {
    ui.zeroMethod.textContent = "Nenhum voto zero foi inferido.";
  } else {
    ui.zeroMethod.textContent = `Quando faltou uma linha da candidatura no arquivo do TSE, o zero foi inferido pela estrutura do arquivo. Nesta cópia, isso ocorreu em ${NUMBER_FORMAT.format(inferredLula)} seção(ões) para Lula e ${NUMBER_FORMAT.format(inferredFlavio)} para Flávio Bolsonaro. O leia-me do TSE não define explicitamente a ausência como zero.`;
  }
  const missingSection = metadata.cobertura.secaoSemResultado;
  ui.unavailableNote.textContent = `${missingSection.cidade} (${missingSection.uf}), zona ${missingSection.zona}, seção ${missingSection.secao}: consta na lista do 2º turno, mas não tem registro correspondente no arquivo oficial de votos do 1º turno consultado. Por isso, não há gráfico; ausência de registro não significa zero voto. O arquivo não informa por que esse registro falta.`;
}

async function loadData() {
  try {
    const [votesResponse, localResponse] = await Promise.all([
      fetch("./dados/comparacao-lula-flavio-1t.json"),
      fetch("./dados/secoes.csv"),
    ]);
    if (!votesResponse.ok) throw new Error(`Falha ao carregar os votos (HTTP ${votesResponse.status}).`);
    if (!localResponse.ok) throw new Error(`Falha ao carregar a lista de seções (HTTP ${localResponse.status}).`);
    const [data, localBytes] = await Promise.all([votesResponse.json(), localResponse.arrayBuffer()]);
    if (!Array.isArray(data.linhas) || data.linhas.length !== data.cobertura.registrosNaCopia) {
      throw new Error("A contagem de votos por seção não confere com os metadados da base.");
    }
    const localCsv = new TextDecoder("windows-1252").decode(localBytes);
    const localValidation = validateCsv(localCsv, "dados/secoes.csv");
    if (localValidation.errors.length > 0) throw new Error("A lista de seções não passou na conferência de formato.");

    const votesBySection = new Map();
    for (const [index, row] of data.linhas.entries()) {
      if (!Array.isArray(row) || row.length !== data.campos.length) throw new Error(`Linha ${index + 1} do arquivo de votos está incompleta.`);
      const key = comparisonSectionKey(row[0], row[1], row[2], row[3]);
      if (votesBySection.has(key)) throw new Error("Há seção duplicada no arquivo de votos.");
      if ((row[4] === null) !== (row[5] === null)) throw new Error("A seção tem resultado incompleto para os dois candidatos.");
      votesBySection.set(key, row);
    }

    sections = localValidation.records.map((record) => {
      const row = votesBySection.get(comparisonSectionKey(record.uf, record.municipio, record.zona, record.secao));
      if (!row) throw new Error(`Faltam dados de voto para ${record.uf}/${record.municipio}/${record.secao}.`);
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
    sections = sortComparisonSections(sections);
    if (votesBySection.size !== sections.length) throw new Error("A contagem da lista de seções não confere com o arquivo de votos.");
    if (sections.filter((section) => section.resultadoDisponivel).length !== data.cobertura.resultadosEncontrados) {
      throw new Error("A quantidade de resultados disponíveis diverge dos metadados.");
    }
    renderCoverage(data);
    populateStates();
    for (const field of [ui.state, ui.city, ui.section, ui.local]) field.disabled = false;
    document.querySelector("#search-button").disabled = false;
    ui.clearButton.disabled = false;
    matches = sections;
    renderVisible();
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
