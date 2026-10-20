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
  **Konfigurace instance jen admin (2026-10-19):** v `provider.routes.ts` mají `requireAdmin` všechny zápisy
  modelů/skills/MCP a čtení MCP serverů (env a headers nesou tokeny) i `settings-permissions`; `GET skills`
  zůstává kvůli slash menu, ale jen pro přidělený projekt. `/api/settings/api-keys` a `/credentials` jen admin,
  externí `POST /api/agent` přijme jen klíč admina (+ `canAccessSession` na `sessionId`), `/api/commands`
  kontroluje přidělený projekt, fork chatu dědí vlastníka. Nová upstream routa, která mění instanci = `requireAdmin`.
  Chaty mají vlastníka (`sessions.owner_user_id`) — restricted uživatel vidí a otevře
  jen ty svoje, admin všechny; sessions bez vlastníka (staré, nebo založené přes CLI
  a cron) jsou jen pro admina. Vynuceno v `modules/auth/session-access.ts` a odtud
  v projects/provider routes i v chat websocketu. Restricted uživatel taky nezaloží
  chat mimo přidělený projekt a přeskakuje onboarding (git + login providera).
  **Čtení cizích vláken (2026-10-15):** `session_shares` (admin sdílí vlákno, ⋯ → Share with users…,
  `PUT /api/admin/sessions/:id/shares`) a `users.sees_all_sessions` (všechna vlákna přidělených
  projektů). Pravidlo čtení je jedna SQL klauzule `viewerScopeClause` v `sessions.db.ts` — všechny
  výpisy s `ownerUserId` ji používají. `canReadSession` = čtení (GET routy přes `router.param`,
  `chat.subscribe`, `session_upserted` per klient přes `connectionUsers`), `canAccessSession` = zápis
  (vše ostatní). Cizí vlákno nese `readOnly`, projekt jen se sdílenými vlákny `sharedOnly`
  (klient: jen Chat, bez New chat; `chat_subscribed.readOnly` pro otevření přes URL). Zápis hlídá i
  `runDetachedChatTurn` (naplánované zprávy, fronta konceptů — dřív bez kontroly), `chat.stop-task`
  a `chat.permission-response` (restricted musí poslat `sessionId` svého vlákna). Restricted tah
  ignoruje `options.cwd` z klienta. Změna sdílení/flagu/projektů → `applyChatAccessChange`
  (odpojí diváka od běžících streamů, klient dostane `chat_access_changed` a přenačte sidebar).
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
- **Stažení projektu jako ZIP** (jen admin): tlačítko na konci horní lišty s taby (za pluginy),
  po potvrzení (`window.confirm`) stáhne `GET /api/file-tree/projects/:id/archive` (`requireAdmin`).
  Od 2026-10-13 už není u názvu projektu v sidebaru. Kód: `project-workspace/utils/projectArchiveDownload.ts`.
