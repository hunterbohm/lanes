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

    def test_samples_keep_memory_used(self):
        _, samples = self.hub({"memFreeGiB": 24.0, "memGiB": 32.0})
        self.assertEqual(samples[-1]["m"], {"mem": 25.0})

    def test_program_with_empty_cmdline_uses_its_short_name(self):
        if not hasattr(lanes, "usage_linux"):
            self.fail("the agent reads no CPU")
        state = tempfile.TemporaryDirectory()
        self.addCleanup(state.cleanup)
        hz = os.sysconf("SC_CLK_TCK")
        first = (0, 0, 100.0, {"20": [0, 10]})
        later = (500, 1000, 101.0, {"20": [hz, 10]})

        def fake(*a):
            if "cmdline" in str(a[0]):
                return mock.Mock(read_bytes=lambda: b"")
            if str(a[0]).endswith("/comm"):
                return mock.Mock(read_text=lambda: "gvisor_sentry\n")
            return Path(*a)
        with mock.patch.object(lanes, "STATE_DIR", Path(state.name)), \
                mock.patch.object(lanes, "linux_ticks", side_effect=[first, later]), \
                mock.patch.object(lanes.time, "sleep"), \
                mock.patch.object(lanes, "Path", side_effect=fake):
            _, top = lanes.usage_linux()
        self.assertEqual(top[0]["name"], "gvisor_sentry")

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


class QueueIntegration(unittest.TestCase):
    def need(self, name):
        if not hasattr(lanes, name):
            self.fail(f"lanes lacks {name}")
        return getattr(lanes, name)

    def test_read_env_file_parses_quotes_comments_and_export(self):
        read_env_file = self.need("read_env_file")
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "wake.env"
            p.write_text("# comment\nexport CI_WAKE_URL='wss://q.example.com/listen'\nCI_WAKE_TOKEN=\"tok-123\"\nBADLINE\n")
            parsed = read_env_file(p)
        self.assertEqual(parsed, {"CI_WAKE_URL": "wss://q.example.com/listen", "CI_WAKE_TOKEN": "tok-123"})

    def test_normalize_queue_url_handles_ws_and_listen_suffix(self):
        normalize_queue_url = self.need("normalize_queue_url")
        self.assertEqual(normalize_queue_url("wss://q.example.com/listen"), "https://q.example.com")
        self.assertEqual(normalize_queue_url("ws://localhost:8787/listen/"), "http://localhost:8787")
        self.assertEqual(normalize_queue_url("https://q.example.com/api/"), "https://q.example.com/api")
        self.assertEqual(normalize_queue_url("ftp://evil.example"), "")

    def test_format_queue_snapshot_counts_states_and_builds_urls(self):
        format_queue_snapshot = self.need("format_queue_snapshot")
        now = 1000.0
        raw = {
            "now": 1000,
            "workers": [{"worker_id": "box-1", "lanes_json": '["fast","vm"]', "free_cpus": 12, "max_cpus": 16, "online": True}],
            "queued": [{"job_id": 11, "repo": "o/r", "run_id": 22, "job_name": "e2e", "state": "QUEUED",
                        "queued_at": 950, "is_release": 1, "wait_reason": "busy"}],
            "running": [{"job_id": 12, "repo": "o/r", "run_id": 22, "job_name": "lint", "state": "RUNNING",
                         "claimed_by": "box-1", "claimed_lane": "fast", "queued_at": 990, "started_at": 992}],
            "recent": [{"job_id": 10, "repo": "o/r", "run_id": 21, "job_name": "ok", "state": "DONE"}],
        }
        snap = format_queue_snapshot(raw, None, now)
        self.assertTrue(snap["ok"])
        self.assertEqual(snap["workers"][0]["lanes"], ["fast", "vm"])
        self.assertEqual(snap["queued"][0]["waited_s"], 50)
        self.assertTrue(snap["queued"][0]["is_release"])
        self.assertEqual(snap["queued"][0]["url"], "https://github.com/o/r/actions/runs/22/job/11")
        self.assertEqual(snap["counts"]["QUEUED"], 1)
        self.assertEqual(snap["counts"]["RUNNING"], 1)
        self.assertEqual(snap["counts"]["DONE"], 1)

    def test_queue_client_keeps_last_good_on_error(self):
        QueueClient = self.need("QueueClient")
        client = QueueClient({"url": "https://q.example.com"})
        good = {"now": 100, "workers": [], "queued": [], "running": [], "recent": []}
        with mock.patch.object(client, "_get_json", side_effect=[lanes.DEFAULT_STATE_MACHINE, good]):
            first = client.fetch(100.0)
        self.assertTrue(first["ok"])
        with mock.patch.object(client, "_get_json", side_effect=OSError("down")):
            second = client.fetch(105.0)
        self.assertFalse(second["ok"])
        self.assertIn("OSError", second["error"])
        self.assertEqual(second["updated"], 100)


