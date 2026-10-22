"""Watchdog 故障路径回归；全部网络、systemctl 和等待均使用替身。"""
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location(
    'tunnel_watchdog', Path(__file__).resolve().parents[1] / 'scripts/tunnel-watchdog.py',
)
watchdog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(watchdog)


class WatchdogTests(unittest.TestCase):
    def setUp(self):
        watchdog.fail_count = 0
        watchdog.last_restart = None
        watchdog.restart_history[:] = []
        self.logs = mock.patch.object(watchdog, 'log').start()
        self.addCleanup(mock.patch.stopall)

    def test_probe_closes_response_and_sets_request_timeout(self):
        response = mock.MagicMock()
        response.__enter__.return_value.status = 200
        with mock.patch.object(watchdog.urllib.request, 'urlopen', return_value=response) as get:
            self.assertTrue(watchdog.check_tunnel())
        self.assertEqual(get.call_args.kwargs['timeout'], watchdog.CHECK_TIMEOUT)
        response.__exit__.assert_called_once()

    def test_probe_non_200_or_network_error_is_failure(self):
        response = mock.MagicMock()
        response.__enter__.return_value.status = 503
        with mock.patch.object(watchdog.urllib.request, 'urlopen', return_value=response):
            self.assertFalse(watchdog.check_tunnel())
        with mock.patch.object(watchdog.urllib.request, 'urlopen', side_effect=TimeoutError()):
            self.assertFalse(watchdog.check_tunnel())

    def test_restart_timeout_returns_failure_and_reports_uncertain_service_job(self):
        with mock.patch.object(watchdog.subprocess, 'run', side_effect=subprocess.TimeoutExpired('systemctl', 30)):
            self.assertFalse(watchdog.restart_cloudflared())
        self.assertIn('服务端任务可能仍在执行', self.logs.call_args.args[0])

    def test_restart_launch_errors_and_nonzero_status_do_not_escape(self):
        for error in [FileNotFoundError(), PermissionError()]:
            with self.subTest(error=type(error).__name__):
                with mock.patch.object(watchdog.subprocess, 'run', side_effect=error):
                    self.assertFalse(watchdog.restart_cloudflared())
        with mock.patch.object(watchdog.subprocess, 'run', return_value=mock.Mock(returncode=1)):
            self.assertFalse(watchdog.restart_cloudflared())

    def test_successful_restart_uses_bounded_systemctl_command(self):
        with mock.patch.object(watchdog.subprocess, 'run', return_value=mock.Mock(returncode=0)) as run:
            self.assertTrue(watchdog.restart_cloudflared())
        run.assert_called_once_with(
            ['systemctl', '--user', 'restart', 'cloudflared.service'],
            capture_output=True, text=True, timeout=watchdog.RESTART_TIMEOUT,
        )

    def test_transient_failure_does_not_restart_and_recovery_resets_counter(self):
        with mock.patch.object(watchdog, 'check_tunnel', side_effect=[False, False, True]), \
                mock.patch.object(watchdog, 'restart_cloudflared') as restart:
            for _ in range(3):
                watchdog.check_once()
        restart.assert_not_called()
        self.assertEqual(watchdog.fail_count, 0)

    def test_timeout_reserves_budget_and_cooldown_then_allows_later_attempt(self):
        watchdog.fail_count = watchdog.FAIL_THRESHOLD - 1
        with mock.patch.object(watchdog, 'check_tunnel', return_value=False), \
                mock.patch.object(watchdog.time, 'monotonic', side_effect=[1000, 1060, 1300]), \
                mock.patch.object(watchdog.subprocess, 'run', side_effect=subprocess.TimeoutExpired('systemctl', 30)) as run:
            watchdog.check_once()
            self.assertEqual(watchdog.restart_history, [1000])
            watchdog.check_once()
            self.assertEqual(run.call_count, 1)
            watchdog.check_once()
        self.assertEqual(run.call_count, 2)
        self.assertEqual(watchdog.restart_history, [1000, 1300])
        self.assertEqual(watchdog.last_restart, 1300)

    def test_main_keeps_polling_after_restart_timeout(self):
        watchdog.fail_count = watchdog.FAIL_THRESHOLD - 1
        with mock.patch.object(watchdog, 'check_tunnel', side_effect=[False, True]) as probe, \
                mock.patch.object(watchdog.time, 'monotonic', return_value=1000), \
                mock.patch.object(watchdog.subprocess, 'run', side_effect=subprocess.TimeoutExpired('systemctl', 30)), \
                mock.patch.object(watchdog.time, 'sleep', side_effect=[None, StopIteration()]):
            with self.assertRaises(StopIteration):
                watchdog.main()
        self.assertEqual(probe.call_count, 2)
        self.assertEqual(watchdog.fail_count, 0)

    def test_failed_commands_count_towards_hourly_limit(self):
        watchdog.fail_count = watchdog.FAIL_THRESHOLD - 1
        with mock.patch.object(watchdog, 'check_tunnel', return_value=False), \
                mock.patch.object(watchdog.time, 'monotonic', side_effect=[1000 + 300 * i for i in range(7)]), \
                mock.patch.object(watchdog, 'restart_cloudflared', return_value=False) as restart:
            for _ in range(7):
                watchdog.check_once()
        self.assertEqual(restart.call_count, watchdog.MAX_RESTARTS_PER_HOUR)
        self.assertEqual(len(watchdog.restart_history), watchdog.MAX_RESTARTS_PER_HOUR)

    def test_expired_attempts_release_hourly_budget(self):
        watchdog.fail_count = watchdog.FAIL_THRESHOLD
        watchdog.last_restart = 2500
        watchdog.restart_history[:] = [1000, 1300, 1600, 1900, 2200, 2500]
        with mock.patch.object(watchdog, 'check_tunnel', return_value=False), \
                mock.patch.object(watchdog.time, 'monotonic', return_value=4600), \
                mock.patch.object(watchdog, 'restart_cloudflared', return_value=False) as restart:
            watchdog.check_once()
        restart.assert_called_once()
        self.assertNotIn(1000, watchdog.restart_history)
        self.assertEqual(watchdog.restart_history[-1], 4600)

    def test_wall_clock_change_does_not_bypass_cooldown(self):
        watchdog.fail_count = watchdog.FAIL_THRESHOLD
        watchdog.last_restart = 1000
        with mock.patch.object(watchdog, 'check_tunnel', return_value=False), \
                mock.patch.object(watchdog.time, 'monotonic', return_value=1060), \
                mock.patch.object(watchdog.time, 'time', side_effect=AssertionError('must use monotonic clock')), \
                mock.patch.object(watchdog, 'restart_cloudflared') as restart:
            watchdog.check_once()
        restart.assert_not_called()

    def test_recovery_after_success_and_unrecovered_restart_both_preserve_budget(self):
        for recovered in [True, False]:
            with self.subTest(recovered=recovered):
                watchdog.fail_count = watchdog.FAIL_THRESHOLD - 1
                watchdog.last_restart = None
                watchdog.restart_history[:] = []
                with mock.patch.object(watchdog, 'check_tunnel', return_value=False), \
                        mock.patch.object(watchdog.time, 'monotonic', return_value=1000), \
                        mock.patch.object(watchdog, 'restart_cloudflared', return_value=True), \
                        mock.patch.object(watchdog, 'verify_recovery', return_value=recovered):
                    watchdog.check_once()
                self.assertEqual(watchdog.fail_count, 0 if recovered else watchdog.FAIL_THRESHOLD)
                self.assertEqual(watchdog.restart_history, [1000])


if __name__ == '__main__':
    unittest.main()
