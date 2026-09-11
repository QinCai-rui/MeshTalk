#!/usr/bin/env python3
"""Validate review citations and one-click suggestions against a PR diff."""

import argparse
import ast
import json
import re
import subprocess
from pathlib import Path


SUGGESTIONS = re.compile(r"```suggestions-json\s*(.*?)\s*```", re.DOTALL)
# Only recognize path-like citations, avoiding ordinary prose such as "HTTP: 422".
CITATION = re.compile(r"(?<![\w./-])((?:[\w.-]+/)*[\w.-]+):(\d+)(?:-(\d+))?")
SEVERITY = re.compile(r"\b(?:blocking|should-fix|nit)\b", re.IGNORECASE)
BOLD_SEVERITY_HEADING = re.compile(
    r"^\s*\*\*(?:blocking(?:\s*/\s*should-fix)?|should-fix|nit|needs\s+discussion(?:\s*/\s*residual\s+risk)?)\s*:?\*\*\s*$",
    re.IGNORECASE,
)
NON_FINDING = re.compile(r"^(?:no\b|none\b|notes?\b.*\bnon[- ]blocking\b)", re.IGNORECASE)


def fail(errors: list[str], errors_path: Path) -> None:
    errors_path.write_text("\n".join(errors) + "\n")
    raise SystemExit(1)


def parse_diff(diff_path: Path) -> tuple[dict[str, set[int]], dict[tuple[str, int], str]]:
    added: dict[str, set[int]] = {}
    content: dict[tuple[str, int], str] = {}
    path: str | None = None
    new_line: int | None = None
    for raw in diff_path.read_text().splitlines():
        match = re.match(r"diff --git a/(.*) b/(.*)", raw)
        if match:
            path = match.group(2)
            added.setdefault(path, set())
            new_line = None
            continue
        match = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@", raw)
        if match:
            new_line = int(match.group(1))
            continue
        if path is None or new_line is None:
            continue
        if raw.startswith("+") and not raw.startswith("+++"):
            added[path].add(new_line)
            content[path, new_line] = raw[1:]
            new_line += 1
        elif raw.startswith("-") and not raw.startswith("---"):
            continue
        elif not raw.startswith("\\"):
            new_line += 1
    return added, content


def safe_path(path: str) -> bool:
    return bool(path) and not path.startswith("/") and ".." not in Path(path).parts


def syntax_error(path: str, source: str) -> str | None:
    suffix = Path(path).suffix.lower()
    try:
        if suffix == ".py":
            ast.parse(source, filename=path)
        elif suffix == ".json":
            json.loads(source)
        elif suffix in {".sh", ".bash"}:
            completed = subprocess.run(
                ["bash", "-n"], input=source, text=True, capture_output=True, check=False
            )
            if completed.returncode:
                return completed.stderr.strip() or "bash -n failed"
    except (SyntaxError, ValueError) as error:
        return str(error)
    return None


def is_heading(line: str) -> bool:
    return bool(re.match(r"^\s{0,3}#{1,6}\s+", line) or BOLD_SEVERITY_HEADING.match(line))


def is_severity_heading(line: str) -> bool:
    return bool(
        re.match(r"^\s{0,3}#{1,6}\s+", line)
        and SEVERITY.search(line)
        or BOLD_SEVERITY_HEADING.match(line)
    )


def block_is_non_finding(block: list[str]) -> bool:
    for line in block:
        if line.strip() and not is_severity_heading(line):
            return bool(NON_FINDING.match(line.strip()))
    return False


