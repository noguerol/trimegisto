# Auditoría adversarial — Delegation Contract (#26)

- **Fecha:** 2026-09-24
- **Alcance:** `src/delegation.ts` (untracked/WIP), `src/tier-status.ts` (mod), `src/index.ts` (mod), `test-delegation.ts`, `test-directive-framing.ts`, historia git de `6ed281e^..HEAD`.
- **Método:** lectura del texto exacto, arqueología git del contrato anterior, ejecución de las dos suites reales, y sonda propia de 19 prompts contra `analyzeDecomposability` (`probe-delegation.ts`).
- **Restricción respetada:** no se modificó ningún archivo del repo; el único fichero escrito es este reporte. La sonda vive en `/tmp`.

> **Nota de concurrencia (importante).** Durante la auditoría, otro worker de #26 editó el repo:
> `test-delegation.ts` a las 16:43:07 y **`src/delegation.ts` a las 16:43:22**. Al inicio del
> probe existía un bug de conteo de ficheros (abajo, §3.1); a las 16:43:22 ya estaba corregido.
> El veredicto se emite sobre el **estado final** (mtime 16:43:22), contrastado con el intermedio.

---

## Veredicto: **PASS**

El nuevo contract **no** reproduce el incidente de "hijack / refusal" y **no** es tan blando como el
opt-in anterior. Quedan una observación de bajo riesgo de tono (§1.3) y cuatro casos límite del
detector (§3.2), ninguno bloqueante.

| Pregunta | Veredicto | Evidencia |
|---|---|---|
| (a) ¿Se lee como hijack y provoca negativa? | **PASS** | Vive en el system prompt, va delimitado, no usa "MUST"; `test-directive-framing.ts` 19/0 |
| (b) ¿Es tan blando que se ignora? | **PASS** | Invierte el defecto, nombra capacidad y allowlist; estrictamente más fuerte que el opt-in previo |
| (c) Sonda `analyzeDecomposability` (19 prompts) | **PASS con matices** | 0 FP en los 7 atómicos claros; 2 FP límite; 2 FN; suites 48/0 y 19/0 |

---

## 1. (a) ¿Es el system prompt un "hijack" que haga negarse a un modelo cauto?

### 1.1 El incidente documentado y su causa raíz

El header de `src/tier-status.ts` describe el fallo medido:

> "Before this rewrite the whole orchestration policy was pushed into that user channel every turn, AFTER the user's own message. Measured on a real session: 57 chars of user request vs 2,103 chars of imperative orchestration text — the last thing the model read before answering was a wall of **"your FIRST action MUST be a trimegisto batch call"**. A cautious model read that as injected instructions with no real request attached and refused to answer."

El texto agresivo anterior, recuperado de git (`git show 6ed281e^:src/index.ts`, ~L2173), era:

> "TRIMEGISTO ACTIVE (multi-agent mode). For every request, first check for 2+ independent subtasks/files/areas/checks; if decomposable, **your FIRST action MUST be a `trimegisto` batch call** — do not solve it serially first. Then orchestrate and integrate."

La causa no era el contenido, sino **el canal y la colocación**: pi convierte los mensajes `role:"custom"` de `before_agent_start` en `role:"user"` sin marcador de origen y los añade **después** del mensaje del usuario (`convertToLlm`, `messages.js`). El modelo leía 2.103 chars imperativos como último turno "del usuario", sin petición real adjunta, y se negaba.

### 1.2 Por qué el contrato nuevo NO es un hijack — frases exactas

El contrato nuevo (`formatDelegationContract({autoSpawn:true})` en `src/delegation.ts`) dice:

> "DELEGATION CONTRACT — the default is to delegate."
> "- Before your first edit, read the request as a set of independent work units. If it splits into two or more, **your first action is one `trimegisto` batch carrying all of them**; do not do the split work serially and delegate only the leftovers."
> "- Work solo only when the request is provably atomic: a single question or lookup, one small change in one file, or one command whose steps cannot run in parallel. **\"Doing it myself is faster\" is not a reason to skip.**"
> "- Fill the capacity. `11 parallel slots configured (…)` Split substantial requests along file/module/check boundaries until the batch uses the available slots…"
> "- Units stay disjoint: never two agents on the same file, question, or output."
> "- One batch, then integrate: the batch's reconciliation is the final answer; do not re-spawn the same work."
> "- If a tier is unavailable or the gate rejects the batch, adjust and relaunch instead of silently falling back to solo work."

