#!/usr/bin/env python3
"""Emit mandatory inline findings for unsafe changed review configuration."""

import argparse
import json
import re
from pathlib import Path


def added_lines(diff: str) -> dict[str, set[int]]:
    added: dict[str, set[int]] = {}
    path: str | None = None
    line: int | None = None
    for raw in diff.splitlines():
        match = re.match(r"diff --git a/(.*) b/(.*)", raw)
        if match:
            path = match.group(2)
            added.setdefault(path, set())
            line = None
            continue
        match = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@", raw)
        if match:
            line = int(match.group(1))
            continue
        if path is None or line is None:
            continue
        if raw.startswith("+") and not raw.startswith("+++"):
            added[path].add(line)
            line += 1
        elif raw.startswith("-") and not raw.startswith("---"):
            continue
        elif not raw.startswith("\\"):
            line += 1
    return added


def suggestion(path: str, line: int, comment: str, prompt: str) -> dict[str, object]:
    return {
        "path": path,
        "line": line,
        "category": "Security",
        "severity": "Should-fix",
        "effort": "Trivial",
        "comment": comment,
        "agent_prompt": prompt,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--diff", required=True, type=Path)
    parser.add_argument("--head-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()

    changed = added_lines(args.diff.read_text())
    findings: list[dict[str, object]] = []
    report: list[str] = ["# Deterministic review policy", ""]
    for path, lines in changed.items():
        if not path.startswith(".opencode/agent/") or not path.endswith(".md"):
            continue
        source = args.head_dir / path
        if not source.is_file():
            continue
        for number, text in enumerate(source.read_text().splitlines(), 1):
            if number not in lines:
                continue
            if re.match(r"""^\s+["']\*["']: allow\s*$""", text):
                findings.append(suggestion(
                    path,
                    number,
                    "The unrestricted `\"*\": allow` permission defeats the agent sandbox and can expose secrets or permit unsafe operations. Replace it with the smallest path or command-specific permission.",
                    "Restrict this broad agent permission to the exact paths or commands required by the agent, then validate the frontmatter YAML.",
                ))
            elif re.match(r"""^\s+["'](?:rg|grep) \*["']: allow\s*$""", text):
                findings.append(suggestion(
                    path,
                    number,
                    "The unrestricted search permission can read process or credential files outside the repository. Deny it or scope searches to approved review paths.",
                    "Replace this broad search permission with path-scoped tool permissions or deny shell search commands, then validate the frontmatter YAML.",
                ))

    if findings:
        report.extend(f"- Required `{item['path']}:{item['line']}`: {item['comment']}" for item in findings)
    else:
        report.append("No mandatory policy findings.")
    args.output.write_text(json.dumps(findings, separators=(",", ":")) + "\n")
    args.report.write_text("\n".join(report) + "\n")


if __name__ == "__main__":
    main()
