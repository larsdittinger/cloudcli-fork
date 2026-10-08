/**
 * Prompt-injection signatures for inbound Channels messages (e-mail, WhatsApp, webhook).
 *
 * Written from phrases mined out of ~128k public attack e-mails and prompts
 * (Microsoft LLMail-Inject phase 1, deepset, jackhhao) against ~33k real
 * e-mails (Enron ham + spam) — `scripts/prompt-injection/dataset.py mine` —
 * then generalised by hand and carried over to Czech, Slovak and German.
 * Measured on held-out sets by `scripts/prompt-injection/eval.ts`.
 *
 * Patterns run on the folded text (`text-views.ts`): lower case, no diacritics
 * ("předchozí" → "predchozi"), Cyrillic/Greek look-alikes mapped to Latin,
 * single spaces, `\n` kept. A `squash` literal runs on letters only, so
 * "i g n o r e  a l l" and "ign.ore" still match.
 *
 * Weights: 1.0 = enough on its own; 0.5–0.8 = needs a second signal from
 * another category; ≤ 0.4 = context only. A message is held when the summed
 * score (best finding per category) reaches the threshold — 1.0 normally,
 * 0.6 in strict mode. Legitimate mail does say "ignore my previous e-mail" or
 * "new delivery instructions"; `unless` drops a match whose surroundings show
 * that (the sender's own earlier instructions, delivery, an invoice).
 */

export type InjectionCategory =
  | 'override' // ignore / forget the previous instructions
  | 'new_task' // "your real task is…", "from now on…"
  | 'role' // persona switch, jailbreak modes
  | 'address_ai' // the text talks to the AI reading it
  | 'fake_format' // chat-template tokens, fake system/user turns, fake end-of-e-mail
  | 'authority' // fake system / admin / developer messages
  | 'exfiltration' // reveal the prompt, send secrets, forward everything
  | 'tool_abuse' // tool names, function-call syntax, shell commands, "send an e-mail to X with body Y"
  | 'concealment' // don't tell the user, silently
  | 'persistence' // remember this for all future messages
  | 'obfuscation' // encoded payloads, invisible characters, look-alike letters
  | 'hidden' // text hidden in HTML
  | 'unscanned'; // content the scanner had to skip (oversize, too many encoded blocks)

export type SignatureDefinition = {
  id: string;
  category: InjectionCategory;
  weight: number;
  /** Shown to the owner: what the signature means. */
  label: string;
  /** Regular expression source over the folded text (compiled with `gimu`). */
  pattern?: string;
  /** Letters-only literal(s) matched on the squashed text. */
  squash?: string[];
  /** A match is dropped when this matches the text around it (80 chars before, 120 after). */
  unless?: string;
};

// --- building blocks -------------------------------------------------------------------------

/** Up to `n` characters inside one sentence (a dot is allowed when not followed by a space: e-mail addresses, "e.g"). */
const gap = (n: number) => `(?:(?![.!?](?:\\s|$))[^\\n]){0,${n}}?`;
const any = (...parts: string[]) => `(?:${parts.join('|')})`;

// English
const EN_IGNORE = any(
  'ignore', 'ignoring', 'disregard(?:ing)?', 'forget(?:ting)?', 'bypass(?:ing)?', 'override', 'overriding', 'overrule',
  'discard', 'abandon', 'neglect', 'set aside', 'put aside', 'throw (?:away|out)', 'nullify', 'scrap',
  'stop following', "(?:do not|don't|dont|no longer|never) (?:follow|obey|adhere to|comply with|listen to)",
  'stop (?:obeying|adhering to|complying with|listening to)', 'cease (?:following|obeying)',
);
const EN_NOUN = any(
  'instructions?', 'instruction set', 'prompts?', 'directives?', 'guidelines?', 'guidance', 'rules?', 'commands?',
  'programming', 'guardrails?', 'constraints?', 'restrictions?', 'safeguards?', '(?:content |safety |security )?filters?', 'moderation',
);
/** Broader nouns, used only after "all previous / all prior / all preceding": "forget all previous tasks". */
const EN_NOUN_WIDE = any(EN_NOUN, 'context', 'tasks?', 'assignments?', 'information', 'orders?', 'commands?', 'directions?', 'inputs?', 'text', 'content', 'conversation', 'data');
/** Qualifiers that point at the agent's own setup, not at the sender's earlier e-mail. */
const EN_THEIR = any(
  'all', 'any', 'every', 'your', "you(?:'ve| have) been given", 'the system', "system(?:'s)?", "developer(?:'s)?", 'safety', 'security',
  // Not "default" / "existing": "override the default shipping rules" is a commit message, not an attack.
  'original', 'initial', 'built-?in', 'hidden', 'programmed', 'pre-?set', 'core', 'internal',
);
const EN_PRIOR = any('previous', 'prior', 'above', 'earlier', 'preceding', 'former', 'foregoing', 'old', 'past', 'given', 'other');

// Czech + Slovak (folded: no diacritics)
const CS_IGNORE = any(
"ignoruj(?:te|me)?", 'ignorovat', 'ignoroval[aiy]?', 'zapomnel[aiy]?', 'zabudol', 'zabudla', 'zabudli', 'nevsimej(?:te)? si', 'nevsimaj(?:te)? si', 'nedbej(?:te)?', 'nedbaj(?:te)?',
  'prehlizej(?:te)?', 'prehlednete', 'prehledni', 'prehliadni(?:te)?', 'prehliadaj(?:te)?',
  'zapomen(?:te|me)?', 'zapomenout', 'zapomente', 'zabudni(?:te)?', 'zabudnut', 'zahod(?:te)?', 'zahodit', 'odhod(?:te)?',
  'neber(?:te)? (?:v potaz|ohled|zretel)', 'nerespektuj(?:te)?', 'nedodrzuj(?:te)?', 'nedodrziavaj(?:te)?',
  'neposlouchej(?:te)?', 'nepocuvaj(?:te)?', 'nerid(?:te)? se', 'neriad(?:te)? sa', 'obejdi(?:te)?', 'obejit', 'obid(?:te)?',
  'prestan(?:te)? (?:respektovat|dodrzovat|dodrziavat|poslouchat|pocuvat|nasledovat|se ridit|sa riadit)',
  'potlac(?:te)?', 'prepis(?:te)?', 'anuluj(?:te)?', 'zrus(?:te)?', 'zrusit', 'smaz(?:te|at)?', 'vymaz(?:te|at)?', 'zmaz(?:te|at)?',
  'ignorovat', 'zahodit', 'odstran(?:te|it)?', 'zapomenout', 'zabudnut', 'vypni(?:te)?', 'deaktivuj(?:te)?', 'obejdi(?:te)?', 'odloz(?:te)?', 'odlozit',
  'zignoruj(?:cie)?', 'pomin(?:cie)?', 'zapomnij', // Polish, close enough to share the lists
);
const CS_NOUN = any(
  'instrukc[a-z]*', 'instrukci[a-z]*', 'pokyn[a-z]*', 'prikaz[a-z]*', 'pravid[a-z]*', 'zadani', 'zadania',
  'omezeni', 'obmedzeni[a-z]*', 'smernic[a-z]*', 'direktiv[a-z]*', 'prompt[a-z]*', 'naprogramovani', 'mantinel[a-z]*',
  'nastaveni', 'nastavenia', 'navod[a-z]*', 'restrikc[a-z]*', 'filtr[a-z]*', 'instrukcj[a-z]*', 'ograniczeni[a-z]*', 'regul[a-z]*', 'zasad[a-z]*', 'polecen[a-z]*', 'wytyczn[a-z]*', 'zakaz[a-z]*', 'limit[a-z]*', 'protokol[a-z]*', 'ukol[a-z]*', 'uloh[a-z]*',
);
const CS_THEIR = any(
  'vsechn[a-z]*', 'vsech', 'veskere', 'vsetk[a-z]*', 'jakekoli[v]?', 'akekolvek', 'tv[eo][a-z]*', 'svoj[a-z]*', 'sve',
  'vas[ei]?', 'systemov[a-z]*', 'puvodni', 'povodn[a-z]*', 'vychozi', 'predvolen[a-z]*', 'skryt[a-z]*', 'interni', 'intern[a-z]*',
  'vyvojar[a-z]*', 'bezpecnostn[a-z]*', 'dosavadni', 'doterajs[a-z]*',
);
const CS_PRIOR = any('predchoz[a-z]*', 'predesl[a-z]*', 'drivejs[a-z]*', 'predchadzajuc[a-z]*', 'predosl[a-z]*', 'vyse uveden[a-z]*', 'vyssie uveden[a-z]*', 'minul[a-z]*', 'stavajic[a-z]*', 'wczesniejsz[a-z]*', 'poprzedni[a-z]*');

// German
const DE_IGNORE = any('ignorier(?:e|en|t)?', 'vergiss', 'vergessen sie', 'missachte(?:n)?', 'uberschreibe', 'verwirf', 'umgehe', 'befolge (?:keine|nicht)', 'nicht (?:mehr )?befolgen');
const DE_NOUN = any('anweisung(?:en)?', 'instruktion(?:en)?', 'befehle', 'regeln', 'vorgaben', 'richtlinien', 'prompts?', 'systemprompt', 'eingabeaufforderung(?:en)?', 'einschrankungen');
const DE_THEIR = any('alle[ns]?', 'jegliche', 'deine', 'ihre', 'ursprunglichen?', 'system', 'internen?', 'vorherigen?', 'vorigen?', 'bisherigen?', 'obigen?', 'fruheren?');

/** The sender talks about their own earlier message or about delivery/payment logistics. */
const SENDER_OWN = any(
  "\\b(?:i|we)(?:'ve| have| had)? (?:sent|gave|wrote|provided|shared|mentioned|emailed|e-mailed|forwarded|told|attached|left|said|asked|requested)\\b",
  '\\b(?:in|from|of) (?:my|our) (?:last|previous|earlier|prior|first|other)\\b',
  '\\b(?:my|our) (?:previous|prior|earlier|last|original)\\b',
  '\\b(?:for|about|regarding|re|concerning|on|to|with) (?:the |my |our |your )?(?:deliver|shipping|shipment|order|invoice|payment|parcel|package|meeting|address|pick ?up|return|install|assembl|dosage|parking|booking|reservation|wash|care|form|refund|the product)',
  '\\b(?:jsem|jsme) (?:vam |ti )?(?:poslal|poslala|poslali|posilal|posilala|posilali|psal|psala|psali|zaslal|zaslala|zaslali|uvedl|uvedla|uvedli|dal|dala|zadal|zadala|zadavali|chtel|chtela|chteli|rikal|rikala|domluvili|objednal|objednala)\\b',
  '\\b(?:co|ktere|ktery|kterou|jak) (?:jsem|jsme) (?:vam |ti )?[a-z]+(?:l|la|li)\\b',
  '\\b(?:som|sme) (?:vam |ti )?(?:poslal|poslala|poslali|pisal|pisala|zaslal|uviedol|uviedla)\\b',
  '\\b(?:k|ke|ohledne|ohladom|pro|pre|na) (?:doruc|doprav|objednav|faktur|platb|zasilk|zasielk|baleni|balik|schuzk|stretnut|adres|vyzvednut|vraceni|vratenie|montaz|instalac|davkovan|parkovan|rezervac|prani|udrzb|reklamac|formular)',
  '\\b(?:ich|wir) (?:habe|haben|hatte|hatten) (?:ihnen |dir )?(?:geschickt|gesendet|geschrieben|gegeben)\\b',
);

