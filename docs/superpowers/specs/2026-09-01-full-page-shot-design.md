# full-page-shot — Design

**Data:** 2026-09-01
**Status:** aprovado, pronto para plano de implementação

## Objetivo

Extensão de Chrome que captura a página inteira — incluindo o conteúdo fora do viewport
— em um clique, e entrega a imagem no clipboard, em download PNG, ou nos dois.

**Pronto quando:** a extensão publicada na Chrome Web Store captura a página inteira — ou,
desde a v1.1, só o viewport — em um clique e entrega a imagem conforme a preferência do
usuário, sem deixar a página em estado alterado.

## Decisões de escopo

| Decisão | Escolha | Motivo |
|---|---|---|
| Modo de captura | Full-page (scroll) por padrão; viewport como segundo modo desde a v1.1 | Full-page é o diferencial; o viewport ganhou lugar por ser o mesmo fluxo de entrega (clipboard + download nomeado) em um caminho instantâneo |
| Saída | Clipboard sempre PNG; download em PNG/JPEG/WebP, configurável | Cobre colar em ferramenta e arquivar |
| Preview antes de salvar | Não | Um clique, sem interrupção |
| Distribuição | Chrome Web Store, repo público | Mesmo padrão do `tab-switch` |
| Navegador | Chrome primeiro | Firefox/Edge ficam fora da v1 |

## Abordagem técnica

**Scroll + stitch com `chrome.tabs.captureVisibleTab`.**

O content script rola a página em passos de viewport; o service worker captura cada
frame; o offscreen document costura os frames num canvas.

### Alternativa rejeitada: `chrome.debugger` + CDP

`Page.captureScreenshot` com `captureBeyondViewport: true` entrega imagem pixel-perfeita
numa chamada só, sem stitching e sem duplicação de elementos fixos. Foi rejeitada porque:

- Exibe banner persistente *"DevTools está depurando esta aba"* durante a captura.
- A permissão `debugger` gera aviso agressivo na instalação e review mais rigoroso na
  Chrome Web Store.
- Quebra quando o usuário já tem o DevTools aberto na aba.

O custo do scroll+stitch é engenharia, que controlamos. O custo do `debugger` é fricção
com o Google e com o usuário, que não controlamos.

**Plano B:** se a qualidade do stitch não for aceitável em teste real com páginas
complexas, o CDP volta à mesa. A decisão é reversível — só a implementação de
`capture-loop` e `stitcher` muda.

## Arquitetura

Quatro contextos de execução, cada um com uma responsabilidade:

### Service worker (background)

Orquestrador. Único componente que fala com as APIs do Chrome.

- Recebe o clique no ícone da action ou o atalho de teclado.
- Injeta o content script via `chrome.scripting.executeScript` (injeção sob demanda; o
  content script **não** é declarado no manifest).
- Dirige o loop de captura e chama `chrome.tabs.captureVisibleTab`.
- Entrega cada frame ao offscreen document assim que o captura.

### Content script

Tudo que precisa tocar a página. Não decide nada — executa comando e responde.

- Mede a página.
- Rola para um offset e sinaliza quando o conteúdo estabilizou.
- Esconde e restaura elementos fixos.
- Restaura o scroll original.

### Offscreen document

Único contexto com DOM completo, e por isso o dono do canvas.

- Acumula os frames num `<canvas>`.
- Gera o blob PNG.

> **Correção (1/set/2026, após os testes e2e da Task 9).** A versão original desta seção dizia
> que o offscreen document era *obrigatório para escrever no clipboard no MV3*. Isso é falso, e
> os testes em Chromium real provaram: `navigator.clipboard.write()` falha com
> `NotAllowedError: Document is not focused`, porque um offscreen document nunca pode ter foco —
> `reasons: [CLIPBOARD]` concede a API, não o foco. Pior: `chrome.downloads` sequer existe nesse
> contexto. O offscreen document costura a imagem; **entregar é com os outros**.

### Entrega dos sinks

