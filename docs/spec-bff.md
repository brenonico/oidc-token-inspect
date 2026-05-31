# Token Inspect — Design

> Data: 2026-05-29
> Estado: Aprovado para planeamento
> Âmbito desta spec: **vertical slice = Login (Authorization Code + PKCE)**, construído
> como plugin genérico reutilizável. Os restantes flows seguem o mesmo molde (ver §9).

## 1. Objetivo

Ferramenta **didática** que representa, estilo *DevTools*, o estado do SessionManager em
"realtime": para cada flow que toca o SessionManager, grava um **trace fiel** da execução
real (com as variáveis envolvidas — PKCE, `state`, `code`, tokens, chaves Redis) e
apresenta-o como uma **timeline percorrível** (stepper) com **diagrama de raias** e
**painéis de variáveis** com decode de JWT.

É uma PoC: **não há requisitos de segurança** sobre a exposição de valores. Tudo é
revelável (incluindo o refresh token), por carregamento explícito do utilizador.

A funcionalidade é desenhada como **plugin genérico** (npm + NuGet *ready*),
drop-in noutros projetos com o padrão BFF + SessionManager. O KCaaIdP é o 1.º consumidor.

## 2. Decisões (resumo)

| # | Decisão |
|---|---|
| Modelo "realtime" | **Gravar + replay (stepper)**. O backend grava o trace real à medida que o flow corre; a UI reproduz como timeline com avançar/recuar. Fidelidade 100% ao que o backend fez. |
| Vertical slice | **Login Authorization Code + PKCE**. |
| Frontends | **3 portais** (customer, partner, ops). O site fica de fora (não tem login). |
| Trace lifecycle | **Journal cronológico** por sessão, com **histórico**, agrupado por flow em **acordeão**; o flow corrente fica aberto e em destaque. |
| Exposição | **Tudo revelável**, incl. refresh token. Preview/hash por defeito → **Decode** (JWT) / **Reveal** (opaco). |
| Fronteira do plugin | **Core genérico in-repo, publicável**: `@token-inspect/react` + lib .NET `TokenInspect`. Zero assunções de Keycloak/Redis nos pacotes. |
| UI | **Slide-over à direita** (altura total, scroll vertical) — layout "B". |
| Segurança/isolamento | **O plugin não compromete o host** (ver §3.2): canal único de egresso, remoção limpa ("fechar as portas"), ACL fail-closed self-scoped + hook do host, keyspace isolado/cifrado/efémero. |

## 3. Arquitetura e fronteira do plugin

Dois pacotes genéricos + o KCaaIdP como host/1.º consumidor.

```
frontend/packages/token-inspect/        ← pacote React/TS publicável ("@token-inspect/react")
  src/
    TokenInspectPanel.tsx               ← UI completa (slide-over: acordeão + stepper + diagrama + vars)
    useTokenInspect.ts                  ← hook: busca o journal, auto-refresh enquanto aberto
    trace-schema.ts                     ← tipos do schema de trace (espelho do backend)
    LaneDiagram.tsx                     ← diagrama de raias derivado dos steps
    Stepper.tsx                         ← timeline vertical, avançar/recuar
    VariableCard.tsx                    ← preview → Decode (JWT) / Reveal (opaco)
    decode.ts                           ← base64url + decode de JWT (sem validação)
  package.json                          ← name "@token-inspect/react"

backend/packages/TokenInspect/          ← class library .NET publicável ("TokenInspect")
  IFlowRecorder.cs                      ← o host chama Record(...) nos pontos do flow
  ITraceStore.cs                        ← abstração de persistência (o host pluga Redis)
  Model/FlowRun.cs, TraceStep.cs, TraceVariable.cs   ← schema genérico, serializável
  TokenInspectEndpoints.cs              ← app.MapTokenInspect() expõe GET /internal/trace
  ServiceCollectionExtensions.cs        ← AddTokenInspect(...)
```

**Regra de ouro do plugin:** nenhum dos pacotes conhece "Keycloak" ou "Redis". O host:
1. chama `recorder.Record(...)` nos seus pontos de orquestração, com as variáveis;
2. fornece uma implementação de `ITraceStore` (no KCaaIdP, Redis cifrado com a Data
   Protection já existente);
3. monta `<TokenInspectPanel>` onde quiser.

