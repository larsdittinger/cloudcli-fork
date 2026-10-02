import type { ChannelAccount, ChannelRule } from '@/modules/channels';

/** A handoff for the agent building the calling application; account credentials stay separate. */
export function buildWebhookAgentGuide({ account, webhookUrl, rules, channelsEnabled }: {
  account: ChannelAccount;
  webhookUrl: string;
  rules: ChannelRule[];
  channelsEnabled: boolean;
}): string {
  const applicableRules = rules
    .filter((rule) => (!rule.accountId || rule.accountId === account.id) && (!rule.channel || rule.channel === 'webhook'))
    .sort((a, b) => a.position - b.position)
    .map((rule) => ({
      id: rule.id, name: rule.name, enabled: rule.enabled, position: rule.position,
      conditions: rule.conditions, projectPath: rule.projectPath, provider: rule.provider,
      model: rule.model, effort: rule.effort, permissionMode: rule.permissionMode,
      conversation: rule.conversation, replyMode: rule.replyMode, promptTemplate: rule.promptTemplate,
    }));
  const callbackUrl = typeof account.config.replyUrl === 'string' ? account.config.replyUrl.trim() : '';
  const handoffs = account.config.allowEscalation === true;
  const json = (value: unknown) => JSON.stringify(value, null, 2);

  return `# Napojení aplikace na agenta CloudCLI

Připrav klienta pro tento webhook. CloudCLI přijme událost, podle pravidla spustí agenta v projektu a rozhodnutí vrátí aplikaci. Každý běh je vidět jako běžný chat v CloudCLI.

## Konkrétní webhook — aktuální nastavení

- Účet: ${json(account.label)}
- ID účtu: \`${account.id}\`
- URL: \`${webhookUrl}\`
- Channels: **${channelsEnabled ? 'zapnuté' : 'vypnuté — nejdřív zapnout v Settings → Channels'}**
- Účet: **${account.enabled ? 'zapnutý' : 'pozastavený — nejdřív obnovit'}**
- Předání člověku: **${handoffs ? 'povolené (action=escalate)' : 'vypnuté'}**
- Volné odesílání agentem přes účet: \`${account.agentSend}\` (odpovědi na příchozí události řídí pravidlo).
- Doručení: ${callbackUrl ? `**callback** na ${json(callbackUrl)}` : '**polling** — aplikace si výsledek vyzvedne'}.

Token získá provozovatel při založení účtu; v aplikaci ho ulož do \`CLOUDCLI_WEBHOOK_TOKEN\`. URL ulož do \`CLOUDCLI_WEBHOOK_URL\`. Token neposílej v URL, do logů ani do repozitáře. Tento návod používá proměnnou prostředí místo hodnoty tokenu.

## 1. Předání události

Pošli \`POST ${webhookUrl}\` s hlavičkami:

\`Authorization: Bearer <hodnota CLOUDCLI_WEBHOOK_TOKEN>\`
\`Content-Type: application/json\`

Příklad těla (identifikátory nahraď skutečnými hodnotami své integrace):

\`\`\`json
${json({
  id: 'facebook:page-123:mid.456',
  thread: 'facebook:page-123:dm:sender-789',
  from: 'meta-monitor',
  subject: 'Facebook Page message',
  text: 'Zákazník: Jan (789)\nZpráva: Kdy dorazí moje objednávka?',
  metadata: { platform: 'facebook', kind: 'message', pageId: '123', senderId: '789' },
})}
\`\`\`

- \`from\` a \`text\` jsou povinné. \`from\` musí odpovídat podmínkám pravidla níže; \`meta-monitor\` je jen příklad identity důvěryhodného hlídače.
- Vždy posílej stabilní \`id\` původní události. Opakovaný POST se stejným ID v tomto účtu vrátí stejné \`messageId\` a nespustí druhého agenta.
- \`thread\` identifikuje jednu konverzaci. Odděl firmy, platformy, stránky a zákazníky. U komentářů používej vlákno kořenového komentáře, nikoli společné vlákno celého videa.
- \`metadata\` je libovolný JSON objekt do 16 KiB: například platforma, typ události, ID stránky, zákazníka, příspěvku a komentáře. CloudCLI ho uloží, předá agentovi jako data a vrátí aplikaci beze změn. URL odpovědí, projekt a oprávnění určuje nastavení CloudCLI.
- Pro IG zprávu použij například \`instagram:account-123:dm:sender-789\` a metadata \`{ "platform": "instagram", "kind": "message", "accountId": "123", "senderId": "789" }\`.
- Pro FB/IG komentář použij například \`facebook:page-123:comment:root-456\` nebo \`instagram:account-123:comment:root-456\`, \`kind: "comment"\` a \`commentId\` (+ \`postId\` / \`mediaId\`). Další komentář nebo zpráva má vlastní ID události.
- Volitelně \`name\`, \`subject\`, \`attachments: [{ name, mime, contentBase64 }]\`; limit příloh je 25 MB. Neposílej přístupové údaje v textu ani metadatech.

Úspěch je HTTP **202**, například:

\`\`\`json
{ "success": true, "data": { "messageId": "uuid", "status": "dispatched", "sessionId": "uuid" } }
\`\`\`

\`dispatched\` znamená zahájený tah, nikoli hotovou odpověď. \`queued\` čeká ve frontě, \`unmatched\` nemá odpovídající pravidlo, \`ignored\` bylo přeskočeno a \`failed\` vyžaduje kontrolu Inboxu/chatu. Při nejistém výsledku POST opakuj stejné ID; nevytvářej nové.

## 2. Rozhodnutí agenta a doručení

Agent uvnitř CloudCLI musí použít MCP nástroj \`channels_reply({ message_id, text, action })\`. Samotný text napsaný do chatu nevytvoří výsledek pro aplikaci.

- \`action: "reply"\`: text určený zákazníkovi; aplikace jej odešle přes svou integraci.
- \`action: "escalate"\`: interní shrnutí a důvod předání člověku. Aplikace upozorní provozovatele, například e-mailem na pevně nakonfigurovanou adresu. **Tento text nikdy neodesílej zákazníkovi.** ${handoffs ? 'Účet tuto akci povoluje.' : 'Tento účet ji zatím nepovoluje; nejdřív ji musí provozovatel zapnout.'}
- Obě akce respektují pravidlo: \`none\` je blokuje, \`draft\` čeká na schválení v CloudCLI, \`auto\` výsledek odešle nebo zveřejní hned.

${callbackUrl ? `### Callback — nakonfigurovaný způsob doručení

CloudCLI pošle JSON na ${json(callbackUrl)}:

\`\`\`json
{ "id": "outbox-id", "action": "reply", "to": "meta-monitor", "text": "Odpověď", "subject": null, "inReplyTo": { "id": "message-id", "externalId": "facebook:page-123:mid.456", "thread": "facebook:page-123:dm:sender-789", "metadata": { "platform": "facebook", "kind": "message", "pageId": "123", "senderId": "789" } } }
\`\`\`

Ověř případný callback Bearer token nastavený provozovatelem (oddělený od vstupního webhook tokenu), událost bezpečně ulož a do 15 sekund vrať 2xx. Redirecty nejsou podporované. Chybu CloudCLI uloží do Outboxu; při ručním retry zůstává stejné \`id\`. Skutečného adresáta zjisti z \`inReplyTo.metadata\` / \`thread\`, protože \`to\` může být identita hlídače. Polling používej pro diagnostiku; neprováděj stejné rozhodnutí zároveň oběma cestami.

` : ''}### Polling${callbackUrl ? ' — také dostupný pro diagnostiku' : ' — nakonfigurovaný způsob doručení'}