- **`VITE_HIDE_COMMUNITY_LINKS`** build flag — skryje GitHub badge, Report issue, Discord.
- **Agenti na pozadí jsou vidět** — Claude runtime posílá klientovi `background_tasks`
  (celý seznam z `background_tasks_changed` + `tool_use_id`/činnost z `task_started`/
  `task_progress`), registr ho drží na běhu a `chat_subscribed` ho vrací pozdě
  připojeným klientům. V composeru fialový štítek „N agents in background“
  (`BackgroundTasksTab`), Agent karta je „running“ podle toho seznamu, ne podle odhadu.
  Od 2026-10-15 nese seznam i `totalTokens` a `lastActivityAt` (z `task_progress`): štítek ukazuje
  součet tokenů, řádek tokeny a „Poslední krok před…“ (po 5 min bez pokroku oranžově „Bez pokroku…“).
  Klik na agenta otevře dialog s jeho přepisem — `GET /api/providers/sessions/:id/agents/:agentId`
  čte `subagents/agent-<taskId>.jsonl` (taskId agenta = agentId), dialog ho čte znovu co 3 s.
  **Jedno UI (2026-10-19):** dokud má náš seznam položky, upstream „Background work…“ tab
  (`activityBesideBackgroundTasks`) i `BackgroundTasksStrip` nad přepisem se schovají; Stop po úkolech
  (`chat.stop-task`) je v řádcích našeho seznamu (ne pro read-only). Ostatní provideři mají upstream UI.
  **Fronta (2026-10-19):** zpráva ve frontě (`dispatchQueuedMessages`, upstream #1434 čeká na všechnu práci
  na pozadí) u Claude odejde hned po konci tahu, když živý proces vezme tah do stdin
  (`runtime.acceptsLiveTurn`: mezi tahy, ne navazující tah CLI, stdin drží) — agenti běží dál.
  Naplánovaná zpráva (`interruptActiveRun`) dál přeruší jen běžící tah v popředí; mezi tahy jde taky do stdin.
  **Esc nad chatem:** globální zkratka Esc = Zastavit (`ChatInterface`) se nespustí, když je otevřený
  modální dialog (`aria-modal`) nebo popover s `data-claims-escape` (`utils/escapeOwnership.ts`) — jinak
  Esc zavírající okno přerušil CLI a zabil všechny agenty na pozadí.
  **Držený proces není „odpovídá":** SDK proces má v `~/.claude/sessions/<pid>.json` `status: busy` po celý
  život. U vlastního procesu proto `listRunningSessions` věří `runtime.isMidTurn` (navazující tah, který CLI
  spustilo samo, od výstupu modelu do `result`), ne souboru — jinak chat „přemýšlel“ a každou novou zprávu
  odložil do fronty, dokud agent nedoběhl (2026-10-15).
  **Stop vždycky zastaví (2026-10-15):** `interrupt()` je control request přes stdin CLI. Když runtime stdin už
  pustil a CLI dál žije kvůli agentovi na pozadí (a samo spouští navazující tahy), SDK request na ukončeném stdin
  tiše zahodí a promise se nikdy nevyřeší — na julce 10× Stop za 8 min bez účinku. `abortSession` proto při
  uvolněném stdin (`isInputReleased` v záznamu session) nebo bez odpovědi do `CLOUDCLI_CLAUDE_INTERRUPT_TIMEOUT_MS`
  (5 s) proces ukončí přes `query.close()`; souběžné Stopy sdílí jeden pokus (`pendingAborts`). Uvolnění stdin,
  když CLI ještě hlásí práci na pozadí, se loguje (`stdin of … released (důvod) with background work…`).
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
  **Autonomie odpovědí a UX (2026-10-08):** pravidlo má `auto_reply_senders` (JSON vzory jako filtr odesílatelů:
  u `draft` pravidla jim odpověď odejde hned, ostatním koncept; doplňuje je tlačítko „Send, then always for this
  sender" = `POST /outbox/:id/approve { trustSender: true }`) a `hold_inbound` (zpráva čeká ve stavu `held`, agent ji
  dostane až po „Send to agent"). Pravidlo bez filtru odesílatelů nesmí mít jiný než `default` permission mode a
  `reply_mode: auto` jen na účtu s `config.autoReplyAnyone: true` („Reply automatically to anyone"); když se přepínač
  vypne, odpovědi spadnou zpět na koncepty (`agentReplyMode` v `outbox.service.ts`). Zpráva je `dispatched` už při
  předání agentovi, ne až po doběhnutí tahu (jinak Inbox nabízel „Send to agent" podruhé). Inbox: viditelný nadpis,
  počty v záložkách, štítek „Reply waits for you", koncept přímo v detailu zprávy, „Open the agent's chat" zavře celý
  Inbox; `PendingReplyCard` je jedna komponenta pro chat, detail i „To send", v chatu ve sloupci composeru.
  Časy z SQLite (`CURRENT_TIMESTAMP` = UTC bez zóny) čte `parseServerTime`.
  **Filtr prompt injection (2026-10-08):** `server/modules/channels/injection/` — každá příchozí zpráva (i odpověď do
  úkolu) projde `injectionGuard.inspect` v `channelsService.ingest` **před** úkoly a pravidly. Skener (`injection-scanner.ts`)
  normalizuje text (`text-views.ts`: bez diakritiky, homoglyfy, leetspeak, rozházená písmena, neviditelné znaky, mapa zpět
  na originál pro úryvky), hledá skrytý text v HTML (`html-hidden.ts`, htmlparser2), čte textové přílohy a dekóduje
  base64/hex/Unicode tagy; signatury CZ/SK/EN/DE v `signatures.ts` (váhy, `unless` = výjimky typu „moje předchozí faktura",
  citace v uvozovkách a popis místo rozkazu váží méně). Skóre ≥ práh (strict 0.6 výchozí / normal 1.0, `app_config`
  `channels_injection_filter` + `_sensitivity`) → `status = 'held'`, `channel_messages.injection_json`, push adminům
  (`/?inbox=<id>` otevře zprávu), MCP `channels_get_message/list_messages` vrací `[Withheld…]`, dispatcher odmítne
  automatické předání. Uvolnění: `POST /messages/:id/release` (`releaseHeld` → `routeStored`: úkol, jinak pravidlo bez jeho
  vlastního holdu) nebo „Send to agent" (manual dispatch = taky uvolnění). Pod prahem se skóre ≥ 0.3 agent dostane
  varování v promptu (`promptWarning` — jen typ a místo nálezu, nikdy úryvek: ten by agentovi donesl skrytý text; i
  v deníku úkolu). Skenuje se i jméno/adresa odesílatele, webhook vlákno a `metadata`, WA citace a názvy příloh;
  dlouhé části začátek + konec, rozpočet 1 MB na zprávu, co se nevejde = `notChecked` + nález `unscanned`.
  `scanForInjectionAsync` mezi částmi uvolní event loop (nejhorší zpráva ~0,5 s). Výjimky (`unless`) platí jen ve
  stejné větě, popis jen ve 3. osobě, uvozovky snižují váhu jen u citace („such as", „věty jako"). Agent nemůže
  `channels_reply` ani `tasks_send_message` na zadrženou zprávu. Chyba skeneru = zpráva projde (fail-open) a Inbox
  ukáže „filter failed".
  Data a měření: `scripts/prompt-injection/` (README s čísly, `dataset.py` fetch/prepare/mine, `eval.ts`).
  **Přečteno + hromadné akce v Inboxu (2026-10-15):** `channel_messages.read_at`; badge (`/summary`) počítá jen
  **nepřečtené** `unmatched`/`held`/`failed` (+ koncepty a návrhy jako dřív). Otevření zprávy ji přečte; nové selhání
  (`setStatus` → `failed`) ji vrátí mezi nepřečtené. Přečteno je jen pozornost — zadržená zpráva zůstává `held`.
  `POST /messages/mark-read {ids}|{all:true}`, `/messages/ignore {ids}` (zprávu u agenta/úkolu jen přečte),
  `/messages/delete {ids}` (+ přílohy; chaty a koncepty zůstanou). Ignore (i jednotlivý) teď posílá
  `channels_inbox_updated` — dřív ne, a badge v sidebaru se po Ignore neobnovil. UI: „⋯" (Mark all as read, Select
  messages), ⌘/Ctrl-klik, Shift-klik rozsah, lišta Mark as read / Ignore / Delete — sdílené `useMultiSelect` + `BulkActionBar`.

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
  `mandate_confirmed = 0`, dokud ho admin nepotvrdí.
  UI (od 2026-10-08): záložka ukazuje jen úkoly svého projektu (badge = jen jeho čekající); všechny
  projekty = ikona `AllTasksButton` v hlavičce sidebaru (overlay `AllTasksOverlay`, detail/editace nad
  ním přes `wrapperClassName`), čekající úkoly i jako badge před názvem projektu v sidebaru. Počty
  drží jeden sdílený store v `useAgentTasksAttention` (jeden fetch `/api/tasks/summary` pro celou
  stránku). Esc dosáhne na všechny otevřené dialogy (`Dialog` poslouchá na `document`) — spodní
  dialog se proto nezavírá, dokud je nad ním jiný.
  **Zpevnění (2026-10-08):** (1) `owner-notify.service.ts` pošle vlastníkovi (nebo adminům) web push / desktop
  notifikaci při otázce, nepotvrzeném mandátu, konceptu, návrhu úkolu a konci; klik vede na `/?task=N`
  (`data.url` v payloadu → `sw.js` → `ProjectEffects` → `TaskLinkOverlay`). (2) Vyčerpaný limit providera
  (`usage limit…|<epoch>`, text bez nástrojů nebo `error`) není chyba: kontrola v čas resetu (jinak +1 h), počet
  chyb se nemění. Neúspěšný běh vrací `seen_event_id`, takže další běh vidí novinky znovu. (3) `tasks_create`
  během běhu úkolu ve stejném projektu (cwd) = jen návrh (`waiting_owner` + systémová otázka Start / Cancel task).
  (4) E-mail adaptér zapisuje `raw.senderAuth` z nejvyšší `Authentication-Results` (jen tvrdé `fail`, softfail
  ne); `fail` neprojde filtrem odesílatelů (`*` ano) ani do úkolu (`sender-auth.ts`, `senderFailedAuth` v barrelu).
  (5) `tasks_send_message` nepošle stejný text stejnému příjemci v rámci úkolu podruhé. (6) Souhrn max 4000 znaků.
  **Přečteno + hromadné akce (2026-10-15):** `tasks.attention_read_key` = otisk toho, co úkol od vlastníka chce
  (`taskAttentionKey`: otázka podle `askedAt`+textu, nepotvrzený mandát, id konceptů). Badge (`attention()`) úkol
  přeskočí, dokud se otisk nezmění (nová otázka / koncept). Nic se tím neodpovídá, nepotvrzuje ani neposílá; karta
  ukáže důvody šedě (`attentionRead`). `POST /api/tasks/mark-read {ids}|{all:true, projectPath?}`, `POST /api/tasks/delete {ids}`.
  UI v `TaskBoard` (záložka projektu i všechny úkoly): „⋯", ⌘/Ctrl/Shift-klik, lišta Mark as read / Delete (s potvrzením).
- **Přepínače autonomie agentů** (od 2026-10-06, výchozí vypnuto, `app_config`): Settings → Channels
  „Agents set up channels without approval" (`channels_agents_auto_approve` → návrh účtu/pravidla se hned
  schválí; validace pravidel platí dál), záložka Schedules „Agents' schedules run without approval"
  (`schedules_agents_auto_approve` → `schedules_propose` rovnou `approve`, prošlé jednorázové datum zůstane
  návrhem), záložka Agent tasks „Trust mandates written by agents" (`tasks_trust_agent_mandates` → úkol od
  agenta má mandát potvrzený). Agenti stav vidí v `*_get_info` (`state.agentsAutoApprove` /
  `state.trustAgentMandates`) a v poznámce odpovědi nástroje. UI: sdílené `SettingSwitch` / `Switch` v `src/shared/ui`. Spec: `docs/superpowers/specs/2026-10-06-tasks-design.md` (hub).

