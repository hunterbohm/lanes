"""Tests for server/lanes. Run: python -m unittest discover -s tests"""
import importlib.machinery
import importlib.util
import json
import os
import socket
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
_loader = importlib.machinery.SourceFileLoader("lanes", str(ROOT / "server" / "lanes"))
_spec = importlib.util.spec_from_loader("lanes", _loader)
lanes = importlib.util.module_from_spec(_spec)
_loader.exec_module(lanes)

LOG = [
    "2026-11-08 10:00:00Z: Listening for Jobs",
    "2026-11-08 10:01:00Z: Running job: build",
    "2026-11-08 10:03:30Z: Job build completed with result: Succeeded",
    "2026-11-08 10:04:00Z: Running job: test",
    "2026-11-08 10:05:00Z: Job test completed with result: Failed",
    "2026-11-08 10:06:00Z: Running job: lint",
]


class RunnerLogs(unittest.TestCase):
    def test_events_read_starts_and_results(self):
        events = lanes.runner_events(LOG)
        self.assertEqual([(name, result) for _, name, result in events],
                         [("build", None), ("build", "success"), ("test", None), ("test", "failure"), ("lint", None)])
        self.assertEqual(events[0][0], lanes.stamp("2026-11-08 10:01:00Z"))

    def test_unknown_result_is_kept_lowercase(self):
        events = lanes.runner_events(["2026-11-08 10:05:00Z: Job x completed with result: Skipped"])
        self.assertEqual(events[0][2], "skipped")

    def test_finished_jobs_pair_with_their_start(self):
        done = lanes.finished_jobs(lanes.runner_events(LOG))
        self.assertEqual([(j, r, e - s) for s, e, j, r in done], [("build", "success", 150), ("test", "failure", 60)])

    def test_finished_job_without_start_has_none(self):
        done = lanes.finished_jobs(lanes.runner_events(["2026-11-08 10:05:00Z: Job x completed with result: Succeeded"]))
        self.assertIsNone(done[0][0])

    def test_running_job_is_the_last_unfinished_one(self):
        self.assertEqual(lanes.running_job(lanes.runner_events(LOG)), ("lint", lanes.stamp("2026-11-08 10:06:00Z")))
        self.assertEqual(lanes.running_job(lanes.runner_events(LOG[:5])), (None, None))
        self.assertEqual(lanes.running_job([]), (None, None))


class Links(unittest.TestCase):
    def test_only_web_links_pass(self):
        self.assertEqual(lanes.web_url("https://github.com/a/b"), "https://github.com/a/b")
        self.assertEqual(lanes.web_url("http://x"), "http://x")
        self.assertIsNone(lanes.web_url("javascript:alert(1)"))
        self.assertIsNone(lanes.web_url("file:///etc/passwd"))
        self.assertIsNone(lanes.web_url(None))


class Sources(unittest.TestCase):
    def test_source_prints_an_object(self):
        self.assertEqual(lanes.run_source("echo '{\"note\": \"hi\"}'"), {"note": "hi"})

    def test_source_that_is_not_an_object_fails(self):
        with self.assertRaises(ValueError):
            lanes.run_source("echo '[1, 2]'")
        with self.assertRaises(ValueError):
            lanes.run_source("echo not json")


class HubMerge(unittest.TestCase):
    def hub(self, snaps, machines):
        state = tempfile.TemporaryDirectory()
        self.addCleanup(state.cleanup)
        patcher = mock.patch.object(lanes, "STATE_DIR", Path(state.name))
        patcher.start()
        self.addCleanup(patcher.stop)
        hub = lanes.Hub({"machines": machines})
        hub.read = lambda m: snaps[m["name"]]
        hub.refresh()
        return json.loads(hub.body)

    def test_jobs_land_on_their_machine_and_count(self):
        now = int(time.time())
        body = self.hub({
            "a": {"load": 1.0, "jobs": [{"repo": "o/r", "job": "j", "since": now - 5, "url": "javascript:x"}],
                  "recent": [{"repo": "o/r", "job": "k", "started": now - 60, "finished": now - 30, "result": "success"}]},
            "b": {"error": "no answer in 25 seconds"},
        }, [{"name": "a"}, {"name": "b"}])
        a, b = body["machines"]
        self.assertTrue(a["ok"])
        self.assertEqual(a["jobs"][0]["machine"], "a")
        self.assertIsNone(a["jobs"][0]["url"])
        self.assertFalse(b["ok"])
        self.assertEqual(b["error"], "no answer in 25 seconds")
        self.assertEqual(body["running"], 1)
        self.assertEqual(body["history"][0]["machine"], "a")

    def test_a_source_can_report_for_another_machine(self):
        body = self.hub({"a": {"jobs": [{"repo": "o/r", "job": "j", "state": "starting", "machine": "cloud"}],
                               "machines": [{"name": "cloud", "meter": {"value": 1, "max": 2}}]}},
                        [{"name": "a"}])
        names = [m["name"] for m in body["machines"]]
        self.assertEqual(names, ["a", "cloud"])
        self.assertEqual(body["machines"][1]["meter"], {"value": 1, "max": 2})
        self.assertEqual(body["starting"], 1)
        self.assertEqual(body["running"], 0)

    def test_machines_command_keeps_valid_unique_entries(self):
        hub = lanes.Hub({"machines_command": "x"})
        with mock.patch.object(lanes, "run_source", return_value={"machines": [
                {"name": "a", "ssh": "a-host", "extra": "dropped"}, {"name": "a"}, {"ssh": "nameless"}, "junk"]}):
            hub.list_machines(time.time())
        self.assertEqual(hub.machines, [{"name": "a", "ssh": "a-host"}])

    def test_machines_command_failure_keeps_the_last_list(self):
        hub = lanes.Hub({"machines": [{"name": "old"}], "machines_command": "x"})
        with mock.patch.object(lanes, "run_source", side_effect=ValueError), mock.patch("sys.stderr"):
            hub.list_machines(time.time())
        self.assertEqual(hub.machines, [{"name": "old"}])


class Server(unittest.TestCase):
    def test_host_header_must_be_expected(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        threading.Thread(target=lanes.serve, args=(lambda: b'{"ok": 1}', "127.0.0.1", port), daemon=True).start()
        with mock.patch("sys.stdout"):
            for _ in range(50):
                try:
                    socket.create_connection(("127.0.0.1", port), 0.1).close()
                    break
                except OSError:
                    time.sleep(0.05)
        url = f"http://127.0.0.1:{port}/status.json"
        self.assertEqual(urllib.request.urlopen(url).read(), b'{"ok": 1}')
        rebound = urllib.request.Request(url, headers={"Host": f"evil.example:{port}"})
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(rebound)
        self.assertEqual(caught.exception.code, 403)


if __name__ == "__main__":
    unittest.main()
