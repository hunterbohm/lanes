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


class MachineUsage(unittest.TestCase):
    """What the whole machine is doing, CI or not, and when it runs hot."""

    def name(self, argv):
        return getattr(lanes, "process_name", lambda a: None)(argv)

    def test_interpreters_show_their_script(self):
        self.assertEqual(self.name(["/usr/bin/python3.12", "/home/x/tmp/probe/suite.py"]), "python3.12 suite.py")
        self.assertEqual(self.name(["node", "--max-old-space-size=4096", "/a/build.js"]), "node build.js")
        self.assertEqual(self.name(["python3", "-u", "-m", "http.server"]), "python3 -m http.server")
        self.assertEqual(self.name(["python3", "-c", "while 1: pass"]), "python3 -c")

    def test_other_programs_show_their_name(self):
        self.assertEqual(self.name(["/usr/lib/firefox/firefox", "-contentproc"]), "firefox")
        self.assertEqual(self.name([]), "?")

    def hub(self, snap):
        state = tempfile.TemporaryDirectory()
        self.addCleanup(state.cleanup)
        with mock.patch.object(lanes, "STATE_DIR", Path(state.name)):
            hub = lanes.Hub({"machines": [{"name": "m"}]})
            hub.read = lambda m: snap
            hub.refresh()
            return json.loads(hub.body), hub.samples

    def test_hot_cpu_is_flagged(self):
        body, _ = self.hub({"cpu": 20.0, "cpuTemp": 95, "gpus": []})
        self.assertEqual(body["machines"][0].get("hot"), "CPU 95°C")

    def test_hot_gpu_is_flagged_with_the_cpu(self):
        body, _ = self.hub({"cpuTemp": 91, "gpus": [{"name": "g", "busy": 99.0, "temp": 87.0}]})
        self.assertEqual(body["machines"][0].get("hot"), "CPU 91°C, GPU 87°C")

    def test_below_the_limits_is_not_hot(self):
        body, _ = self.hub({"cpuTemp": 89, "gpus": [{"name": "g", "busy": 1.0, "temp": 84.0}]})
        self.assertIsNone(body["machines"][0].get("hot"))

    def test_samples_keep_cpu_gpu_and_heat(self):
        _, samples = self.hub({"load": 2.5, "cpu": 40.0, "cpuTemp": 70, "gpus": [{"busy": 10.0}, {"busy": 60.0}]})
        self.assertEqual(samples[-1]["m"], {"load": 2.5, "cpu": 40.0, "gpu": 60.0, "temp": 70})

    def test_cpu_share_since_the_last_reading(self):
        if not hasattr(lanes, "usage_linux"):
            self.fail("the agent reports no CPU %")
        state = tempfile.TemporaryDirectory()
        self.addCleanup(state.cleanup)
        now = time.time()
        Path(state.name, "cpu.json").write_text(json.dumps({
            "t": now - 5, "busy": 1000, "total": 5000, "uptime": 100.0,
            "procs": {"10": [100, 50], "11": [900, 60], "12": [7, 70]}}))
        hz = os.sysconf("SC_CLK_TCK")
        # 5 s later: 1000 more busy ticks of 4000. pid 10 used 2.5 s, pid 11 is a new process reusing a pid,
        # pid 13 started since the last reading, pid 12 barely moved.
        reading = (2000, 9000, 105.0, {"10": [100 + int(2.5 * hz), 50], "11": [int(1 * hz), int(104.5 * hz)],
                                       "12": [8, 70], "13": [int(4 * hz), int(104 * hz)]})
        with mock.patch.object(lanes, "STATE_DIR", Path(state.name)), \
                mock.patch.object(lanes, "linux_ticks", return_value=reading), \
                mock.patch.object(lanes.time, "time", return_value=now), \
                mock.patch.object(lanes, "Path", side_effect=lambda *a: Path(*a) if "cmdline" not in str(a[0]) else
                                  mock.Mock(read_bytes=lambda: f"python3\0job{a[0].split('/')[2]}.py\0".encode())):
            cpu, top = lanes.usage_linux()
        self.assertEqual(cpu, 25.0)
        self.assertEqual([(t["pid"], t["cpu"]) for t in top], [(13, 80), (10, 50), (11, 20)])
        self.assertEqual(top[0]["name"], "python3 job13.py")

    def test_nvidia_gpus_are_read(self):
        if not hasattr(lanes, "gpus"):
            self.fail("the agent reads no GPUs")
        out = "NVIDIA GeForce RTX 2080 Super with Max-Q Design, 7, 2403, 8192, 54\nNVIDIA X, [N/A], 0, 1024, [N/A]\n"
        with mock.patch.object(lanes, "run", return_value=out), \
                mock.patch.object(lanes.Path, "glob", return_value=iter([])):
            found = lanes.gpus()
        self.assertEqual(found[0], {"name": "RTX 2080 Super with Max-Q Design", "busy": 7.0, "memUsedGiB": 2.3,
                                    "memGiB": 8.0, "temp": 54.0})
        self.assertEqual((found[1]["busy"], found[1]["temp"]), (None, None))


if __name__ == "__main__":
    unittest.main()