O **diagrama é derivado dos steps gravados** (raias de participantes + mensagens
`from→to`), nunca desenhado à mão por flow — por isso funciona para qualquer flow de
qualquer projeto.

### 3.1 Fluxo de dados (Login PKCE)

```
1. Portal SPA → GET /auth/login
   SessionManager: gera PKCE+state
     Record(run-started, pkce-generated, authorize-url-built)   correlationKey = state
   → Redirect para o Keycloak.
2. Keycloak login → GET /auth/callback?code&state
   SessionManager: ResumeRun(state)
     Record(code-received, code-exchange-request, tokens-received[hashes],
            session-created[redis-key], run-completed)
   → Complete(run, sessionId): anexa o run ao JOURNAL da sessão.
3. Portal SPA recarrega (returnTo) → <TokenInspectPanel> monta
   → GET /api/{app}/inspect (proxy de /internal/trace) → journal
   → acordeão; run de login aberto + destacado; utilizador percorre passo-a-passo.
4. Flows in-session (token.exchange, auth.refresh): o painel faz auto-refresh enquanto
   aberto e os novos runs aparecem no journal.
```

A **correlação `correlationKey = state`** cose as duas metades (login + callback, separadas
pelo redirect ao Keycloak) num único `FlowRun`. O `state` já é persistido no
`OidcFlowState` durante o `/auth/login`, logo sobrevive ao redirect.

### 3.2 Princípio de segurança e isolamento (o plugin NÃO compromete o host)

> Princípio fundador. O Token Inspect é, por design, uma **exceção controlada e reversível**
> à postura de segurança do host (expõe ao browser material de tokens que o padrão BFF +
> SessionManager mantém fora dele). Essa exceção tem de ser contida, auditável e — sobretudo
> — **removível sem deixar buracos**: ao ser desinstalado, restaura *exatamente* a postura
> original ("fechar as portas"). Como o isolamento total é impossível (os dados têm de chegar
> ao ecrã), a fuga vive num **canal único, explícito e ACL-gated alinhado com o host**.

**1. Canal único de egresso (onde "vaza").** Há dois pontos de fronteira; só **um** atravessa
para o ecrã:

| Ponto | Rota | Fronteira |
|---|---|---|
| Ingresso (segredos entram no trace) | `recorder.Record(...)` → keyspace `ti:*` (Redis) | servidor-só |
| **Egresso para o browser (CANAL ÚNICO)** | **`GET /api/{app}/inspect`** (BFF) | atravessa para o cliente |
| (interno) | `GET /internal/trace` (SessionManager) | servidor-a-servidor, não chega ao ecrã |

Todo o material sensível chega ao ecrã **exclusivamente** por `GET /api/{app}/inspect`. É o
chokepoint que se audita, se loga e se remove. A rota é etiquetada (`tag: token-inspect`) para
ser trivialmente greppável e identificável no OpenAPI/logs.

**2. Remoção limpa ("fechar as portas") — sem partir o host.**

- **Seam com no-op por defeito.** O host depende de `IFlowRecorder`; o registo *default* é
  `NullFlowRecorder` (no-op: não grava, não expõe). As chamadas `Record(...)` no host
  compilam e correm mesmo sem o plugin ativo — simplesmente não fazem nada. Remover o pacote
  → fallback no-op → host intacto e a compilar.
- **Flag default-OFF + endpoint só mapeado quando ON.** O canal de egresso
  (`/api/{app}/inspect` + `/internal/trace`) **só é mapeado** quando `TokenInspect:Enabled=true`.
  Porta fechada por defeito; o host opta explicitamente por abri-la. Qualquer outro consumidor
  recebe-a fechada.
- **Keyspace isolado e efémero.** O trace vive só em `ti:*`, cifrado (key ring do host) e com
  TTL. Desligar/remover → deixa de escrever e os restos expiram. **Nunca** toca no keyspace de
  sessão (`sess:*`) nem em qualquer outro do host.
- **Aditivo e indistinguível na ausência.** A presença do plugin desligado é indistinguível da
  postura original do host.

**3. ACL fail-closed, self-scoped + hook do host.** Quando a flag está ON, o canal único exige:

- sessão autenticada (sem sessão válida → **nega**);
- **self-scoped**: o chamador vê **apenas** o trace da sua própria sessão, nunca de outra;
- **hook opcional do host** `CanInspect(ctx)`: o host pode **apertar** (ex: exigir uma role de
  debug). O plugin fornece o default self-scoped; o host endurece — nunca afrouxa.