- **Download:** no service worker, que tem `chrome.downloads` de verdade.
- **Clipboard:** no content script da aba capturada, que é um documento com foco real.
- Os dois são **independentes**: a falha de um nunca cancela o outro, e o badge reporta sucesso
  parcial com honestidade.

### Options page

Preferências de saída: copiar, baixar, ou ambos. **Não há popup** — o clique no ícone
dispara a captura diretamente.

## Módulos

| Módulo | Responsabilidade | Depende de | Testável sem browser |
|---|---|---|---|
| `page-metrics` | Calcula os passos de scroll a partir de `scrollHeight`, viewport, `devicePixelRatio` | nada (função pura sobre um objeto de medidas) | sim |
| `fixed-elements` | Detecta `position: fixed`/`sticky`, esconde, restaura | DOM | parcial |
| `scroll-driver` | Rola para o passo N e espera estabilização (lazy-load, animação) | DOM | parcial |
| `capture-loop` | Sequencia os passos, aplica throttle, encaminha frames | APIs do Chrome | não |
| `stitcher` | Frames + metadados → blob PNG | canvas | sim |
| `sinks` | Entrega: `chrome.downloads` no service worker, clipboard no content script | APIs do Chrome | parcial (orquestração e badge são puros) |

`page-metrics` e `stitcher` concentram a corretude aritmética da captura e são puros:
cobertos por teste unitário. `fixed-elements` e `scroll-driver` são onde a captura quebra
visualmente; isolá-los permite iterar neles sem tocar no resto.

## Fluxo

1. Usuário clica no ícone da action ou usa o atalho de teclado.
2. Service worker valida a URL da aba ativa. Se restrita, aborta aqui.
3. Service worker injeta o content script.
4. Content script devolve as medidas: `scrollWidth`, `scrollHeight`, largura e altura do
   `visualViewport` (fracionárias — `innerWidth`/`innerHeight` são arredondados pelo Chrome
   e o arredondamento deixava linhas transparentes em DPR fracionário),
   `devicePixelRatio`, posição de scroll atual.
5. `page-metrics` calcula os passos e valida contra o limite de área do canvas.
6. Service worker garante o offscreen document criado.
7. Loop, por passo:
   - Content script rola para o offset e espera estabilizar.
   - Service worker chama `captureVisibleTab`, respeitando o throttle.
   - O frame é enviado ao offscreen document imediatamente.
8. Content script restaura elementos fixos e o scroll original.
9. Offscreen document fecha o canvas em blob e devolve a imagem como data URL ao service
   worker, que fecha o documento em seguida — nada mais fica pendente lá.
10. Service worker executa os sinks configurados **em paralelo** (`Promise.allSettled`):
    download nele mesmo, clipboard via mensagem `copyImage` ao content script.
11. Badge na action confirma o resultado, distinguindo sucesso total, falha total e
    sucesso parcial.

### Frames vão para o offscreen um a um

O service worker do MV3 pode ser encerrado a qualquer momento. Manter dezenas de
dataURLs na memória dele arrisca perder a captura no meio de uma página longa. O canvas
no offscreen document é o acumulador; o service worker só faz passar.

### Elementos fixos aparecem no primeiro frame e somem do resto

Escondê-los desde o início remove o header da imagem inteira. Mantê-los em todos os
frames duplica o header N vezes na imagem final. A regra: capturar o frame 0 com tudo
visível, esconder a partir do frame 1, restaurar ao terminar.

## Tratamento de erros

| Falha | Resposta |
|---|---|
| URL restrita (`chrome://`, Chrome Web Store, visualizador de PDF) | Aborta antes de injetar; badge indica o motivo. É o erro mais frequente na prática |
| Página excede o limite de área do canvas | `page-metrics` detecta antes de capturar; avisa e captura até o limite |
| Rate limit do `captureVisibleTab` | Throttle fixo no loop, com retry e backoff |
| Usuário troca de aba ou rola durante a captura | Detecta, aborta, restaura |
| Erro em qualquer ponto do loop | Restauração roda em `finally` e é idempotente |

**Regra que prevalece sobre a captura:** a página do usuário nunca fica em estado
alterado. Falhar sem estragar a página é mais importante do que entregar a imagem.