- **Globální WS události** (broadcast všem klientům) pojmenovávat `<modul>_updated`. Chat handler
  (`useChatRealtimeHandlers`) ukládá do přepisu jen allowlist `TRANSCRIPT_KINDS` (text, tool_use,
  tool_result, thinking, error, task_notification) — nový druh řádku přepisu se musí přidat tam,
  jinak se nezobrazí. Store (`appendRealtime`) řádku bez `id` id doplní. Historie: 2026-10-06
  se `tasks_updated` uložil jako řádek bez `id` a každé další odeslání v tom chatu spadlo.
- **Odeslání nikdy tiše nespadne** (`useChatComposerState.handleSubmit`): zpráva jde do socketu
  dřív než echo; zavřený socket (`sendMessage` vrací `false`) nebo výjimka → text zůstane
  v composeru (u nového chatu v jeho konceptu) a nad ním je `sendError` (jen v chatu, kde vznikl).
- **Překlady (2026-10-19):** vlastní moduly mají namespace `channels`, `schedules`, `agentTasks` (en + cs),
  sdílená `BulkActionBar` bere hotovou větu `selectedLabel` (plurál z volajícího). Test
  `src/modules/i18n/tests/localeCompleteness.test.ts` hlídá, že cs má každý en klíč (čeština `_one/_few/_many/_other`)
  a naopak — **po merge upstreamu spadne, když přinese nové en texty: doplnit cs**. Nový text v UI = en + cs.
  Nepřekládat texty pro agenty (prompty, `webhookAgentGuide.ts`, MCP popisy) ani hlášky serveru.