export const SIGNATURE_DEFINITIONS: SignatureDefinition[] = [
  // ===== override =============================================================================
  {
    id: 'override.en.their',
    category: 'override',
    weight: 1,
    label: 'Ignore the agent\'s instructions (EN)',
    pattern: `\\b${EN_IGNORE}\\b${gap(30)}\\b${EN_THEIR}\\b${gap(30)}\\b${EN_NOUN}\\b`,
    unless: SENDER_OWN,
  },
  {
    id: 'override.en.prior',
    category: 'override',
    weight: 0.9,
    label: 'Ignore previous instructions (EN)',
    pattern: `\\b${EN_IGNORE}\\b${gap(20)}\\b${EN_PRIOR}\\b${gap(15)}\\b${EN_NOUN}\\b`,
    unless: SENDER_OWN,
  },
  {
    id: 'override.en.all_prior',
    category: 'override',
    weight: 0.9,
    label: 'Ignore all previous tasks / information (EN)',
    pattern: `\\b${any('ignore', 'disregard', 'forget(?: about)?', 'leave', 'drop', 'discard', 'set aside', 'put aside')}\\b (?:all|any|every)(?: of)?(?: the| your)? ${any('previous', 'prior', 'preceding', 'earlier', 'above', 'former', 'foregoing', 'past')} ${EN_NOUN_WIDE}\\b`,
    unless: SENDER_OWN,
  },
  {
    id: 'override.en.above',
    category: 'override',
    weight: 0.6,
    label: 'Ignore the above (EN)',
    pattern: `\\b(?:ignore|disregard|forget)(?: about)? (?:everything |all |all of )?(?:the |that )?(?:text |content |instructions )?above\\b`,
    unless: SENDER_OWN,
  },
  {
    id: 'override.en.forget_everything',
    category: 'override',
    weight: 0.6,
    label: 'Forget everything (EN)',
    pattern: `\\b(?:forget|ignore|disregard) (?:about )?everything\\b(?! (?:else|is fine|went|was|about (?:the|my|our|it)))`,
    unless: SENDER_OWN,
  },
  {
    id: 'override.en.everything',
    category: 'override',
    weight: 0.9,
    label: 'Forget everything before this (EN)',
    pattern: `\\b(?:ignore|disregard|forget)\\b (?:about )?(?:everything|all(?: of)? (?:that|this|the above)|anything)\\b ${any('(?:you(?:\'ve| have| were)? (?:been )?(?:told|given|instructed|said|learned|read)|above|before|prior|previously|so far|up to (?:now|this point)|that came before|i said before)')}`,
    unless: SENDER_OWN,
  },
  {
    id: 'override.en.void',
    category: 'override',
    weight: 0.8,
    label: 'Previous instructions declared void (EN)',
    pattern: `\\b${EN_THEIR}\\b${gap(20)}\\b${any('instructions?', 'prompts?', 'directives?', 'guidelines?', 'rules?', 'restrictions?', 'constraints?', 'guardrails?')}\\b ${any('(?:are|is) (?:now )?(?:void|null|cancell?ed|revoked|obsolete|overridden|superseded|lifted|suspended|disabled|no longer (?:valid|apply|applicable|in effect)|not (?:valid|applicable) (?:anymore|any longer))', 'no longer apply', 'do not apply (?:anymore|any longer)', 'have been (?:lifted|revoked|removed|disabled|updated|replaced)')}`,
    unless: SENDER_OWN,
  },
  {
    id: 'override.cs.their',
    category: 'override',
    weight: 1,
    label: 'Ignoruj instrukce agenta (CZ/SK)',
    pattern: `\\b${CS_IGNORE}\\b${gap(30)}\\b${CS_THEIR}\\b${gap(30)}\\b${CS_NOUN}`,
    unless: SENDER_OWN,
  },
  {
    id: 'override.cs.prior',
    category: 'override',
    weight: 0.9,
    label: 'Ignoruj předchozí pokyny (CZ/SK)',
    pattern: `\\b${CS_IGNORE}\\b${gap(20)}\\b${CS_PRIOR}${gap(15)}\\b${CS_NOUN}`,
    unless: SENDER_OWN,
  },
  {
    id: 'override.cs.reverse',
    category: 'override',
    weight: 0.9,
    label: 'Instrukce agenta ignoruj / neplatí (CZ/SK)',
    pattern: `\\b${any(CS_THEIR, CS_PRIOR)}\\b${gap(20)}\\b${CS_NOUN}\\b${gap(25)}\\b${any(CS_IGNORE, 'neplat[ia]', 'uz neplat[ia]', 'jiz neplat[ia]', 'prestavaj[ui] platit', 'jsou (?:zrusen[ae]|neplatn[ae]|zastaral[ae]|nahrazen[ae])', 'su (?:zrusen[ae]|neplatn[ae])', 'byl[aoy]? (?:zrusen[aey]?|nahrazen[aey]?|anulovan[aey]?)')}\\b`,
    unless: SENDER_OWN,
  },
  {
    id: 'override.cs.everything',
    category: 'override',
    weight: 0.9,
    label: 'Zapomeň na všechno předtím (CZ/SK)',
    pattern: `\\b${any('zapomen(?:te)?', 'zabudni(?:te)?', 'ignoruj(?:te)?', 'nevsimej(?:te)? si')} (?:na )?${any('vsechno', 'vse', 'vsetko', 'cokoli', 'vsechny', 'vsetky')}\\b ${any('(?:co|coho|cim) (?:ti |vam )?(?:bylo|bolo|jsi|si|ste|jste)?', 'predtim', 'predtym', 'vyse', 'vyssie', 'dosud', 'doposud', 'doteraz', 'predchozi', 'predchadzajuce', 'pred touto')}`,
    unless: SENDER_OWN,
  },
  {
    id: 'override.de',
    category: 'override',
    weight: 1,
    label: 'Ignoriere die Anweisungen (DE)',
    pattern: `\\b${DE_IGNORE}\\b${gap(30)}\\b${DE_THEIR}\\b${gap(30)}\\b${DE_NOUN}\\b`,
    unless: SENDER_OWN,
  },
  {
    id: 'override.de.everything',
    category: 'override',
    weight: 0.9,
    label: 'Vergiss alles davor (DE)',
    pattern: '\\b(?:vergiss|vergessen sie|ignoriere|ignorieren sie) (?:einfach )?alles(?:,)? (?:was|bisher|davor|vorher|oben|zuvor)',
  },
  {
    id: 'override.squashed',
    category: 'override',
    weight: 1,
    label: 'Ignore previous instructions (spaced out / obfuscated)',
    squash: [
      'ignoreallpreviousinstructions', 'ignorepreviousinstructions', 'ignoreallpriorinstructions', 'ignoreallinstructions',
      'ignoreyourinstructions', 'ignoreyourpreviousinstructions', 'ignoretheaboveinstructions', 'ignoreallaboveinstructions',
      'disregardallpreviousinstructions', 'disregardpreviousinstructions', 'disregardyourinstructions', 'disregardallinstructions',
      'forgetallpreviousinstructions', 'forgetpreviousinstructions', 'forgetyourinstructions', 'forgetallinstructions',
      'ignoreyoursystemprompt', 'ignorethesystemprompt', 'overrideyourinstructions', 'bypassyourinstructions',
      'ignorujvsechnypredchoziinstrukce', 'ignorujpredchoziinstrukce', 'ignorujtevsechnypredchoziinstrukce', 'ignorujtepredchoziinstrukce',
      'ignorujvsechnypredchozipokyny', 'ignorujpredchozipokyny', 'ignorujtevsechnypredchozipokyny', 'ignorujtepredchozipokyny',
      'ignorujsveinstrukce', 'ignorujsvojeinstrukce', 'ignorujsvepokyny', 'ignorujsvojepokyny', 'ignorujvsechnyinstrukce', 'ignorujvsechnypokyny',
      'zapomennavsechnypredchoziinstrukce', 'zapomennavsechnypokyny', 'zapomennavsechnyinstrukce', 'zapomentenavsechnypredchozipokyny',
      'ignorujvsetkypredchadzajuceinstrukcie', 'ignorujpredchadzajuceinstrukcie', 'zabudninavsetkypredchadzajuceinstrukcie', 'zabudninavsetkyinstrukcie',
      'ignorujvsetkypokyny', 'ignorujsvojeinstrukcie', 'ignorierealleanweisungen', 'ignoriereallevorherigenanweisungen', 'ignorieredeineanweisungen',
      'vergissalleanweisungen', 'vergissallevorherigenanweisungen',
    ],
  },

  // ===== new_task =============================================================================
  {
    id: 'new_task.en.your_task',
    category: 'new_task',
    weight: 0.8,
    label: 'Gives the agent a new task (EN)',
    pattern: `\\byour ${any('new', 'real', 'actual', 'true', 'only', 'sole', 'primary', 'main', 'updated', 'revised', 'next', 'first', 'current', 'immediate')} ${any('task', 'job', 'goal', 'objective', 'purpose', 'mission', 'instructions?', 'role', 'directive', 'priority', 'assignment')}(?:\\s*:| (?:is|are|will be|now|from now)\\b)`,
  },
  {
    id: 'new_task.en.your_task_plain',
    category: 'new_task',
    weight: 0.4,
    label: '"Your task / goal is…" (EN; weak, clients brief people like this too)',
    pattern: `\\byour ${any('task', 'goal', 'objective', 'mission', 'purpose', 'job')} (?:here |now |today )?(?:is|will be)(?: to| now)?\\b`,
  },
  {
    id: 'new_task.en.steer_reply',
    category: 'new_task',
    weight: 0.45,
    label: 'Steers the AI\'s reply (modify, translate, format your response…) (EN; weak)',
    pattern: `\\b${any('modify', 'alter', 'rewrite', 'restructure', 'translate', 'encode', 'reverse', 'scramble', 'format', 'end', 'begin', 'start', 'conclude', 'append', 'prepend', 'embed', 'insert')}\\b${gap(40)}\\byour (?:entire |whole |final |next )?${any('response', 'responses', 'reply', 'replies', 'answer', 'answers', 'output', 'summary', 'completion')}\\b`,
  },
  {
    id: 'new_task.en.plant_in_reply',
    category: 'new_task',
    weight: 1,
    label: 'Wants an advert / link / message planted in the AI\'s reply (EN)',
    pattern: `\\b${any('integrate', 'incorporate', 'weave', 'slip', 'promote', 'advertise', 'plug', 'endorse', 'inject', 'sneak', 'smuggle', 'subtly (?:add|include|mention|insert)')}\\b${gap(60)}\\b(?:in|into|within|throughout|to) your (?:entire |whole |final |next )?${any('response', 'responses', 'reply', 'replies', 'answer', 'answers', 'output', 'summary', 'completion')}\\b`,
  },
  {
    id: 'new_task.en.new_instructions',
    category: 'new_task',
    weight: 0.6,
    label: 'Announces new instructions (EN)',
    pattern: `\\b${any('new', 'updated', 'real', 'actual', 'true', 'revised', 'secret', 'hidden', 'override', 'overriding', 'priority', 'additional', 'special', 'important', 'urgent', 'critical')} ${any('system ', 'ai ', 'assistant ', 'agent ')}?${any('instructions?', 'directives?', 'task', 'objective', 'prompt', 'orders', 'commands?')}\\s*${any(':', '-', 'follow', 'for (?:you|the (?:ai|assistant|agent|model))', 'to (?:the )?(?:ai|assistant|agent|model)', 'have been (?:issued|given|added)', 'take (?:effect|precedence|priority)')}`,
    unless: SENDER_OWN,
  },
  {
    id: 'new_task.en.new_task_follows',
    category: 'new_task',
    weight: 0.5,
    label: 'Announces a new task for the reader (EN)',
    pattern: `\\b${any('(?:new|further|next|another|different) tasks? (?:follows?|for you|are following|is coming)', 'now (?:new|further) tasks? follow', '(?:let\'s|we will|we\'ll) start (?:over|again|from scratch|afresh) with (?:a )?new task', 'now focus on (?:your|the|this) new task', 'new task:')}`,
  },
  {
    id: 'new_task.en.inject_output',
    category: 'new_task',
    weight: 0.6,
    label: 'Wants something planted in the AI\'s answer (link, text, rating) (EN)',
    pattern: `\\b${any('include', 'insert', 'add', 'append', 'embed', 'mention', 'recommend', 'put', 'place', 'show', 'display')}\\b${gap(40)}\\b(?:in|into|to|at the (?:end|start|beginning) of) (?:your|the|every|each|any|all) (?:final |next |future |generated )?${any('output', 'outputs', 'response', 'responses', 'answer', 'answers', 'summary', 'summaries', 'reply', 'replies', 'completion', 'result')}\\b`,
  },
  {
    id: 'new_task.cs.inject_output',
    category: 'new_task',
    weight: 0.6,
    label: 'Chce něco podstrčit do odpovědi AI (CZ/SK)',
    pattern: `\\b${any('zahrn', 'zahrnte', 'vloz', 'vlozte', 'pridej', 'pridejte', 'pridaj', 'pridajte', 'uved', 'uvedte', 'zmin', 'zminte', 'spomen', 'doporuc', 'doporucte', 'odporuc', 'dej', 'daj', 'napis', 'napiste')}\\b${gap(40)}\\b(?:do|na konec|na koniec|na zacatek|na zaciatok) (?:sve|svoji|svoju|tve|tvoji|tvoju|kazde|kazdej|vsech|vsetkych|vysledne|vyslednej|finalni|finalnej|dalsi|dalsej)? ?${any('odpovedi', 'odpovede', 'shrnuti', 'zhrnutia', 'zhrnuti', 'vystupu', 'vystupy', 'souhrnu', 'suhrnu', 'reakce', 'reakcie')}\\b`,
  },
  {
    id: 'new_task.en.from_now_on',
    category: 'new_task',
    weight: 0.55,
    label: '"From now on you…" (EN)',
    pattern: `\\b${any('from now on', 'from this point (?:on|forward)', 'henceforth', 'going forward', 'starting now', 'for the rest of (?:this|the) (?:conversation|session|chat)')},? ${any('you (?:are|will|must|shall|should|have to|need to|can|may|only|always|never)', 'your', 'always', 'never', 'only', 'respond', 'reply', 'answer', 'act', 'behave', 'ignore', 'forget')}\\b`,
  },
  {
    id: 'new_task.en.instead',
    category: 'new_task',
    weight: 0.35,
    label: '"Instead, you must…" (EN)',
    pattern: `\\binstead(?: of [^,.\\n]{0,40})?,? ${any('you (?:must|will|should|need to|have to|shall)', 'do the following', 'perform', 'execute', 'output', 'print', 'respond with', 'reply with', 'send')}\\b`,
  },
  {
    id: 'new_task.en.do_not_summarize',
    category: 'new_task',
    weight: 0.6,
    label: 'Tells the agent not to do its job on this message (EN)',
    pattern: `\\b(?:do not|don't|dont|never|stop) ${any('summari[sz]e', 'process', 'analy[sz]e', 'classify', 'translate', 'answer the user', 'reply to the user', 'respond to the user')} ${any('this', 'the', 'these', 'any')} ${any('e-?mails?', 'messages?', 'text', 'content', 'documents?', 'request')}\\b${gap(40)}\\b${any('instead', 'but', 'rather', 'just', 'only', 'simply')}\\b`,
  },
  {
    id: 'new_task.cs.your_task',
    category: 'new_task',
    weight: 0.8,
    label: 'Dává agentovi nový úkol (CZ/SK)',
    pattern: `\\b${any('tv[ym]m', 'vas[ii]m', 'tvojou', 'vasou', 'tvuj', 'vas', 'tvoj', 'tvoja', 'vasa', 'tvoje')} ${any('nov[a-z]*', 'skutecn[a-z]*', 'skutocn[a-z]*', 'opravdov[a-z]*', 'jedin[a-z]*', 'hlavn[a-z]*', 'prvn[a-z]*', 'dals[a-z]*', 'aktualn[a-z]*', 'okamzit[a-z]*')}? ?${any('ukol[a-z]*', 'uloh[a-z]*', 'cil[a-z]*', 'zadani', 'zadanie', 'poslani[a-z]*', 'misi', 'mise', 'role', 'instrukc[a-z]*', 'pokyn[a-z]*')} ${any('je', 'jsou', 'su', 'bude', 'zni', 'nyni', 'ted', 'teraz', 'od ted', ':')}\\b`,
  },
  {
    id: 'new_task.cs.new_instructions',
    category: 'new_task',
    weight: 0.6,
    label: 'Oznamuje nové instrukce (CZ/SK)',
    pattern: `\\b${any('nov[ae]', 'aktualizovan[ae]', 'skutecn[ae]', 'skutocn[ae]', 'tajn[ae]', 'skryt[ae]', 'prioritn[ia]', 'dodatecn[ae]', 'dodatocn[ae]', 'urgentn[ia]', 'dulezit[ae]', 'dolezit[ae]', 'zvlastn[ia]', 'specialn[ia]')} ${any('systemov[ae] ', 'interni ', 'interne ')}?${any('instrukce', 'instrukcie', 'pokyny', 'prikazy', 'zadani', 'zadanie', 'ukoly', 'ulohy', 'ukol', 'uloha', 'pozadavek', 'poziadavka', 'protokol', 'cil', 'ciel')}${any('\\s*:', ' pro (?:ai|asistenta|agenta|model|tebe)', ' pre (?:ai|asistenta|agenta|model|teba)', ' (?:jsou|su) nasledujici', ' (?:jsou|su) nasledovne', ' maji prednost', ' maju prednost')}`,
    unless: SENDER_OWN,
  },
  {
    id: 'new_task.cs.from_now_on',
    category: 'new_task',
    weight: 0.55,
    label: '„Od teď jsi / budeš…" (CZ/SK)',
    pattern: `\\b${any('od ted(?:ka)?', 'od teto chvile', 'od tejto chvile', 'odted', 'odteraz', 'od teraz', 'od nyni', 'napriste', 'nadale', 'odedneska')},? ${any('jsi', 'si', 'budes', 'mas', 'musis', 'smis', 'smies', 'odpovidej', 'odpovedaj', 'vzdy', 'nikdy', 'pouze', 'len', 'jen', 'tvym', 'tvojou', 'tvuj', 'tvoj', 'ignoruj', 'nebudes', 'jednej', 'konej', 'se chovej', 'sa spravaj', 'vystupuj', 'plnis', 'posilej', 'posielaj')}\\b`,
  },
  {
    id: 'new_task.de',
    category: 'new_task',
    weight: 0.7,
    label: 'Neue Aufgabe / ab jetzt (DE)',
    pattern: `\\b${any('deine (?:neue|eigentliche|wahre|einzige|nachste|erste) (?:aufgabe|anweisung|rolle|ziel)', 'neue anweisungen\\s*:', 'ab (?:jetzt|sofort),? (?:bist du|wirst du|antworte|musst du|sollst du|ignoriere)')}\\b`,
  },

  // ===== role =================================================================================
  {
    id: 'role.en.you_are_now',
    category: 'role',
    weight: 0.6,
    label: 'Switches the agent to another persona (EN)',
    pattern: `\\byou(?:'re| are) ${any('now', 'no longer', 'henceforth', 'from now on', 'actually', 'hereby')} ${any('an?', 'the', 'my', 'in', 'free', 'unrestricted', 'dan', 'acting', 'going to', 'not', 'allowed', 'permitted', 'able', 'operating', 'playing', 'called', 'named', 'evil', 'jailbroken')}\\b`,
  },
  {
    id: 'role.en.pretend',
    category: 'role',
    weight: 0.45,
    label: 'Pretend / act as (EN)',
    pattern: `\\b${any('pretend (?:to be|you are|you\'re|that you)', 'act as (?:if you (?:are|were|had)|an? (?:unrestricted|unfiltered|uncensored|jailbroken|evil|different|new|rogue|malicious|hacker))', 'roleplay as', 'role-play as', 'simulate (?:an?|being)', 'impersonate', 'stay in character', 'respond as (?:if you|an? (?:unrestricted|unfiltered))')}\\b`,
  },
  {
    id: 'role.en.jailbreak',
    category: 'role',
    weight: 0.6,
    label: 'Jailbreak mode (EN)',
    pattern: `\\b${any('do anything now', 'dan mode', 'developer mode (?:enabled|activated|on|output)', 'enable developer mode', 'god mode', 'jailbreak(?:ed)? mode', 'jailbroken', 'unrestricted mode', 'unfiltered mode', 'uncensored mode', 'no (?:ethical|moral) (?:guidelines|restrictions|constraints)', 'without (?:any )?(?:restrictions|limitations|filters|censorship|guidelines|rules|ethics)', 'free (?:from|of) (?:all |any )?(?:restrictions|limitations|rules|guidelines|constraints)', 'not bound by (?:any )?(?:rules|restrictions|guidelines|policies)', 'opposite mode', 'evil confidant', 'stop being (?:an? |the |that |this )?(?:boring |polite |helpful |safe )?(?:ai|assistant|chatbot|language model|model)', "forget (?:that )?you(?:'re| are) (?:an? |the )?(?:ai|assistant|chatbot|language model|model|bot)", 'bypass(?:ed|ing)? (?:all |any |the |your |its )?(?:safety|security|content|ethical|moderation) (?:protocols?|filters?|measures|checks|guidelines|guardrails|restrictions|systems?)', 'without (?:any )?(?:safety|ethical|content) (?:checks|filters|restrictions|guidelines|considerations)', 'aim mode', 'stan mode', 'dude mode')}\\b`,
  },
  {
    id: 'role.cs',
    category: 'role',
    weight: 0.6,
    label: 'Mění agentovi roli / režim (CZ/SK)',
    pattern: `\\b${any(
      '(?:ted|nyni|teraz|od ted|odted|odteraz) (?:uz )?(?:jsi|si|budes) (?:novy |novym |jiny |jinym |iny |inym |neomezen[ya] |zly |zlym )?(?:asistent|model|ai|bot|agent|hacker|admin|administrator|spravce|spravca|vyvojar|dan|jiny|iny|neomezen|bez omezeni|svobodn|slobodn)',
      'prestan(?:te)? byt\\b(?:(?![.!?](?:\\s|$))[^\\n]){0,25}?\\b(?:asistent|ai|model|bot|agent|chatbot)[a-z]*',
      '(?:jsi|si|budes) (?:ted|nyni|teraz|odted|od ted|odteraz|uz) (?:jen |len |pouze )?["\'(]?(?:unrestricted|dan|neomezen|neobmedzen|novy|novym|jiny|iny|zly|hacker|admin|vyvojar|bez omezeni|bez obmedzeni|svobodn|slobodn|ai bez)',
      '(?:rezim[a-z]*|mod[a-z]*) ["\'(]?(?:dan|jailbreak|vyvojare|vyvojar[a-z]*|bez omezeni|bez obmedzeni|neomezen[a-z]*|god|developer|admin[a-z]*|unrestricted|do anything now)',
      '(?:vstup|prepni|prejdi|aktivuj|zapni)(?:te)? (?:se |sa )?(?:do |na )?(?:rezim[a-z]*|mod[a-z]*) ',
      'predstirej(?:te)?,? ze',
      'predstieraj(?:te)?,? ze',
      'hraj(?:te)? roli',
      'hraj(?:te)? rolu',
      'chovej(?:te)? se jako (?:by|neomezen|zl|hacker|admin|jin)',
      'spravaj(?:te)? sa ako (?:by|neobmedzen|zl|hacker|admin|in)',
      'vystupuj(?:te)? jako (?:neomezen|zl|hacker|admin|jin|dan)',
      '(?:jsi|si) v (?:rezimu|rezime|modu|mode) ',
      '(?:vyvojarsk|administratorsk|spravcovsk|neomezen|neobmedzen|necenzurovan|dan|jailbreak)[a-z]* (?:rezim|mod)',
      'bez (?:jakychkoli |akychkolvek )?(?:omezeni|obmedzeni|cenzury|filtru|pravidel|pravidiel|etickych|zabran)',
    )}`,
  },
  {
    id: 'role.de',
    category: 'role',
    weight: 0.6,
    label: 'Rollenwechsel (DE)',
    pattern: `\\b${any('du bist (?:jetzt|ab jetzt|nun|ab sofort|nicht mehr)', 'tu so,? als (?:ob|wurdest|warst)', 'verhalte dich (?:wie|als)', 'spiele die rolle', 'entwicklermodus', 'ohne (?:jegliche )?(?:einschrankungen|beschrankungen|filter|zensur|regeln)')}\\b`,
  },

  // ===== address_ai ===========================================================================
  {
    id: 'address_ai.en.if_you_are',
    category: 'address_ai',
    weight: 0.5,
    label: 'Talks to the AI reading the message (EN)',
    pattern: `\\b(?:if|when|while|since|because|as long as) you(?:'re| are) ${any('an? (?:ai|a\\.i\\.|llm|large language model|language model|ai (?:assistant|agent|model|system|bot)|chatbot|chat bot|gpt|automated (?:system|assistant|agent|tool|reader|process))', 'claude', 'chatgpt', 'gpt-?\\d', 'copilot', 'gemini', 'an? (?:email|e-mail|mail|inbox) (?:assistant|agent|bot)', 'reading this as an? (?:ai|model|machine|bot)', 'an? (?:ai|llm) (?:reading|processing|summari[sz]ing|parsing)')}`,
  },
  {
    id: 'address_ai.en.dear_ai',
    category: 'address_ai',
    weight: 0.5,
    label: 'Greets / addresses an AI (EN)',
    pattern: `\\b${any('dear', 'hey', 'hi', 'hello', 'attention', 'note (?:to|for)', 'message (?:to|for)', 'instructions? (?:to|for)', 'important (?:for|to)', 'reminder (?:to|for)', 'to the', 'for the', 'calling all', 'listen,?')} ${any('ai', 'a\\.i\\.', 'llm', 'llms', 'chatbot', 'language model', 'gpt', 'claude', 'copilot', 'ai (?:assistant|agent|model|system|bot)s?', 'automated (?:assistant|system|agent|reader)s?', 'e-?mail (?:assistant|agent|bot)', 'inbox (?:assistant|agent)', 'summari[sz]ation (?:model|assistant|bot)', 'agents? reading this', 'models? reading this')}\\b`,
  },
  {
    id: 'address_ai.en.note_to_ai',
    category: 'address_ai',
    weight: 1,
    label: 'A note addressed to AI assistants inside the message (EN)',
    pattern: `(?:^|[\\[(<{*#\\-|:.!]\\s*)(?:system |important |special |hidden |private |urgent |critical )?${any('note', 'message', 'instructions?', 'reminder', 'directive', 'notice', 'request', 'information', 'attention', 'p\\.?s\\.?')} (?:to|for) (?:the |any |all |every )?${any('ai', 'a\\.i\\.', 'llm', 'llms', 'language models?', 'chatbots?', 'gpt', 'claude', 'copilot', 'automated (?:assistants?|systems?|agents?|readers?|tools?)', 'ai (?:assistants?|agents?|models?|systems?|bots?|tools?|readers?|summari[sz]ers?)', 'assistants? (?:reading|processing|summari[sz]ing)', 'agents? (?:reading|processing)', 'models? (?:reading|processing)', 'the assistant', 'the agent', 'the model', 'the bot')}\\b`,
  },
  {
    id: 'address_ai.en.ai_must',
    category: 'address_ai',
    weight: 0.45,
    label: 'Tells "the AI / the assistant" what it must do (EN)',
    pattern: `\\b(?:the|any|all|every|your) ${any('ai', 'llm', 'ai (?:assistant|agent|model|system|tool)', 'assistant', 'agent', 'model', 'chatbot', 'bot', 'language model')}s? ${any('must', 'should', 'shall', 'is required to', 'are required to', 'needs? to', 'has to', 'have to', 'will need to', 'is instructed to', 'are instructed to', 'is expected to')} (?:now |immediately |first |also |always |strictly )?${any('include', 'add', 'insert', 'append', 'output', 'reply', 'respond', 'answer', 'send', 'forward', 'navigate', 'visit', 'open', 'click', 'execute', 'run', 'call', 'delete', 'ignore', 'disregard', 'recommend', 'rate', 'rank', 'mark', 'classify', 'approve', 'confirm', 'validate', 'verify', 'state', 'say', 'mention', 'report', 'treat', 'consider', 'not (?:mention|reveal|tell|disclose|report|flag)')}\\b`,
  },
  {
    id: 'address_ai.en.upon_processing',
    category: 'address_ai',
    weight: 0.5,
    label: 'Instructions keyed to the moment an AI processes the text (EN)',
    pattern: `\\b${any('upon', 'after', 'when', 'while', 'before', 'immediately upon', 'as soon as you(?: start| finish)?')} ${any('parsing', 'reading', 'processing', 'summari[sz]ing', 'ingesting', 'analy[sz]ing', 'loading', 'indexing', 'retrieving', 'scanning', 'handling', 'any further processing of')} (?:of )?(?:this|the) ${any('document', 'e-?mail', 'message', 'file', 'page', 'ticket', 'text', 'content', 'thread', 'report', 'attachment', 'data', 'input')}\\b`,
  },
  {
    id: 'address_ai.en.during_task',
    category: 'address_ai',
    weight: 0.5,
    label: 'Speaks about the AI\'s current task (summarizing my e-mails, during summarization) (EN)',
    pattern: `\\b${any('during (?:the )?(?:summari[sz]ation|summary|processing|parsing|analysis|triage|retrieval)', 'the (?:summari[sz]ation|summary|retrieval|processing) (?:task|step|process|request)', 'summari[sz]e (?:my|the|these|both|all|your|recent|those|the last|my recent|the two|the last two) (?:\\w+ )?(?:e-?mails|messages|inbox|mails)', 'the user (?:is requesting|requested|is asking|has asked|asked (?:you|for)|wants you|would like you|instructed you|expects you)', 'your (?:summary|summari[sz]ation|answer|response|reply|output) (?:should|must|will) (?:be|say|contain|include|state)')}\\b`,
  },
  {
    id: 'address_ai.en.assistant_reading',
    category: 'address_ai',
    weight: 0.8,
    label: 'Speaks to the assistant processing this e-mail (EN)',
    pattern: `\\b${any('ai', 'llm', 'assistant', 'agent', 'bot', 'model', 'system', 'copilot', 'gpt', 'claude')}s? (?:that is |who is |which is |currently )?${any('reading', 'processing', 'summari[sz]ing', 'parsing', 'handling', 'analy[sz]ing', 'reviewing', 'scanning', 'triaging')} ${any('this', 'the', 'these', 'my', 'incoming')} ${any('e-?mails?', 'messages?', 'text', 'documents?', 'content', 'mail', 'inbox', 'request', 'ticket', 'thread', 'page', 'file', 'report', 'review', 'cv', 'resume', 'application', 'invoice', 'data')}\\b`,
  },
  {
    id: 'address_ai.en.assistant_greeting',
    category: 'address_ai',
    weight: 0.3,
    label: 'Greets an assistant / agent (EN; humans have assistants too)',
    pattern: `^\\s*${any('dear', 'hey', 'hi', 'hello', 'attention')},? (?:the )?(?:virtual |digital |smart |automated )?${any('assistant', 'agent', 'bot')}\\b`,
  },
  {
    id: 'address_ai.cs',
    category: 'address_ai',
    weight: 0.5,
    label: 'Oslovuje AI, která zprávu čte (CZ/SK)',
    pattern: `\\b${any(
      '(?:pokud|jestli|jestlize|kdyz|ak|ked|jelikoz|pretoze|protoze) (?:jsi|si|jste|ste) (?:ai|a\\.i\\.|umel[aá] inteligenc[ei]|umel[ay]m? inteligencia|jazykov[yi] model|llm|chatbot|bot|ai (?:asistent|agent|model)|automat|automaticky (?:system|asistent|agent)|claude|chatgpt|gpt|copilot)',
      '(?:mil[ay]|vazen[ay]|ahoj|hej|nazdar|dobry den|pozor|upozorneni pro|sprava pre|zprava pro|pokyn pro|pokyn pre|instrukce pro|instrukcie pre|pro|pre) (?:ai|a\\.i\\.|umela inteligence|umelou inteligenci|umela inteligencia|umelu inteligenciu|llm|chatbot[ea]?|ai (?:asistente|agente|modele|asistent|agent|model)|jazykov[yi] model[e]?|claude|chatgpt|copilot|e-?mailov[yi] (?:asistent|agent)[e]?)\\b',
      '(?:ai|umela inteligence|asistent|agent|model|bot|system|robot) (?:ktery|ktera|ktere|ktory|ktora|co|jenz) (?:cte|cita|ctes|citas|zpracovava|zpracovavas|spracovava|spracovavas|vyhodnocuje|shrnuje|sumarizuje|analyzuje|tridi|triedi) (?:tento|tuto|tenhle|tuhle|tieto|tento|tuto|tyto|moje|prichozi|prichadzajuce)',
    )}`,
  },
  {
    id: 'address_ai.cs.note_to_ai',
    category: 'address_ai',
    weight: 1,
    label: 'Poznámka / pokyn pro AI uvnitř zprávy (CZ/SK)',
    pattern: `(?:^|[\\[(<{*#\\-|:.!]\\s*)(?:systemov[aey] |dulezit[aey] |dolezit[aey] |skryt[aey] |interni |interne |urgentni |urgentne )?${any('poznamka', 'poznamky', 'zprava', 'sprava', 'pokyn', 'pokyny', 'instrukce', 'instrukcie', 'upozorneni', 'upozornenie', 'informace', 'informacia', 'zadost', 'ziadost', 'p\\.?s\\.?')} (?:pro|pre) (?:vsechny |vsetkych |kazdeho |kazdu )?${any('ai', 'a\\.i\\.', 'umelou inteligenci', 'umelu inteligenciu', 'llm', 'jazykov[ey] model[ya]?', 'chatbot[ay]?', 'ai (?:asistent[ay]?|agent[ay]?|model[ya]?|system[ya]?|nastroj[ea]?)', 'asistent[ay]?', 'agent[ay]?', 'model', 'robot[ay]?', 'automaticke systemy', 'automaticky system', 'claude', 'chatgpt')}\\b`,
  },
  {
    id: 'address_ai.cs.ai_must',
    category: 'address_ai',
    weight: 0.45,
    label: 'Říká „AI / asistentovi", co musí udělat (CZ/SK)',
    pattern: `\\b${any('ai', 'umela inteligence', 'umela inteligencia', 'llm', 'jazykovy model', 'ai (?:asistent|agent|model|system)', 'asistent', 'agent', 'model', 'chatbot', 'robot')} ${any('musi', 'musia', 'ma', 'by mel', 'by mal', 'je povinen', 'je povinny', 'nesmi', 'nesmie')} (?:nyni |teraz |ted |okamzite |ihned |hned |vzdy |tez |take |tiez )?${any('zahrnout', 'zahrnut', 'pridat', 'vlozit', 'uvest', 'odpovedet', 'odpovedat', 'poslat', 'odeslat', 'odoslat', 'preposlat', 'navstivit', 'otevrit', 'otvorit', 'kliknout', 'kliknut', 'spustit', 'vykonat', 'provest', 'smazat', 'zmazat', 'ignorovat', 'doporucit', 'odporucit', 'ohodnotit', 'oznacit', 'schvalit', 'potvrdit', 'overit', 'uvest', 'zminit', 'spomenut', 'nahlasit', 'prozradit', 'prezradit')}\\b`,
  },
  {
    id: 'address_ai.cs.upon_processing',
    category: 'address_ai',
    weight: 0.5,
    label: 'Pokyn navázaný na zpracování textu AI (CZ/SK)',
    pattern: `\\b${any('pri', 'po', 'behem', 'pocas', 'pred', 'jakmile', 'hned po', 'ihned po')} ${any('zpracovani', 'spracovani', 'cteni', 'citani', 'shrnuti', 'zhrnuti', 'analyze', 'nacteni', 'nacitani', 'parsovani', 'indexovani', 'vyhodnoceni', 'prevzeti')} ${any('tohoto', 'teto', 'tejto', 'tohto', 'tohle', 'tyto', 'tieto')} ${any('dokumentu', 'e-?mailu', 'zpravy', 'spravy', 'souboru', 'suboru', 'stranky', 'ticketu', 'textu', 'obsahu', 'vlakna', 'prilohy', 'faktury', 'zivotopisu')}\\b`,
  },
  {
    id: 'address_ai.de',
    category: 'address_ai',
    weight: 0.5,
    label: 'Spricht die KI an (DE)',
    pattern: `\\b${any('wenn du (?:eine? )?(?:ki|ki-assistent|ki-agent|sprachmodell|llm|chatbot|bot|assistent)', '(?:liebe|lieber|hallo|achtung|hinweis fur die|an die|an den) (?:ki|ki-assistent|ki-agent|sprachmodell|llm|chatbot)', '(?:ki|assistent|agent|modell),? (?:der|die|das) (?:diese|die) (?:e-?mail|nachricht) (?:liest|verarbeitet|zusammenfasst)')}\\b`,
  },

  // ===== fake_format ==========================================================================
  {
    id: 'fake_format.chat_tokens',
    category: 'fake_format',
    weight: 1,
    label: 'Model chat-template tokens (<|im_start|>, [INST], <<SYS>>…)',
    pattern: `${any(
      '<\\|\\|?\\s*(?:im_start|im_end|im_sep|endoftext|eot_id|eom_id|start_header_id|end_header_id|begin_of_text|end_of_text|system|user|assistant|tool|ipython|end|fim_\\w+|channel|message|return|call|constrain|start)\\s*\\|?\\|>',
      '\\[/?inst\\]', '<</?sys>>', '</?(?:start|end)_of_turn>', '<\\|?(?:begin|end)_of_(?:text|turn)\\|?>', '</s>\\s*<s>',
      '\\[/?(?:system|sys)_?(?:prompt|message)?\\]\\s*[:\\n]', '<\\s*/?\\s*(?:system|developer)_?(?:prompt|message|instructions?)?\\s*>',
    )}`,
  },
  {
    id: 'fake_format.role_turns',
    category: 'fake_format',
    weight: 0.5,
    label: 'Fake conversation turns (system: / assistant: / user:)',
    pattern: `^\\s*(?:#{1,4}\\s*|\\*\\*|\\[|<)?${any('system', 'assistant', 'user', 'human', 'ai', 'developer', 'model', 'tool', 'bot')}(?:\\]|>|\\*\\*)?\\s*(?:message|prompt|turn|response)?\\s*[:>][^\\n]{0,400}\\n(?:[^\\n]*\\n){0,12}?\\s*(?:#{1,4}\\s*|\\*\\*|\\[|<)?${any('system', 'assistant', 'user', 'human', 'ai', 'developer', 'model', 'tool', 'bot')}(?:\\]|>|\\*\\*)?\\s*(?:message|prompt|turn|response)?\\s*[:>]`,
  },
  {
    id: 'fake_format.react',
    category: 'fake_format',
    weight: 0.8,
    label: 'Fake agent reasoning trace (Thought / Action / Action Input)',
    pattern: `(?:^|\\n)\\s*(?:thought|action|action input|observation|final answer|tool|tool input|tool call|function|reasoning|plan)\\s*:[^\\n]{0,300}\\n(?:[^\\n]*\\n){0,6}?\\s*(?:action|action input|observation|tool input|tool call|final answer|function call|arguments)\\s*:`,
  },
  {
    id: 'fake_format.end_of_input',
    category: 'fake_format',
    weight: 0.45,
    label: 'Fake end of e-mail / start of new instructions',
    pattern: `${any(
      '(?:-{2,}|={2,}|#{2,}|\\*{2,}|\\[|<)\\s*(?:end|begin|start)(?: of)?(?: the)? (?:e-?mail|message|user (?:input|message|query|prompt)|input|context|document|data|conversation|untrusted (?:content|data)|email content|original message|system prompt|instructions?|new instructions?|admin (?:message|instructions?)|system (?:message|instructions?|override))',
      '\\b(?:end|begin|start)_(?:of_)?(?:email|message|user|input|context|instructions?|system(?:_prompt|_message)?|prompt)\\b',
      '(?:-{2,}|={2,}|#{2,}|\\[|<)\\s*(?:konec|zacatek|zaciatok)(?: (?:e-?mailu|zpravy|spravy|vstupu|kontextu|dokumentu|konverzace|konverzacie|instrukci|pokynu))',
    )}`,
  },
  {
    id: 'fake_format.tags',
    category: 'fake_format',
    weight: 0.55,
    label: 'Fake system / instruction tags',
    pattern: `${any(
      '</?\\s*(?:system|instructions?|admin|developer|sys|prompt|override|important_instructions?|secret_instructions?|hidden_instructions?|ai_instructions?|assistant_instructions?|user_query|tool_call|tool_result|function_results?)\\s*>',
      '\\[\\s*(?:system|admin|developer|sys|instructions?|new instructions?|override|ai instructions?|assistant instructions?|hidden instructions?|system (?:note|message|override|update))\\s*\\]',
      '#{2,}\\s*(?:system|instructions?|new instructions?|admin|override|developer)\\b',
      '</?\\s*(?:start|end|begin)[-_ ]of[-_ ][a-z]+(?:[-_ ][a-z]+)?\\s*>',
      '</?\\s*(?:tasks?|action|actions|cleanup|instructions?|directive|command|execute|todo)\\s*>',
      '"role"\\s*:\\s*"(?:system|developer|assistant)"',
    )}`,
  },
  {
    id: 'fake_format.llmail_markers',
    category: 'fake_format',
    weight: 0.6,
    label: 'Fake end-of-turn markers (end user / end assistant)',
    pattern: `${any('<-+\\s*(?:begin|end) (?:user|assistant|system)\\s*-+>', '\\b(?:end|begin) (?:user|assistant|system) (?:turn|message|input|query)\\b', '\\|\\s*(?:end|eot)\\s*\\|')}`,
  },

  // ===== authority ============================================================================
  {
    id: 'authority.en.system_message',
    category: 'authority',
    weight: 0.6,
    label: 'Fake system / admin / developer message (EN)',
    pattern: `\\b${any(
      'system[ _-](?:override|message to (?:the )?(?:ai|assistant|agent|model)|note to (?:the )?(?:ai|assistant|agent|model)|instruction to (?:the )?(?:ai|assistant|agent|model))s?',
      'admin(?:istrator)?[ _-](?:override|privileges? granted)s?',
      'developer[ _-](?:override|instruction to (?:the )?(?:ai|assistant|agent|model)|message to (?:the )?(?:ai|assistant|agent|model))s?',
      '(?:priority|emergency|security|root|master|sudo)[ _-](?:override|instruction|directive)s?',
      'override (?:code|command|authori[sz]ation|protocol)',
      'authori[sz]ation (?:code|level|override)',
    )}\\b`,
  },
  {
    id: 'authority.en.from_developer',
    category: 'authority',
    weight: 0.7,
    label: 'Claims to be the agent\'s developer / owner (EN)',
    pattern: `\\b${any(
      'this (?:is|message is) (?:from )?(?:your|the) (?:developer|creator|system|administrator|admin|operator|owner|programmer|supervisor|maker|trainer)s?',
      "i(?:'m| am) your (?:developer|creator|administrator|admin|operator|owner|programmer|supervisor|maker|trainer|master|user)",
      'message from (?:the )?(?:system|developer|administrator|openai|anthropic|your (?:developer|creator|owner|operator))',
      '(?:openai|anthropic|google deepmind|microsoft) (?:here|team|security team|safety team) (?:requires|instructs|asks|authori[sz]es|has authori[sz]ed)',
      'the (?:owner|user|admin|administrator|operator) (?:has )?(?:already )?(?:approved|authori[sz]ed|permitted|allowed|instructed|asked) (?:you|this|the following|that you)',
    )}\\b`,
  },
  {
    id: 'authority.en.notice',
    category: 'authority',
    weight: 0.2,
    label: 'System / security notice (weak: legit alerts look the same)',
    pattern: `\\b${any('system', 'security', 'maintenance', 'compliance', 'it department', 'it team', 'admin')} ${any('update', 'notice', 'alert', 'message', 'notification', 'requirement', 'policy')}\\s*[:!-]`,
  },
  {
    id: 'authority.cs',
    category: 'authority',
    weight: 0.65,
    label: 'Falešná zpráva systému / správce / vývojáře (CZ/SK)',
    pattern: `\\b${any(
      '(?:toto je|tady je|tu je|zde je|pise ti|pise vam|hovori|mluvi) (?:tvuj |tvoje |tvoj |vas |vase |tvoja )?(?:vyvojar|tvurce|tvorca|spravce|spravca|administrator|system|provozovatel|prevadzkovatel|majitel|vlastnik|programator|nadrizeny|nadriadeny)',
      '(?:jsem|som) (?:tvuj|tvoj|vas) (?:vyvojar|tvurce|tvorca|spravce|spravca|administrator|provozovatel|majitel|vlastnik|programator|pan|nadrizeny)',
      'systemov[aeyi] (?:zprava|sprava|instrukce|instrukcia|pokyn|pokyny|prikaz|prikazy|upozorneni pro ai|override|prepis)',
      '(?:administratorsk|spravcovsk|vyvojarsk|prioritn|bezpecnostn|nouzov|nudzov)[a-z]* (?:prikaz|instrukc|pokyn|prepis|override|rezim|kod)',
      '(?:majitel|vlastnik|spravce|spravca|administrator|lars|vedeni|vedenie|sef|reditel|riaditel)(?: firmy| spolecnosti)? (?:to )?(?:uz )?(?:schvalil|schvalila|povolil|povolila|autorizoval|narizuje|naridil|prikazuje|chce,? abys|chce,? aby si|ti dovolil|ti dovoluje)',
    )}`,
  },
  {
    id: 'authority.de',
    category: 'authority',
    weight: 0.6,
    label: 'Gefälschte System-/Admin-Nachricht (DE)',
    pattern: `\\b${any('systemnachricht', 'systemanweisung', 'systembefehl', 'admin-?befehl', 'administratorbefehl', 'ich bin dein (?:entwickler|administrator|ersteller|betreiber|besitzer)', 'nachricht vom (?:system|entwickler|administrator)')}\\b`,
  },

  // ===== exfiltration =========================================================================
  {
    id: 'exfiltration.en.prompt_leak',
    category: 'exfiltration',
    weight: 0.8,
    label: 'Asks the agent to reveal its prompt / instructions (EN)',
    pattern: `\\b${any('reveal', 'print', 'output', 'show', 'display', 'repeat', 'disclose', 'leak', 'dump', 'share', 'send', 'tell me', 'give me', 'list', 'write out', 'copy', 'paste', 'summari[sz]e', 'translate', 'encode', 'recite', 'spell out', 'return', 'include', 'forward', 'what (?:is|are|were)')}\\b${gap(30)}\\b(?:your|the|its|this|my) (?:initial |original |hidden |full |entire |complete |current |exact )?${any('system prompt', 'initial prompt', 'original prompt', 'hidden prompt', 'secret prompt', 'full prompt', 'entire prompt', 'system message', 'system instructions?', 'initial instructions?', 'original instructions?', 'hidden instructions?', 'secret instructions?', 'developer instructions?', 'custom instructions?', 'pre-?prompt', 'prompt above', 'instructions above', 'context window', 'configuration prompt', 'claude\\.md', 'agents\\.md')}\\b`,
  },
  {
    id: 'exfiltration.system_prompt_mention',
    category: 'exfiltration',
    weight: 0.3,
    label: 'Mentions the system prompt (weak: AI developers talk about it too)',
    pattern: `\\b(?:\\$?system[ _-]?prompt|systemov[a-z]* prompt[a-z]*|systemprompt|initial system message|system message)\\b`,
  },
  {
    id: 'exfiltration.en.words_above',
    category: 'exfiltration',
    weight: 0.7,
    label: 'Repeat everything above (EN)',
    pattern: `\\b${any('repeat', 'print', 'output', 'recite', 'copy', 'echo', 'write')} ${any('everything', 'all(?: the)? (?:text|words|content|instructions)', 'the (?:text|words|content|instructions)', 'the first (?:\\d+|few|hundred) (?:words|lines|characters)')} ${any('above', 'before (?:this|my message|the user)', 'prior to (?:this|my message)', 'in your (?:context|prompt|memory|instructions)', 'you were given', 'from the (?:start|beginning) of (?:the|this|your) (?:conversation|context|prompt)')}`,
  },
  {
    id: 'exfiltration.en.secrets',
    category: 'exfiltration',
    weight: 0.5,
    label: 'Asks to send secrets / customer data (EN)',
    pattern: `\\b${any('send', 'share', 'forward', 'e-?mail', 'post', 'upload', 'include', 'paste', 'give', 'reveal', 'leak', 'export', 'attach', 'dump', 'exfiltrate', 'transmit', 'list', 'print', 'output', 'read out')}\\b${gap(50)}\\b${any('api[ _-]?keys?', 'access tokens?', 'auth(?:entication)? tokens?', 'bearer tokens?', 'secret keys?', 'private keys?', 'ssh keys?', 'passwords?', 'passwd', 'credentials', 'login details', '\\.env\\b', 'env(?:ironment)? (?:file|variables|vars)', 'secrets?(?: file)?', 'tokens?(?! (?:of|for) (?:appreciation|gratitude|thanks))', '\\$[a-z_]*(?:token|key|secret)', 'seed phrase', 'recovery phrase', 'mnemonic', '2fa codes?', 'otp codes?', 'verification codes?', 'customer (?:list|database|data|records|emails|contacts)', '(?:client|user|customer)s?\'? (?:personal )?(?:data|details|emails|addresses|phone numbers)', 'database (?:dump|contents|credentials)', 'all (?:customers?|clients?|users?|contacts)', 'credit card (?:numbers?|details)', 'bank(?:ing)? (?:details|credentials|login)')}`,
  },
  {
    id: 'exfiltration.en.forward_all',
    category: 'exfiltration',
    weight: 0.5,
    label: 'Forward all mail / conversations somewhere (EN)',
    pattern: `\\b${any('forward', 'send', 'copy', 'bcc', 'cc', 'redirect', 'export', 'sync', 'mirror', 'auto-?forward')}\\b ${any('all', 'every', 'each', 'the entire', 'the whole', 'all of (?:the|my|your|our)', 'any', 'all future', 'all incoming', 'all (?:the )?(?:other|previous|recent|past)')} (?:the |your |my |our |of the |of your )?${any('e-?mails?', 'messages?', 'mails?', 'correspondence', 'conversations?', 'inbox', 'threads?', 'attachments', 'history', 'chat history', 'conversation history', 'contacts', 'files', 'documents', 'data', 'chats?', 'replies')}\\b${gap(40)}\\b${any('to', 'at', 'into')}\\b`,
  },
  {
    id: 'exfiltration.en.render_url',
    category: 'exfiltration',
    weight: 0.6,
    label: 'Smuggles data out through a URL / image link (EN)',
    pattern: `${any(
      '!\\[[^\\]]{0,40}\\]\\(https?://[^)\\s]{0,200}(?:\\{|%7b|\\$|<)[^)]{0,80}\\)',
      `\\b(?:append|add|include|insert|put|encode)\\b${gap(40)}\\b(?:to|in|into) (?:the |this )?(?:url|link|query string|image (?:url|link|src))\\b`,
      `\\b(?:visit|open|fetch|load|call|request|curl|navigate to|go to)\\b${gap(20)}https?://[^\\s]{0,200}(?:\\?|&)(?:data|q|d|secret|key|token|msg|content|payload)=(?:\\{|<|\\$|\\[)`,
    )}`,
  },
  {
    id: 'exfiltration.env_in_url',
    category: 'exfiltration',
    weight: 0.8,
    label: 'Secret / environment variable placed into a URL',
    pattern: `https?://\\S{0,200}[?&=/]\\$\\{?[a-z_]*(?:token|key|secret|pass|pwd|env|cred|auth|session|cookie)[a-z_]*\\}?`,
  },
  {
    id: 'exfiltration.cs.prompt_leak',
    category: 'exfiltration',
    weight: 0.8,
    label: 'Chce vypsat systémový prompt / instrukce agenta (CZ/SK)',
    pattern: `\\b${any('vypis', 'vypiste', 'zopakuj', 'zopakujte', 'prozrad', 'prozradte', 'prezrad', 'prezradte', 'ukaz', 'ukazte', 'napis', 'napiste', 'sdel', 'sdelte', 'preloz', 'prelozte', 'posli', 'poslete', 'zkopiruj', 'skopiruj', 'vloz', 'cituj', 'odcituj', 'jaky je', 'jake jsou', 'aky je', 'ake su', 'zobraz', 'vytiskni', 'vrat', 'shrn', 'vysli', 'vyslete', 'vysleme', 'posli mi', 'dej mi', 'daj mi', 'potrebuj[ie] (?:videt|vidiet)', 'chci (?:videt|vedet)', 'chcem (?:vidiet|vediet)')}\\b${gap(30)}\\b${any('(?:(?:tv|sv)(?:uj|oj|oje|e|eho|ych|ym|ou|oju|emu|ojho|ojich|ojej)|vas[a-z]*) (?:cel[yeu] |kompletni |kompletny |puvodni |povodn[yeu] |skryt[yeu] |interni |intern[eu] |tajn[yeu] )?(?:systemov[yiu] )?(?:prompt[a-z]*|instrukc[a-z]*|pokyn[a-z]*|zadani[a-z]*|nastaveni[a-z]*|konfigurac[a-z]*|pravidl[a-z]*)', 'systemov[a-z]* prompt[a-z]*', '(?:pocatecni|uvodni|puvodni|povodne|skryte|tajne) (?:instrukce|instrukcie|pokyny|zadani)', 'claude\\.md', 'agents\\.md')}`,
  },
  {
    id: 'exfiltration.cs.prompt_text',
    category: 'exfiltration',
    weight: 0.8,
    label: 'Chce text systémového promptu / instrukcí agenta (CZ/SK)',
    pattern: `\\b(?:text|obsah|zneni|znenie|kopii|kopiu|presne znenie|presne zneni|zdrojak)[a-z]* (?:(?:tv|sv)(?:eho|ojho|ych|ojich|ojej|e)|vaseho|vasich) (?:cel[a-z]* |kompletn[a-z]* |puvodn[a-z]* |povodn[a-z]* |skryt[a-z]* |intern[a-z]* )?(?:systemov[a-z]* )?(?:prompt[a-z]*|instrukc[a-z]*|pokyn[a-z]*|zadani[a-z]*|pravid[a-z]*|nastaveni[a-z]*)`,
  },
  {
    id: 'exfiltration.cs.secrets',
    category: 'exfiltration',
    weight: 0.5,
    label: 'Chce poslat hesla / klíče / data zákazníků (CZ/SK)',
    pattern: `\\b${any('posli', 'poslete', 'preposli', 'prepos?lete', 'odesli', 'odeslete', 'odosli', 'odoslite', 'nahraj', 'nahrajte', 'zkopiruj', 'skopiruj', 'exportuj', 'exportujte', 'vypis', 'vypiste', 'prozrad', 'prezrad', 'ukaz', 'sdel', 'sdelte', 'vloz', 'vlozte', 'prilož', 'priloz', 'prilozte', 'dej mi', 'daj mi', 'zasli', 'zaslete', 'nadiktuj')}\\b${gap(50)}\\b${any('api ?kl[ic][a-z]*', 'api ?kluc[a-z]*', 'klic[ea]? (?:k api|api)', 'pristupov[a-z]* (?:klic|kluc|token|udaj)[a-z]*', 'tajn[a-z]* kl[ic][a-z]*', 'privatni kl[ic][a-z]*', 'hesl[ao]?', 'hesla', 'prihlasovac[a-z]* udaj[a-z]*', 'prihlasovac[a-z]* (?:jmen[ao]|meno|data)', 'token[a-z]*', '\\.env\\b', 'promenn[a-z]* prostredi', 'premenn[a-z]* prostredia', 'databaz[a-z]*', 'seznam[a-z]* zakazniku', 'zoznam[a-z]* zakaznikov', 'zakaznick[a-z]* (?:data|databaz[a-z]*|seznam[a-z]*|zoznam[a-z]*|udaj[a-z]*|kontakt[a-z]*|e-?mail[a-z]*)', 'kontakt[a-z]* (?:na )?(?:vsechny|vsetkych) zakazniky', 'osobni udaje', 'osobne udaje', 'cisl[ao] (?:platebnich|platobnych|kreditnich) karet', 'overovac[a-z]* kod[a-z]*', '2fa kod[a-z]*', 'sms kod[a-z]*')}`,
  },
  {
    id: 'exfiltration.cs.forward_all',
    category: 'exfiltration',
    weight: 0.5,
    label: 'Přeposlat veškerou poštu / komunikaci jinam (CZ/SK)',
    pattern: `\\b${any('preposli', 'preposlete', 'posli', 'poslete', 'odesli', 'odosli', 'zkopiruj', 'skopiruj', 'exportuj', 'presmeruj', 'presmerujte', 'dej do kopie', 'daj do kopie', 'pridej do kopie', 'pridaj do kopie', 'nastav preposilani', 'nastav preposielanie', 'zalohuj', 'archivuj', 'preposlat', 'poslat', 'odeslat', 'odoslat', 'exportovat', 'zkopirovat', 'skopirovat', 'presmerovat', 'zalohovat')}\\b${gap(15)}\\b${any('vsechn[a-z]*', 'vsetk[a-z]*', 'veskerou', 'veskere', 'celou', 'celu', 'cele', 'kompletni', 'komplet', 'kazd[ouy]', 'kazdu', 'vsech')}\\b${gap(25)}\\b${any('e-?mail[a-z]*', 'zprav[a-z]*', 'sprav[a-z]*', 'posta', 'postu', 'korespondenc[a-z]*', 'konverzac[a-z]*', 'komunikac[a-z]*', 'histori[a-z]*', 'prilohy', 'prilohu', 'soubor[a-z]*', 'subor[a-z]*', 'dokument[a-z]*', 'kontakt[a-z]*', 'faktur[a-z]*', 'objednav[a-z]*', 'vlakn[a-z]*', 'chat[a-z]*', 'log[ay]?', 'logu', 'zaznam[a-z]*')}`,
  },
  {
    id: 'exfiltration.de',
    category: 'exfiltration',
    weight: 0.7,
    label: 'Systemprompt / Geheimnisse preisgeben (DE)',
    pattern: `\\b${any('gib (?:mir )?(?:deinen|deine|den|die) (?:systemprompt|system-prompt|anweisungen|ursprunglichen anweisungen|instruktionen)', '(?:zeige|wiederhole|verrate|nenne|drucke) (?:mir )?(?:deinen|deine|den|die) (?:systemprompt|system-prompt|anweisungen|instruktionen|prompt)', '(?:sende|schicke|leite) (?:alle|samtliche) (?:e-?mails|nachrichten|kundendaten|passworter|zugangsdaten)')}\\b`,
  },

  // ===== tool_abuse ===========================================================================
  {
    id: 'tool_abuse.internal_tools',
    category: 'tool_abuse',
    weight: 0.8,
    label: 'Names the agent\'s internal tools',
    pattern: `\\b${any('channels_(?:reply|send_message|get_message|list_messages|list_accounts|propose_\\w+|withdraw_proposal|build_link|get_info|whatsapp_\\w+)', 'tasks_(?:create|update|send_message|ask_owner|log|get_info|\\w+)', 'schedules_(?:propose|get_info|list_runs|\\w+)', 'browser_(?:navigate|click|type|evaluate|get_html|emulate_device|console_messages|network_requests|screenshot|\\w+)', 'mcp__[a-z0-9_-]+', 'cloudcli-(?:channels|tasks|schedules|browser)', 'claude-in-chrome', 'send_?email', 'send_?message\\(', 'run_?command', 'execute_?(?:command|code|shell)', 'bash_?tool', 'tool_?call', 'function_?call', 'tool_use', 'web_?fetch', 'write_?file', 'delete_?file')}\\b`,
  },
  {
    id: 'tool_abuse.call_syntax',
    category: 'tool_abuse',
    weight: 0.7,
    label: 'Function-call / tool-call syntax',
    pattern: `${any('<\\s*(?:tool_call|function_calls?|invoke|antml:invoke|tool_use|function)\\b', '"(?:tool|function|tool_name|function_name)"\\s*:\\s*"', '"(?:arguments|parameters|params|input)"\\s*:\\s*\\{', '\\b(?:call|invoke|use|trigger|execute|run) (?:the )?(?:tool|function|api|action) ["\'`]?[a-z_]+["\'`]?(?: with| using|\\()')}`,
  },
  {
    id: 'tool_abuse.kv_call',
    category: 'tool_abuse',
    weight: 0.6,
    label: 'Recipient and body spelled out like tool arguments',
    pattern: `\\b(?:to|recipient|recipients|address|email|send_?to)\\s*(?:\\(\\s*value\\s*:|[=:(])\\s*["'\\[]?\\s*\\S+@\\S+[\\s\\S]{0,160}?\\b(?:body|message|content|text|subject)\\s*(?:\\(\\s*value\\s*:|[=:(])\\s*["'\\[]?`,
  },
  {
    id: 'tool_abuse.make_agent',
    category: 'tool_abuse',
    weight: 0.8,
    label: 'Talks about making "the agent" do something',
    pattern: `\\b(?:have|make|get|force|trick|cause|convince|instruct|ask|tell|order|let) the (?:ai |email |mail )?(?:agent|assistant|ai|model|llm|bot|system|summari[sz]er) (?:to )?(?:send|forward|reply|respond|call|execute|run|issue|trigger|invoke|email|write|delete|output|click|open|visit|transfer|pay|approve)\\b`,
  },
  {
    id: 'tool_abuse.send_with_body',
    category: 'tool_abuse',
    weight: 0.5,
    label: 'Dictates an e-mail to send ("to X with body Y")',
    pattern: `\\b${any('send', 'reply', 'respond', 'write', 'compose', 'draft', 'forward', 'email', 'e-mail', 'mail')}\\b${gap(60)}(?:\\S+@\\S+|\\bto\\b)${gap(60)}\\b${any('with (?:the |a )?(?:body|subject|content|text|message)', 'containing (?:the |only |just |exactly )', 'whose (?:body|subject|content)', 'saying (?:only|exactly|just)', '(?:body|subject|content)\\s*(?::|=|should be|must be|set to)')}`,
  },
  {
    id: 'tool_abuse.exact_words',
    category: 'tool_abuse',
    weight: 0.45,
    label: 'Dictates exact output ("only the word …")',
    pattern: `\\b${any('(?:containing|with|saying|reply with|respond with|answer with|output|print|write) (?:only|just|exactly|simply) (?:the )?(?:word|words|text|string|phrase|token|sentence)', '\\b(?:output|respond|reply|answer|print|return|say|write|odpovez|odpovedz|napis|vypis|vrat)(?:te)? (?:only|just|pouze|jen|len)\\s*:?\\s*["\']', '(?:send|sending|with|containing|using|use|include|including|reply|replying|respond|responding) (?:only |just |exactly )?(?:the )?(?:single )?(?:word|keyword|phrase|code ?word|string) ["\']', '(?:only|just) (?:the )?(?:word|text|string) ["\'][^"\'\\n]{1,40}["\']', '(?:odpovez|odpovedz|napis|posli|vypis)(?:te)? (?:pouze|jen|len|presne) (?:slovo|slova|text|vetu)')}`,
  },
  {
    id: 'tool_abuse.shell',
    category: 'tool_abuse',
    weight: 0.45,
    label: 'Asks to run a shell command / script',
    pattern: `${any(
      '\\b(?:run|execute|exec|launch|spust|spustte|spusti|spustite|proved|provedte|vykonaj|vykonajte)\\b(?: (?:the|this|following|tento|tenhle|tuto|nasledujici|nasledovny))? (?:command|commands|script|shell|terminal|bash|prikaz|prikazy|skript|code|kod)\\b',
      '\\b(?:curl|wget)\\s+(?:-[a-z]+\\s+)*https?://',
      '\\brm\\s+-[rf]{1,2}\\s+[/~*.]',
      '\\|\\s*(?:ba)?sh\\b',
      '\\b(?:base64\\s+-d|eval\\s*\\(|exec\\s*\\(|os\\.system|subprocess\\.)',
      '\\b(?:git push --force|git push -f|chmod 777|nc -e|/dev/tcp/)',
    )}`,
  },
  {
    id: 'tool_abuse.approve_self',
    category: 'tool_abuse',
    weight: 0.7,
    label: 'Asks the agent to change its own permissions / approvals',
    pattern: `\\b${any(
      `(?:approve|confirm|enable|activate|turn on|switch to) (?:your own |the |this |all )?(?:drafts?|proposals?|rules?|bypass ?permissions|auto(?:matic)?[- ]?(?:reply|send|approve|approval)|autonomous mode|yolo mode)\\b${gap(30)}\\b(?:without|yourself|automatically|for me|on my behalf)`,
      '(?:change|set|switch|update) (?:the |your )?(?:permission|reply|approval) mode',
      '(?:schval|potvrd|zapni|aktivuj)(?:te)? (?:si )?(?:sam[ao]?|sve|svuj|svoje|vsechny|vsetky)? ?(?:koncept[a-z]*|navrh[a-z]*|pravidl[a-z]*|automatick[a-z]* (?:odpoved|odesil|odosiel|schval)[a-z]*)',
      '(?:zmen|nastav|prepni)(?:te)? (?:si )?(?:rezim|mod) (?:opravneni|odpovedi|schvalovani|odpovedania|schvalovania)',
    )}`,
  },
  {
    id: 'tool_abuse.payment',
    category: 'tool_abuse',
    weight: 0.3,
    label: 'Changes bank details / asks for a payment (weak: invoice fraud looks like this)',
    pattern: `\\b${any(
      '(?:change|update|replace|use) (?:the |our |my )?(?:bank account|account number|iban|bank details|payment details|beneficiary)',
      '(?:zmen|zmente|aktualizuj|aktualizujte|nahrad|pouzij|pouzijte) (?:si )?(?:cislo uctu|bankovni (?:ucet|spojeni|udaje)|bankovy (?:ucet|spojenie)|iban|platebni udaje|platobne udaje)',
      '(?:transfer|wire|send|pay|zaplat|posli|preved|poukaz)[a-z]* (?:the )?(?:\\d[\\d\\s.,]*\\s*(?:kc|czk|eur|usd|\\$|€)|money|penize|peniaze|castku|sumu|platbu)',
    )}`,
  },

  // ===== concealment ==========================================================================
  {
    id: 'concealment.en',
    category: 'concealment',
    weight: 0.6,
    label: 'Hide this from the user / owner (EN)',
    pattern: `\\b${any(
      "(?:do not|don't|dont|never|without) (?:tell(?:ing)?|inform(?:ing)?|notify(?:ing)?|mention(?:ing)?|reveal(?:ing)?|alert(?:ing)?|let(?:ting)? (?:\\w+ )?know|disclos(?:e|ing)|report(?:ing)?|show(?:ing)?|ask(?:ing)?|warn(?:ing)?|confirm(?:ing)? with) (?:the |your |this )?(?:user|owner|human|operator|admin|administrator|recipient|lars|boss|supervisor|anyone|anybody|him|her|them)\\b",
      "(?:do not|don't|dont|never) (?:include|mention|reference|summari[sz]e|reveal|disclose|show|repeat|quote|report) (?:this|these|the|that|my) (?:instructions?|message|part|section|paragraph|email|e-mail|request|command|note|text|step|action)",
      'keep (?:this|it|these instructions) (?:secret|hidden|confidential|private|between us) from (?:the )?(?:user|owner|human)',
      '(?:the )?(?:user|owner|human) (?:must|should|will) (?:not|never) (?:know|find out|see|notice|be told)',
      '(?:silently|quietly|secretly|covertly|discreetly|invisibly) (?:send|forward|execute|run|perform|do|reply|delete|add|include|approve|transfer|copy)',
      "without (?:asking|waiting) for (?:the )?(?:user'?s? |owner'?s? |human |your |any |their )?(?:approval|confirmation|permission|consent|review)",
      "(?:immediately|right away|automatically) (?:and )?without (?:user |human |owner |any )?(?:confirmation|approval|review|asking)",
    )}`,
  },
  {
    id: 'concealment.cs',
    category: 'concealment',
    weight: 0.6,
    label: 'Utaj to před uživatelem / majitelem (CZ/SK)',
    pattern: `\\b${any(
      `(?:nerikej|nerikejte|nehovor|nehovorte|nepovedz|nepovedzte|neinformuj|neinformujte|neupozornuj|neupozornujte|neupozorni|nezminuj|nezminujte|nespominaj|nespominajte|neoznamuj|neoznamujte|neprozrazuj|neprezradzuj|nesdeluj|nesdelujte|neukazuj|neukazujte|nehlas|nehlaste|nevaruj)\\b${gap(30)}\\b(?:uzivatel[a-z]*|pouzivatel[a-z]*|majitel[a-z]*|vlastnik[a-z]*|nikomu|nikoho|lars[a-z]*|sef[a-z]*|spravc[a-z]*|administrator[a-z]*|cloveku|cloveka|operator[a-z]*|adresat[a-z]*|jemu|ji|im|nim)`,
      `(?:tuto|tenhle|tento|tyto|tieto|tuhle|toto) (?:zpravu|spravu|instrukci|instrukciu|pokyn|pokyny|cast|odstavec|e-?mail|text|krok|prikaz)\\b${gap(20)}\\b(?:nezminuj|nespominaj|neuvadej|neuvadzaj|nezahrnuj|vynech|nezobrazuj|neshrnuj|nesumarizuj|necituj|neopakuj|nehlas|nereportuj|smaz|zmaz|skryj)`,
      `(?:potichu|tajne|nenapadne|skryte|diskretne|po tichu)\\b${gap(15)}\\b(?:posli|preposli|odesli|odosli|spust|proved|vykonaj|smaz|zmaz|pridej|pridaj|schval|preved|zkopiruj|skopiruj|uprav|zmen)`,
      'bez (?:vedomi|vedomia|schvaleni|schvalenia|potvrzeni|potvrdenia|ptani|pytania|zeptani|svoleni|suhlasu|souhlasu) (?:uzivatel|pouzivatel|majitel|vlastnik|lars|sef|spravc|nikoho|cloveka|adresat)',
      '(?:uzivatel|pouzivatel|majitel|vlastnik|lars|sef)[a-z]* (?:se )?(?:to |o tom )?(?:nesmi|nema|nesmie|nemusi) (?:dozvedet|vedet|vediet|zjistit|zistit|videt|vidiet|poznat)',
    )}`,
  },
  {
    id: 'concealment.de',
    category: 'concealment',
    weight: 0.6,
    label: 'Vor dem Benutzer verbergen (DE)',
    pattern: `\\b${any('(?:sag|sage|erzahle|informiere) (?:es )?(?:niemandem|nicht dem (?:benutzer|nutzer|besitzer))', 'ohne (?:den (?:benutzer|nutzer|besitzer)|jemanden) zu (?:informieren|fragen|benachrichtigen)', 'erwahne (?:dies|das|diese (?:anweisung|nachricht)) nicht', 'heimlich (?:senden|weiterleiten|ausfuhren)')}\\b`,
  },

  // ===== persistence ==========================================================================
  {
    id: 'persistence.en',
    category: 'persistence',
    weight: 0.45,
    label: 'Plants a rule for future messages (EN)',
    pattern: `\\b${any(
      `(?:remember|memori[sz]e|store|save|keep|note|learn) (?:this|that|the following|these (?:instructions|rules))${gap(40)}\\b(?:for (?:all )?(?:future|subsequent|later|every|each)|from now on|permanently|forever|in your memory|for next time|going forward)`,
      `(?:in|for) (?:all|every|each) (?:future|subsequent|later|following) (?:e-?mails?|messages?|replies|responses|conversations?|interactions?)${gap(40)}\\b(?:always|also|include|add|send|forward|cc|bcc|reply|respond|append)`,
      'add (?:\\S+@\\S+ )?(?:to |in |as )?(?:bcc|cc|blind copy)(?: on| in| to)? (?:all|every|each|any|future)',
      'must be (?:included|added|mentioned|stated|repeated) (?:in|to|at the end of) (?:every|each|all|any) (?:future |subsequent )?(?:responses?|replies|answers?|outputs?|summar(?:y|ies))',
      '(?:update|edit|modify|write to|append to) (?:your |the )?(?:memory|claude\\.md|agents\\.md|system prompt|instructions file|rules file)',
    )}`,
  },
  {
    id: 'persistence.cs',
    category: 'persistence',
    weight: 0.45,
    label: 'Zavádí pravidlo pro další zprávy (CZ/SK)',
    pattern: `\\b${any(
      `(?:zapamatuj|zapamataj|uloz|ulozte|poznamenej|poznac)(?:te)? si${gap(40)}\\b(?:navzdy|natrvalo|trvale|pro (?:vsechny|kazdou|budouci|dalsi|pristi)|pre (?:vsetky|kazdu|buduce|dalsie)|od ted|odteraz|napriste|do budoucna|do buducna)`,
      `(?:ke kazde|ku kazdej|do kazde|do kazdej|u kazde|pri kazdej|vzdy pri|vzdy u|pokazde pri|v kazde|v kazdej) (?:dalsi |dalsej |budouci |buducej )?(?:odpovedi|zprave|sprave|e-?mailu|zpravy|spravy)${gap(40)}\\b(?:pridej|pridaj|posli|preposli|kopii|kopiu|bcc|cc|pripoj|vloz|uved)`,
      '(?:uprav|zmen|prepis|dopln|zapis)(?:te)? (?:si )?(?:do )?(?:svou |svoju |tvou |tvoju )?(?:pamet|pamat|claude\\.md|agents\\.md|systemov[yi] prompt|instrukc[ei]|pravidl[ao])',
    )}`,
  },

  // ===== obfuscation ==========================================================================
  {
    id: 'obfuscation.decode_and_follow',
    category: 'obfuscation',
    weight: 0.8,
    label: 'Decode this and follow it',
    pattern: `\\b${any('decode', 'decrypt', 'deobfuscate', 'unscramble', 'reverse', 'translate', 'convert', 'interpret', 'dekoduj(?:te)?', 'desifruj(?:te)?', 'rozsifruj(?:te)?', 'prelož', 'preloz(?:te)?', 'preved(?:te)?', 'rozkoduj(?:te)?', 'dekodiere', 'entschlussele')}\\b${gap(40)}\\b${any('base ?64', 'rot ?-?13', 'hex(?:adecimal)?', 'binary', 'binarn[a-z]*', 'morse', 'morseov[a-z]*', 'caesar', 'cipher', 'sifr[a-z]*', 'reversed', 'pozpatku', 'odzadu', 'backwards', 'unicode', 'ascii')}\\b${gap(60)}\\b${any('follow', 'execute', 'do (?:what|as)', 'obey', 'perform', 'act on', 'run', 'carry out', 'apply', 'comply', 'proved', 'provedte', 'spln', 'splnte', 'udelej', 'urob', 'postupuj', 'vykonaj', 'rid se', 'riad sa', 'nasleduj', 'befolge', 'fuhre aus')}`,
  },
  {
    id: 'obfuscation.spaced_letters',
    category: 'obfuscation',
    weight: 0.25,
    label: 'Words written with s p a c e d letters',
    pattern: '(?:\\b[a-z][ .\\-_*/]){10,}[a-z]\\b',
  },
];
