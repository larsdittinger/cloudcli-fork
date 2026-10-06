# cloudcli-fork — zdrojáky aplikace

Fork [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) →
[larsdittinger/cloudcli-fork](https://github.com/larsdittinger/cloudcli-fork).
Pracovní větev: **`main`**. Repo je **veřejný**.

Leží uvnitř hubu `~/dev/cloudcli/` jako `fork/`, ale je to **samostatný git repo**
(hub ho má v `.gitignore`). Provozní kontext — kde která instance běží, jak se
nasazuje — je v `../CLAUDE.md`.

## Co je ve větvi `main` navíc proti upstreamu

- **Multi-user**: role `admin` / `restricted`, tabulka `user_project_access`, admin UI
  v Settings → Users. Server-side guardy (`requireAdmin`, blok `/shell` websocketu).
  Chaty mají vlastníka (`sessions.owner_user_id`) — restricted uživatel vidí a otevře
  jen ty svoje, admin všechny; sessions bez vlastníka (staré, nebo založené přes CLI
  a cron) jsou jen pro admina. Vynuceno v `modules/auth/session-access.ts` a odtud
  v projects/provider routes i v chat websocketu. Restricted uživatel taky nezaloží
  chat mimo přidělený projekt a přeskakuje onboarding (git + login providera).
- **Interaktivní Browser tab** — admin ovládá živou agentní session klikáním a psaním
  (`POST /api/browser-use/sessions/:id/input`). Restricted uživatel má tab taky, ale vidí
  a ovládá jen sessions, které agent založil v jeho přidělených projektech: MCP klient
  posílá svůj cwd (`X-Browser-Use-Cwd`), session si ho drží jako `projectPath`
  a routy to kontrolují přes `canAccessProjectPath`. Nastavení a instalace runtime jen admin.
- **Mobilní emulace + DevTools pro agenty** (`browser-emulation.ts`, `browser-devtools.ts`):
  `browser_emulate_device` (presety iphone-15, pixel-7, ipad-mini… nebo vlastní
  width/height), `browser_console_messages`, `browser_network_requests`,
  `browser_evaluate`, `browser_get_html`. Emulace sedí i pro server-side detekci
  (`Sec-CH-UA`), kliky jdou jako tap, screenshot chodí z MCP jako obrázek.
- **`VITE_HIDE_COMMUNITY_LINKS`** build flag — skryje GitHub badge, Report issue, Discord.
- **Agenti na pozadí jsou vidět** — Claude runtime posílá klientovi `background_tasks`
  (celý seznam z `background_tasks_changed` + `tool_use_id`/činnost z `task_started`/
  `task_progress`), registr ho drží na běhu a `chat_subscribed` ho vrací pozdě
  připojeným klientům. V composeru fialový štítek „N agents in background“
  (`BackgroundTasksTab`), Agent karta je „running“ podle toho seznamu, ne podle odhadu.
- **Channels** (`server/modules/channels`, `src/modules/channels`, Settings tab
  `tabs/channels-settings`): příchozí e-mail (imapflow) / WhatsApp (baileys) / webhook
  → pravidla → chat přes `createAppSession` + `runDetachedChatTurn`; odpovědi přes
  MCP `cloudcli-channels` (`channels-mcp.ts`, endpoint `/api/channels-mcp`). Tabulky
  `channel_*`, WS frames `channels_inbox_updated` / `channels_outbox_updated`.
  Webhooky mají polling výsledků `GET /api/channels/webhook/:accountId/messages/:messageId`,
  idempotentní příjem podle `id`, callback Bearer token (`secrets.replyToken`) a rozhodnutí
  `channels_reply.action = reply | escalate`. Předání člověku jen s explicitním
  `config.allowEscalation: true`; callback musí rozlišit interní předání od odpovědi.
  Payload může nést `metadata` (JSON objekt do 16 KiB), vrací se v pollingu i callbacku.
  Návod v README, klient `examples/channel_webhook.py` (volitelně SMTP upozornění).
  Karta webhooku má **Copy agent guide (.md)** + náhled: aktuální URL, pravidla,
  payloady a zpracování odpovědí/předání pro agenta, který píše volající aplikaci.
  Token zůstává zvlášť v prostředí aplikace. Generátor je v
  `src/modules/settings/utils/webhookAgentGuide.ts`.
  Dialogy otevírané ze Settings potřebují `wrapperClassName="z-[10000]"` (Settings modal je
  `z-[9999]`). Spec v hubu: `docs/superpowers/specs/2026-09-14-channels-design.md`.
  **Agent si nastaví Channels sám (2026-10-06):** MCP `channels_get_info` (návod v
  `agent-info.ts` + živý stav), `channels_propose_account` / `channels_propose_rule` →
  řádek se sloupcem `proposal` (JSON), vždy `enabled = 0`, schválí admin
  (`POST /api/channels/{accounts,rules}/:id/approve`, karta s „Proposed by an agent").
  Agent nikdy nemění schválenou konfiguraci, `channels_withdraw_proposal` maže jen návrhy.
  Logika v `proposals.service.ts`; MCP proces posílá svůj `cwd` = výchozí projekt.
  **Odkazy s promptem:** `channels_build_link` → `/session/<id>?prompt=…` nebo
  `/?project=<cesta>&prompt=…`; klient (`project-workspace/hooks/usePromptLink.ts`) text
  jen zapíše do draftu composeru, nic neodešle. Veřejná URL: `CLOUDCLI_PUBLIC_URL`, jinak
  `app_config.channels_public_url` z posledního admin requestu na `/api/channels`.
  Spec: `docs/superpowers/specs/2026-10-06-channels-agent-setup-design.md`.

- **Schedules** (`server/modules/schedules`, `src/modules/schedules`, záložka `schedules`
  jen pro admina; od 2026-10-06, nahrazuje plugin `workspace-scheduled-prompts`): úlohy
  `prompt` (běh = chat v sidebaru přes `createAppSession` + `runDetachedChatTurn`, bez limitu)
  a `script` (`bash -lc` v projektu, timeout, log v `~/.cloudcli/schedules/logs`, volitelně
  `handoff: on_output` → AI chat se stdout). Rozvrh = JSON `ScheduleSpec` (`schedule-spec.ts`,
  `croner`, Europe/Prague), tabulky `schedules` + `schedule_runs`, ticker 20 s, zmeškané
  > 5 min = `missed`, překryv = `skipped`, restart = `failed`. Chyby providera chodí jako
  chat event `error`, ne výjimka — `prompt-runner` je čte z `chatRunRegistry`. MCP
  `cloudcli-schedules` (registruje se při startu) → návrhy `proposal` jako u Channels.
  Při prvním startu import úloh z `~/.cloudcli-workspace-scheduled-prompts` a plugin se
  vypne (`disablePlugin`). Opakované shodné `skipped` běhy se slučují do jednoho řádku
  (`repeat_count`, v UI ×N); úprava bez změny rozvrhu drží `next_run_at`; jednorázová úloha
  přeskočená souběhem se zkusí za minutu; smazání úlohy zastaví běžící skript (i potomky).
  Spec: `docs/superpowers/specs/2026-10-06-schedules-design.md` (hub).
- **Tasks — dlouhé úkoly agentů** (`server/modules/tasks`, `src/modules/agent-tasks`, záložka
  `agent-tasks` „Agent tasks" jen pro admina; od 2026-10-06; pozor, `tasks` je TaskMaster z upstreamu):
  karta úkolu (`tasks` + deník `task_events`) je jediná paměť agenta. Každé probuzení = nový chat
  v projektu úkolu (`createAppSession` + `runDetachedChatTurn`), první zpráva je snímek karty
  (`task-prompt.ts`). Probouzí založení, komentář/odpověď/„Wake now" od Larse, `next_check_at`
  a příchozí zpráva k úkolu; co přijde během běhu, čeká v `pending_wake`. Engine (`engine.service.ts`):
  jeden běh na úkol, limit `CLOUDCLI_TASKS_MAX_RUNS` (výchozí 2), běh bez plánu → kontrola za 4 h
  (`waiting_external` za 2 dny), chyba → za 30 min, 3× → systémová otázka, > 20 probuzení / 24 h →
  otázka, restart → wake `restart`. Channels napojení přes hooky (`channels/task-hooks.ts`):
  `tasks_send_message` → `outboxService.createTaskMessage` (`channel_outbox.task_id`, značka `[T-N]`
  v předmětu, nepotvrzený mandát = vždy koncept), po odeslání se vlákno zapíše do `task_threads`;
  příchozí zpráva ve vlákně, nebo se značkou otevřeného úkolu **od adresy/firemní domény, které úkol
  psal** (jinak by stačilo uhodnout číslo), dostane `status = 'task'` a jde mimo pravidla; text zvenku je
  v promptu citovaný (`> `). Automatické odpovědi (`Auto-Submitted`) jen do deníku. MCP mutace jen pro
  úkoly projektu volajícího (cwd), `tasks_send_message` jen během běhu úkolu; `channels_send_message`
  v projektu s běžícím úkolem → 409. Běhy jen `bypassPermissions`, bez AskUserQuestion/plan mode,
  watchdog `CLOUDCLI_TASKS_RUN_TIMEOUT_MIN` (výchozí 180). MCP `cloudcli-tasks` (`tasks-mcp.ts`, bridge `/api/tasks-mcp`). Úkol od agenta má
  `mandate_confirmed = 0`, dokud ho admin nepotvrdí. Spec: `docs/superpowers/specs/2026-10-06-tasks-design.md` (hub).

Držet **minimal-diff** proti upstreamu — čím menší rozdíl, tím snazší merge. Nové
featury zvažovat nejdřív jako plugin (viz cron plugin `workspace-scheduled-prompts`,
žije na persistentním volume, ne ve forku).

## Merge upstreamu

```bash
git fetch upstream
git checkout main && git merge upstream/main
npm ci && npm run typecheck && TSX_TSCONFIG_PATH=server/tsconfig.json npm test
git push origin main
cd .. && ./cloudcli ethia update       # a další dotčené instance
```

Buildy na serverech si berou **aktuální commit `main` z GitHubu** — lokální změny se
do nasazení dostanou až po `git push origin main`.

## Historie pojmenování

Do 2026-08-27 se repo jmenoval `larsdittinger/cloudcli-ethia` a pracovní větev `ethia`.
Přejmenováno na obecné, protože z něj běží víc instancí než jen ethia. GitHub drží
redirect ze starého URL, ale **větev `ethia` už neexistuje**.


## Pravidla vývoje z upstreamu

# Repository guidance

## Backend code

For every task that creates, modifies, refactors, or reviews backend code under `server/`, load and follow `$backend-module-standards` from `.agents/skills/backend-module-standards/SKILL.md`. Apply it only to backend code; do not impose those architecture rules on the frontend.

## Frontend code

For every task that creates, modifies, refactors, or reviews frontend code under `src/`, load and follow `$frontend-module-standards` from `.agents/skills/frontend-module-standards/SKILL.md`. Apply it only to frontend code; do not impose those architecture rules on the backend.

## Jediný zdroj instrukcí

`AGENTS.md` je relativní symlink na `CLAUDE.md`. Tento soubor i symlink jsou
commitnuté; instrukce pro Claude a Codex se tím nikdy nerozcházejí. Změny instrukcí
píšeme sem. Provozní hodnoty a přístupy zůstávají v privátním hubu, ne v tomto repu.
