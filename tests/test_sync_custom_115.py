"""Exercise synchronization against disposable Git repositories, without GitHub writes."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock


SOURCE = Path(__file__).resolve().parents[1] / "scripts/sync_custom_115.py"
PRODUCTION_CONFIG = json.loads((SOURCE.parent.parent / "build-config/custom-115-sync.json").read_text())
spec = importlib.util.spec_from_file_location("sync_custom_115", SOURCE)
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


def command(directory, *args):
    return subprocess.run(["git", "-C", str(directory), *args], check=True, capture_output=True, text=True).stdout.strip()


class FakeGitHub:
    def __init__(self, repository):
        self.repository = repository
        self.calls = []
        self.pulls = []

    def ref(self, branch):
        return command(self.repository, "rev-parse", "refs/heads/" + branch)

    def pull_request(self, branch, base, title, body):
        self.pulls.append((branch, base, title, body))
        return {"number": 1, "html_url": "https://github.com/example/test/pull/1"}

    def request(self, path, method="GET", body=None, public=False):
        self.calls.append((path, method, body))
        return None


class SyncIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.upstream_work = self.root / "upstream-work"
        self.upstream_work.mkdir()
        command(self.upstream_work, "init", "-b", "main")
        command(self.upstream_work, "config", "user.name", "Fixture")
        command(self.upstream_work, "config", "user.email", "fixture@example.invalid")
        for path, text in {"docs/guide.md": "original guide\n", "internal/task/worker.go": "original worker\n"}.items():
            file = self.upstream_work / path
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(text)
        command(self.upstream_work, "add", "docs", "internal")
        command(self.upstream_work, "commit", "-m", "feat(fixture): create upstream baseline")
        self.checkpoint = command(self.upstream_work, "rev-parse", "HEAD")
        self.upstream = self.root / "upstream.git"
        command(self.root, "clone", "--bare", str(self.upstream_work), str(self.upstream))
        command(self.upstream_work, "remote", "add", "fixture", str(self.upstream))
        self.work = self.root / "work"
        command(self.root, "clone", str(self.upstream), str(self.work))
        command(self.work, "switch", "-c", "custom/115")
        command(self.work, "config", "user.name", "Fixture")
        command(self.work, "config", "user.email", "fixture@example.invalid")
        self.config = {
            "repository": "example/test", "upstream_repository": "example/upstream",
            "branch": "custom/115", "upstream_commit": self.checkpoint,
            "automatic_paths": ["docs/**", "drivers/**"],
            "review_paths": ["internal/**", "drivers/115*/**", ".github/**", "build-config/**"],
        }
        (self.work / "build-config").mkdir()
        (self.work / sync.CONFIG).write_text(json.dumps(self.config, indent=2) + "\n")
        (self.work / "internal/task/worker.go").write_text("personal worker\n")
        command(self.work, "add", "build-config", "internal")
        command(self.work, "commit", "-m", "feat(fixture): preserve personal task behavior")
        self.base = command(self.work, "rev-parse", "HEAD")
        self.origin = self.root / "origin.git"
        command(self.root, "clone", "--bare", str(self.work), str(self.origin))
        command(self.work, "remote", "set-url", "origin", str(self.origin))
        self.result = self.root / "result.json"
        self.api = FakeGitHub(self.origin)
        original_git = sync.git

        def routed_git(*args, **kwargs):
            args = list(args)
            if args[0] == "fetch" and args[2] == "https://github.com/example/upstream.git":
                args[2] = str(self.upstream)
            return original_git(*args, **kwargs)

        self.addCleanup(mock.patch.stopall)
        mock.patch.object(sync, "git", side_effect=routed_git).start()
        mock.patch.object(sync, "GitHub", return_value=self.api).start()
        mock.patch.dict(os.environ, {"GITHUB_REPOSITORY": "example/test"}, clear=False).start()
        for key in ("GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY"):
            if key in os.environ:
                mock.patch.dict(os.environ, {key: str(self.root / key)}).start()
        previous = Path.cwd()
        self.addCleanup(os.chdir, previous)
        os.chdir(self.work)

    def update_upstream(self, path="docs/guide.md", text="updated guide\n", delete=False):
        file = self.upstream_work / path
        if delete:
            file.unlink()
        else:
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(text)
        command(self.upstream_work, "add", "--", path)
        command(self.upstream_work, "commit", "-m", "fix(fixture): update upstream behavior")
        command(self.upstream_work, "push", "fixture", "main")
        return command(self.upstream_work, "rev-parse", "HEAD")

    def test_no_update_does_not_create_pr_or_advance_branch(self):
        state = sync.prepare(self.result)
        self.assertFalse(state["changed"])
        self.assertEqual(self.api.ref("custom/115"), self.base)
        self.assertFalse(self.api.pulls)

    def test_dry_run_does_not_commit_or_push(self):
        self.update_upstream()
        state = sync.prepare(self.result, dry_run=True)
        self.assertTrue(state["automatic"])
        self.assertEqual(command(self.work, "rev-parse", "HEAD"), self.base)
        self.assertFalse(self.api.pulls)

    def test_safe_update_preserves_personal_code_until_validation(self):
        upstream = self.update_upstream()
        state = sync.prepare(self.result)
        self.assertEqual(self.api.ref("custom/115"), self.base)
        self.assertEqual((self.work / "internal/task/worker.go").read_text(), "personal worker\n")
        self.assertEqual(json.loads(sync.CONFIG.read_text())["upstream_commit"], upstream)
        self.assertTrue(state["automatic"])
        self.assertIn("待执行", self.api.pulls[0][3])

    def test_validated_safe_update_is_fast_forwarded(self):
        self.update_upstream()
        candidate = sync.prepare(self.result)
        final = sync.finalize(self.result, "success")
        self.assertTrue(final["accepted"])
        self.assertEqual(self.api.ref("custom/115"), candidate["candidate_sha"])
        self.assertTrue(sync.ancestor(self.base, candidate["candidate_sha"]))

    def test_failed_validation_keeps_target_and_records_failure(self):
        self.update_upstream()
        sync.prepare(self.result)
        state = sync.finalize(self.result, "failure")
        self.assertFalse(state["accepted"])
        self.assertEqual(self.api.ref("custom/115"), self.base)
        self.assertEqual(self.api.calls[-1][2]["state"], "failure")

    def test_shared_task_change_requires_review_even_when_tests_pass(self):
        self.update_upstream("internal/task/new.go", "new task management\n")
        state = sync.prepare(self.result)
        self.assertEqual(state["review_paths"], ["internal/task/new.go"])
        self.assertFalse(sync.finalize(self.result, "success")["accepted"])
        self.assertEqual(self.api.ref("custom/115"), self.base)

    def test_conflict_prepares_upstream_pr_without_claiming_validation(self):
        upstream = self.update_upstream("internal/task/worker.go", "different upstream worker\n")
        state = sync.prepare(self.result)
        self.assertFalse(state["mergeable"])
        self.assertFalse(state["automatic"])
        self.assertEqual(state["candidate_sha"], upstream)
        self.assertEqual(state["conflicts"], ["internal/task/worker.go"])
        command(self.work, "switch", "--detach", self.base)
        final = sync.finalize(self.result, "skipped")
        self.assertFalse(final["accepted"])
        self.assertFalse(any("statuses" in path for path, _, _ in self.api.calls))

    def test_local_only_upstream_path_is_blocked_before_push(self):
        self.update_upstream("docs/115/PLAN.md", "upstream collision\n")
        with self.assertRaisesRegex(RuntimeError, "local-only"):
            sync.prepare(self.result)
        self.assertFalse(self.api.pulls)
        self.assertEqual(self.api.ref("custom/115"), self.base)

    def test_safe_path_deletion_still_requires_review(self):
        self.update_upstream(delete=True)
        state = sync.prepare(self.result)
        self.assertFalse(state["automatic"])
        self.assertIn("docs/guide.md", state["review_paths"])

    def test_rename_inspects_removed_shared_path_and_new_path(self):
        command(self.upstream_work, "mv", "internal/task/worker.go", "docs/worker.md")
        command(self.upstream_work, "commit", "-m", "refactor(fixture): move shared worker")
        command(self.upstream_work, "push", "fixture", "main")
        command(self.work, "fetch", str(self.upstream), "main")
        changes = sync.changed_paths(self.checkpoint, command(self.upstream_work, "rev-parse", "HEAD"))
        _, review = sync.classify(changes, self.config)
        self.assertIn("internal/task/worker.go", review)

    def test_same_inputs_produce_same_candidate_without_force_push(self):
        self.update_upstream()
        first = sync.prepare(self.result)
        command(self.work, "switch", "--detach", self.base)
        second = sync.prepare(self.result)
        self.assertEqual(first["candidate_sha"], second["candidate_sha"])
        self.assertEqual(first["candidate_branch"], second["candidate_branch"])

    def test_candidate_branch_change_invalidates_validation(self):
        self.update_upstream()
        state = sync.prepare(self.result)
        command(self.origin, "update-ref", "refs/heads/" + state["candidate_branch"], self.base)
        with self.assertRaisesRegex(RuntimeError, "Candidate branch changed"):
            sync.finalize(self.result, "success")
        self.assertEqual(self.api.ref("custom/115"), self.base)

    def test_target_advance_during_validation_keeps_pr(self):
        self.update_upstream()
        sync.prepare(self.result)
        command(self.work, "switch", "--detach", self.base)
        (self.work / "docs/user.md").write_text("concurrent user change\n")
        command(self.work, "add", "docs/user.md")
        command(self.work, "commit", "-m", "docs(fixture): add user change")
        advanced = command(self.work, "rev-parse", "HEAD")
        command(self.work, "push", "origin", "HEAD:custom/115")
        with self.assertRaisesRegex(RuntimeError, "Managed branch changed"):
            sync.finalize(self.result, "success")
        self.assertEqual(self.api.ref("custom/115"), advanced)

    def test_dirty_worktree_is_rejected(self):
        (self.work / "untracked.txt").write_text("local work\n")
        with self.assertRaisesRegex(RuntimeError, "clean"):
            sync.prepare(self.result)

    def test_unreachable_checkpoint_is_rejected(self):
        self.config["upstream_commit"] = "0" * 40
        sync.CONFIG.write_text(json.dumps(self.config) + "\n")
        command(self.work, "add", str(sync.CONFIG))
        command(self.work, "commit", "-m", "test(fixture): change checkpoint")
        command(self.work, "push", "origin", "HEAD:custom/115")
        with self.assertRaisesRegex(RuntimeError, "ancestry"):
            sync.prepare(self.result)

    def test_verified_frontend_pin_alone_can_be_synchronized(self):
        self.config["frontend_repository"] = "example/frontend"
        sync.CONFIG.write_text(json.dumps(self.config, indent=2) + "\n")
        sync.PIN.write_text(f'frontend_commit="{self.checkpoint}"\n')
        command(self.work, "add", "build-config")
        command(self.work, "commit", "-m", "build(fixture): record frontend pin")
        self.base = command(self.work, "rev-parse", "HEAD")
        command(self.work, "push", "origin", "HEAD:custom/115")
        with mock.patch.object(sync, "choose_frontend", return_value=(self.base, "validated")):
            state = sync.prepare(self.result)
        self.assertTrue(state["changed"])
        self.assertTrue(state["automatic"])
        self.assertEqual(sync.read_pin(), self.base)
        self.assertTrue(sync.finalize(self.result, "success")["accepted"])


class FrontendValidationTests(unittest.TestCase):
    def test_failed_exact_status_does_not_fall_back_to_an_older_success(self):
        api = mock.Mock()
        api.request.return_value = {"statuses": [{"context": "custom-115/frontend-validation", "state": "failure", "creator": {"login": "github-actions[bot]"}}]}
        self.assertFalse(sync.frontend_verified(api, "example/frontend", "a" * 40))
        self.assertEqual(api.request.call_count, 1)

    def test_status_from_an_unexpected_actor_is_not_accepted(self):
        api = mock.Mock()
        api.request.return_value = {"statuses": [{"context": "custom-115/frontend-validation", "state": "success", "creator": {"login": "someone"}}]}
        self.assertFalse(sync.frontend_verified(api, "example/frontend", "a" * 40))

    def test_successful_pr_run_does_not_validate_a_branch_commit(self):
        api = mock.Mock()
        api.request.side_effect = [{"statuses": []}, {"workflow_runs": [{"head_sha": "a" * 40, "conclusion": "success", "event": "pull_request"}]}]
        self.assertFalse(sync.frontend_verified(api, "example/frontend", "a" * 40))

    def test_successful_exact_push_run_is_accepted(self):
        api = mock.Mock()
        api.request.side_effect = [{"statuses": []}, {"workflow_runs": [{"head_sha": "a" * 40, "conclusion": "success", "event": "push"}]}]
        self.assertTrue(sync.frontend_verified(api, "example/frontend", "a" * 40))

    def test_success_for_a_different_commit_is_not_accepted(self):
        api = mock.Mock()
        api.request.side_effect = [{"statuses": []}, {"workflow_runs": [{"head_sha": "b" * 40, "conclusion": "success", "event": "push"}]}]
        self.assertFalse(sync.frontend_verified(api, "example/frontend", "a" * 40))

    def test_unvalidated_frontend_head_keeps_existing_pin_without_fetch(self):
        api = mock.Mock()
        api.request.return_value = {"object": {"sha": "b" * 40}}
        with mock.patch.object(sync, "read_pin", return_value="a" * 40), mock.patch.object(sync, "frontend_verified", return_value=False), mock.patch.object(sync, "git") as git:
            commit, _ = sync.choose_frontend(api, {"frontend_repository": "example/frontend", "branch": "custom/115"})
        self.assertEqual(commit, "a" * 40)
        git.assert_not_called()


class ProductionPolicyTests(unittest.TestCase):
    def test_shared_task_paths_require_review_in_the_shipped_policy(self):
        paths = ["src/pages/manage/tasks/Tasks.tsx", "src/types/task.ts", "src/utils/api.ts", "package.json"] if "Frontend" in PRODUCTION_CONFIG["repository"] else ["server/handles/task.go", "internal/bootstrap/task.go", "internal/offline_download/tool/download.go", "drivers/115_open/driver.go", "go.mod"]
        for path in paths:
            with self.subTest(path=path):
                _, review = sync.classify([("M", path)], PRODUCTION_CONFIG)
                self.assertEqual(review, [path])

    def test_local_personal_paths_are_blocked_in_the_shipped_policy(self):
        for path in ("AGENTS.override.md", "docs/115/PLAN.md"):
            blocked, _ = sync.classify([("A", path)], PRODUCTION_CONFIG)
            self.assertEqual(blocked, [path])

    def test_ordinary_documentation_is_eligible_in_the_shipped_policy(self):
        blocked, review = sync.classify([("M", "docs/development/guide.md")], PRODUCTION_CONFIG)
        self.assertFalse(blocked)
        self.assertFalse(review)


if __name__ == "__main__":
    unittest.main()