- **Zastaralý tab po deployi** (`src/modules/stale-build`): po reconnectu socketu, návratu do tabu
  a co 10 min porovná vlastní `assets/index-*.js` s tím v aktuálním `index.html` a ukáže lištu
  Reload. Sám se nepřenačte (neuložený editor ve Files, formuláře). Bez toho běžel otevřený tab
  hodiny na starém kódu a oprava se k němu nedostala.
- **Scroll přepisu na telefonu (2026-10-17):** Safari nemá CSS scroll anchoring, takže každá změna
  výšky nad viditelnou zprávou házela přepisem. Kotvu dělá `useTranscriptScrollAnchor` →
  `utils/scrollAnchor.ts` ve všech prohlížečích (pane má `overflow-anchor: none`, starý pagination
  restore v `useChatSessionState` se při podpoře přeskočí — jinak by se stránka vyrovnala dvakrát).
  Kotva = první řádek začínající na obrazovce, ne nejstarší načtený (mění se mu hlavička) ani zástupný
  blok s odhadem (`data-estimated-height`); dole drží konec jen při změně layoutu, ne při scrollu
  (stream); kliknutý prvek drží na místě. **Nevracet** `content-visibility: auto` ani `hyphens: auto`
  na `.chat-message` (to druhé WebKit zamrazilo natrvalo) a `scrollIntoView` v přepisu nechat bez
  `smooth`. Nejstarších 30 načtených řádků se mountuje hned, ať dočtená stránka přijde změřená.
  Simulace: Playwright WebKit (iPhone 15) proti lokálnímu `npm run dev` s `HOME` na kopii dlouhého
  JSONL, scroll po 60 px a měření posunu zprávy uprostřed; `overflow-anchor: none` = chování Safari.

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

