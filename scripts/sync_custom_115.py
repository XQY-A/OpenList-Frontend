#!/usr/bin/env python3
"""Prepare immutable upstream candidates and accept only validated safe updates."""

import argparse
import fnmatch
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request


CONFIG = Path("build-config/custom-115-sync.json")
PIN = Path("build-config/custom-115-frontend.conf")
SHA = re.compile(r"^[0-9a-f]{40}$")
LOCAL_PATHS = ("AGENTS.override.md", "docs/115/**")


def git(*args, check=True, env=None):
    result = subprocess.run(
        ["git", *args], text=True, capture_output=True,
        env={**os.environ, **(env or {})},
    )
    if check and result.returncode:
        # Do not echo authenticated remote URLs or credential helper output.
        raise RuntimeError(f"Git operation {args[0]} failed (exit {result.returncode})")
    return result


def ancestor(older, newer):
    result = git("merge-base", "--is-ancestor", older, newer, check=False)
    if result.returncode not in (0, 1):
        raise RuntimeError("Cannot verify commit ancestry")
    return result.returncode == 0


def matches(path, patterns):
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns)


def classify(changes, config):
    """Deletions, unknown paths and shared code require review; inspect both rename paths."""
    blocked, review = [], []
    for status, path in changes:
        if matches(path, LOCAL_PATHS):
            blocked.append(path)
        if (status != "M" and status != "A") or matches(path, config["review_paths"]) or not matches(path, config["automatic_paths"]):
            review.append(path)
    return sorted(set(blocked)), sorted(set(review))


def changed_paths(before, after):
    fields = git("diff", "--name-status", "--no-renames", "-z", before, after).stdout.split("\0")
    return list(zip(fields[0::2], fields[1::2]))


class GitHub:
    def __init__(self, repository):
        self.repository = repository

    def request(self, path, method="GET", body=None, public=False):
        headers = {"Accept": "application/vnd.github+json", "User-Agent": "custom-115-sync"}
        token = os.environ.get("GH_TOKEN")
        if token and not public:
            headers["Authorization"] = "Bearer " + token
        payload = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(
            "https://api.github.com/" + path, data=payload, method=method, headers=headers,
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                data = response.read()
                return json.loads(data) if data else None
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"GitHub {method} {path} returned HTTP {error.code}") from None

    def ref(self, branch):
        encoded = urllib.parse.quote(branch, safe="/")
        return self.request(f"repos/{self.repository}/git/ref/heads/{encoded}")["object"]["sha"]

    def pull_request(self, branch, base, title, body):
        query = urllib.parse.urlencode({"head": self.repository.split("/")[0] + ":" + branch, "base": base, "state": "open"})
        existing = self.request(f"repos/{self.repository}/pulls?{query}")
        if existing:
            return self.request(f"repos/{self.repository}/pulls/{existing[0]['number']}", "PATCH", {"title": title, "body": body})
        return self.request(f"repos/{self.repository}/pulls", "POST", {"head": branch, "base": base, "title": title, "body": body})


def frontend_verified(api, repository, commit):
    combined = api.request(f"repos/{repository}/commits/{commit}/status", public=True)
    # The same repository's trusted CI records validation for the exact source SHA.
    for status in combined["statuses"]:
        if status["context"] == "custom-115/frontend-validation":
            return status["state"] == "success" and status["creator"]["login"] == "github-actions[bot]"
    query = urllib.parse.urlencode({"head_sha": commit, "status": "success", "per_page": 20})
    runs = api.request(f"repos/{repository}/actions/workflows/build_custom_115.yml/runs?{query}", public=True)
    return any(run["head_sha"] == commit and run["conclusion"] == "success" and run["event"] in ("push", "workflow_dispatch") for run in runs["workflow_runs"])


def read_pin():
    match = re.search(r'^frontend_commit="([0-9a-f]{40})"$', PIN.read_text(), re.MULTILINE)
    if not match:
        raise RuntimeError("Frontend pin is not a complete commit SHA")
    return match.group(1)


def choose_frontend(api, config):
    current = read_pin()
    repository = config["frontend_repository"]
    head = api.request(f"repos/{repository}/git/ref/heads/{config['branch']}", public=True)["object"]["sha"]
    if head == current:
        return current, "The frontend pin is current."
    if not SHA.fullmatch(head):
        raise RuntimeError("Invalid frontend commit")
    if not frontend_verified(api, repository, head):
        return current, "The new frontend HEAD has no successful exact-commit validation; keep the existing pin."
    git("fetch", "--no-tags", f"https://github.com/{repository}.git", f"refs/heads/{config['branch']}")
    if git("rev-parse", "FETCH_HEAD").stdout.strip() != head or not ancestor(current, head):
        raise RuntimeError("Frontend history changed; rerun or review the pin manually")
    return head, "The new frontend HEAD passed exact-commit validation."


