# full-page-shot — Design

**Data:** 2026-09-01
**Status:** aprovado, pronto para plano de implementação

## Objetivo

Extensão de Chrome que captura a página inteira — incluindo o conteúdo fora do viewport
— em um clique, e entrega a imagem no clipboard, em download PNG, ou nos dois.

**Pronto quando:** a extensão publicada na Chrome Web Store captura a página inteira em
um clique e entrega a imagem conforme a preferência do usuário, sem deixar a página em
estado alterado.

## Decisões de escopo

| Decisão | Escolha | Motivo |
|---|---|---|
| Modo de captura | Full-page (scroll) apenas | É o diferencial; viewport puro já é resolvido pelo print do sistema operacional |
| Saída | Clipboard **e** download PNG, configurável | Cobre colar em ferramenta e arquivar |
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
| `sinks` | Entrega via `chrome.downloads` e/ou clipboard | APIs do Chrome | não |

`page-metrics` e `stitcher` concentram a corretude aritmética da captura e são puros:
cobertos por teste unitário. `fixed-elements` e `scroll-driver` são onde a captura quebra
visualmente; isolá-los permite iterar neles sem tocar no resto.

## Fluxo

1. Usuário clica no ícone da action ou usa o atalho de teclado.
2. Service worker valida a URL da aba ativa. Se restrita, aborta aqui.
3. Service worker injeta o content script.
4. Content script devolve as medidas: `scrollWidth`, `scrollHeight`, `innerWidth`,
   `innerHeight`, `devicePixelRatio`, posição de scroll atual.
5. `page-metrics` calcula os passos e valida contra o limite de área do canvas.
6. Service worker garante o offscreen document criado.
7. Loop, por passo:
   - Content script rola para o offset e espera estabilizar.
   - Service worker chama `captureVisibleTab`, respeitando o throttle.
   - O frame é enviado ao offscreen document imediatamente.
8. Content script restaura elementos fixos e o scroll original.
9. Offscreen document fecha o canvas em blob e executa os sinks configurados.
10. Badge na action confirma o resultado.

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
- **Permissões:** `activeTab`, `scripting`, `offscreen`, `downloads`, `clipboardWrite`.
  Nenhuma permissão que dispare aviso agressivo na instalação.

## Testes

**Unitários (Vitest):** `page-metrics` e `stitcher`. É onde mora o erro de off-by-one que
produz faixa duplicada ou linha faltando no meio da imagem final — barato de pegar aqui,
caro de diagnosticar depois.

**End-to-end (Playwright):** carrega a extensão real num Chromium e captura páginas
fixture:

- página curta (um frame só);
- página longa com header `position: fixed`;
- página com lazy-load de imagens;
- página cujo `scrollHeight` não é múltiplo do viewport.

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

A magnitude é pequena e cresce com o número de passos: no varrimento de 478.408 combinações
o pior caso é de 31 pixels de device (≈ 23 px CSS) na emenda 63 de uma página de ~48.000 px
a `dpr` 1.33. Em páginas de tamanho comum a deriva fica em poucos pixels. O último frame é
exceção: ele é ancorado no rodapé do canvas (`canvasHeight − frameHeight`), então o fim da
página sempre bate exato — a deriva nunca corta conteúdo no final da imagem.

A deriva é aceita porque a alternativa é pior. Sem a grade uniforme, arredondar cada posição
de forma independente deixa **linhas de device inteiras sem cobertura** — buracos
transparentes no meio da imagem, ou o rodapé da página cortado. Também não é um artefato da
grade escolhida: uma variante que minimiza a deriva, mantendo a posição real sempre que isso
não quebra a contiguidade, foi varrida em 24.472 combinações e produziu exatamente o mesmo
máximo de 31 px. O resíduo é estrutural — eliminá-lo exigiria desenhar frames mais altos do
que o bitmap realmente é. A escolha real é entre deriva e buracos, e buraco é pior. O limite
está travado por teste de propriedade em `tests/core/stitch-plan.test.ts`, para que uma
mudança futura que piore as emendas falhe alto em vez de degradar a imagem em silêncio.

## Fora de escopo na v1

- Captura só do viewport.
- Captura de área selecionada ou de elemento específico.
- Preview antes de salvar.
- Anotação ou edição da imagem.
- Formatos além de PNG.
- Firefox e Edge.
- Salvar direto em pasta do Obsidian vault.

## Referências

- Nota de projeto no vault: `10-projects/Extensão de print da tela inteira do navegador.md`
- Extensão anterior: [raniellimontagna/tab-switch](https://github.com/raniellimontagna/tab-switch)