## Stack

- **Build:** Vite + TypeScript + `@crxjs/vite-plugin`.
- **UI:** React na options page. É conveniência — reaproveita a base do `tab-switch` —
  não necessidade técnica. Uma options page com três checkboxes funcionaria em vanilla.
- **Manifest:** V3.
- **Permissões (v1.1, sete):** `activeTab`, `scripting`, `offscreen`, `downloads`,
  `clipboardWrite`, `storage` e `contextMenus`. Nenhum `host_permissions`, e nenhuma
  permissão que dispare aviso agressivo na instalação — `contextMenus` entrou na v1.1
  apenas para o menu de botão direito no ícone da toolbar.

## Modos de captura (v1.1)

Dois modos, um único caminho de entrega:

- **Full-page** (padrão): injeta o content script, mede, esconde elementos fixos, rola,
  captura frame a frame, costura e restaura. Inalterado desde a v1.
- **Viewport:** um `captureVisibleTab` do que já está na tela. Não injeta content script,
  não mede, não rola, não esconde nada — e por isso **não tem restauração**: não há o que
  desfazer. Também não pode ser truncado, porque um viewport está sempre muito abaixo dos
  limites de canvas do Chrome.

O modo de uma captura vem de três lugares, nesta ordem: o modo explícito do menu de
contexto ou do atalho `capture-viewport`; senão a preferência `captureMode` da options
page. O clique no ícone (e o `_execute_action`) não nomeia modo algum, logo usa a
preferência.

**Menu de contexto:** dois itens com `contexts: ['action']` — "Capture full page" e
"Capture visible area". Aparecem só no botão direito sobre o ícone da extensão, nunca
sobre a página que o usuário está lendo.

**Atalhos:** `Ctrl/Cmd+Shift+Y` dispara a action (modo padrão do usuário) e
`Ctrl/Cmd+Shift+U` dispara `capture-viewport`.

O nome do arquivo distingue os dois: `<host>-<timestamp>-viewport.<ext>`. Sem o sufixo,
duas capturas do mesmo host no mesmo segundo seriam indistinguíveis por nome e o Chrome
numeraria uma delas em silêncio.

## Tamanho da saída (v1.1)

- **Escala 1× é o padrão.** O canvas é sempre costurado em pixels *de dispositivo*, então
  numa tela hidpi ele já é uma imagem 2×. "1×" significa dividir de volta pelo
  `devicePixelRatio` (no-op numa tela comum); "2×" significa entregar o canvas como está.
  O redimensionamento acontece **uma vez só**, no canvas pronto — a aritmética de
  costura (`page-metrics`, `stitch-plan`) nunca é informada da escala.
- **O clipboard é sempre PNG.** `ClipboardItem` com `image/png` é o único tipo de imagem
  amplamente colável; formatos com perda no clipboard simplesmente não colam na maioria
  dos destinos. A preferência de formato vale **só para o download**.
- **Formatos do download:** `png` (padrão), `jpeg` (`.jpg`) e `webp`. Qualidade fixa em
  **0.85**, sem controle na UI: é o ponto em que o ganho de tamanho já aconteceu e o
  artefato ainda não aparece em texto de captura de tela, e um slider a mais custaria mais
  em decisão do usuário do que entregaria.
- **Uma codificação por captura.** Quando o download também é PNG, o mesmo data URL vai
  para os dois sinks em vez de a imagem ser codificada duas vezes.

## Testes

**Unitários (Vitest):** `page-metrics` e `stitcher`. É onde mora o erro de off-by-one que
produz faixa duplicada ou linha faltando no meio da imagem final — barato de pegar aqui,
caro de diagnosticar depois.

**End-to-end (Playwright):** carrega a extensão real num Chromium e captura páginas
fixture:

- página curta (um frame só);
- página longa com header `position: fixed`;
- página com lazy-load de imagens;
- página cujo `scrollHeight` não é múltiplo do viewport;
- (v1.1) captura viewport numa página rolada: um frame só, nenhuma mensagem para a página,
  nenhuma injeção de content script, scroll intacto;