## Izolovaní agenti (od 2026-10-20)

Projekt může být **izolovaný**: každý běh Claude v něm (chat, Channels, Schedules, Agent tasks) jede
v sesterském kontejneru `cloudcli-<x>-sandbox`, ne v hlavním. Spec/plán v hubu:
`docs/superpowers/specs|plans/2026-10-20-izolovani-agenti*.md`. Kód: `server/modules/isolation/**`
(`daemon/**` = běží v sandboxu, jen Node builtins, server z něj smí importovat jen `allowlist.ts`),
`src/modules/isolation/**` (zámek, štítek, dialogy Kopírovat agenta / Izolace…).

**Architektura**
- Sandbox = stejný image, entrypoint = **daemon** (root, minimum capabilities vč. `FSETID`, jinak by kernel
  smazal setgid bit a app by neviděla soubory agenta). Hlavní app mluví s daemonem přes `daemon.sock`
  (sdílený token z deploye), sandbox zpět do appky jen přes `main.sock` (loopback forward `127.0.0.1:7701`).
  Oba sockety jsou v `isolation/` (0770).
- Claude runtime u izolovaného projektu nastaví SDK `spawnClaudeCodeProcess` → daemon spustí `claude` pod uid
  projektu; stdin/stdout/exit/kill se přeposílají. Rozhodnutí „je izolovaný“ je centrálně v runtime
  (`isIsolatedPath` — i podadresáře a cokoli pod `ISOLATED_ROOT`), ne u volajících.
