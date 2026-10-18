# OndeVotoAgora

Página estática para pesquisar mudanças de local de votação do 1º para o 2º turno das Eleições 2026. O site funciona em celular e computador, não pede cadastro ou dados pessoais e não usa serviços externos para realizar a busca.

## Acessar

O caminho do site é `/ondevotoagora/`. Para testar localmente a partir da raiz do repositório:

```sh
python3 -m http.server 8000
```

Abra `http://localhost:8000/ondevotoagora/`. A pasta continua independente do app educacional e usa somente HTML, CSS e JavaScript.

## Fonte e cobertura

Fonte oficial: [TSE — Estatísticas do eleitorado — Capilaridade — Seções alteradas](https://sig.tse.jus.br/ords/dwapr/r/seai/sig-eleicao-eleitorado/home). A notícia do TSE sobre as mudanças está [neste link](https://www.tse.jus.br/comunicacao/noticias/2026/Outubro/entenda-por-que-a-justica-eleitoral-trocou-o-endereco-de-algumas-secoes-para-o-2o-turno).

`dados/secoes.csv` contém 4.288 linhas de dados, extraídas sem regravação do CSV no ZIP `secoes_eleitorais_alteradas_2t-pais_2026.csv.zip`. O ZIP marca o arquivo interno em 15/10/2026 às 16:21. SHA-256 do CSV: `3a6562976ffcd599d96a101b9ae3f5b2527db9f95aaed4805b19ae24b5f56f17`. SHA-256 do ZIP: `0e58a24c3e985c558bbb0db4aea16e10119db37da7a3580bb840085fc10ab7ef`. As duas cópias locais encontradas em Downloads têm o mesmo hash e os mesmos bytes.

Durante consultas posteriores, o painel do TSE informou contagens diferentes (5.146, depois 1.774 e 2.033 às 23:33 de 17/10/2026), enquanto o ZIP disponível permaneceu com 4.288 linhas. Não foi encontrada uma exportação atual que permita reconciliar essas versões. Por isso, a base do site está marcada como **não reconciliada**; a quantidade de registros faltantes, alterados ou ausentes permanece desconhecida. O site não declara cobertura integral. Um resultado sem correspondência não confirma que o local permaneceu igual. Confirme no Autoatendimento Eleitoral ou no e-Título.

## Atualizar e comparar uma exportação atual

1. Baixe uma exportação diretamente do painel oficial do TSE e coloque o CSV, sem conversão, em `dados/fonte-oficial.csv`.
2. Execute `node ondevotoagora/validar-dados.mjs` a partir da raiz do repositório. O script valida cada linha dos dois arquivos, confere o cabeçalho, campos obrigatórios, duplicatas, hash e contagem, compara por eleição + UF + município + zona + seção, e grava `dados/relatorio-validacao.json`.
3. O primeiro relatório informa o SHA-256 e a contagem da exportação. Registre em `dados/meta.json`, no objeto `fonteOficialAtual`, a URL oficial, data de captura, hash, número de linhas, data/hora e contagem informadas no painel; rode o script novamente.
4. O script retorna erro enquanto faltar uma fonte atual identificada, houver linhas inválidas, duplicatas ou diferenças. O relatório discrimina registros encontrados na fonte e faltantes na base, alterações nos campos, e registros locais ausentes da fonte. Só depois de revisar a exportação oficial, atualize `dados/secoes.csv` com os registros confirmados e rode as verificações novamente. O script não altera os dados automaticamente.

Exemplo do objeto de procedência a preencher em `meta.json`:

```json
"fonteOficialAtual": {
  "url": "https://sig.tse.jus.br/ords/dwapr/r/seai/sig-eleicao-eleitorado/home",
  "capturadaEm": "AAAA-MM-DDTHH:mm:ss-03:00",
  "sha256Csv": "hash-calculado-pelo-script",
  "registros": 0,
  "painelAtualizacaoInformada": "AAAA-MM-DDTHH:mm:ss-03:00",
  "painelRegistrosInformados": 0
}
```

## Verificações

```sh
node --test ondevotoagora/testes.mjs
node ondevotoagora/validar-dados.mjs
```

O validador retorna código diferente de zero se a base não estiver reconciliada. Sem `dados/fonte-oficial.csv`, esse bloqueio é esperado e o relatório deixa as diferenças como desconhecidas, em vez de tratá-las como zero.