- (v1.1) 1× com `devicePixelRatio` 2: a imagem é exatamente metade do canvas em ambos os
  eixos, e 2× entrega o canvas como costurado;
- (v1.1) download `jpeg`/`webp`: os bytes no disco começam com o magic number do formato e
  o clipboard continua sendo PNG.

Sem a camada E2E, regressão visual só aparece em uso real.

**CI:** GitHub Actions com lint, test e build; cobertura no Codecov. Mesmo padrão do
`tab-switch`.

## Pendências de publicação

Não bloqueiam o desenvolvimento, mas entram no plano de implementação:

- Ícones 16, 32, 48 e 128 px.
- Descrição na store justificando cada permissão.
- Política de privacidade — o Google exige a declaração mesmo quando a extensão não
  coleta dado algum.
- Screenshots promocionais.

## Limitações conhecidas

**Deriva das emendas em páginas longas com `devicePixelRatio` fracionário.** O canvas é
pintado em frames inteiros: cada frame tem exatamente `round(viewportHeight × dpr)` pixels
de device de altura, e os frames são posicionados numa grade uniforme, em `i × frameHeight`.
Só que o conteúdo da página avança pelo valor exato `viewportHeight × dpr`. Quando o `dpr`
é fracionário — 1.25, 1.5, 1.75, os fatores de escala padrão do Windows e do ChromeOS — a
diferença sub-pixel entre os dois se acumula descendo a página, e as emendas interiores
ficam levemente deslocadas da posição real do conteúdo.

A magnitude cresce com o número de passos. No varrimento de 615.096 combinações — viewports
de **400 a 1080 px CSS** de altura, `dpr` de 1 a 3, páginas de até 60.000 px CSS — o pior caso
é de **35 pixels de device** (≈ 28 px CSS) na emenda 70 de 72, a `dpr` 1.25 e viewport de
720,4 px. Esse número vale para *essa* faixa de viewport e só para ela; não é um teto
estrutural. A relação real é

```
deriva ≲ 0,5 × número de passos
```

porque cada frame erra no máximo meio pixel de device (`round(vh × dpr)` contra `vh × dpr`) e
o erro se acumula linearmente ao longo da grade. A consequência é que a deriva **piora
conforme o viewport encolhe**, já que a mesma página passa a ser coberta por mais frames:
varrendo a mesma grade de `dpr` e de alturas de página com viewport de 401 px CSS o pior caso
vai a 53 px de device; com 250 px, a 104; com 150 px, a 174. Janelas de tamanho normal não
chegam perto disso — viewports de 400 e de 800 px dão deriva zero em toda a varredura, porque
`vh × dpr` cai em inteiro para todos os `dpr` varridos —, mas uma janela deliberadamente baixa
numa página muito longa deriva mais do que os 35 px medidos aqui. O último frame é exceção:
ele é ancorado no rodapé do canvas (`canvasHeight − frameHeight`), então o fim da página
sempre bate exato — a deriva nunca corta conteúdo no final da imagem.

A deriva é aceita porque a alternativa é pior. Sem a grade uniforme, arredondar cada posição
de forma independente deixa **linhas de device inteiras sem cobertura** — buracos
transparentes no meio da imagem, ou o rodapé da página cortado. Também não é um artefato da
grade escolhida: uma variante que minimiza a deriva, mantendo a posição real sempre que isso
não quebra a contiguidade, foi varrida em 24.472 combinações e produziu exatamente o mesmo
máximo daquela grade (31 px, medidos quando o varrimento ainda só usava viewports inteiros) —
ou seja, não melhorou nada. Eliminar o resíduo exigiria desenhar frames mais altos do que o
bitmap realmente é. A escolha real é entre deriva e buracos, e buraco é pior. O limite da
faixa varrida está travado por teste de propriedade em `tests/core/stitch-plan.test.ts`, para
que uma mudança futura que piore as emendas falhe alto em vez de degradar a imagem em
silêncio.

