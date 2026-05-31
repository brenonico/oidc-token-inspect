# Token Inspect — Plugin Agnóstico à Arquitetura — Design

> Data: 2026-05-29
> Estado: Aprovado para planeamento
> Antecede: [2026-05-29-token-inspect-design.md](2026-05-29-token-inspect-design.md) (vertical slice BFF) e o cap. [13](../../13-token-inspect-plugin.md).
> Esta spec **generaliza** o Token Inspect para funcionar em **qualquer** aplicação que use
> autenticação com Keycloak, independentemente da arquitetura — incluindo arquiteturas "más"
> (SPA public-client com PKCE no browser e tokens em localStorage; API de experiência que lê o
> token do browser, faz RBAC e chama APIs core/BD). Objetivo: ser o **modelo de referência**
> reutilizável para todos os projetos do cliente.

## 1. Objetivo e princípios

Tornar o Token Inspect um **plugin ~99.9999% desacoplado**, trivialmente incluído e excluído,
agnóstico a frameworks/camadas, que **nunca quebra o host** e **nunca altera o Keycloak**.

**Princípio fundador — "encontrar o token onde ele vive".** A captura faz-se no **ponto de
observação** onde o token/flow é observável. Três adaptadores, escolhidos conforme a arquitetura:

| Adaptador | Vê | Não vê |
|---|---|---|
| **ClientObserver** (browser) | flows no browser, tokens no storage, arestas das chamadas de API, claims | internos do servidor, tokens que nunca chegam ao browser, cookies `HttpOnly` |
| **ServerMiddleware** (.NET drop-in) | token recebido, validação/RBAC, downstream, stores server-side (BD/cache) | o que não passa no servidor instrumentado |
| **ExplicitRecorder** (BFF/SessionManager) | tudo onde a app chama `Record()` (sessão cifrada incluída) | — |

**Matriz cenário → adaptador → alterações:**

| Cenário | Token vive em | Adaptador | Front | Back | KC |
|---|---|---|---|---|---|
| Code+PKCE (public client) | browser (storage) | ClientObserver | `<script>`+config | — | — |
| Implicit flow | browser (fragmento) | ClientObserver | `<script>`+config | — | — |
| ROPC no browser | browser | ClientObserver | `<script>`+config | — | — |
| ROPC no servidor | servidor | ServerMiddleware | — | middleware | — |
| Tokens em BD/cache (server) | servidor | ServerMiddleware | — | middleware | — |
| BFF + SessionManager | sessão cifrada (server) | ExplicitRecorder | painel | recorder (feito) | — |

**Invariante de segurança (regra de ouro):** **seguro-por-defeito = inerte-por-defeito.** Sem
opt-in explícito, o plugin não instrumenta nada, não injeta nada, não monta nada. KC nunca tocado.

## 2. Decisões (resumo)

| # | Decisão |
|---|---|
| Captura | 3 adaptadores por ponto de observação (client / server / BFF) |
| Arquitetura | **Approach A**: `TraceSource` plugável + schema comum; **um só renderer** |
| Distribuição | `<script>` UMD self-mount (Shadow DOM, traz o seu React) + export React + NuGet .NET |
| Profundidade | client + middleware server, fundidos por correlation-id |
| Config | **inerte por defeito, opt-in por capacidade**; auto-deteção minimiza config *dentro* do que é ligado; presets |
| Merge | ordenação **lógica**; limitado a 1 hop client + 1 hop server (fan-out sinalizado, não achatado) |
| Headers | **anonimizados**: default `traceparent` (W3C, neutro), configurável; nunca um nome que revele a ferramenta; off por defeito; só same-origin/allowlist |
| Segurança | hardening completo (ver §7), incl. fix do IDOR latente no pacote atual |

## 3. Arquitetura (Approach A): `TraceSource` + adaptadores

```ts
interface TraceSource {
  getJournal(): TraceJournal | Promise<TraceJournal>;
  subscribe(cb: (j: TraceJournal) => void): () => void;
}
```

- **`HttpTraceSource(client, endpoint)`** — busca/poll o journal de um endpoint (modos server/BFF).
- **`LiveTraceSource`** — store em memória alimentado pelo ClientObserver; emite updates.
- **`CompositeTraceSource`** — funde várias fontes por `correlationId`.

Os 3 adaptadores emitem o **mesmo schema** (`FlowRun[]`). O painel React passa a consumir um
`TraceSource` (refactor pequeno — hoje depende de `client.get`, ver `useTokenInspect.ts`).

**Pacotes:**
```
@token-inspect/core      → schema, tipos, TraceSource, merge/correlação, decode (sem framework)
@token-inspect/react     → painel + renderer atual, refatorado para consumir TraceSource
@token-inspect/browser   → ClientObserver + bundle UMD self-mount (Shadow DOM)
TokenInspect (.NET)      → ExplicitRecorder + ITraceStore + MapTokenInspect (atual, com fix ACL)
                           + ServerMiddleware genérico (UseTokenInspect)
```

