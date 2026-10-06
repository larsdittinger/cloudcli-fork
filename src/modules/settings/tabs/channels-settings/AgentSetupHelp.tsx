import SettingsCard from '@/modules/settings/SettingsCard';

function Code({ children }: { children: string }) {
  return <code className="break-all rounded bg-muted px-1 py-0.5 text-xs">{children}</code>;
}

/** Used by ChannelsSettingsTab to explain what agents can set up themselves and how prompt links work. */
export default function AgentSetupHelp() {
  const origin = window.location.origin;
  return (
    <SettingsCard>
      <div className="space-y-4 p-4 text-sm">
        <div>
          <p className="font-medium">Agents know how Channels work</p>
          <p className="mt-1 text-muted-foreground">
            Every agent has the <Code>cloudcli-channels</Code> MCP server. <Code>channels_get_info</Code> gives it the full guide
            (accounts, rules, reply modes, prompt templates, webhook payloads) plus the live state of this instance. Just ask in a chat,
            e.g. “set yourself up to handle e-mails from @firma.cz in this project” or “create a webhook for n8n”.
          </p>
        </div>

        <div>
          <p className="font-medium">Agent proposals need your approval (unless the switch above is on)</p>
          <p className="mt-1 text-muted-foreground">
            Agents can propose accounts (<Code>channels_propose_account</Code>: e-mail, WhatsApp, webhook) and rules
            (<Code>channels_propose_rule</Code>, defaulting to the agent’s project). A proposal shows up below as
            <span className="font-medium text-amber-700 dark:text-amber-300"> Proposed by an agent</span>, stays disabled and does nothing
            until you press <span className="font-medium">Approve</span> — check permission mode, reply mode and senders first. The inbox badge
            counts waiting proposals. Agents never change or delete approved accounts and rules; they can only withdraw their own proposals.
            For WhatsApp the agent can hand you a pairing code after approval.
          </p>
        </div>

        <div>
          <p className="font-medium">Links with a prepared prompt</p>
          <p className="mt-1 text-muted-foreground">
            Agents can put links into e-mails or messages for you (<Code>channels_build_link</Code>). A link opens CloudCLI with the prompt
            already typed into the composer — it is never sent on its own; you read it, edit it and send it. Several links in one e-mail work
            as ready-made actions (“Look at this e-mail and draft a reply”, “Offer a discount”, “Ask for the delivery address”).
          </p>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            <li><Code>{`${origin}/session/<chat id>?prompt=…`}</Code> — continues that chat with its history (for an inbound message: the chat it started)</li>
            <li><Code>{`${origin}/?project=<project path>&prompt=…`}</Code> — new chat in the project</li>
          </ul>
          <p className="mt-1 text-muted-foreground">
            The prompt is URL-encoded, at most 4000 characters. You have to be signed in; a restricted user only opens their own projects.
            You can write such links by hand too, e.g. into bookmarks for prompts you use often.
          </p>
        </div>
      </div>
    </SettingsCard>
  );
}
