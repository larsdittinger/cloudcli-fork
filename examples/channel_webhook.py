#!/usr/bin/env python3
"""Bridge an existing message watcher to CloudCLI (Python standard library only).

Set CLOUDCLI_WEBHOOK_URL to the account's full /api/channels/webhook/<id> URL,
CLOUDCLI_WEBHOOK_TOKEN to its token. Pass normalized JSON on stdin, including a
stable id and thread. stdout is the approved decision for your watcher to handle.
No Meta credentials are needed here: your existing watcher sends action=reply
through its own Meta integration. Never send action=escalate to the customer.

Optional --email-handoff sends escalation to the fixed HANDOFF_EMAIL_TO via SMTP.
SMTP_HOST, SMTP_USER, SMTP_PASSWORD, SMTP_FROM are required; SMTP_PORT defaults
465 (implicit TLS), other ports use STARTTLS. Credentials belong in environment.
The watcher must record processed decision ids to prevent duplicate replies/mail.
On timeout, retry with the SAME inbound id; CloudCLI won't start a second agent.
"""

import argparse
import json
import os
import smtplib
import ssl
import sys
import time
from email.message import EmailMessage
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward the account token to another URL.


def request(url, token, payload=None):
    body = json.dumps(payload).encode() if payload is not None else None
    req = Request(url, data=body, headers={
        'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
    })
    with build_opener(NoRedirect).open(req, timeout=30) as response:
        result = json.load(response)
    if not result.get('success'):
        raise RuntimeError('CloudCLI rejected the request')
    return result['data']


def run_agent(payload, timeout=600):
    url = os.environ['CLOUDCLI_WEBHOOK_URL'].rstrip('/')
    token = os.environ['CLOUDCLI_WEBHOOK_TOKEN']
    parts = urlsplit(url)
    if parts.scheme not in ('http', 'https') or parts.query or parts.fragment or parts.username:
        raise ValueError('CLOUDCLI_WEBHOOK_URL must be the HTTP(S) account URL without credentials or query')
    if not isinstance(payload, dict) or not all(isinstance(payload.get(key), str) and payload[key].strip() for key in ('id', 'from', 'text', 'thread')):
        raise ValueError('Input needs non-empty string id, from, text, thread')
    accepted = request(url, token, payload)
    result_url = url + '/messages/' + quote(accepted['messageId'], safe='')
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        data = request(result_url, token)
        if data['status'] in ('failed', 'unmatched', 'ignored'):
            raise RuntimeError('Message was not handled: ' + data['status'] + ': ' + (data.get('statusDetail') or 'check Channels rules and Inbox'))
        # Drafts are visible to polling but MUST wait for approval in CloudCLI.
        ready = [item for item in data['results'] if item['status'] == 'sent']
        if ready:
            if len(ready) != 1:
                raise RuntimeError('Agent produced multiple decisions; review them in CloudCLI')
            decision = ready[0]
            if decision['action'] not in ('reply', 'escalate'):
                raise RuntimeError('Unsupported decision action')
            return {**decision, 'messageId': data['messageId'], 'externalId': data['externalId'], 'thread': data['thread']}
        if any(item['status'] in ('failed', 'discarded') for item in data['results']):
            raise RuntimeError('Decision failed or was discarded; review it in CloudCLI')
        time.sleep(2)
    raise TimeoutError('No approved decision yet. Retry the same input id or inspect CloudCLI Inbox.')


def email_handoff(decision):
    """Recipient is fixed by the operator, never read from the customer/agent."""
    if decision['action'] != 'escalate':
        raise ValueError('Only escalations may be emailed')
    mail = EmailMessage()
    mail['From'] = os.environ['SMTP_FROM']
    mail['To'] = os.environ['HANDOFF_EMAIL_TO']
    mail['Subject'] = 'CloudCLI: zprávu musí vyřídit člověk'
    mail['Message-ID'] = '<cloudcli-' + decision['id'] + '@' + os.environ['SMTP_FROM'].split('@')[-1] + '>'
    mail.set_content('Vlákno: ' + decision['thread'] + '\nID zprávy: ' + decision['externalId'] + '\n\n' + decision['text'])
    port = int(os.environ.get('SMTP_PORT', '465'))
    context = ssl.create_default_context()
    if port == 465:
        smtp = smtplib.SMTP_SSL(os.environ['SMTP_HOST'], port, timeout=30, context=context)
    else:
        smtp = smtplib.SMTP(os.environ['SMTP_HOST'], port, timeout=30)
    with smtp:
        if port != 465:
            smtp.starttls(context=context)
        smtp.login(os.environ['SMTP_USER'], os.environ['SMTP_PASSWORD'])
        smtp.send_message(mail)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--timeout', type=int, default=600)
    parser.add_argument('--email-handoff', action='store_true')
    args = parser.parse_args()
    if args.email_handoff:
        # Fail before starting an agent when notification configuration is missing.
        for key in ('SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM', 'HANDOFF_EMAIL_TO'):
            if not os.environ.get(key):
                raise ValueError('Missing ' + key)
    decision = run_agent(json.load(sys.stdin), timeout=args.timeout)
    if args.email_handoff and decision['action'] == 'escalate':
        email_handoff(decision)
        decision['emailSent'] = True
    print(json.dumps(decision, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (KeyError, ValueError, RuntimeError, TimeoutError, HTTPError, URLError, OSError) as error:
        print('CloudCLI webhook: ' + str(error), file=sys.stderr)
        sys.exit(1)