Tres diferencias estructurales, no solo de redacción:

1. **Canal.** Ya no viaja por `before_agent_start` como `role:"custom"`. `buildSystemPolicy(event)` en `src/index.ts` lo mete en el **system prompt**: `` `${event?.systemPrompt ?? ""}\n\n${buildSystemPolicy(event)}` ``. El system prompt no compite con la petición del usuario ni aparece como "lo último que el modelo lee del usuario".
2. **Enmarcado.** Va dentro de `<trimegisto-policy>` y abierto por la línea: *"Injected by the Trimegisto extension. It gives this session a `trimegisto` tool… **This block is stable reference**; live agent status, if any, arrives separately in the user channel."* Un modelo cauto puede atribuir el origen sin ambigüedad.
3. **Tono.** Desaparece el `MUST` / "FIRST action". Ahora es "your first action is one batch" (minúscula, sin modal de obligación) y con escape explícito ("Work solo only when the request is provably atomic").

La sonda `test-directive-framing.ts` (ejecutada contra el handler real y el `convertToLlm` real) pasa **19/19**, incluida la aserción literal del hijack:

```
Placement: the stable policy lives in the SYSTEM PROMPT, not the user channel:
  ✓ the policy block is appended to the system prompt
  ✓ the policy carries the delegation rules
  ✓ the policy carries the tier capacity lines
  ✓ the imperative that read as a hijack is gone
Volume: an idle orchestrator injects NOTHING into the user channel:
  ✓ user channel is exactly the user's request
  ✓ no trimegisto text in the user channel at all
...
19 passed, 0 failed
```

Y la prueba del canal de usuario sigue siendo limpia: en turno idle el handler devuelve `{ systemPrompt }` sin `message`; si hay agentes, `formatDirectiveContent` va envuelto por `frameExtensionContext` con `EXTENSION_CONTEXT_NOTICE` (*"This is NOT the user's message and NOT a new request. The user's request is the message above…"*).

**Conclusión (a):** el mecanismo que provocó la negativa (canal usuario + después del mensaje + sin origen + ratio 31:1) está eliminado por diseño, no solo suavizado. **PASS.**

### 1.3 Riesgo residual de bajo nivel (tono)

Aun en el system prompt, el contrato es **imperativo de estado de ánimo**: "the default is to delegate", "your first action is one batch", "Fill the capacity", "Doing it myself is faster is not a reason to skip". Un modelo *demasiado* obediente podría sobre-delegar una petición límite (p. ej. "explica src/a.ts y src/b.ts", §3.2) en vez de responder. Eso es **sobre-delegación**, no negativa-a-responder: un modo de fallo distinto y mucho menos grave que el documentado. No requiere acción para este veredicto; se registra por completitud.

---

## 2. (b) ¿O es tan blando que un modelo lo ignorará? Comparación con el opt-in anterior

### 2.1 Texto opt-in anterior (HEAD, commit `6ed281e`, `proactivePolicyText()`)

`git show HEAD:src/index.ts`:

> "When a request decomposes into 2+ independent, disjoint subtasks, **prefer delegating them as one `trimegisto` batch** over working through them serially. When it does not decompose, just do the work yourself — no batch is expected."

(rama `autoSpawn=false`: *"Auto-spawn is OFF: delegate only when the user asks for it or clearly benefits from it."*)

Ese es exactamente el texto que el header de `delegation.ts` describe como causa de slots ociosos:

> "Models read that as \"delegate if you happen to feel like it\" and did the work serially, leaving every configured slot idle. Measured symptom: `trimegisto` was available, enabled and advertised, and was simply not called."

### 2.2 Cuánto más fuerte es el nuevo