## 4. Schema de trace (genérico)

```
Journal (por sessão)
└── FlowRun[]                  uma execução de um flow
    ├── id, flowKind           "auth.login" | "auth.refresh" | "token.exchange" | ...
    ├── title, status          running | completed | failed
    ├── startedAt, endedAt
    ├── participants: string[] raias do diagrama: ["Browser","SessionManager","Keycloak","Redis"]
    └── steps: TraceStep[]
        ├── ordinal, label      rótulo didático: "Generated PKCE pair"
        ├── from, to            participantes → seta de mensagem no diagrama
        ├── timestamp, note?    nota de ensino opcional
        └── vars: TraceVariable[]
            ├── name            "code_verifier" | "access_token" | "state" | ...
            ├── kind            jwt | opaque | code | url | hash | plain | json
            └── value           valor completo (tudo revelável); a UI calcula o preview
```

`kind` diz à UI como tratar o valor:
- `jwt` → botão **Decode** mostra header + payload descodificados;
- `opaque` (ex: refresh token) → botão **Reveal** mostra o valor cru;
- `code` / `url` / `plain` → texto; preview curto (truncado) por defeito;
- `hash` → valor já é um hash; mostra-o como tal;
- `json` → render de objeto.

## 5. API do recorder (backend, .NET)

```csharp
public interface IFlowRecorder {
    FlowRun BeginRun(string flowKind, string title, string[] participants,
                     string? correlationKey = null);   // correlationKey sobrevive a redirects
    FlowRun? ResumeRun(string correlationKey);          // retoma um run iniciado antes
    void Step(FlowRun run, string label, string from, string to,
              TraceVariable[] vars, string? note = null);
    void Complete(FlowRun run, string sessionId);       // anexa ao journal da sessão
    void Fail(FlowRun run, string error);
}

// helpers de variável
TraceVariable.Jwt("access_token", at);
TraceVariable.Opaque("refresh_token", rt);
TraceVariable.Code("authorization_code", code);
TraceVariable.Url("authorize_url", url);
TraceVariable.Plain("state", state);
```

```csharp
public interface ITraceStore {
    Task SaveRunAsync(string key, FlowRun run, CancellationToken ct);        // key transitório (correlationKey)
    Task<FlowRun?> GetRunAsync(string key, CancellationToken ct);
    Task AppendToJournalAsync(string sessionId, FlowRun run, CancellationToken ct);
    Task<IReadOnlyList<FlowRun>> GetJournalAsync(string sessionId, CancellationToken ct);
}
```

`BeginRun`/`ResumeRun` mantêm o run num store transitório (`SaveRunAsync`/`GetRunAsync`);
`Complete` move-o para o journal da sessão (`AppendToJournalAsync`).

## 6. Wiring backend e instrumentação (KCaaIdP host)

### 6.1 Princípio de colocação

As chamadas `Record(...)` vivem na **camada de orquestração** (os *endpoint handlers*),
**nunca** dentro de utilitários-folha. `PkceGenerator` (estático) e os clients (`KeycloakClient`,
`SessionStore`) ficam **puros** — zero acoplamento ao plugin. Isto mantém a portabilidade
e facilita replicar o padrão aos restantes flows.

Exceção pragmática: o `auth.refresh` é gravado no `SessionService` (que **é** um serviço
injetável, não um util-folha), onde a rotação acontece.

### 6.2 Instrumentação do Login (concreto)

```csharp
// AuthEndpoints.Login (/auth/login)
var run = recorder.BeginRun("auth.login", "Login (Authorization Code + PKCE)",
            ["Browser","SessionManager","Keycloak","Redis"], correlationKey: state);
recorder.Step(run, "Generated PKCE pair", "SessionManager", "SessionManager",
   [TraceVariable.Plain("code_verifier", verifier),
    TraceVariable.Plain("code_challenge", challenge),
    TraceVariable.Plain("state", state)],
   note: "challenge = base64url(SHA256(verifier))");
recorder.Step(run, "Redirect to Keycloak", "SessionManager", "Browser",
   [TraceVariable.Url("authorize_url", url)]);

// AuthEndpoints.Callback (/auth/callback)
var run = recorder.ResumeRun(state);
recorder.Step(run, "Authorization code received", "Keycloak", "SessionManager",
   [TraceVariable.Code("authorization_code", code)]);
recorder.Step(run, "Exchange code for tokens", "SessionManager", "Keycloak",
   [TraceVariable.Plain("grant_type", "authorization_code"),
    TraceVariable.Plain("code_verifier", flow.CodeVerifier)]);
recorder.Step(run, "Tokens received", "Keycloak", "SessionManager",
   [TraceVariable.Jwt("access_token", at),
    TraceVariable.Jwt("id_token", it),
    TraceVariable.Opaque("refresh_token", rt)]);
recorder.Step(run, "Session stored (encrypted)", "SessionManager", "Redis",
   [TraceVariable.Plain("redis_key", key)]);
recorder.Complete(run, sessionId);
```