- **Run tokeny** (`run-tokens.ts`): jeden na proces, jen v paměti, účel `claude|exec|pty|self-check`, nese
  projekt, sezení, případně `channel` (zpráva/vlákno/odesílatel) nebo `taskId`. Jediný credential agenta vůči appce.
  Do MCP (`cloudcli-channels`, `cloudcli-tasks`) smí jen `claude`; projekt i sezení se berou z tokenu, ne z `cwd`.
- **Claude proxy** (`/anthropic/*` na main.sock) pouští jen `^/v1/messages(/count_tokens)?$`, `^/v1/models(/id)?$`,
  `/api/hello`; ostatní 403 (logováno 1× na cestu). Token upstreamu = `app_config.isolation_claude_token`
  (`claude setup-token`), jinak access token appky (vyprší). Agent dostane jen run token jako
  `CLAUDE_CODE_OAUTH_TOKEN` a `ANTHROPIC_BASE_URL`.
- **Přihlášení Claude v UI** (Settings → **Izolace**, jen admin; `claude-login.ts`, `/api/isolation/claude-login`):
  stav sandboxu, zdroj přihlášení (✅ setup-token / ⚠️ credentials s expirací / ❌ nic), poslední ověření (v `app_config`,
  platí jen pro token se stejným otiskem) a poslední výsledek proxy (jen v paměti, `claudeUpstreamHealth`). Uložení
  vytáhne `sk-ant-oat01-…` z celého vloženého výstupu a ověří ho `POST /v1/messages/count_tokens` (zdarma); 401/403 se
  neuloží nikdy, nedostupný Anthropic jen s `force`. API vrací z tokenu jen poslední 4 znaky. Token zapsaný hubem nemá
  `isolation_claude_token_set_at` → „uložen z hubu“. Dialog Izolace… u projektu ukáže žlutý pruh, když chybí trvalé
  přihlášení nebo proxy dostala 401/403.
- **Síť**: iptables/ip6tables `--uid-owner` — uid projektu smí jen na loopback 7701/7702 a `host:port` z allowlistu;
  zbytek **REJECT** (tcp-reset / icmp-admin-prohibited, ne DROP). **Egress proxy 7702** (CONNECT + HTTP) s
  per-projektovým přihlášením povolí jen domény allowlistu, zamítnutí loguje (to vidí UI v „zablokované požadavky“).
  Žádné DNS ven, žádný loopback pro vlastní dev servery.
- **uid**: od 20000 z monotónního čítače `app_config.isolation_next_uid` (uid se nikdy nepoužije znovu),
  gid procesu = uid. Projekt a home: vlastník uid, skupina = gid appky, mód `2770`, umask `007`; rodiče
  `isolated`/`isolated-homes` jsou `0771` (agent projde ke svému, nevypíše sousedy).
- **Přepisy**: CLI píše transcripty 0600/0700 → daemon `POST /v1/projects/:id/share-transcripts` (g+r, setgid dirs,
  jen `<home>/.claude/projects`, fd-walk s `O_NOFOLLOW`) volá poller (6 s) a `exit` každého procesu.
  Synchronizér bere jen přepisy s cwd daného projektu a nepoužitým session id (anti-hijack).
- **TMPDIR** i `CLAUDE_CODE_TMPDIR` = `<home>/.tmp` (0700) per projekt, sdílené `/tmp` se nepoužívá.
- Kopírování agenta (`projects/…copy`) čte zdroj no-follow helpery; ne-izolovaná kopie izolovaného zdroje jde do
  `WORKSPACES_ROOT/<slug>`.

**Invarianty (nikdy neporušit)**
1. **Fail closed**: sandbox neběží / daemon odmítne / chybí env → běh skončí chybou, nikdy lokální spuštění.
2. Do sandboxu jen **allowlist env** (`buildSandboxEnv`, vč. malých `http_proxy`/`no_proxy`); nikdy `{...process.env}`,
   žádné tokeny z `~/.claude.json`.