> **Fonte única do schema (anti-rot):** os tipos TS e .NET são espelhos mantidos à mão hoje.
> Para não divergirem entre N projetos, o schema passa a ter **uma fonte de verdade** (gerar os
> tipos TS a partir do .NET, ou ambos a partir de um JSON Schema em `@token-inspect/core`).

## 4. Schema de trace (extensões)

Retrocompatível com a spec anterior. Adições:

```ts
interface FlowRun {
  // ...atuais...
  correlationId?: string;                          // funde client + server
  source?: "client" | "server" | "bff" | "merged";
}
interface TraceStep {
  // ...atuais (incl. short?)...
  source?: "client" | "server" | "bff";
  seq?: number;                                     // ordinal LÓGICO por fonte (não wall-clock)
}
interface TraceJournal { sessionId?: string; runs: FlowRun[]; }
```

- **Novos flows** (`api.call`, `auth.implicit`, `auth.ropc`, …) = valores novos de `flowKind` (string livre).
- **Detalhe de chamada de API** = `TraceVariable` (method/url/status como `Plain`, Bearer como `Jwt`).
- **Ordenação lógica:** o merge usa `source` + `seq` (ordinal por fonte) + ligações causais,
  **não** `timestamp` (evita interleaving errado por clock skew entre client e server).

## 5. Adaptadores

### 5.1 ClientObserver (`@token-inspect/browser`) — **opt-in**

- **Interceção:** wrap pass-through de `window.fetch` e `XMLHttpRequest` (`open`/`send`/`setRequestHeader`);
  referências originais guardadas e **restauradas no teardown**. A chamada do host corre **mesmo se a
  instrumentação rebentar** (try/catch só à volta da gravação); preserva `this`/args/retorno; **não
  clona nem consome** corpos/streams; **deteta wrappers existentes** (Datadog, MSW, Axios…) e compõe-se
  ou recusa-se a patchar.
- **Storage (opt-in separado `storageScan`):** wrap de `Storage.setItem` + varrimento por JWTs.
- **Redirects:** lê `?code&state` / `#access_token=` de `window.location`; PKCE (`code_verifier`,`state`) do storage.
- **IdP:** por config (`issuer`) ou auto via OIDC discovery / matching de tráfego.
- **Reconstrução:** `auth.login` (code+PKCE), `auth.implicit`, `auth.ropc`, `auth.refresh`, `api.call`.
- **Correlação (opt-in `correlation`):** injeta `traceparent` (configurável) **só** em hosts
  same-origin/allowlist; **nunca** cross-origin; nunca um header que identifique a ferramenta.

### 5.2 ServerMiddleware (.NET, `app.UseTokenInspect()`) — **opt-in**

- Grava token recebido (resultado de validação, claims, decisão RBAC), chamadas downstream, markers de BD/cache.
- **Principal resolvido server-side** (`HttpContext.User`) — **nunca** de um header da request.
- **Correlation-id gerado/validado no servidor** (`^[A-Za-z0-9_-]{8,64}$`); saneado antes de logs/chaves.
- Buffer em ring **limitado + TTL**; cifrado se persistido; nunca altera respostas; instrumentação em try/catch.
- Endpoint dev: flag-gated, **hard-stop em Production**, **loopback por defeito**, **autorizado** (principal
  tem de possuir o trace), path configurável/ofuscável.

### 5.3 ExplicitRecorder (atual) — **fix de ACL obrigatório**

`TokenInspectEndpoints.cs` hoje confia no header `X-Session-Id` (IDOR latente; só seguro porque o BFF
resolve a sessão server-side). Correção: o pacote **deixa de confiar no header** — exige um delegate de
autorização que **nega por defeito** quando exposto, e a posse da sessão é derivada do contexto
autenticado, não de input da request. Aplica-se **já** ao código existente.

## 6. Config — inerte por defeito, opt-in por capacidade

```yaml
enabled: false                 # master. Em Production exige ack_exposes_tokens=true + warning ruidoso
ack_exposes_tokens: false      # 2.ª confirmação explícita p/ permitir em prod
capabilities:
  clientObserver: false        # opt-in: wrap fetch/XHR
  storageScan: false           # opt-in SEPARADO (localizar JWTs é sensível)
  correlation:
    enabled: false             # opt-in: injeta header de correlação
    header: "traceparent"      # neutro/anonimizado; configurável; nunca identifica a ferramenta
    allowlist: ["self"]        # SÓ same-origin por defeito; hosts extra explícitos
idp: { issuer: null }          # opcional (auto via discovery/tráfego)
apis: [{ match: "...", lane: "Core API" }]   # opcional: rótulos de raias
redaction: "didactic"          # "didactic" mostra tudo (PoC); "mask" redige
mount: { dock: "bottom", shadowDom: true }
egress: { endpoint: "/api/.../inspect" }     # FIXO no load — NÃO mutável em runtime (anti-exfiltração)
preset: null                   # public-client-spa | bff-sessionmanager | api-validates-token
```