### 6.3 Endpoints

```
SessionManager:  GET /internal/trace        ← novo, de MapTokenInspect(); lê X-Session-Id → journal
                 (o antigo GET /internal/tokens é REMOVIDO — o seu conteúdo passa a ser
                  variáveis dentro dos runs de login/refresh)
BFF (api-bff):   GET /api/{app}/inspect      ← passa a fazer proxy do journal de /internal/trace
                 (a forma antiga {session, exchanged} é SUBSTITUÍDA pelo journal)
```

> Ambas as rotas **só são mapeadas quando `TokenInspect:Enabled=true`** (default OFF) e o
> egresso (`/api/{app}/inspect`) é o **canal único** ACL-gated self-scoped + hook do host
> (ver §3.2). Com a flag OFF ou o pacote removido, o `NullFlowRecorder` no-op não grava nada
> e nenhuma rota é exposta — postura original do host restaurada.

### 6.4 Flows in-session que dão a sensação "live"

- **token.exchange** — gravado no handler `/internal/token` (participantes: BFF →
  SessionManager → Keycloak), anexado ao journal com `correlationKey = sessionId`. É o que
  o inspector antigo mostrava como `exchanged`, agora como um run percorrível.
- **auth.refresh** — gravado no `SessionService` quando o access token expira e há rotação
  do refresh token.

### 6.5 Persistência (ITraceStore no KCaaIdP)

Implementação Redis cifrada (mesma Data Protection key ring que o `SessionStore` já usa):
- `ti:run:{correlationKey}` — run transitório durante o redirect (TTL curto, ex: 10 min).
- `ti:journal:{sessionId}` — lista append-only dos runs (TTL alinhado com a sessão).

## 7. UI — Slide-over à direita (layout B)

Painel de **altura total à direita**, scroll vertical, aberto pelo botão ☰ no header.
Mesma metáfora dos DevTools. Estrutura (de cima para baixo):

1. **Header** do painel: título + controlos avançar/recuar (◀ ▶).
2. **Acordeão de flows** (journal cronológico): cada flow é um grupo colapsável; o flow
   **corrente fica aberto e em destaque** (barra amarela à esquerda + label `· agora · 4/6`).
   Flows anteriores ficam colapsados no histórico.
3. **Stepper vertical** (dentro do flow aberto): lista de steps com linha conectora; o step
   **atual destacado**; clicar num step seleciona-o; ◀/▶ avançam/recuam.
4. **Diagrama de raias** (compacto): colunas dos participantes; a mensagem `from→to` do step
   atual fica em destaque.
5. **Cartões de variáveis** do step selecionado: `name` + pílula de `kind` + preview
   (truncado/hash) + botão **Decode** (JWT → header+payload) ou **Reveal** (opaco → valor cru).

Componentes do pacote: `TokenInspectPanel`, `Stepper`, `LaneDiagram`, `VariableCard`,
`useTokenInspect` (busca + auto-refresh enquanto aberto).

## 8. Integração frontend (KCaaIdP host)

- **Consumo:** alias Vite `@token-inspect` → `frontend/packages/token-inspect/src`, adicionado
  ao `vite.config.ts` dos 3 portais (mesmo mecanismo do `@shared`).
- **Ponto de montagem:** `AppShell` (prop `showInspector`) passa a renderizar
  `<TokenInspectPanel client={apiClient} endpoint={`/api/${app}/inspect`} />` em vez do
  `<TokenInspector>` atual.
- **Limpeza:** remover `frontend/shared/src/components/TokenInspector.tsx`; a lógica de
  `shared/src/lib/jwt.ts` migra para `token-inspect/src/decode.ts` (pacote auto-contido).
