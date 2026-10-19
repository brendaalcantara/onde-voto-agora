# OndeVotoAgora

Página estática para pesquisar mudanças de local de votação do 1º para o 2º turno das Eleições 2026. O site funciona em celular e computador, não pede cadastro ou dados pessoais e não usa serviços externos para realizar a busca.

## Acessar

O caminho do site é `/ondevotoagora/`. Para testar localmente a partir da raiz do repositório:

```sh
python3 -m http.server 8000
```

Abra `http://localhost:8000/ondevotoagora/`. A pasta continua independente do app educacional e usa somente HTML, CSS e JavaScript.

## Fonte e versões

Fonte oficial: [TSE — Seções alteradas](https://sig.tse.jus.br/ords/dwapr/r/seai/sig-eleicao-eleitorado/se%C3%A7%C3%B5es-alteradas). A notícia do TSE sobre as mudanças está [neste link](https://www.tse.jus.br/comunicacao/noticias/2026/Outubro/entenda-por-que-a-justica-eleitoral-trocou-o-endereco-de-algumas-secoes-para-o-2o-turno).

O catálogo `dados/versoes.json` separa as listas completas preservadas das contagens transitórias que não têm arquivo integral:

| Versão completa | Registros | Identificação da data |
| --- | ---: | --- |
| TSE, atualização informada em 19/10/2026 às 11h27 | 554 | CSV dentro do ZIP marcado em 19/10/2026 às 11h29; este carimbo não é o horário da atualização do painel |
| TSE, atualização informada em 19/10/2026 às 10h50; captura da tabela às 11h05 | 774 | Versão anterior preservada |
| Arquivo anterior | 4.288 | Data interna do ZIP: 15/10/2026 às 16h21; não confirma a atualização do painel |

Cada lista tem seu CSV e seus votos do 1º turno na pasta `dados/versoes/<versao>/`. A exportação mais recente tem 554 linhas válidas e únicas. A comparação de 774 para 554 encontrou 535 chaves compartilhadas, 239 presentes somente na versão de 774, 19 somente na nova e 136 registros compartilhados com campos diferentes. Isso compara duas capturas; não prova que 239 seções foram canceladas. O relatório completo das diferenças está ligado no histórico.

Os votos da versão de 554 foram recalculados a partir do ZIP integral oficial de resultados por seção do TSE (gerado em 06/10/2026), não filtrados do detalhamento da versão de 774. As 554 seções têm linhas válidas para Lula (13) e Flávio Bolsonaro (22); nenhuma comparação ficou indisponível e nenhuma ausência foi convertida em zero.

Em consultas anteriores, foram observadas contagens de 5.146 (17/10 às 20h28), 1.774 (horário não registrado) e 2.033 (17/10 às 23h33). O número 1.106 apareceu numa aba antiga do TSE que já indicava sessão encerrada. Esses valores não têm arquivo completo preservado; por isso, aparecem apenas como observações e não podem ser pesquisados por seção.

## Rotina de atualização

O workflow `.github/workflows/atualizar-ondevotoagora.yml` tenta consultar o painel do TSE às **06h35, 11h35, 15h35 e 20h35** (horário da Bahia), dez minutos após os horários informados pelo painel. Também pode ser iniciado manualmente pela aba **Actions** do GitHub. A rotina coleta o ZIP nacional, valida filtros, contagem, estrutura, duplicatas e hashes; quando a lista ou o horário oficial do painel muda, preserva uma versão e reconcilia as capturas. Se a lista mudar, também recalcula os votos do 1º turno antes de atualizar os dados ativos.

O job de coleta tem apenas leitura. Um segundo job, separado, pode gravar somente os arquivos de dados validados; então chama o workflow do Pages para publicar o commit. Se a coleta ou qualquer validação falhar, a versão publicada não é substituída. A coleta headless ainda depende do funcionamento do painel/exportador do TSE e precisa ser observada na primeira execução. O agendamento do GitHub é uma tentativa: pode atrasar ou não executar, portanto não garante que o site reflita uma alteração exatamente dez minutos depois. Se o TSE mudar o arquivo oficial de resultados do 1º turno, a checagem de hash interrompe a rotina para revisão, em vez de presumir que o novo arquivo é equivalente.

Cada versão completa fica em `dados/versoes/<versao>/`, sem substituir os snapshots anteriores. A ausência de uma seção numa captura não é interpretada como cancelamento.

## Conferir uma atualização manualmente

O validador da captura oficial pode ser executado em modo de conferência antes de aplicar os dados:

```sh
node ondevotoagora/relatorios/atualizar-dados-tse.mjs --source=ondevotoagora/relatorios/fonte-oficial-secoes-tse-AAAA-MM-DD-HHMM.json
```

O script verifica estrutura, filtros nacionais, intervalos de página, duplicatas, hashes e divergências contra a lista local. `--apply` substitui a lista ativa; portanto, antes de usá-lo numa atualização futura, arquive a versão anterior e acrescente a nova versão validada ao catálogo. A ausência de uma seção em qualquer lista não prova que seu local permaneceu igual.

## Verificações

```sh
node --test ondevotoagora/testes.mjs
node ondevotoagora/validar-dados.mjs
npm test --prefix ondevotoagora/automation
```

O validador retorna código diferente de zero se a base não estiver reconciliada. Sem `dados/fonte-oficial.csv`, esse bloqueio é esperado e o relatório deixa as diferenças como desconhecidas, em vez de tratá-las como zero.