class PullRequestsAndMedia(unittest.TestCase):
    def need(self, name):
        if not hasattr(lanes, name):
            self.fail(f"lanes lacks {name}")
        return getattr(lanes, name)

    def test_media_allowlist_rewrites_blob_and_blocks_ssrf(self):
        is_allowed_media_url = self.need("is_allowed_media_url")
        owners = ["AcmeOrg", "alice"]
        self.assertEqual(
            is_allowed_media_url("https://github.com/acmeorg/app/blob/main/proof/demo.mp4?raw=true", owners),
            "https://raw.githubusercontent.com/acmeorg/app/main/proof/demo.mp4",
        )
        self.assertEqual(
            is_allowed_media_url("https://github.com/alice/app/raw/feat/x/img.png", owners),
            "https://raw.githubusercontent.com/alice/app/feat/x/img.png",
        )
        self.assertEqual(
            is_allowed_media_url("https://raw.githubusercontent.com/alice/app/main/a.jpg", owners),
            "https://raw.githubusercontent.com/alice/app/main/a.jpg",
        )
        self.assertEqual(
            is_allowed_media_url("https://github.com/user-attachments/assets/489a4912-b184-4817-a6ba-1ca8603b167d", owners),
            "https://github.com/user-attachments/assets/489a4912-b184-4817-a6ba-1ca8603b167d",
        )
        # Blocked cases: unconfigured owner, non-https, internal IP, traversal, userinfo, non-443 port
        self.assertIsNone(is_allowed_media_url("https://github.com/other/app/raw/main/a.mp4", owners))
        self.assertIsNone(is_allowed_media_url("http://github.com/alice/app/raw/main/a.mp4", owners))
        self.assertIsNone(is_allowed_media_url("https://169.254.169.254/latest/meta-data/", owners))
        self.assertIsNone(is_allowed_media_url("https://github.com/alice/app/raw/main/../secret", owners))
        self.assertIsNone(is_allowed_media_url("https://user@github.com/alice/app/raw/main/a.mp4", owners))
        self.assertIsNone(is_allowed_media_url("https://github.com:8443/alice/app/raw/main/a.mp4", owners))

    def test_redirect_host_allowlist_and_content_type_sanitizer(self):
        is_allowed_redirect_host = self.need("is_allowed_redirect_host")
        sanitize_media_content_type = self.need("sanitize_media_content_type")
        self.assertTrue(is_allowed_redirect_host("github-production-user-asset-6210df.s3.amazonaws.com"))
        self.assertTrue(is_allowed_redirect_host("objects.githubusercontent.com"))
        self.assertFalse(is_allowed_redirect_host("127.0.0.1"))
        self.assertFalse(is_allowed_redirect_host("evil.example.com"))
        self.assertEqual(sanitize_media_content_type("video/mp4; charset=binary"), "video/mp4")
        self.assertEqual(sanitize_media_content_type("text/html; charset=utf-8"), "application/octet-stream")
        self.assertEqual(sanitize_media_content_type("image/svg+xml"), "application/octet-stream")

    def test_extract_pr_summary_reads_structured_headings(self):
        extract_pr_summary = self.need("extract_pr_summary")
        body = "## Why\nSafari lost focus.\n\n## What changed\n- Keeps focus on autocomplete\n- Adds unit tests\n"
        summary, why = extract_pr_summary(body)
        self.assertIn("Keeps focus on autocomplete", summary)
        self.assertEqual(why, "Safari lost focus.")

    def test_extract_pr_media_finds_videos_images_and_attachments(self):
        extract_pr_media = self.need("extract_pr_media")
        body = (
            "Proof:\n"
            "https://github.com/user-attachments/assets/489a4912-b184-4817-a6ba-1ca8603b167d\n"
            "![Before/After](https://github.com/alice/app/blob/main/proof/before-after.jpg?raw=true)\n"
            "![Blocked](https://evil.example/a.png)\n"
        )
        comments = [{"body": '<video src="https://github.com/alice/app/raw/main/clip.mp4"></video>'}]
        items = extract_pr_media(body, comments, ["alice"], probe_kind=lambda u: "video")
        self.assertEqual(len(items), 3)
        self.assertEqual([i["kind"] for i in items], ["video", "video", "image"])
        self.assertTrue(all(i["src"].startswith("/media?url=") for i in items))

    def test_summarize_ci_checks_counts_and_prioritizes_failures(self):
        summarize_ci_checks = self.need("summarize_ci_checks")
        rollup = {
            "state": "FAILURE",
            "contexts": {"nodes": [
                {"__typename": "CheckRun", "name": "lint", "status": "COMPLETED", "conclusion": "SUCCESS", "detailsUrl": "https://x/1"},
                {"__typename": "CheckRun", "name": "e2e", "status": "COMPLETED", "conclusion": "FAILURE", "detailsUrl": "https://x/2"},
                {"__typename": "CheckRun", "name": "build", "status": "IN_PROGRESS", "conclusion": None, "detailsUrl": "https://x/3"},
                {"__typename": "StatusContext", "context": "deploy", "state": "PENDING", "targetUrl": "https://x/4"},
            ]},
        }
        ci = summarize_ci_checks(rollup)
        self.assertEqual((ci["state"], ci["passed"], ci["failed"], ci["running"], ci["pending"], ci["total"]),
                         ("failing", 1, 1, 1, 1, 4))
        self.assertEqual([c["name"] for c in ci["checks"]], ["e2e", "build", "deploy", "lint"])

    def test_merge_ready_requires_passing_ci_and_no_pending_review(self):
        PullRequestPoller = self.need("PullRequestPoller")
        poller = PullRequestPoller({"owners": ["alice"], "token_command": ""})
        base = {
            "number": 7, "title": "Fix", "url": "https://github.com/alice/app/pull/7",
            "isDraft": False, "headRefName": "fix/x", "baseRefName": "main",
            "createdAt": "2026-11-25T10:00:00Z", "updatedAt": "2026-11-25T11:00:00Z",
            "additions": 10, "deletions": 2, "changedFiles": 1, "mergeable": "MERGEABLE",
            "body": "ok", "author": {"login": "alice"}, "repository": {"nameWithOwner": "alice/app"},
            "files": {"nodes": []}, "comments": {"nodes": []},
            "commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": "SUCCESS", "contexts": {"nodes": [
                {"__typename": "CheckRun", "name": "ci", "status": "COMPLETED", "conclusion": "SUCCESS", "detailsUrl": None}
            ]}}}}]},
        }
        self.assertTrue(poller.normalize_pr({**base, "reviewDecision": "APPROVED"})["merge_ready"])
        self.assertTrue(poller.normalize_pr({**base, "reviewDecision": ""})["merge_ready"])
        self.assertFalse(poller.normalize_pr({**base, "reviewDecision": "REVIEW_REQUIRED"})["merge_ready"])
        self.assertFalse(poller.normalize_pr({**base, "reviewDecision": "CHANGES_REQUESTED"})["merge_ready"])
        self.assertFalse(poller.normalize_pr({**base, "reviewDecision": "APPROVED", "isDraft": True})["merge_ready"])

    def test_query_owner_paginates_in_bounded_batches(self):
        PullRequestPoller = self.need("PullRequestPoller")
        poller = PullRequestPoller({"owners": ["alice"], "page_size": 10, "token_command": ""})
        calls = []

        def fake_page(owner, limit, token, after=None):
            calls.append((owner, limit, after))
            if after is None:
                return [{"number": i, "repository": {"nameWithOwner": "alice/a"}} for i in range(10)], "cursor-1"
            return [{"number": 10 + i, "repository": {"nameWithOwner": "alice/a"}} for i in range(5)], None

        with mock.patch.object(poller, "_query_owner_page", side_effect=fake_page):
            nodes = poller._query_owner("alice", 15, "tok")
        self.assertEqual(len(nodes), 15)
        self.assertEqual(calls, [("alice", 10, None), ("alice", 5, "cursor-1")])

    def test_exclude_repos_filters_matching_patterns(self):
        PullRequestPoller = self.need("PullRequestPoller")
        poller = PullRequestPoller({"owners": ["alice"], "exclude_repos": ["*/bench-*", "scratch-*"], "token_command": ""})
        self.assertTrue(poller._is_excluded_repo("alice/bench-foo"))
        self.assertTrue(poller._is_excluded_repo("alice/scratch-1"))
        self.assertFalse(poller._is_excluded_repo("alice/real-app"))

    def test_media_proxy_strips_auth_on_s3_redirect_and_streams_range(self):
        PullRequestPoller = self.need("PullRequestPoller")
        poller = PullRequestPoller({"owners": ["alice"], "token_command": ""})
        poller._token = "secret-gh-token"
        poller._token_at = time.time()
        seen_headers = []

        class FakeResp:
            status = 206
            headers = {"Content-Type": "video/mp4", "Content-Range": "bytes 0-3/10", "Content-Length": "4"}
            def __init__(self):
                self._data = [b"MP4!", b""]
            def read(self, n=-1):
                return self._data.pop(0) if self._data else b""
            def close(self):
                pass

        def fake_open(req, timeout=15):
            seen_headers.append((req.full_url, dict(req.header_items())))
            if "github.com" in req.full_url:
                raise urllib.error.HTTPError(
                    req.full_url, 302, "Found",
                    {"Location": "https://github-production-user-asset-6210df.s3.amazonaws.com/signed-item"},
                    None,
                )
            return FakeResp()

        with mock.patch.object(lanes._NO_REDIRECT_OPENER, "open", side_effect=fake_open):
            status, hdrs, stream = poller.open_media_upstream(
                "https://github.com/user-attachments/assets/489a4912-b184-4817-a6ba-1ca8603b167d",
                range_header="bytes=0-3",
            )
        self.assertEqual(status, 206)
        self.assertEqual(stream.read(), b"MP4!")
        self.assertIn("Authorization", seen_headers[0][1])
        self.assertNotIn("Authorization", seen_headers[1][1])
        self.assertEqual(seen_headers[1][1].get("Range"), "bytes=0-3")

    def test_server_serves_prs_and_media_with_sandbox_headers(self):
        self.need("PullRequestPoller")
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]

        class FakeStream:
            def __init__(self):
                self.done = False
            def read(self, n=-1):
                if self.done:
                    return b""
                self.done = True
                return b"<html>not-trusted</html>"
            def close(self):
                pass

        def fake_media(query, rng, head):
            return 200, {"Content-Type": "text/html", "Content-Length": "24"}, FakeStream()

        threading.Thread(
            target=lanes.serve,
            args=(lambda: b'{"ok": 1}', "127.0.0.1", port),
            kwargs={"prs_source": lambda: b'{"configured": true, "prs": []}', "media_handler": fake_media},
            daemon=True,
        ).start()
        with mock.patch("sys.stdout"):
            for _ in range(50):
                try:
                    socket.create_connection(("127.0.0.1", port), 0.1).close()
                    break
                except OSError:
                    time.sleep(0.05)

        prs_res = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/prs.json").read())
        self.assertTrue(prs_res["configured"])
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/media?url=https://x") as resp:
            self.assertEqual(resp.headers.get("Content-Type"), "application/octet-stream")
            self.assertEqual(resp.headers.get("Content-Security-Policy"), "sandbox")
            self.assertEqual(resp.read(), b"<html>not-trusted</html>")


if __name__ == "__main__":
    unittest.main()