| Eje | Opt-in anterior (HEAD) | Contrato nuevo |
|---|---|---|
| Defecto | "prefer delegating… when it decomposes" (condicional) | **"the default is to delegate"** (invertido) |
| Antes de actuar | silencio | "Before your first edit… read the request as a set of independent work units" |
| Presión a llenar | no la nombra | **"Fill the capacity. N parallel slots configured (…)"** con recuento real |
| Carga de la prueba | la delegación se justifica | la **atomicidad** se justifica ("provably atomic") |
| Excusa vaga | no la aborda | rechaza explícitamente "Doing it myself is faster" |
| Reincidencia | no la aborda | "one batch, then integrate: … do not re-spawn" |

Además el modo autoSpawn=false cambia de "delegate only when explicitly requested" a una formulación opt-in deliberadamente pasiva: *"DELEGATION: opt-in. Work solo unless the user explicitly asks for parallel agents or the request is large enough that delegation is obviously what they want."* Es decir: el modo ON se endurece y el OFF se ablanda, que es la dirección correcta.

**Conclusión (b):** no es blando; es más fuerte que el opt-in anterior y la suite `test-delegation.ts` ya asserta que no puede volver a derivar al viejo fraseo. **PASS.**

### 2.3 Observaciones menores de documentación / cache

- **Cita no literal en el header.** `src/delegation.ts` abre con: `The older policy was opt-in: "when a request decomposes into 2+ independent subtasks, prefer delegating".` Entrecomillado como si fuera textual, pero el texto real commiteado era más largo ("…prefer delegating them as one `trimegisto` batch over working through them serially…"). Es una paráfrasis con comillas; precisión documental mejorable, sin impacto funcional.
- **Cache del prefix.** `formatDecomposabilityNote()` se renderiza **al final** de `formatSystemPolicyContent` (después de "Roles: …", justo antes de `</trimegisto-policy>`), así que solo cambia la cola del bloque y el prefix cacheado sobrevive. Correcto. Matiz: el test de estabilidad de `test-directive-framing.ts` solo cubre el turno **sin prompt** (`handler({systemPrompt:"BASE"})`); no ejercita la variación por `decomposabilityNote` entre prompts. No es un defecto del diseño, es una cobertura de test incompleta.

---

## 3. (c) Sonda `analyzeDecomposability` — 19 prompts

**Script:** `probe-delegation.ts` (importa `analyzeDecomposability` desde la ruta absoluta `./trimegisto/src/delegation.ts`).
**Comando:** `node --experimental-strip-types probe-delegation.ts` (Node v22.23.1).
**Cobertura:** 7 atómicos + 8 multi-parte + 4 casos límite deliberados (2 con marca `FP?` y 2 con marca `FN?`).

### 3.1 Salida (estado final, mtime 16:43:22)

