import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).with_name("review-policy.py")
SPEC = importlib.util.spec_from_file_location("review_policy", SCRIPT)
review_policy = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(review_policy)


class ReviewPolicyTest(unittest.TestCase):
    def run_policy(self, source: str) -> list[dict]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            head = root / "head/.opencode/agent"
            head.mkdir(parents=True)
            path = ".opencode/agent/reviewer.md"
            (head / "reviewer.md").write_text(source)
            diff = root / "diff.patch"
            diff.write_text(
                "diff --git a/.opencode/agent/reviewer.md b/.opencode/agent/reviewer.md\n"
                "new file mode 100644\n"
                "--- /dev/null\n"
                "+++ b/.opencode/agent/reviewer.md\n"
                f"@@ -0,0 +1,{len(source.splitlines())} @@\n"
                + "".join(f"+{line}\n" for line in source.splitlines())
            )
            output = root / "required.json"
            report = root / "report.md"
            with mock.patch(
                "sys.argv",
                [
                    "review-policy.py", "--diff", str(diff), "--head-dir", str(root / "head"),
                    "--output", str(output), "--report", str(report),
                ],
            ):
                review_policy.main()
            return json.loads(output.read_text())

    def test_flags_unrestricted_permission(self):
        findings = self.run_policy('permission:\n  bash:\n    "*": allow\n')
        self.assertEqual(findings[0]["line"], 3)
        self.assertIn("unrestricted", findings[0]["comment"])

    def test_flags_unrestricted_search(self):
        findings = self.run_policy('permission:\n  bash:\n    "rg *": allow\n')
        self.assertEqual(findings[0]["line"], 3)
        self.assertIn("search", findings[0]["comment"])

    def test_ignores_scoped_permissions(self):
        findings = self.run_policy('permission:\n  bash:\n    "*": deny\n    "git diff*": allow\n')
        self.assertEqual(findings, [])


if __name__ == "__main__":
    unittest.main()
