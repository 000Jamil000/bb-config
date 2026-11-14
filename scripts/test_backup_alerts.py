import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('backup', Path(__file__).with_name('server_backup.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class Inbox:
    def __init__(self):
        self.events = []
        self.fail = False

    def call(self, *args, **kwargs):
        if self.fail:
            raise RuntimeError('temporarily unavailable')
        if args[4] == 'activityCapabilities':
            return {'version': 1}
        path = args[args.index('--input-file') + 1]
        self.events.append(json.loads(Path(path).read_text()))
        return {'accepted': True, 'id': 'activity', 'duplicate': False}


class AlertTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.source = Path(self.temp.name)
        self.inbox = Inbox()

    def tearDown(self):
        self.temp.cleanup()

    def test_repeated_failure_is_one_item_and_recovery_is_one_new_outcome(self):
        backup.report_backup_alert(self.source, 'backup-error', self.inbox, now=10)
        backup.report_backup_alert(self.source, 'backup-error', self.inbox, now=20)
        self.assertEqual(len(self.inbox.events), 1)
        backup.report_backup_alert(self.source, 'healthy', self.inbox, now=20)
        backup.report_backup_alert(self.source, 'healthy', self.inbox, now=30)
        self.assertEqual(len(self.inbox.events), 2)
        failed, recovered = self.inbox.events
        self.assertEqual((failed['status'], recovered['status']), ('error', 'ready'))
        self.assertEqual(failed['entityId'], recovered['entityId'])
        self.assertGreater(recovered['occurredAt'], failed['occurredAt'])
        self.assertEqual(len(recovered['target']['segments']), 2)

    def test_unavailable_inbox_keeps_same_event_for_retry(self):
        self.inbox.fail = True
        backup.report_backup_alert(self.source, 'backup-error', self.inbox, now=10)
        initial = backup.read_json(self.source / 'notification-state.json')['event']
        self.inbox.fail = False
        backup.report_backup_alert(self.source, 'backup-error', self.inbox, now=20)
        self.assertEqual(self.inbox.events, [initial])

    def test_short_offline_period_is_quiet_but_a_day_without_delivery_alerts(self):
        backup.delivery_succeeded(self.source, Path('yesterday.age'), self.inbox, now=0)
        backup.delivery_pending(self.source, self.inbox, now=6 * 3600)
        self.assertEqual(self.inbox.events, [])
        backup.delivery_pending(self.source, self.inbox, now=24 * 3600)
        backup.delivery_pending(self.source, self.inbox, now=25 * 3600)
        self.assertEqual(len(self.inbox.events), 1)
        self.assertEqual(self.inbox.events[0]['status'], 'error')
        backup.delivery_succeeded(self.source, Path('today.age'), self.inbox, now=26 * 3600)
        self.assertEqual(self.inbox.events[-1]['status'], 'ready')

    def test_ordinary_success_does_not_create_notifications(self):
        backup.delivery_succeeded(self.source, Path('today.age'), self.inbox, now=10)
        backup.delivery_succeeded(self.source, Path('today.age'), self.inbox, now=20)
        self.assertEqual(self.inbox.events, [])
        self.assertEqual(backup.read_json(self.source / 'delivery-state.json')['lastSuccessfulDeliveryAt'], 10)


if __name__ == '__main__':
    unittest.main()