Po přijetí události volej \`GET ${webhookUrl}/messages/<messageId>\` se stejnou Bearer hlavičkou. Odpověď \`data\` obsahuje \`messageId\`, \`externalId\`, \`thread\`, \`metadata\`, \`status\`, \`statusDetail\`, \`sessionId\`, \`processing\` a \`results\`:

\`\`\`json
{ "results": [{ "id": "outbox-id", "action": "reply", "text": "Odpověď", "to": "meta-monitor", "status": "sent", "statusDetail": null, "createdAt": "2026-10-02 08:00:00" }] }
\`\`\`

Zpracuj jen \`results\` se stavem **sent**. \`draft\` čeká na člověka, \`approved\` / \`sending\` ještě nejsou hotové, \`failed\` vyžaduje kontrolu a \`discarded\` bylo zahozeno. Bez callbacku znamená \`sent\` zveřejnění pro klienta; doručení do FB/IG nebo e-mailu provádí tvoje aplikace. Prázdné výsledky nejsou odpověď. Polluj s prodlevou (například 2 s) a s omezeným čekáním; timeout řeš pokračováním nad stejným \`messageId\` nebo kontrolou Inboxu.

Opakovanému externímu odeslání zabraň trvalou evidencí podle **outbox \`id\`**. Stejný výsledek se může objevit při dalším pollingu nebo retry callbacku. Idempotentní příjem v CloudCLI neznamená zaručené právě jedno odeslání přes Meta/SMTP; nejasný výsledek externího odeslání řeš kontrolou místo slepého opakování. Příchozí zprávy se uchovávají 90 dní.

## 3. Pravidla, se kterými můžeš počítat

Toto je snímek aktuálních použitelných pravidel v pořadí. První **zapnuté a odpovídající** pravidlo vyhrává; globální pravidlo může mít přednost před pravidlem tohoto účtu. Pravidla mohou být později změněna.

\`\`\`json
${json(applicableRules)}
\`\`\`

${applicableRules.some((rule) => rule.enabled) ? '' : '**Momentálně tu není žádné zapnuté použitelné pravidlo. Nejdřív ho nastav v Settings → Channels; jinak se agent nespustí.**\n\n'}Pro automatické odpovědi nebo bypass oprávnění vyžaduje CloudCLI filtr odesílatelů. U hlídače je to identita důvěryhodné aplikace; text zákazníka zůstává nedůvěryhodný obsah. Pro veřejné komentáře nesděluj osobní údaje zákazníků; podmínky automatických odpovědí určuje provozovatel v projektu a promptu pravidla.

Použitý vlastní prompt má obsahovat \`{{text}}\`, \`{{metadata}}\` a \`{{replyInstructions}}\` (výchozí prompt je obsahuje). Projekt, provider/model, oprávnění, pokračování konverzace a schvalování vybírá pravidlo, nikoli příchozí událost. Dodaný MCP postup používá Claude; u jiného providera nejdřív ověř dostupnost Channels nástrojů.

HTTP 400 = vadný payload; 401 = chybný token; 404 = neexistující účet/zpráva nebo zpráva jiného účtu; 503 = vypnuté Channels/účet nebo neběžící adaptér. Token umožňuje příjem událostí a přístup k výsledkům tohoto webhook účtu; přístup k transcriptům chatů tím nezískáš.

V repozitáři \`larsdittinger/cloudcli-fork\` je klient \`examples/channel_webhook.py\`: předá JSON, počká na schválené rozhodnutí a vrátí je včetně metadata. Volba \`--email-handoff\` odešle eskalaci přes SMTP na pevně nastavenou adresu. Meta ověření událostí, přístupové tokeny a konkrétní API pro odesílání obsluhuje tvoje integrace.
`;
}