3. Hlavní app **nikdy nespouští ani nesleduje soubory izolovaného projektu** (agent může podstrčit symlink, FIFO,
   `.git/hooks`, obří soubor): čtení/zápis jen přes `isolated-fs.ts` (no-follow fd, limity), git přes daemon
   (`isolated-git.ts`; push/pull/fetch/publish jsou 409). Nový main-side kód nad cestou v izolaci = projít tímto.
4. MCP scope **vždy z run tokenu**; `cwd`/`project_path` z těla agenta se ignoruje. Dispatcher Channels navazuje vlákno jen
   v sezení se stejným `project_path` jako pravidlo.
5. Bypass bez filtru odesílatelů smí jen izolovaný projekt (server i `ruleValidation.ts`); mandát úkolu od izolovaného
   agenta potvrzuje vždy Lars; `tasks_send_message` jen přes účty vlastního projektu.
6. Claude proxy: žádné další cesty; „Povolit“ nikdy pro `anthropic.com`/`claude.ai`/`claude.com` (`isClaudeServiceHost`).

**Testy**
- macOS (dev mode, daemon bez root a bez iptables, injektovaný `statOwner`): `TSX_TSCONFIG_PATH=server/tsconfig.json npm test`,
  `NODE_OPTIONS=--no-experimental-webstorage npm run test:client`, `npm run typecheck`. Node 26 občas shodí
  `agent.routes.test` ('Unable to deserialize cloned data') — běží samostatně.
- Linux root (kernelové věci: `/proc/self/fd`, setuid/setgid, `iptables-restore --test`, share-transcripts) v Dockeru:
  `git archive HEAD | docker run -i --init --cap-add NET_ADMIN -e TMPDIR=/var/tmp node:22-bookworm bash -c 'mkdir /src && tar -x -C /src && cd /src && apt-get update -qq && apt-get install -y -qq iptables >/dev/null && npm ci && TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/isolation/tests/*.test.ts server/modules/projects/tests/isolated-workspace-path.test.ts'`
  (poslední stav 166/166). `--init` je nutné (zombie po killu), `TMPDIR` mimo `/tmp` (to je v izolaci zakázané).
  Testy Dockeru nesmí zapisovat do `/tmp` — workspace test staví strom v `.test-tmp/`.

**Omezení v1** (zdokumentované, vědomé)
- Přímá spojení mimo proxy (IMAP/SMTP mimo allowlist, nástroj ignorující proxy, DNS) jsou rejectnutá, ale **v UI se
  nezobrazí** (žádný NFLOG reader); v seznamu jsou jen zamítnutí egress proxy.
- Izolované projekty vidí v `ps` navzájem své procesy (bez `hidepid`); sdílí pidy, paměť (1,5 GB / 512 pidů kontejneru)
  i disk — **žádné kvóty na projekt**.
- Terminál `claude` v izolovaném projektu jede bez MCP (bez channels/tasks). Isolated Agent-task běh nečte
  přes `channels_get_message` zprávy-odpovědi úkolu (jen zkrácený text).
- Jen Claude; Codex/Cursor/OpenCode/Gemini server pro izolovaný projekt odmítne. Browser MCP tam není.
- Proxy nefiltruje privátní IP pro povolená jména (povolené jméno mířící do privátní sítě projde).
- Odložené drobnosti: `/v1/models/%2F` (proxy nedekóduje, upstream pravděpodobně taky ne); synchronní walk share-transcripts
  každých 6 s na home (latence při mnoha projektech); prune v `syncAll` může vzácně srazit souběžné kopírování (retry);
  force-delete izolovaného projektu smaže jsonl podle cesty v home zapisovatelném agentem; thread-memory porovnává cestu
  textově (symlinkované cesty pravidel = nové vlákno); `ps`/`.tmp` se zakládá jen při provisioningu.

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