def review_blocks(review: str) -> list[list[str]]:
    blocks: list[list[str]] = []
    block: list[str] = []
    for line in review.splitlines():
        item = re.match(r"^\s*(?:[-*]|\d+[.)])\s+", line)
        if is_heading(line) or item:
            pure_severity_heading = len(block) == 1 and is_severity_heading(block[0])
            if pure_severity_heading and item:
                block.append(line)
                continue
            if block and not pure_severity_heading:
                blocks.append(block)
            block = [line]
        elif line.strip():
            block.append(line)
        elif block:
            if len(block) == 1 and is_severity_heading(block[0]):
                continue
            blocks.append(block)
            block = []
    if block:
        blocks.append(block)
    return blocks


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--diff", required=True, type=Path)
    parser.add_argument("--head-dir", required=True, type=Path)
    parser.add_argument("--review", required=True, type=Path)
    parser.add_argument("--suggestions", required=True, type=Path)
    parser.add_argument("--errors", required=True, type=Path)
    args = parser.parse_args()

    added, diff_content = parse_diff(args.diff)
    review = args.review.read_text()
    errors: list[str] = []

    human_review = review.split("```suggestions-json", 1)[0]
    for block_lines in review_blocks(human_review):
        block = " ".join(block_lines)
        if block_is_non_finding(block_lines):
            continue
        citations = CITATION.findall(block)
        changed_citations = []
        invalid_citations = []
        for path, start, end in citations:
            end_line = int(end or start)
            if path not in added:
                # Avoid treating ordinary prose such as "HTTP: 422" as a citation.
                if "/" in path or "." in path:
                    invalid_citations.append((path, start, end, "missing"))
                continue
            invalid = [line for line in range(int(start), end_line + 1) if line not in added[path]]
            if invalid:
                invalid_citations.append((path, start, end, "context"))
            else:
                changed_citations.append((path, start, end))

        if SEVERITY.search(block) and not changed_citations and not citations:
            errors.append("Each severity-tagged finding must include an exact changed path:line citation.")
        # A finding's primary changed-line citation is authoritative. Supporting
        # references may point at unchanged context without invalidating the review.
        if not changed_citations:
            for path, start, end, _reason in invalid_citations:
                if _reason == "missing":
                    errors.append(f"Citation {path}:{start} does not name a file changed by this PR.")
                else:
                    errors.append(
                        f"Citation {path}:{start}{'-' + end if end else ''} is not entirely on added PR lines."
                    )

    blocks = SUGGESTIONS.findall(review)
    if len(blocks) != 1:
        errors.append("Return exactly one suggestions-json block.")
        fail(errors, args.errors)
    try:
        suggestions = json.loads(blocks[0])
        if not isinstance(suggestions, list):
            raise ValueError("must be a JSON array")
        if len(suggestions) > 10:
            raise ValueError("may contain at most 10 suggestions")
    except (json.JSONDecodeError, ValueError) as error:
        errors.append(f"The suggestions-json block is invalid: {error}.")
        fail(errors, args.errors)

    valid: list[dict] = []
    for index, suggestion in enumerate(suggestions[:10]):
        label = f"Suggestion {index + 1}"
        if not isinstance(suggestion, dict):
            errors.append(f"{label} is not an object.")
            continue
        path = suggestion.get("path")
        line = suggestion.get("line")
        replacement = suggestion.get("suggestion")
        end_line = suggestion.get("end_line", line)
        if not isinstance(path, str) or not safe_path(path):
            errors.append(f"{label} has an unsafe or missing repo-relative path.")
            continue
        if not isinstance(line, int) or isinstance(line, bool):
            errors.append(f"{label} has no integer new-file line.")
            continue
        if not isinstance(end_line, int) or isinstance(end_line, bool) or end_line < line:
            errors.append(f"{label} has an invalid end_line.")
            continue
        if not isinstance(replacement, str) or not replacement.strip():
            errors.append(f"{label} has an empty replacement.")
            continue
        if path not in added or any(n not in added[path] for n in range(line, end_line + 1)):
            errors.append(f"{label} targets {path}:{line}-{end_line}, outside added PR lines.")
            continue
        head_path = args.head_dir / path
        if not head_path.is_file():
            errors.append(f"{label} cannot be checked because PR-head file {path} is unavailable.")
            continue
        source_lines = head_path.read_text().splitlines(keepends=True)
        if end_line > len(source_lines):
            errors.append(f"{label} targets past the end of {path}.")
            continue
        expected = [diff_content[path, n] for n in range(line, end_line + 1)]
        actual = [line_text.rstrip("\r\n") for line_text in source_lines[line - 1:end_line]]
        if actual != expected:
            errors.append(f"{label} no longer matches PR-head source at {path}:{line}-{end_line}.")
            continue
        replacement_lines = replacement.splitlines(keepends=True)
        if replacement_lines and not replacement_lines[-1].endswith(("\n", "\r")):
            replacement_lines[-1] += "\n" if source_lines[end_line - 1].endswith("\n") else ""
        patched = source_lines[:line - 1] + replacement_lines + source_lines[end_line:]
        syntax = syntax_error(path, "".join(patched))
        if syntax:
            errors.append(f"{label} fails a syntax check after applying to {path}: {syntax}")
            continue
        valid.append(suggestion)

    if errors:
        fail(errors, args.errors)
    args.suggestions.write_text(json.dumps(valid, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