def pr_body(state, validation="pending"):
    paths = "\n".join("- `" + path.replace("`", "") + "`" for path in state["review_paths"]) or "- 无共享路径变更。"
    conflicts = "\n".join("- `" + path.replace("`", "") + "`" for path in state["conflicts"])
    testing = {"pending": "待执行候选提交的 Personal 115 Build。", "success": "候选提交的 Personal 115 Build 已通过。", "failure": "候选提交验证失败；未自动合并。", "cancelled": "候选提交验证取消；未自动合并。", "skipped": "存在合并冲突，未执行候选提交验证。"}[validation]
    return (
        "## Summary / 摘要\n\n"
        f"同步 `{state['upstream_repository']}@{state['upstream_sha']}` 到个人 `{state['branch']}`。\n\n"
        f"- 候选提交：`{state['candidate_sha']}`\n"
        f"- 同步前提交：`{state['base_sha']}`\n"
        f"- 自动合并资格：{'符合路径规则，仍须验证通过' if state['automatic'] else '需兼容性审查或解决冲突'}\n"
        f"- 前端版本：`{state.get('frontend_sha') or '本仓库源码'}`\n\n"
        "共享路径及需要审查的变更：\n\n" + paths + "\n\n"
        + ("冲突路径（必须保留个人功能并适配上游）：\n\n" + conflicts + "\n\n" if conflicts else "")
        + "115 兼容性审查需确认原始回执、重启恢复、防重复提交、默认本地删除、云清理保留文件和失败保留任务。\n\n"
        "## Testing / 测试\n\n" + testing + "\n\n"
        f"运行记录：{state['run_url']}\n\n"
        "此 PR 由确定性同步脚本生成；路径分类不代表已经完成业务兼容性审查。\n"
    )


def save_result(path, state):
    Path(path).write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n")
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        keys = ("changed", "mergeable", "automatic", "candidate_sha", "base_sha", "accepted")
        with open(output, "a") as stream:
            for key in keys:
                value = state.get(key, "")
                if isinstance(value, bool):
                    value = str(value).lower()
                stream.write(f"{key}={value}\n")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as stream:
            stream.write("### Personal 115 upstream sync\n\n")
            stream.write(state.get("message", "") + "\n\n")
            if state.get("pr_url"):
                stream.write("- Sync PR: " + state["pr_url"] + "\n")
            if state.get("frontend_note"):
                stream.write("- " + state["frontend_note"] + "\n")


def prepare(result_path, dry_run=False):
    config = json.loads(CONFIG.read_text())
    repository, branch = config["repository"], config["branch"]
    if os.environ.get("GITHUB_REPOSITORY", repository) != repository:
        raise RuntimeError("This configuration belongs to another repository")
    if branch != "custom/115" or not SHA.fullmatch(config["upstream_commit"]):
        raise RuntimeError("Invalid managed branch or upstream checkpoint")
    if git("status", "--porcelain", "--untracked-files=normal").stdout:
        raise RuntimeError("Worktree must be clean before preparing a candidate")
    base = git("rev-parse", "HEAD").stdout.strip()
    git("fetch", "--no-tags", "origin", f"refs/heads/{branch}")
    if git("rev-parse", "FETCH_HEAD").stdout.strip() != base:
        raise RuntimeError("Managed branch advanced; rerun against its latest commit")
    git("fetch", "--no-tags", f"https://github.com/{config['upstream_repository']}.git", "refs/heads/main")
    upstream = git("rev-parse", "FETCH_HEAD").stdout.strip()
    checkpoint = config["upstream_commit"]
    if not ancestor(checkpoint, base) or not ancestor(checkpoint, upstream):
        raise RuntimeError("Upstream checkpoint ancestry changed; manual review is required")
    changes = changed_paths(checkpoint, upstream)
    blocked, review = classify(changes, config)
    if blocked:
        raise RuntimeError("Upstream introduced local-only paths; preserve local copies before resolving: " + ", ".join(blocked))
    api = GitHub(repository)
    frontend, note = choose_frontend(api, config) if "frontend_repository" in config else (None, None)
    pin_changed = frontend is not None and frontend != read_pin()
    state = {
        "repository": repository, "branch": branch,
        "base_sha": base, "upstream_repository": config["upstream_repository"],
        "upstream_sha": upstream, "frontend_sha": frontend, "frontend_note": note,
        "changed": checkpoint != upstream or pin_changed,
        "review_paths": review, "conflicts": [], "mergeable": True,
        "automatic": not review, "accepted": False,
        "run_url": f"https://github.com/{repository}/actions/runs/{os.environ.get('GITHUB_RUN_ID', '')}",
    }
    if dry_run or not state["changed"]:
        state["message"] = "Read-only sync inspection completed." if dry_run else "No upstream or verified frontend update."
        save_result(result_path, state)
        return state
    git("config", "user.name", "github-actions[bot]")
    git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com")
    git("switch", "--detach", base)
    if not ancestor(upstream, base):
        merge = git("merge", "--no-ff", "--no-commit", upstream, check=False)
        if merge.returncode:
            state["conflicts"] = git("diff", "--name-only", "--diff-filter=U").stdout.splitlines()
            if not state["conflicts"]:
                raise RuntimeError("Merge failed without resolvable conflict paths")
            git("merge", "--abort")
            git("switch", "--detach", upstream)
            state["mergeable"] = state["automatic"] = False
    if state["mergeable"]:
        config["upstream_commit"] = upstream
        CONFIG.write_text(json.dumps(config, indent=2) + "\n")
        paths = [str(CONFIG)]
        if pin_changed:
            PIN.write_text(re.sub(r'^frontend_commit="[0-9a-f]{40}"$', f'frontend_commit="{frontend}"', PIN.read_text(), flags=re.MULTILINE))
            paths.append(str(PIN))
        git("add", "--", *paths)
        timestamps = [int(git("show", "-s", "--format=%ct", sha).stdout) for sha in (base, upstream, frontend) if sha]
        # A retry of the same inputs produces the same commit and never needs a force push.
        stamp = str(max(timestamps) + 1) + " +0000"
        message = f"chore(sync): merge verified upstream inputs\n\n- Integrate {config['upstream_repository']} at {upstream}.\n- Record the upstream checkpoint for subsequent synchronization."
        if pin_changed:
            message += f"\n- Pin the validated personal frontend at {frontend}."
        git("commit", "-m", message, env={"GIT_AUTHOR_DATE": stamp, "GIT_COMMITTER_DATE": stamp})
    state["candidate_sha"] = git("rev-parse", "HEAD").stdout.strip()
    state["candidate_branch"] = "codex/sync-upstream/" + "-".join(sha[:12] for sha in (base, upstream, frontend) if sha)
    git("push", "origin", f"HEAD:refs/heads/{state['candidate_branch']}")
    pull = api.pull_request(state["candidate_branch"], branch, "chore(sync): integrate upstream updates", pr_body(state))
    state["pr_number"], state["pr_url"] = pull["number"], pull["html_url"]
    state["message"] = "Candidate prepared; validation and review rules control acceptance."
    save_result(result_path, state)
    return state