```
kind         | decomp | score | signals
-------------+--------+-------+------------------------------------------
ATOMIC       | false  | 0     | "fix the typo"
             |        |       | signals: 1 action verb
ATOMIC       | false  | 0     | "¿Qué hace este archivo?"
             |        |       | signals: (none)
ATOMIC       | false  | 0     | "renombra la variable foo"
             |        |       | signals: 1 action verb
ATOMIC       | false  | 1     | "read package.json"
             |        |       | signals: 1 file
ATOMIC       | false  | 0     | "what is the current date"
             |        |       | signals: (none)
ATOMIC       | false  | 0     | "Add a semicolon on line 10"
             |        |       | signals: 1 action verb
ATOMIC       | false  | 0     | "explica este error"
             |        |       | signals: (none)
MULTI        | true   | 6     | "arregla src/a.ts y añade tests en src/a.test.ts y actualiza el README"
             |        |       | signals: 2 files | 4 action verbs | coordinated clauses
MULTI        | true   | 6     | "refactoriza src/delegation.ts, revisa src/tier-status.ts y document..."
             |        |       | signals: 2 files | 3 action verbs | coordinated clauses
MULTI        | true   | 3     | "implementa login, escribe tests y despliega"
             |        |       | signals: 3 action verbs | coordinated clauses
MULTI        | true   | 6     | "Fix the bug in parser.js, add a regression test, and update CHANGEL..."
             |        |       | signals: 2 files | 4 action verbs | coordinated clauses
MULTI        | true   | 5     | "Necesito tres cosas:\n- arregla el parser\n- añade los tests\n- actual..."
             |        |       | signals: 3-item list | 4 action verbs | 3 sentence breaks
MULTI        | true   | 6     | "analiza src/index.ts y src/delegation.ts; después corrige los error..."
             |        |       | signals: 2 files | 4 action verbs | coordinated clauses
MULTI        | true   | 3     | "crea el endpoint de alta, añade validación de campos, documenta la ..."
             |        |       | signals: 4 action verbs | coordinated clauses
MULTI        | true   | 3     | "Review the whole auth flow, because the token refresh is broken, th..."
             |        |       | signals: 4 action verbs | coordinated clauses
FP?ATOMIC    | true   | 4     | "explica src/a.ts y src/b.ts"
             |        |       | signals: 2 files | coordinated clauses  <-- FALSE POSITIVE
FN?MULTI     | false  | 1     | "Encárgate del login. Luego ocúpate del logout. Al final pásame el r..."
             |        |       | signals: coordinated clauses  <-- FALSE NEGATIVE
FN?MULTI     | false  | 1     | "The frontend is broken, the API returns 500s, and the docs are stale."
             |        |       | signals: coordinated clauses  <-- FALSE NEGATIVE
FP?ATOMIC    | true   | 4     | "Muéstrame el contenido de src/index.ts y de src/config.ts"
             |        |       | signals: 2 files | coordinated clauses  <-- FALSE POSITIVE

=== SUMMARY ===
cases: 19  (7 atomic, 8 multi, 4 adversarial)
false positives (atomic flagged decomposable): 2
false negatives (multi NOT flagged):           2
```

### 3.2 Análisis de falsos positivos / negativos

- **7/7 atómicos claros → `decomposable:false` (0 FP reales).** `"fix the typo"`, `"¿Qué hace este archivo?"`, `"renombra la variable foo"`, `"read package.json"`, `"what is the current date"`, `"Add a semicolon on line 10"`, `"explica este error"` quedan en score 0–1. Cumple el requisito de "no dar la lata en one-liners".
- **8/8 multi-parte → `decomposable:true` (0 FN reales).** Todos superan el umbral 3 con señales nombradas.
- **FP-1 y FP-2 (límite, no duros):** `"explica src/a.ts y src/b.ts"` y `"Muéstrame el contenido de src/index.ts y de src/config.ts"` puntúan 4 ("2 files" +3, "coordinated clauses" +1). Son *una sola* petición de lectura/consulta sobre dos artefactos. Discutible: nombrar 2 ficheros es, por diseño del detector (`>= 2 files +3`, "very strong: touches more than one artifact"), una invitación a paralelizar (un agente por fichero). El propio contrato declara la lectura de dos archivos como no atómica. Los marco **límite/de diseño**, no como defecto.
- **FN-1 (real):** `"Encárgate del login. Luego ocúpate del logout. Al final pásame el resumen."` → score 1, no marcado. Son 2–3 unidades reales, pero los verbos ("encárgate", "ocúpate", "pásame") no están en `ACTION_STEMS`, y solo hay 2 cortes de frase (`.\s+Mayúscula`), por debajo del umbral 3. **Falso negativo verificado.**
- **FN-2 (límite):** `"The frontend is broken, the API returns 500s, and the docs are stale."` → score 1. Es más un *triage* de un estado que tres unidades de trabajo; lo marco como límite.
- **Impacto de los FN:** una nota de refuerzo que no se añade. El contrato base en el system prompt ya dice "the default is to delegate", así que el prompt no pierde la política; pierde solo el empujón específico. Severidad baja.

### 3.3 Bug encontrado y corregido durante la auditoría (concurrencia)

