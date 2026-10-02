import os
import unittest
from unittest.mock import MagicMock, patch

from channel_webhook import email_handoff, run_agent


class WebhookClientTests(unittest.TestCase):
    payload = {'id': 'mid.1', 'from': 'meta-monitor', 'text': 'Customer message', 'thread': 'meta:page:person'}
    env = {'CLOUDCLI_WEBHOOK_URL': 'https://cloudcli.example/api/channels/webhook/account', 'CLOUDCLI_WEBHOOK_TOKEN': 'secret'}

    def snapshot(self, status, action='reply'):
        return {'messageId': 'message', 'externalId': 'mid.1', 'thread': self.payload['thread'], 'status': 'dispatched',
                'results': [{'id': 'outbox', 'status': status, 'action': action, 'text': 'Answer'}]}

    def test_drafts_wait_for_approval(self):
        with patch.dict(os.environ, self.env), patch('channel_webhook.request', side_effect=[{'messageId': 'message'}, self.snapshot('draft'), self.snapshot('sent')]) as api, patch('channel_webhook.time.sleep') as sleep:
            result = run_agent(self.payload)
            self.assertEqual(result['action'], 'reply')
            self.assertEqual(result['id'], 'outbox')
            self.assertEqual(api.call_args_list[0].args[2]['id'], 'mid.1')
            sleep.assert_called_once_with(2)

    def test_escalation_remains_a_separate_action(self):
        with patch.dict(os.environ, self.env), patch('channel_webhook.request', side_effect=[{'messageId': 'message'}, self.snapshot('sent', 'escalate')]):
            self.assertEqual(run_agent(self.payload)['action'], 'escalate')

    def test_unmatched_or_failed_does_not_become_an_answer(self):
        for status in ('unmatched', 'failed'):
            with patch.dict(os.environ, self.env), patch('channel_webhook.request', side_effect=[{'messageId': 'message'}, {'status': status, 'results': []}]):
                with self.assertRaises(RuntimeError):
                    run_agent(self.payload)

    def test_email_uses_fixed_operator_recipient(self):
        env = {'SMTP_FROM': 'bot@example.com', 'HANDOFF_EMAIL_TO': 'operator@example.com', 'SMTP_HOST': 'smtp.example.com', 'SMTP_USER': 'user', 'SMTP_PASSWORD': 'secret', 'SMTP_PORT': '465'}
        smtp = MagicMock()
        with patch.dict(os.environ, env), patch('channel_webhook.smtplib.SMTP_SSL', return_value=smtp):
            decision = self.snapshot('sent', 'escalate')['results'][0]
            email_handoff({**decision, 'to': 'untrusted-customer@example.com', 'thread': 'meta:person', 'externalId': 'mid.1'})
            mail = smtp.send_message.call_args.args[0]
            self.assertEqual(mail['To'], 'operator@example.com')
            self.assertIn('meta:person', mail.get_content())

    def test_reply_cannot_be_sent_as_an_internal_email(self):
        with self.assertRaises(ValueError):
            email_handoff({'action': 'reply'})


if __name__ == '__main__':
    unittest.main()