def finalize(result_path, validation):
    state = json.loads(Path(result_path).read_text())
    config = json.loads(CONFIG.read_text())
    if state["repository"] != config["repository"] or state["branch"] != "custom/115":
        raise RuntimeError("Candidate state belongs to another repository or branch")
    if not SHA.fullmatch(state["candidate_sha"]) or not SHA.fullmatch(state["base_sha"]):
        raise RuntimeError("Invalid candidate SHA")
    api = GitHub(state["repository"])
    if api.ref(state["candidate_branch"]) != state["candidate_sha"]:
        raise RuntimeError("Candidate branch changed after preparation; rerun validation")
    body = pr_body(state, validation)
    api.request(f"repos/{state['repository']}/pulls/{state['pr_number']}", "PATCH", {"body": body})
    if state["mergeable"] and validation != "skipped":
        context = "custom-115/frontend-validation" if "frontend_repository" not in config else "custom-115/sync-validation"
        api.request(f"repos/{state['repository']}/statuses/{state['candidate_sha']}", "POST", {
            "state": "success" if validation == "success" else "failure",
            "context": context, "target_url": state["run_url"],
            "description": "Exact candidate validation: " + validation,
        })
    if validation != "success" or not state["automatic"] or not state["mergeable"]:
        state["message"] = "Sync PR retained; validation or compatibility review is required."
        save_result(result_path, state)
        return state
    if api.ref(state["branch"]) != state["base_sha"]:
        raise RuntimeError("Managed branch changed during validation; keep the PR and rerun")
    git("fetch", "--no-tags", "origin", f"refs/heads/{state['candidate_branch']}")
    if git("rev-parse", "FETCH_HEAD").stdout.strip() != state["candidate_sha"] or not ancestor(state["base_sha"], state["candidate_sha"]):
        raise RuntimeError("Candidate no longer matches the validated fast-forward")
    git("push", "origin", f"{state['candidate_sha']}:refs/heads/{state['branch']}")
    if api.ref(state["branch"]) != state["candidate_sha"]:
        raise RuntimeError("Remote SHA does not match the validated candidate; do not publish")
    state["accepted"] = True
    state["message"] = "Validated candidate fast-forwarded to custom/115; remote SHA verified."
    save_result(result_path, state)
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "finalize"))
    parser.add_argument("--result", required=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--validation", choices=("success", "failure", "cancelled", "skipped"))
    args = parser.parse_args()
    if args.action == "prepare":
        prepare(args.result, args.dry_run)
    elif args.validation:
        finalize(args.result, args.validation)
    else:
        parser.error("finalize requires --validation")


if __name__ == "__main__":
    main()
