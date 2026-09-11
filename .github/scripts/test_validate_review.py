import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).with_name("validate-review.py")
SPEC = importlib.util.spec_from_file_location("validate_review", SCRIPT)
validate_review = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(validate_review)


DIFF = """diff --git a/src/example.py b/src/example.py
index 1111111..2222222 100644
--- a/src/example.py
+++ b/src/example.py
@@ -1,2 +1,3 @@
 def example():
+    return 1
"""

EXTENSIONLESS_DIFF = """diff --git a/Dockerfile b/Dockerfile
index 1111111..2222222 100644
--- a/Dockerfile
+++ b/Dockerfile
@@ -1,1 +1,2 @@
 FROM alpine
+RUN true
"""


class ValidateReviewTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        (self.root / "head/src").mkdir(parents=True)
        (self.root / "head/src/example.py").write_text("def example():\n    return 1\n")
        (self.root / "diff.patch").write_text(DIFF)
        self.review = self.root / "review.md"
        self.suggestions = self.root / "suggestions.json"
        self.errors = self.root / "errors.txt"

    def tearDown(self):
        self.tempdir.cleanup()

    def run_validator(self, review):
        self.review.write_text(review)
        with mock.patch(
            "sys.argv",
            [
                "validate-review.py",
                "--diff", str(self.root / "diff.patch"),
                "--head-dir", str(self.root / "head"),
                "--review", str(self.review),
                "--suggestions", str(self.suggestions),
                "--errors", str(self.errors),
            ],
        ):
            try:
                validate_review.main()
            except SystemExit as result:
                return result.code
        return 0

    def test_accepts_changed_line_and_applicable_python_suggestion(self):
        review = """## Findings
- **should-fix** `src/example.py:2`: Return the intended value.

```suggestions-json
[{"path":"src/example.py","line":2,"suggestion":"    return 2"}]
```
"""
        self.assertEqual(self.run_validator(review), 0)
        self.assertEqual(json.loads(self.suggestions.read_text())[0]["line"], 2)

    def test_rejects_citation_on_context_line(self):
        review = """## Findings
- **should-fix** `src/example.py:1`: This is not an added line.

```suggestions-json
[]
```
"""
        self.assertEqual(self.run_validator(review), 1)
        self.assertIn("Citation", self.errors.read_text())

    def test_accepts_bold_section_heading_and_supporting_context(self):
        review = """**Blocking / should-fix**
- **should-fix** `src/example.py:2`: Change the added return. The old implementation at `src/example.py:1` is supporting context.

```suggestions-json
[]
```
"""
        self.assertEqual(self.run_validator(review), 0)

    def test_ignores_non_finding_status_heading(self):
        review = """No blocking defects.

```suggestions-json
[]
```
"""
        self.assertEqual(self.run_validator(review), 0)

    def test_accepts_extensionless_citation(self):
        (self.root / "diff.patch").write_text(EXTENSIONLESS_DIFF)
        (self.root / "head/Dockerfile").write_text("FROM alpine\nRUN true\n")
        review = """## Findings
- **should-fix** `Dockerfile:2`: Use the required instruction.

```suggestions-json
[]
```
"""
        self.assertEqual(self.run_validator(review), 0)

    def test_checks_uncited_prose_under_severity_heading(self):
        review = """## Findings

### should-fix

This finding has no location.

```suggestions-json
[]
```
        """
        self.assertEqual(self.run_validator(review), 1)

    def test_ignores_citations_inside_suggestions_block(self):
        review = """## Findings
No actionable findings.

```suggestions-json
[{"path":"src/example.py","line":1,"comment":"not a human finding","suggestion":"def example():"}]
```
"""
        self.assertEqual(self.run_validator(review), 1)
        self.assertNotIn("Citation src/example.py:1", self.errors.read_text())


if __name__ == "__main__":
    unittest.main()