**Teto de ~48 MB no PNG final.** A imagem costurada atravessa dois saltos de mensagem como
data URL em base64: `chrome.runtime.sendMessage` do offscreen document para o service worker,
e `chrome.tabs.sendMessage` do service worker para o content script que escreve na área de
transferência. Cada um desses canais tem um limite interno de 64 MiB por mensagem, e o base64
acrescenta cerca de 33% ao tamanho do PNG — então um PNG acima de aproximadamente **48 MB**
estoura o limite. O erro aparece no salto da mensagem, com mensagem clara e badge de falha, e
não como arquivo corrompido: a captura falha por inteiro em vez de entregar meia imagem.
Páginas extremamente longas ou em telas de DPI alto são o caso realista de se chegar lá.

## Fora de escopo na v1

> **Correção (2/set/2026, v1.1).** "Captura só do viewport" saiu desta lista: ela foi
> implementada na v1.1. O motivo original — "o print do sistema operacional já resolve" —
> não se sustentou no uso: o print do SO não entrega a imagem no clipboard *e* em arquivo
> com nome padronizado, não respeita a preferência de escala, e obriga a sair da extensão
> no meio de uma sequência de capturas. O modo viewport é um caminho separado e curto
> (um `captureVisibleTab`, sem content script, sem scroll, sem restauração porque nada é
> alterado), não um caso especial do full-page.

- Captura de área selecionada ou de elemento específico.
- Preview antes de salvar.
- Anotação ou edição da imagem.
- Formatos além de PNG.
- Firefox e Edge.
- Salvar direto em pasta do Obsidian vault.

## Backlog pós-v1

Itens levantados na revisão final da branch e **deliberadamente não implementados** antes do
merge: nenhum deles é bug de comportamento, todos custam mais do que valem neste momento.

- **Aviso de depreciação do Vite 8 no import sem extensão.** `vite.config.ts` importa
  `./src/manifest.config` sem extensão; o Vite 8 já avisa que a resolução de extensão para
  arquivos TypeScript vai sair. Trocar por `./src/manifest.config.ts` é de uma linha, mas
  mexe no arquivo que configura o build inteiro — vale fazer junto do próximo bump de Vite,
  com os cinco portões rodando.
- **Teste unitário isolando o piso da altura.** `planCapture` tem um `Math.max(1, ...)` no
  `maxHeightCss` que nenhum teste exercita sozinho: qualquer entrada que force esse piso
  também estoura o clamp de largura, então os dois ramos sempre disparam juntos. Falta um
  caso que ative só o piso da altura.
- **`visibility: … !important` inline perde o `!important` no restore.** `fixed-elements.ts`
  guarda e devolve o valor da propriedade inline, mas a flag de prioridade não vai junto: uma
  página que declarava `style="visibility: visible !important"` volta do capture com a mesma
  declaração sem o `!important`. É raro e cosmético, mas é uma alteração residual na página.
- **Verificar se dá para largar o `clipboardWrite`.** A escrita na área de transferência
  acontece no content script, num documento focado, que não precisa dessa permissão. A suíte
  e2e **não** responde isso (o contexto do Playwright concede permissões de clipboard por
  conta própria); só a verificação manual no Chrome real decide — ver a nota da permissão em
  `docs/store/listing.md`.
- **`store/screenshots/01-options-page.png` é ~95% espaço em branco.** A página de opções tem
  dois checkboxes no canto superior esquerdo de uma imagem 1280×800. Funciona como prova de
  que a tela existe, mas é um screenshot ruim de vitrine — reenquadrar ou compor antes de
  submeter.

Vale revisitar também o `web_accessible_resources` que o CRXJS gera para o content script: a
entrada sai com `use_dynamic_url: false`, o que deixa qualquer página sondar a existência da
extensão pelo id fixo. Não expõe dado do usuário, mas é uma superfície de fingerprinting que
não precisa existir.

## Referências

- Nota de projeto no vault: `10-projects/Extensão de print da tela inteira do navegador.md`
- Extensão anterior: [raniellimontagna/tab-switch](https://github.com/raniellimontagna/tab-switch)