En el primer probe (antes de las 16:43:22) `analyzeDecomposability("arregla src/a.ts y src/b.ts")` devolvía **score 2, `decomposable:false`**, señal `1 file`: dos ficheros del mismo directorio colapsaban a una única clave. Causa: el grupo de captura de `FILE_PATH_RE` era `((?:\.{0,2}\/)?[\w.@-]+\/)*`, que solo capturaba **el directorio** ("src/"), no la ruta completa; `distinctMatches` metía "src/" dos veces y el `Set` lo deduplicaba. Reproducción directa:

```
"arregla src/a.ts y src/b.ts"
   score=2 decomp=false signals=[1 file | 1 action verb | coordinated clauses]
   regex keys=["src/"]
"arregla a.ts y b.ts"
   score=4 decomp=true  signals=[2 files | 1 action verb | coordinated clauses]
   regex keys=[" a.ts"," b.ts"]
```

Esto era un falso negativo **sistemático** para rutas del mismo directorio (el caso más común). Coincidía con 2 tests ya rojos en `test-delegation.ts` (`comma-separated paths all count`, `paths inside a JSON array count`). El worker concurrente lo corrigió a las 16:43:22: el grupo de captura pasó a envolver la ruta entera y el set de separadores previos se amplió a `[\s("'\`,;:]`. Tras el fix, el probe devuelve `"arregla src/a.ts y src/b.ts"` con **2 files, score 4, true**, y la sonda `prueba-files2` muestra las claves correctas.

**Estado final de las suites:**

```
test-delegation.ts          → 48 passed, 0 failed (exit 0)
test-directive-framing.ts   → 19 passed, 0 failed (exit 0)
```

---

## 4. Hallazgos accionables (no bloqueantes)

1. **[Bajo] Header con cita no literal** en `src/delegation.ts` ("prefer delegating" entre comillas no existe textualmente en git). Ajustar la cita o quitar las comillas.
2. **[Bajo] Falso negativo de verbos no listados** (`encárgate`, `ocúpate`, `pásame`). Si interesa, añadir formas imperativas irregulares o ponderar `.\s+Mayúscula` con umbral 2 cuando el prompt tenga ≥2 frases.
3. **[Bajo] FP de diseño en "2 ficheros, una sola pregunta"** (`explica src/a.ts y src/b.ts`). Es coherente con el contrato (uno por fichero); documentarlo como intencional en vez de "corregirlo".
4. **[Info] Cobertura de test de cache**: `test-directive-framing.ts` no prueba la variación de `decomposabilityNote` entre prompts. Añadir un caso con `event.prompt` decomponible y verificar que el prefijo estable no cambia.

---

## 5. Citas exactas usadas como evidencia

- `src/tier-status.ts` header: *"the last thing the model read before answering was a wall of \"your FIRST action MUST be a trimegisto batch call\". A cautious model read that as injected instructions with no real request attached and refused to answer."*
- `src/tier-status.ts`: *"The tone is deliberately advisory, not imperative: \"prefer to delegate\" reads as guidance; \"your FIRST action MUST be\" reads as a hijack."*
- `src/tier-status.ts`: `EXTENSION_CONTEXT_NOTICE` = *"Automatic context injected by the Trimegisto extension. This is NOT the user's message and NOT a new request. The user's request is the message above; answer that. …"*
- `src/index.ts` comentario del handler: *"The contract now inverts the default — delegate unless provably atomic — and names the capacity to fill. It still avoids the hijack tone (\"your FIRST action MUST be\") that made cautious models refuse."*
- `src/index.ts`: `` const systemPrompt = `${event?.systemPrompt ?? ""}\n\n${buildSystemPolicy(event)}`; ``
- Git `6ed281e^` (hijack antiguo): *"your FIRST action MUST be a `trimegisto` batch call — do not solve it serially first."*
- Git `HEAD` (opt-in anterior): *"When a request decomposes into 2+ independent, disjoint subtasks, prefer delegating them as one `trimegisto` batch over working through them serially. When it does not decompose, just do the work yourself — no batch is expected."*
- `test-directive-framing.ts`: `check("the imperative that read as a hijack is gone", !/FIRST action MUST/i.test(...))`
- `test-delegation.ts`: `check("never contains the hijack phrasing", !/FIRST action MUST/i.test(out))`