- **Inerte:** `enabled:false` ou capacidade off → zero patching, zero painel, zero header.
- **Auto-deteção** opera **dentro** de uma capacidade já ligada (não liga capacidades sozinha).
- **Presets** aplicam defaults sãos por padrão; o utilizador faz override.

## 7. Segurança e isolamento (achados da revisão sénior, todos adotados)

1. **ACL sem header-trust** — posse derivada do contexto autenticado; request-supplied id é input não fiável. (Corrige IDOR; aplica-se ao código atual.)
2. **"ON em prod" não-catastrófico** — hard-stop em `Production` salvo `ack_exposes_tokens=true`; warning ruidoso no arranque; endpoint dev em loopback por defeito.
3. **Supply chain** — UMD com **SRI obrigatório** + versão pinada + proveniência assinada; **egresso não mutável em runtime**; sem `eval`/script dinâmico; guia de CSP (`connect-src`).
4. **Shadow DOM = isolamento só cosmético** (CSS/markup), não de JS — documentado; minimizar superfície global; **teardown idempotente** + self-test (`window.fetch === original`); limpar buffers e listeners.
5. **Correlation-id** gerado/validado no servidor; saneado antes de logs/chaves (anti log/cache injection).
6. **Opt-in por capacidade** (inverte "auto-on") — instrumentar uma app arbitrária exige opt-in explícito.
7. **`traceparent` same-origin/off-by-default** (substitui header bespoke) — evita preflight CORS que parte chamadas e fuga cross-origin; **nomes de header anonimizados/configuráveis**.
8. **Merge lógico, 1+1 hop** — sem wall-clock; fan-out **sinalizado, não achatado** (um diagrama enganador é inaceitável numa ferramenta didática).

**Não-exfiltração:** egresso bloqueado a um allowlist definido em config-load; proibido repointar em runtime; o plugin nunca transmite valores observados para fora da origem.

## 8. Decoupling / remoção limpa (invariantes)

- Remover o `<script>`/import + config → restaura `fetch`/XHR/`setItem`, remove listeners, desfaz padding,
  para a injeção de header, limpa buffers. Host indistinguível de antes.
- Pacotes `core`/`react`/`browser` **sem** referências a Keycloak/Redis/host; toda a especificidade vive na
  config e nos adaptadores do host.
- KC nunca alterado, em nenhum cenário.

## 9. Fora de âmbito (1ª versão)

- Tracing distribuído completo (spans aninhados, fan-out N-serviços) — roadmap via W3C trace-context.
- Middlewares para stacks além de .NET (Node, etc.) — depois (o contrato suporta).
- Publicação real em npm/NuGet (os pacotes nascem publish-ready; assinatura/SRI definidos, publicação posterior).
- Captura de internos de servidores não instrumentáveis sem o middleware.

## 10. Critérios de aceitação

1. **Inerte por defeito:** com config vazia / `enabled:false`, nenhum global é patchado, nenhum painel monta,
   nenhum header é injetado (teste: `window.fetch === original`).
2. **Public-client SPA (cenário "mau"):** com `clientObserver` ligado, um login PKCE no browser + chamadas de
   API aparecem como `auth.login` + `api.call` no painel, com claims decodificáveis — **sem** alterações no
   código da app nem no KC.
3. **API valida token (cenário "mau"):** com o ServerMiddleware drop-in + `correlation`, os hops internos
   (RBAC, core) fundem-se com o trace do browser **por correlation-id**, num único `FlowRun` com `source` por step.
4. **Não quebra o host:** uma exceção forçada na instrumentação **não** afeta a chamada do host; chamadas
   cross-origin **não** recebem header injetado; nenhuma chamada simples passa a sofrer preflight inesperado.
5. **ACL sem header-trust:** pedir o trace de outra sessão/principal via header → **negado**.
6. **Prod fail-safe:** `enabled:true` em `Production` sem `ack_exposes_tokens` → endpoints não mapeados +
   warning ruidoso.
7. **Remoção limpa:** após teardown, globais restaurados, listeners removidos, buffers limpos.
8. **Desacoplamento:** `grep` por keycloak/redis/host nos pacotes `core`/`react`/`browser` → vazio.
9. **BFF mode intacto:** o caminho atual continua a funcionar e o smoke da PoC continua verde.