- **Gating (frontend):** o prop `showInspector` do `AppShell` controla apenas a **montagem
  da UI**; não é a porta de segurança. Mesmo montado, o painel só obtém dados se o canal
  único backend estiver ativo (flag ON) e a ACL permitir.
- **Gating (a porta real):** está no backend — flag `TokenInspect:Enabled` **default OFF**;
  o KCaaIdP (host) opta explicitamente por ON na sua config. ACL fail-closed self-scoped +
  hook do host (§3.2). O pacote é agnóstico ao ambiente; o host decide se abre a porta.

## 9. Replicação aos restantes flows (fora do vertical slice, mesmo molde)

Cada flow segue o padrão: `BeginRun`/`Step`/`Complete` na camada de orquestração + um
catálogo de participantes/labels. Candidatos (todos tocam o SessionManager):

| flowKind | Onde grava | Participantes típicos |
|---|---|---|
| `auth.guest` | `/auth/guest` | Browser, SessionManager, Redis |
| `auth.otp` | `/auth/otp/start` + `/auth/otp/verify` | Browser, SessionManager, Redis |
| `auth.logout` | `/auth/logout` | Browser, SessionManager, Keycloak, Redis |
| `auth.stepup` | `/auth/stepup` + callback | Browser, SessionManager, Keycloak |
| `user.provision` | `/internal/provision-user` | BFF, SessionManager, Keycloak |
| `user.set-password` | action-link UPDATE_PASSWORD | Browser, Keycloak (parcial — ver nota) |

> Nota: `user.set-password` é maioritariamente do lado do Keycloak (required action). A
> instrumentação no SessionManager limita-se ao que ele orquestra (geração/entrega do
> action-link). O detalhe interno do KC não é gravável por este plugin.

## 10. Fora de âmbito (1.ª iteração)

- Streaming push (SSE/WebSocket) — o login navega para fora do SPA durante o redirect, o que
  anula o valor de stream ao vivo; o modelo gravar+replay com auto-refresh cobre o caso.
- Publicação real em npm/NuGet — os pacotes nascem *publish-ready* mas a publicação é
  posterior.
- Adaptadores genéricos para outros backends de sessão (Approach 3) — não nesta iteração.
- Gating por ambiente / produção — é PoC didática; sem requisitos de segurança.
- Flows além do Login PKCE — desenhados no §9, implementados em iterações seguintes.

## 11. Critérios de aceitação (vertical slice)

1. Fazer login num dos 3 portais grava um `FlowRun` `auth.login` no journal da sessão, com
   os steps: PKCE gerado → redirect → code recebido → troca de code → tokens recebidos →
   sessão guardada → completo.
2. O `state` cose corretamente as metades `/auth/login` e `/auth/callback` num único run.
3. O `<TokenInspectPanel>` (slide-over B) abre pelo ☰, mostra o acordeão com `auth.login`
   aberto/destacado, e permite percorrer os steps com ◀/▶.
4. Para cada variável: preview por defeito; **Decode** mostra o JWT (access/id token);
   **Reveal** mostra o refresh token cru.
5. O diagrama de raias destaca a mensagem `from→to` do step atual.
6. Usar o portal gera runs adicionais (`token.exchange`, `auth.refresh`) que aparecem no
   journal por auto-refresh.
7. Os pacotes `@token-inspect/react` e `TokenInspect` (.NET) não referenciam Keycloak nem
   Redis — toda a especificidade do KCaaIdP está no host (instrumentação + `ITraceStore`).

**Segurança e isolamento (§3.2):**

- **Remoção limpa:** com `TokenInspect:Enabled=false` (ou o pacote removido), nenhuma rota
  `/api/{app}/inspect` nem `/internal/trace` é mapeada, o `NullFlowRecorder` no-op não grava
  nada em `ti:*`, e o comportamento do host é indistinguível de antes do plugin (smoke
  existente continua a passar; `sess:*` intacto).
- **Canal único:** `GET /api/{app}/inspect` é a **única** rota que entrega material de tokens
  ao browser (greppável, etiquetada `token-inspect`); nenhuma outra rota nova expõe trace.
- **ACL fail-closed self-scoped:** sem sessão válida → nega; o chamador só obtém o trace da
  **sua própria** sessão; o hook `CanInspect(ctx)` do host pode apertar e nunca afrouxar.
